import AVFoundation
import Foundation
import SherpaOnnx
import UIKit
import CryptoKit

private final class SpeechGenerationCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}

/// Sherpa instances are confined to this queue, including destruction. Neither
/// model loading nor neural synthesis/PCM conversion runs on the main actor.
private final class OfflineSpeechWorker: @unchecked Sendable {
    struct Generated: Sendable {
        let wav: Data
        let sampleRate: Int
        let sampleCount: Int
    }
    enum Failure: LocalizedError {
        case missingModel, initialization, generation
        var errorDescription: String? {
            switch self {
            case .missingModel: return "离线声库文件不完整，请重新下载声库。"
            case .initialization: return "离线声库无法载入，请重新下载或改用系统语音。"
            case .generation: return "这句文字暂时无法生成语音，可跳到下一段或改用系统语音。"
            }
        }
    }
    private let directory: URL
    private let engineKind: SpeechEngine
    private let speakerID: Int
    private let queue = DispatchQueue(label: "app.qingread.offline-speech", qos: .userInitiated)
    private var tts: SherpaOnnxOfflineTtsWrapper?

    init(directory: URL, engine: SpeechEngine, speakerID: Int) { self.directory = directory; engineKind = engine; self.speakerID = speakerID }

    func clear() { queue.async { self.tts = nil } }

