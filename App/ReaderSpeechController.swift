import AVFoundation
import MediaPlayer
import ReadingCore
import UIKit

@MainActor
final class ReaderSpeechController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    enum State: Equatable { case stopped, playing, paused, waiting }
    @Published private(set) var state: State = .stopped
    @Published private(set) var paragraphIndex = 0
    @Published private(set) var paragraphCount = 0
    @Published private(set) var availableVoices: [ReaderSpeechVoice] = []
    @Published var message: String?
    var onParagraph: ((Int) -> Void)?
    var onChapterBoundary: ((Int) -> Void)?
    var onChapterCompleted: (() -> Void)?
    var automaticVoice: ReaderSpeechVoice? { availableVoices.first }
    var wantsContinuation: Bool { continuationRequested && (state == .playing || state == .waiting) }
    var currentUTF16Anchor: Int? {
        guard let document, let cursor, document.paragraphRanges.indices.contains(paragraphIndex) else { return nil }
        return document.paragraphRanges[paragraphIndex].location + cursor.utf16Offset
    }

    private let synthesizer = AVSpeechSynthesizer()
    private var document: ReaderDocument?
    private var settings = ReaderSettings()
    private var utterance: AVSpeechUtterance?
    private var cursor: ReaderSpeechCursor?
    private var offlineSpeech: OfflineSpeechEngine?
    private var offlinePlayback = UUID()
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var bookTitle = ""
    private var interruptionObserver: NSObjectProtocol?
    private var voiceObservers: [NSObjectProtocol] = []
    private var wasPlayingBeforeInterruption = false
    private var playbackIntent = UUID()
    private var continuationRequested = false

    override init() {
        super.init()
        synthesizer.delegate = self
        refreshVoices()
        let notifications = NotificationCenter.default
        voiceObservers.append(notifications.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshVoices() }
        })
        if #available(iOS 17, *) {
            voiceObservers.append(notifications.addObserver(forName: AVSpeechSynthesizer.availableVoicesDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refreshVoices() }
            })
        }
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            Task { @MainActor in
                guard let self else { return }
                self.trace("interruption type=\(raw)")
                if type == .began {
                    self.wasPlayingBeforeInterruption = self.state == .playing
                    self.pause()
                } else {
                    let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                    if self.wasPlayingBeforeInterruption && AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) { self.resume() }
                }
            }
        }
    }

    func prepare(content: ChapterContent, settings: ReaderSettings, anchor: Int, bookTitle: String, autoplay: Bool) {
        stopUtterance()
        self.settings = settings
        self.bookTitle = bookTitle
        let document = ReaderDocument(content: content, settings: settings)
        self.document = document
        paragraphCount = content.paragraphs.count
        align(toUTF16: anchor)
        state = .stopped
        continuationRequested = autoplay
        trace("prepared autoplay=\(autoplay)")
        if autoplay { play() }
    }

    /// Stops the old chapter synchronously before ReaderView changes its index.
    /// A stop action invalidates this token even if the next network load finishes later.
    func beginChapterTransition(autoplay: Bool) -> UUID? {
        stopUtterance()
        if autoplay {
            playbackIntent = UUID()
            continuationRequested = true
            state = .waiting
            updateNowPlaying()
        } else { stop() }
        document = nil
        cursor = nil
        paragraphCount = 0
        trace("chapterTransition autoplay=\(autoplay)")
        return autoplay ? playbackIntent : nil
    }

    func permitsAutoplay(_ intent: UUID) -> Bool {
        continuationRequested && playbackIntent == intent
    }

    func updateSettings(_ value: ReaderSettings) {
        let engineChanged = settings.speechEngine != value.speechEngine
        let speechChanged = settings.speechRate != value.speechRate || settings.speechVoiceIdentifier != value.speechVoiceIdentifier || engineChanged
        settings = value
        guard speechChanged else { return }
        if engineChanged {
            offlineSpeech?.stop()
            offlineSpeech = nil
        } else if value.speechEngine == .melo {
            // Time stretch the existing player; never regenerate the current
            // sentence when a rate slider changes.
            offlineSpeech?.setRate(value.speechRate)
            updateNowPlaying()
            return
        }
        if state == .playing { speakCurrentParagraph() }
        else if state == .paused {
            // Invalidating the old utterance defers replacement until Resume.
            // Never enqueue a new one while the user's intent is paused.
            stopUtterance()
            updateNowPlaying()
        }
    }

    func alignIfStopped(toUTF16 offset: Int) {
        guard state == .stopped else { return }
        align(toUTF16: offset)
    }

    private func align(toUTF16 offset: Int) {
        guard let document, paragraphCount > 0 else { cursor = nil; paragraphIndex = 0; return }
        let index = min(max(0, document.paragraph(atUTF16: offset)), paragraphCount - 1)
        setParagraph(index, utf16Offset: offset - document.paragraphRanges[index].location)
    }

    private func setParagraph(_ index: Int, utf16Offset: Int = 0) {
        guard let document, document.content.paragraphs.indices.contains(index) else { return }
        paragraphIndex = index
        cursor = ReaderSpeechCursor(text: document.content.paragraphs[index], utf16Offset: utf16Offset)
    }

    func refreshVoices() {
        let voices = AVSpeechSynthesisVoice.speechVoices().map {
            ReaderSpeechVoice(id: $0.identifier, name: $0.name, language: $0.language,
                              quality: ReaderSpeechVoice.Quality(rawValue: $0.quality.rawValue) ?? .standard)
        }
        availableVoices = ReaderSpeechVoice.sorted(voices)
    }

    func toggle() {
        switch state {
        case .playing: pause()
        case .paused: resume()
        case .stopped: play()
        case .waiting: pause()
        }
    }

    func play() {
        guard paragraphCount > 0 else { return }
        playbackIntent = UUID()
        continuationRequested = true
        message = nil
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            message = "系统音频暂时不可用：\(error.localizedDescription)"
            return
        }
        installRemoteCommands()
        trace("play requested")
        speakCurrentParagraph()
    }

    func pause() {
        if state == .waiting {
            continuationRequested = false
            state = .paused
            updateNowPlaying()
            trace("pause while waiting")
            return
        }
        guard state == .playing else { return }
        continuationRequested = false
        if settings.speechEngine == .melo {
            offlineSpeech?.pause()
            state = .paused
            if let anchor = currentUTF16Anchor { onParagraph?(anchor) }
            updateNowPlaying()
            return
        }
        // A freshly enqueued or interrupted utterance may not yet be pausable.
        // Retain the user's pause intent even in that narrow transition.
        if !synthesizer.pauseSpeaking(at: .word) { stopUtterance() }
        state = .paused
        if let anchor = currentUTF16Anchor { onParagraph?(anchor) }
        updateNowPlaying()
        trace("paused")
    }

    func resume() {
        guard state == .paused else { return }
        continuationRequested = true
        if document == nil {
            continuationRequested = true
            state = .waiting
            updateNowPlaying()
            trace("resume while waiting")
            return
        }
        if settings.speechEngine == .melo, let offlineSpeech {
            state = .playing
            if offlineSpeech.resume() {
                if state == .playing { updateNowPlaying() }
                return
            }
        }
        if utterance != nil && synthesizer.continueSpeaking() { state = .playing; updateNowPlaying(); trace("resumed") }
        else { speakCurrentParagraph() }
    }

    func stop() {
        if state == .playing || state == .paused, let anchor = currentUTF16Anchor { onParagraph?(anchor) }
        playbackIntent = UUID()
        continuationRequested = false
        stopUtterance()
        offlineSpeech?.stop()
        offlineSpeech = nil
        state = .stopped
        trace("stopped")
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        for (command, token) in remoteTargets { command.removeTarget(token) }
        remoteTargets.removeAll()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func moveParagraph(_ delta: Int) {
        guard document != nil else { return }
        let next = paragraphIndex + delta
        if (0..<paragraphCount).contains(next) {
            setParagraph(next)
            if state == .playing { speakCurrentParagraph() }
            else {
                stopUtterance()
                onParagraph?(document!.paragraphRanges[next].location)
                updateNowPlaying()
            }
        } else { requestChapter(delta > 0 ? 1 : -1) }
    }

    func requestChapter(_ delta: Int) {
        let shouldContinue = wantsContinuation
        stopUtterance()
        continuationRequested = shouldContinue
        state = .waiting
        trace("request chapter delta=\(delta)")
        updateNowPlaying()
        onChapterBoundary?(delta)
    }

    func endOfBook() {
        stop()
        message = "已读到最后一章。"
    }

    private func speakCurrentParagraph() {
        guard let document, document.content.paragraphs.indices.contains(paragraphIndex) else { return }
        stopUtterance()
        if cursor == nil { setParagraph(paragraphIndex) }
        if settings.speechEngine == .melo {
            speakOfflineParagraph(document)
            return
        }
        refreshVoices()
        let selected = availableVoices.first { $0.id == settings.speechVoiceIdentifier } ?? automaticVoice
        guard let selected, let voice = AVSpeechSynthesisVoice(identifier: selected.id) else {
            stop()
            message = "系统没有可用的中文语音。请在 iPhone「设置 → 辅助功能 → 朗读内容 → 声音」中下载中文声音。"
            return
        }
        if !settings.speechVoiceIdentifier.isEmpty && selected.id != settings.speechVoiceIdentifier {
            message = "所选音色当前不可用，已改用\(selected.name)。可在系统设置下载后重新选择。"
        } else { message = nil }
        var remaining = cursor?.beginUtterance() ?? ""
        while remaining.isEmpty, paragraphIndex + 1 < paragraphCount {
            setParagraph(paragraphIndex + 1)
            remaining = cursor?.beginUtterance() ?? ""
        }
        guard !remaining.isEmpty else { stop(); return }
        let item = AVSpeechUtterance(string: remaining)
        item.voice = voice
        item.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(settings.speechRate)))
        item.postUtteranceDelay = 0.2
        utterance = item
        state = .playing
        trace("playing voice=\(voice.language) rate=\(settings.speechRate)")
        onParagraph?(document.paragraphRanges[paragraphIndex].location + (cursor?.utf16Offset ?? 0))
        synthesizer.speak(item)
        updateNowPlaying()
    }

    private func stopUtterance() {
        offlinePlayback = UUID()
        offlineSpeech?.stop(releaseModel: false)
        utterance = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    private func speakOfflineParagraph(_ document: ReaderDocument) {
        guard let directory = AIModelManager.shared.readyDirectory else {
            stop()
            message = "请先在听书面板下载离线声库，或选择系统语音。"
            return
        }
        if offlineSpeech?.modelDirectory != directory {
            offlineSpeech?.stop()
            offlineSpeech = OfflineSpeechEngine(modelDirectory: directory)
        }
        guard let engine = offlineSpeech else { return }
        let token = UUID()
        offlinePlayback = token
        let index = paragraphIndex
        let text = document.content.paragraphs[index]
        state = .playing
        message = nil
        onParagraph?(document.paragraphRanges[index].location + (cursor?.utf16Offset ?? 0))
        updateNowPlaying()
        engine.play(text: text, offset: cursor?.utf16Offset ?? 0, rate: settings.speechRate,
                    onPosition: { [weak self] offset in
            guard let self, self.offlinePlayback == token, self.paragraphIndex == index else { return }
            self.cursor = ReaderSpeechCursor(text: text, utf16Offset: offset)
        }, onFinish: { [weak self] in
            guard let self, self.offlinePlayback == token, self.state == .playing else { return }
            self.finishParagraph()
        }, onError: { [weak self] error in
            guard let self, self.offlinePlayback == token else { return }
            self.stop()
            self.message = error
        })
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.finishSpeech(utterance) }
    }

    private func finishSpeech(_ utterance: AVSpeechUtterance) {
        trace("didFinish current=\(self.utterance === utterance)")
        guard self.utterance === utterance, state == .playing else { return }
        finishParagraph()
    }

    private func finishParagraph() {
        if paragraphIndex + 1 < paragraphCount {
            setParagraph(paragraphIndex + 1)
            speakCurrentParagraph()
        } else {
            if let document, document.content.paragraphs.indices.contains(paragraphIndex) {
                let text = document.content.paragraphs[paragraphIndex]
                cursor = ReaderSpeechCursor(text: text, utf16Offset: (text as NSString).length)
            }
            onChapterCompleted?()
            requestChapter(1)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.receiveSpeechRange(characterRange, utterance: utterance) }
    }

    private func receiveSpeechRange(_ range: NSRange, utterance: AVSpeechUtterance) {
        // Delegate deliveries queued before Stop/change voice/change chapter are
        // harmless: only the current utterance may move the paragraph cursor.
        guard self.utterance === utterance, state == .playing || state == .paused else { return }
        cursor?.willSpeak(range)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.utterance === utterance else { return }
            self.trace("didStart")
        }
    }

    private func trace(_ event: String) {
        #if DEBUG
        print("QINGREAD_SPEECH \(event) state=\(state) paragraph=\(paragraphIndex + 1)/\(paragraphCount)")
        #endif
    }

    #if DEBUG
    /// State/callback diagnostics use unqueued utterances; no voice is played.
    static func runDiagnostics() {
        do {
            let migrated = try JSONDecoder().decode(ReaderSettings.self, from: Data(#"{"speechRate":1.2}"#.utf8))
            assert(migrated.speechVoiceIdentifier.isEmpty && migrated.speechRate == 1.2 && migrated.speechEngine == .system)
            var selected = migrated
            selected.speechVoiceIdentifier = "diagnostic-only-voice"
            let roundTrip = try JSONDecoder().decode(ReaderSettings.self, from: JSONEncoder().encode(selected))
            assert(roundTrip == selected)
            var offlineSettings = selected
            offlineSettings.speechEngine = .melo
            let offlineRoundTrip = try JSONDecoder().decode(ReaderSettings.self, from: JSONEncoder().encode(offlineSettings))
            assert(offlineRoundTrip == offlineSettings)
            let chapter = Chapter(id: "speech-diagnostic", title: "语音诊断", url: URL(string: "https://example.invalid/speech")!, index: 0)
            let text = "开头👩🏽‍🚀，当前词，还有后面的句子。"
            let content = ChapterContent(chapter: chapter, paragraphs: [text, "本章最后一句。"])
            let document = ReaderDocument(content: content, settings: selected)
            let wordOffset = (text as NSString).range(of: "当前词").location
            let speech = ReaderSpeechController()
            speech.prepare(content: content, settings: selected, anchor: document.paragraphRanges[0].location + wordOffset,
                           bookTitle: "诊断", autoplay: false)
            assert(speech.cursor?.utf16Offset == wordOffset)
            let stale = AVSpeechUtterance(string: text)
            speech.utterance = stale
            speech.state = .paused
            var changed = selected
            changed.speechRate = 1.6
            speech.updateSettings(changed)
            assert(speech.state == .paused && speech.utterance == nil && speech.cursor?.utf16Offset == wordOffset)
            changed.speechVoiceIdentifier = ""
            speech.updateSettings(changed)
            assert(speech.state == .paused && !speech.synthesizer.isSpeaking)
            let current = AVSpeechUtterance(string: speech.cursor!.beginUtterance())
            speech.utterance = current
            speech.state = .playing
            speech.pause()
            assert(speech.state == .paused && !speech.wantsContinuation)
            speech.utterance = current
            let beforeStale = speech.cursor
            speech.receiveSpeechRange(NSRange(location: 3, length: 1), utterance: stale)
            speech.finishSpeech(stale)
            assert(speech.cursor == beforeStale && speech.paragraphIndex == 0 && speech.state == .paused)
            speech.receiveSpeechRange(NSRange(location: 3, length: 1), utterance: current)
            assert(speech.cursor!.utf16Offset == wordOffset + 3)
            var completed = 0
            speech.onChapterCompleted = { completed += 1; assert(speech.document != nil) }
            speech.requestChapter(1)
            assert(completed == 0 && !speech.wantsContinuation)
            speech.setParagraph(1)
            speech.utterance = current
            speech.state = .playing
            speech.continuationRequested = true
            speech.finishSpeech(current)
            assert(completed == 1 && speech.state == .waiting && speech.wantsContinuation)
            speech.finishSpeech(current)
            assert(completed == 1)
            speech.onChapterCompleted = nil
            speech.stop()
            print("QINGREAD_SPEECH_SELFTEST settings=passed pausedChanges=passed utf16Anchor=passed staleCallbacks=passed naturalCompletion=passed")
        } catch { assertionFailure("Speech diagnostics failed: \(error)") }
    }
    #endif

    private func installRemoteCommands() {
        guard remoteTargets.isEmpty else { return }
        let center = MPRemoteCommandCenter.shared()
        let actions: [(MPRemoteCommand, @MainActor () -> Void)] = [
            (center.playCommand, { [weak self] in self?.resumeOrPlay() }),
            (center.pauseCommand, { [weak self] in self?.pause() }),
            (center.togglePlayPauseCommand, { [weak self] in self?.toggle() }),
            (center.stopCommand, { [weak self] in self?.stop() }),
            (center.nextTrackCommand, { [weak self] in self?.moveParagraph(1) }),
            (center.previousTrackCommand, { [weak self] in self?.moveParagraph(-1) })
        ]
        for (command, action) in actions {
            command.isEnabled = true
            let token = command.addTarget { _ in
                Task { @MainActor in action() }
                return .success
            }
            remoteTargets.append((command, token))
        }
    }

    private func resumeOrPlay() { state == .paused ? resume() : play() }

    private func updateNowPlaying() {
        guard let document else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: document.content.chapter.title,
            MPMediaItemPropertyAlbumTitle: bookTitle,
            MPMediaItemPropertyArtist: settings.speechEngine == .melo ? "清读 · 离线 AI" : "清读 · 系统朗读",
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? settings.speechRate : 0,
            MPNowPlayingInfoPropertyIsLiveStream: true
        ]
    }

    deinit {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        for observer in voiceObservers { NotificationCenter.default.removeObserver(observer) }
        for (command, token) in remoteTargets { command.removeTarget(token) }
    }
}
