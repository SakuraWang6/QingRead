import AVFoundation
import MediaPlayer
import ReadingCore

@MainActor
final class ReaderSpeechController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    enum State: Equatable { case stopped, playing, paused, waiting }
    @Published private(set) var state: State = .stopped
    @Published private(set) var paragraphIndex = 0
    @Published private(set) var paragraphCount = 0
    @Published var message: String?
    var onParagraph: ((Int) -> Void)?
    var onChapterBoundary: ((Int) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private var document: ReaderDocument?
    private var settings = ReaderSettings()
    private var utterance: AVSpeechUtterance?
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var bookTitle = ""
    private var interruptionObserver: NSObjectProtocol?
    private var wasPlayingBeforeInterruption = false
    private var playbackIntent = UUID()
    private var continuationRequested = false

    override init() {
        super.init()
        synthesizer.delegate = self
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
        paragraphIndex = min(max(0, document.paragraph(atUTF16: anchor)), max(0, paragraphCount - 1))
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
        paragraphCount = 0
        trace("chapterTransition autoplay=\(autoplay)")
        return autoplay ? playbackIntent : nil
    }

    func permitsAutoplay(_ intent: UUID) -> Bool {
        continuationRequested && playbackIntent == intent
    }

    func updateSettings(_ value: ReaderSettings) {
        let rateChanged = settings.speechRate != value.speechRate
        settings = value
        if rateChanged && state == .playing { speakCurrentParagraph() }
    }

    func alignIfStopped(toUTF16 offset: Int) {
        guard state == .stopped, let document else { return }
        paragraphIndex = min(max(0, document.paragraph(atUTF16: offset)), max(0, paragraphCount - 1))
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
        if synthesizer.pauseSpeaking(at: .word) { state = .paused; updateNowPlaying(); trace("paused") }
    }

    func resume() {
        guard state == .paused else { return }
        if document == nil {
            continuationRequested = true
            state = .waiting
            updateNowPlaying()
            trace("resume while waiting")
            return
        }
        if synthesizer.continueSpeaking() { state = .playing; updateNowPlaying(); trace("resumed") }
        else { speakCurrentParagraph() }
    }

    func stop() {
        playbackIntent = UUID()
        continuationRequested = false
        stopUtterance()
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
            paragraphIndex = next
            if state == .stopped { onParagraph?(document!.paragraphRanges[next].location) }
            else { speakCurrentParagraph() }
        } else { requestChapter(delta > 0 ? 1 : -1) }
    }

    func requestChapter(_ delta: Int) {
        stopUtterance()
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
        guard let voice = AVSpeechSynthesisVoice(language: "zh-CN") ?? AVSpeechSynthesisVoice.speechVoices().first(where: { $0.language.hasPrefix("zh") }) else {
            state = .stopped
            message = "系统没有可用的中文语音。请在 iPhone「设置 → 辅助功能 → 朗读内容 → 声音」中下载中文声音。"
            return
        }
        let item = AVSpeechUtterance(string: document.content.paragraphs[paragraphIndex])
        item.voice = voice
        item.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(settings.speechRate)))
        item.postUtteranceDelay = 0.2
        utterance = item
        state = .playing
        trace("playing voice=\(voice.language) rate=\(settings.speechRate)")
        onParagraph?(document.paragraphRanges[paragraphIndex].location)
        synthesizer.speak(item)
        updateNowPlaying()
    }

    private func stopUtterance() {
        utterance = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.trace("didFinish current=\(self.utterance === utterance)")
            guard self.utterance === utterance, self.state == .playing else { return }
            if self.paragraphIndex + 1 < self.paragraphCount {
                self.paragraphIndex += 1
                self.speakCurrentParagraph()
            } else { self.requestChapter(1) }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.trace("didStart") }
    }

    private func trace(_ event: String) {
        #if DEBUG
        print("QINGREAD_SPEECH \(event) state=\(state) paragraph=\(paragraphIndex + 1)/\(paragraphCount)")
        #endif
    }

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
            MPMediaItemPropertyArtist: "清读 · 系统朗读",
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? settings.speechRate : 0,
            MPNowPlayingInfoPropertyIsLiveStream: true
        ]
    }

    deinit {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        for (command, token) in remoteTargets { command.removeTarget(token) }
    }
}