    func generate(_ text: String, cancellation: SpeechGenerationCancellation) async throws -> Generated {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    if cancellation.isCancelled { throw CancellationError() }
                    let cache = Self.cacheRoot.appendingPathComponent(SHA256.hash(data: Data("v1.13.8|\(self.engineKind.rawValue)|\(self.speakerID)|\(text)".utf8)).map { String(format: "%02x", $0) }.joined() + ".wav")
                    if let data = try? Data(contentsOf: cache), data.count > 44,
                       String(data: data.prefix(4), encoding: .ascii) == "RIFF" {
                        let sampleRate = data[24..<28].enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
                        if (8000...96000).contains(sampleRate) {
                            continuation.resume(returning: Generated(wav: data, sampleRate: sampleRate, sampleCount: (data.count - 44) / 2))
                            return
                        }
                    }
                    let engine = try self.loadModel()
                    if cancellation.isCancelled { throw CancellationError() }
                    let callback: TtsCallbackWithArg = { _, _, argument in
                        guard let argument else { return 0 }
                        let token = Unmanaged<SpeechGenerationCancellation>.fromOpaque(argument).takeUnretainedValue()
                        return token.isCancelled ? 0 : 1
                    }
                    let argument = Unmanaged.passUnretained(cancellation).toOpaque()
                    let audio = engine.generateWithCallbackWithArg(text: text, callback: callback, arg: argument, sid: self.speakerID, speed: 1)
                    // The official 1.13.8 wrappers expose nullable C pointers as
                    // IUOs. Check before touching n/sampleRate/samples.
                    guard audio.audio != nil else { throw Failure.generation }
                    if cancellation.isCancelled { throw CancellationError() }
                    guard audio.n > 0, audio.n <= 96_000 * 120 else { throw Failure.generation }
                    let samples = audio.samples
                    guard samples.count == Int(audio.n), samples.allSatisfy(\.isFinite) else { throw Failure.generation }
                    let wave = try ReaderSpeechPCM.wav(samples: samples, sampleRate: Int(audio.sampleRate))
                    if cancellation.isCancelled { throw CancellationError() }
                    try? FileManager.default.createDirectory(at: Self.cacheRoot, withIntermediateDirectories: true)
                    try? wave.write(to: cache, options: .atomic)
                    Self.pruneCache()
                    continuation.resume(returning: Generated(wav: wave, sampleRate: Int(audio.sampleRate), sampleCount: samples.count))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func loadModel() throws -> SherpaOnnxOfflineTtsWrapper {
        if let tts { return tts }
        let files = engineKind == .kokoro ? ["model.int8.onnx", "voices.bin", "tokens.txt", "date-zh.fst", "number-zh.fst", "lexicon-zh.txt", "espeak-ng-data/phontab", "espeak-ng-data/phondata"] : ["model.int8.onnx", "lexicon.txt", "tokens.txt", "date.fst", "number.fst", "LICENSE"]
        guard directory.isFileURL else { throw Failure.missingModel }
        let paths = files.map { directory.appendingPathComponent($0) }
        for path in paths {
            let values = try? path.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values?.isRegularFile == true, values?.isSymbolicLink != true, (values?.fileSize ?? 0) > 0 else { throw Failure.missingModel }
        }
        var model = sherpaOnnxOfflineTtsModelConfig(numThreads: 2, provider: "cpu")
        if engineKind == .kokoro {
            let kokoro = sherpaOnnxOfflineTtsKokoroModelConfig(model: paths[0].path, voices: paths[1].path, tokens: paths[2].path,
                dataDir: directory.appendingPathComponent("espeak-ng-data").path,
                lexicon: paths[5].path + "," + directory.appendingPathComponent("lexicon-us-en.txt").path)
            model = sherpaOnnxOfflineTtsModelConfig(kokoro: kokoro, numThreads: 2, debug: 0, provider: "cpu")
        } else {
            let vits = sherpaOnnxOfflineTtsVitsModelConfig(model: paths[0].path, lexicon: paths[1].path, tokens: paths[2].path)
            model = sherpaOnnxOfflineTtsModelConfig(vits: vits, numThreads: 2, debug: 0, provider: "cpu")
        }
        var config = sherpaOnnxOfflineTtsConfig(model: model, ruleFsts: paths[3].path + "," + paths[4].path, maxNumSentences: 1)
        let engine = SherpaOnnxOfflineTtsWrapper(config: &config)
        guard engine.tts != nil else { throw Failure.initialization }
        tts = engine
        return engine
    }

    static var cacheRoot: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!.appendingPathComponent("QingReadAudio", isDirectory: true) }
    private static func pruneCache() {
        let files = ((try? FileManager.default.contentsOfDirectory(at: cacheRoot, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? []).compactMap { url -> (URL, Int, Date)? in
            guard let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (url, v.fileSize ?? 0, v.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var size = files.reduce(0) { $0 + $1.1 }
        for file in files where size > 128 * 1024 * 1024 { try? FileManager.default.removeItem(at: file.0); size -= file.1 }
    }
}

@MainActor
final class OfflineSpeechEngine: NSObject, AVAudioPlayerDelegate {
    let modelDirectory: URL
    let engineKind: SpeechEngine
    let speakerID: Int
    private let worker: OfflineSpeechWorker
    private var player: AVAudioPlayer?
    private var timer: Timer?
    private var task: Task<Void, Never>?
    private var pendingAudio: [Int: Task<OfflineSpeechWorker.Generated, Error>] = [:]
    private var backgroundTasks: [UUID: UIBackgroundTaskIdentifier] = [:]
    private var generation = UUID()
    private var cancellation: SpeechGenerationCancellation?
    private var chunks: [ReaderSpeechChunk] = []
    private var chunkIndex = 0
    private var fullText = ""
    private var rate: Float = 1
    private var isPaused = false
    private var finishedWhilePaused = false
    private var onPosition: ((Int) -> Void)?
    private var onFinish: (() -> Void)?
    private var onError: ((String) -> Void)?
    #if DEBUG
    private var diagnosticVolume: Float = 1
    private var chunkWaits: [Double] = []
    #endif

    init(modelDirectory: URL, engine: SpeechEngine = .melo, speakerID: Int = 0) {
        self.modelDirectory = modelDirectory
        engineKind = engine
        self.speakerID = speakerID
        worker = OfflineSpeechWorker(directory: modelDirectory, engine: engine, speakerID: speakerID)
        super.init()
    }

    func play(text: String, offset: Int, rate: Double, onPosition: @escaping (Int) -> Void,
              onFinish: @escaping () -> Void, onError: @escaping (String) -> Void) {
        stop(releaseModel: false)
        fullText = text
        chunks = ReaderSpeechChunk.split(text, fromUTF16: offset)
        self.onPosition = onPosition
        self.onFinish = onFinish
        self.onError = onError
        setRate(rate)
        cancellation = SpeechGenerationCancellation()
        generateCurrentChunk()
    }

    func setRate(_ value: Double) {
        rate = Float(value.isFinite ? min(1.8, max(0.6, value)) : 1)
        player?.rate = rate
    }

    func pause() {
        isPaused = true
        reportPosition()
        player?.pause()
        timer?.invalidate(); timer = nil
    }

    @discardableResult func resume() -> Bool {
        guard cancellation != nil else { return false }
        isPaused = false
        if finishedWhilePaused { finishedWhilePaused = false; advanceChunk() }
        else if let player {
            if player.play() { startTimer(); prefetchNextChunk() }
            else { fail("系统音频暂时无法播放，请重试。") }
        }
        return true
    }

    func stop(releaseModel: Bool = true) {
        generation = UUID()
        cancellation?.cancel()
        cancellation = nil
        task?.cancel(); task = nil
        pendingAudio.values.forEach { $0.cancel() }; pendingAudio.removeAll()
        for identifier in backgroundTasks.values { UIApplication.shared.endBackgroundTask(identifier) }
        backgroundTasks.removeAll()
        timer?.invalidate(); timer = nil
        player?.delegate = nil
        player?.stop(); player = nil
        chunks.removeAll(); chunkIndex = 0; fullText = ""
        isPaused = false; finishedWhilePaused = false
        onPosition = nil; onFinish = nil; onError = nil
        if releaseModel { worker.clear() }
    }

    private func generateCurrentChunk() {
        let token = generation
        guard chunks.indices.contains(chunkIndex) else {
            task = Task { @MainActor [weak self] in
                await Task.yield()
                guard let self, self.generation == token else { return }
                if self.isPaused { self.finishedWhilePaused = true; return }
                let completion = self.onFinish
                self.stop(releaseModel: false)
                completion?()
            }
            return
        }
        guard let cancellation else { return }
        let chunk = chunks[chunkIndex]
        let pending = pendingAudio.removeValue(forKey: chunkIndex)
        task = Task { @MainActor [weak self] in
            do {
                guard !Task.isCancelled, let self, self.generation == token else { return }
                #if DEBUG
                let waitingAt = Date()
                #endif
                let audio: OfflineSpeechWorker.Generated
                if let pending { audio = try await pending.value }
                else { audio = try await self.generateAudio(chunk.text, cancellation: cancellation) }
                guard !Task.isCancelled, self.generation == token else { return }
                // Prime one following sentence before starting. This avoids
                // playing a cached first sentence while its successor is cold.
                if self.chunkIndex == 0, self.chunks.count > 1, !self.isPaused {
                    self.prefetchNextChunk()
                    if let next = self.pendingAudio[1] { _ = try await next.value }
                    guard !Task.isCancelled, self.generation == token else { return }
                }
                let player = try AVAudioPlayer(data: audio.wav, fileTypeHint: AVFileType.wav.rawValue)
                #if DEBUG
                self.chunkWaits.append(Date().timeIntervalSince(waitingAt))
                player.volume = self.diagnosticVolume
                #endif
                player.enableRate = true
                player.rate = self.rate
                player.delegate = self
                guard player.prepareToPlay() else { throw OfflineSpeechWorker.Failure.generation }
                self.player = player
                self.onPosition?(chunk.range.location)
                if !self.isPaused { self.startTimer(); self.prefetchNextChunk() }
                if !self.isPaused && !player.play() { self.fail("系统音频暂时无法播放，请重试。") }
            } catch {
                guard !Task.isCancelled, let self, self.generation == token, !(error is CancellationError) else { return }
                self.fail((error as? LocalizedError)?.errorDescription ?? "离线语音生成失败，请重试或改用系统语音。")
            }
        }
    }

    private func generateAudio(_ text: String, cancellation: SpeechGenerationCancellation) async throws -> OfflineSpeechWorker.Generated {
        let key = UUID()
        let identifier = UIApplication.shared.beginBackgroundTask(withName: "QingReadOfflineSpeech") { [weak self] in
            Task { @MainActor in
                guard let self, self.backgroundTasks[key] != nil else { return }
                self.fail("系统暂停了离线语音，请回到清读后重新播放。")
            }
        }
        if identifier != .invalid { backgroundTasks[key] = identifier }
        defer {
            if let identifier = backgroundTasks.removeValue(forKey: key) { UIApplication.shared.endBackgroundTask(identifier) }
        }
        return try await worker.generate(text, cancellation: cancellation)
    }

    /// Bounded look-ahead spans paragraph boundaries; generated audio is reused.
    private func prefetchNextChunk() {
        guard !isPaused, let cancellation else { return }
        for next in (chunkIndex + 1)..<min(chunks.count, chunkIndex + 4) where pendingAudio[next] == nil {
            let text = chunks[next].text
            pendingAudio[next] = Task { @MainActor [weak self] in
                guard let self, !Task.isCancelled else { throw CancellationError() }
                return try await self.generateAudio(text, cancellation: cancellation)
            }
        }
    }

    private func advanceChunk() {
        timer?.invalidate(); timer = nil
        player?.delegate = nil; player = nil
        chunkIndex += 1
        generateCurrentChunk()
    }

    private func fail(_ message: String) {
        let callback = onError
        stop()
        callback?(message)
    }

    private func startTimer() {
        timer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reportPosition() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func reportPosition() {
        guard let player, player.duration > 0, chunks.indices.contains(chunkIndex) else { return }
        let chunk = chunks[chunkIndex]
        // Neural output has no word timestamps. Interpolate within this short
        // sentence, and normalize to a composed-character UTF-16 boundary.
        let fraction = finishedWhilePaused ? 1 : min(1, max(0, player.currentTime / player.duration))
        let approximate = chunk.range.location + Int(Double(chunk.range.length) * fraction)
        onPosition?(ReaderSpeechCursor(text: fullText, utf16Offset: approximate).utf16Offset)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, self.player === player else { return }
            guard flag else { self.fail("离线语音播放中断，请重试。"); return }
            self.timer?.invalidate(); self.timer = nil
            if self.chunks.indices.contains(self.chunkIndex) {
                self.onPosition?(NSMaxRange(self.chunks[self.chunkIndex].range))
            }
            if self.isPaused { self.finishedWhilePaused = true }
            else { self.advanceChunk() }
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, self.player === player else { return }
            self.fail("离线语音音频无法读取，请重试或改用系统语音。")
        }
    }

    #if DEBUG
    /// Requires an explicitly downloaded verified model. Generates a real public
    /// domain sentence, saves it for inspection, then briefly plays at volume 0.
    static func runDiagnostics(modelDirectory: URL, kind: SpeechEngine = .melo, voiceID: Int = 0) async -> Bool {
        let engine = OfflineSpeechEngine(modelDirectory: modelDirectory, engine: kind, speakerID: voiceID)
        engine.diagnosticVolume = 0
        let cancellation = SpeechGenerationCancellation()
        defer { cancellation.cancel(); engine.stop() }
        do {
            let started = Date()
            let audio = try await engine.generateAudio("晋太元中，武陵人捕鱼为业。", cancellation: cancellation)
            let elapsed = Date().timeIntervalSince(started)
            guard audio.sampleRate > 0, audio.sampleCount > 0 else { return false }
            let warmText = "初极狭，才通人。复行数十步，豁然开朗。土地平旷，屋舍俨然，有良田、美池、桑竹之属。"
            let warmAt = Date()
            let warmAudio = try await engine.generateAudio(warmText, cancellation: cancellation)
            let warmSeconds = Date().timeIntervalSince(warmAt)
            let cacheAt = Date()
            let cached = try await engine.generateAudio(warmText, cancellation: cancellation)
            let cacheSeconds = Date().timeIntervalSince(cacheAt)
            guard cached.wav == warmAudio.wav else { return false }
            print(String(format: "QINGREAD_AI_BENCHMARK engine=%@ voice=%d warmSeconds=%.3f audioSeconds=%.3f cacheSeconds=%.3f", kind.rawValue, voiceID, warmSeconds, Double(warmAudio.sampleCount) / Double(warmAudio.sampleRate), cacheSeconds))
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("QingRead/Diagnostics", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let output = root.appendingPathComponent("\(kind.rawValue)-\(voiceID)-sample.wav")
            try audio.wav.write(to: output, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
            let player = try AVAudioPlayer(data: audio.wav, fileTypeHint: AVFileType.wav.rawValue)
            player.volume = 0
            player.enableRate = true
            guard player.prepareToPlay(), player.duration > 0 else { return false }
            player.currentTime = min(0.1, player.duration / 4)
            let beforeRate = player.currentTime
            player.rate = 1.6
            guard abs(player.currentTime - beforeRate) < 0.005 else { return false }
            engine.player = player
            engine.fullText = "晋太元中，武陵人捕鱼为业。"
            engine.chunks = ReaderSpeechChunk.split(engine.fullText, fromUTF16: 0)
            engine.cancellation = cancellation
            var unexpectedCompletion = false
            engine.onFinish = { unexpectedCompletion = true }
            guard engine.resume(), player.isPlaying else { return false }
            try await Task.sleep(nanoseconds: 40_000_000)
            engine.pause()
            let pausedTime = player.currentTime
            engine.setRate(0.8)
            try await Task.sleep(nanoseconds: 30_000_000)
            guard !player.isPlaying, abs(player.currentTime - pausedTime) < 0.005 else { return false }
            guard engine.resume(), player.isPlaying else { return false }
            let oldGeneration = engine.generation
            engine.stop()
            engine.audioPlayerDidFinishPlaying(player, successfully: true)
            await Task.yield()
            guard cancellation.isCancelled, oldGeneration != engine.generation,
                  !player.isPlaying, engine.player == nil, !unexpectedCompletion else { return false }
            do {
                _ = try await engine.worker.generate("此任务已取消。", cancellation: cancellation)
                return false
            } catch is CancellationError { /* Expected before native generation. */ }
            let chapter = "晋太元中，武陵人捕鱼为业。\n缘溪行，忘路之远近。"
            var completed = false
            var failed = false
            var positions: [Int] = []
            engine.chunkWaits = []
            engine.play(text: chapter, offset: 0, rate: 1.8, onPosition: { positions.append($0) }, onFinish: { completed = true }, onError: { _ in failed = true })
            let deadline = Date().addingTimeInterval(35)
            while !completed && !failed && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
            guard completed, !failed, positions.last == (chapter as NSString).length,
                  zip(positions, positions.dropFirst()).allSatisfy({ $0 <= $1 }) else { return false }
            print(String(format: "QINGREAD_AI_CONTINUITY engine=%@ voice=%d paragraphs=2 completed=passed maxFollowingWait=%.3f", kind.rawValue, voiceID, engine.chunkWaits.dropFirst().max() ?? 0))
            print(String(format: "QINGREAD_AI_SELFTEST engine=%@ voice=%d synthesisSeconds=%.3f sampleRate=%d samples=%d finite=passed ratePosition=passed pauseResume=passed staleCallbacks=passed cancellation=passed", kind.rawValue, voiceID, elapsed, audio.sampleRate, audio.sampleCount))
            return true
        } catch {
            print("QINGREAD_AI_SELFTEST failed: \(error.localizedDescription)")
            return false
        }
    }
    #endif

    deinit {
        timer?.invalidate(); cancellation?.cancel(); task?.cancel(); pendingAudio.values.forEach { $0.cancel() }
        player?.stop()
        worker.clear()
    }
}
