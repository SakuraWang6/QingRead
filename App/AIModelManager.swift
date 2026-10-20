import Foundation
import CryptoKit
import Combine

struct AIModelFile: Sendable {
    let name: String
    let bytes: Int64
    let sha256: String
}

/// Optional assets, downloaded only by an explicit tap. Text and generated
/// speech never leave the phone. A partial or corrupt model is never selected.
@MainActor
final class AIModelManager: ObservableObject {
    enum State: Equatable { case missing, downloading(progress: Double), ready, failed(String) }
    static let shared = AIModelManager()
    @Published private(set) var state: State = .missing

    nonisolated static let files: [AIModelFile] = [
        .init(name: "model.int8.onnx", bytes: 53_517_430, sha256: "f085f5079e05f039b800aeb542f5253c26a303211b0c6465d0d9387977855a63"),
        .init(name: "lexicon.txt", bytes: 6_837_671, sha256: "7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528"),
        .init(name: "tokens.txt", bytes: 655, sha256: "d18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d"),
        .init(name: "date.fst", bytes: 59_154, sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718"),
        .init(name: "number.fst", bytes: 64_482, sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd"),
        .init(name: "LICENSE", bytes: 1053, sha256: "88a50e5a02bbc2a5c2f084dc19da751aa97b1690f5fda76cd8005c8634d1ca70")
    ]
    nonisolated static let modelRevision = "a0d5c6a264c0ef92d70d8661d8cc502d79627cd6"
    private let root: URL
    private let files: [AIModelFile]
    private let baseURL: URL
    private let session: URLSession
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private static var activeStages: Set<String> = []
    private var stagePrefix: String { ".\(root.lastPathComponent)-download-" }
    private var manifestStamp: String { files.map { "\($0.name):\($0.bytes):\($0.sha256)" }.joined(separator: "\n") }

    init(root: URL? = nil, files: [AIModelFile] = AIModelManager.files, baseURL: URL? = nil, session: URLSession? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("QingRead/VoiceModels/Melo-int8", isDirectory: true)
        self.files = files
        self.baseURL = baseURL ?? URL(string: "https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/resolve/\(Self.modelRevision)/")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.allowsCellularAccess = false
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 600
        self.session = session ?? URLSession(configuration: configuration)
        cleanupAbandonedDownloads()
        if isComplete { state = .ready }
    }

    var readyDirectory: URL? { state == .ready && isComplete ? root : nil }

    func download() {
        if case .downloading = state { return }
        let token = UUID()
        generation = token
        state = .downloading(progress: 0)
        cleanupAbandonedDownloads()
        let stage = root.deletingLastPathComponent().appendingPathComponent(stagePrefix + token.uuidString, isDirectory: true)
        Self.activeStages.insert(stage.path)
        let total = max(1, files.reduce(Int64(0)) { $0 + $1.bytes })
        task = Task { [weak self] in
            guard let self else { return }
            defer {
                Self.activeStages.remove(stage.path)
                try? FileManager.default.removeItem(at: stage)
            }
            do {
                try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
                var stageValues = URLResourceValues()
                stageValues.isExcludedFromBackup = true
                var stageDirectory = stage
                try? stageDirectory.setResourceValues(stageValues)
                var complete: Int64 = 0
                for file in self.files {
                    try Task.checkCancellation()
                    let previous = complete
                    let progress = AIModelDownloadProgress { [weak self] written in
                        Task { @MainActor in
                            guard let self, self.generation == token else { return }
                            guard case .downloading = self.state else { return }
                            self.state = .downloading(progress: min(0.999, Double(previous + min(file.bytes, written)) / Double(total)))
                        }
                    }
                    var request = URLRequest(url: self.baseURL.appendingPathComponent(file.name))
                    request.setValue("QingRead/0.3", forHTTPHeaderField: "User-Agent")
                    let (temporary, response) = try await self.session.download(for: request, delegate: progress)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw ModelError.unavailable }
                    let destination = stage.appendingPathComponent(file.name)
                    try FileManager.default.moveItem(at: temporary, to: destination)
                    try await Task.detached(priority: .utility) { try Self.validate(destination, file: file) }.value
                    try Task.checkCancellation()
                    complete += file.bytes
                }
                guard self.generation == token else { throw CancellationError() }
                try Data(self.manifestStamp.utf8).write(to: stage.appendingPathComponent("verified.txt"), options: .atomic)
                if FileManager.default.fileExists(atPath: self.root.path) { try FileManager.default.removeItem(at: self.root) }
                try FileManager.default.moveItem(at: stage, to: self.root)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var root = self.root
                try? root.setResourceValues(values)
                self.state = .ready
            } catch {
                guard self.generation == token else { return }
                if error is CancellationError { self.state = .missing }
                else { self.state = .failed("声库下载未完成。请确认 Wi‑Fi 可访问 Hugging Face 后重试。\n\(error.localizedDescription)") }
            }
            if self.generation == token { self.task = nil }
        }
    }

    func cancelDownload() {
        generation = UUID()
        task?.cancel()
        task = nil
        state = isComplete ? .ready : .missing
    }

    func remove() {
        cancelDownload()
        do {
            if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
            state = .missing
        } catch { state = .failed("声库删除失败：\(error.localizedDescription)") }
    }

    private func cleanupAbandonedDownloads() {
        let parent = root.deletingLastPathComponent()
        let candidates = (try? FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])) ?? []
        for url in candidates where url.lastPathComponent.hasPrefix(stagePrefix) && !Self.activeStages.contains(url.path) {
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if values?.isDirectory == true, values?.isSymbolicLink != true { try? FileManager.default.removeItem(at: url) }
        }
    }

    private var isComplete: Bool {
        guard (try? String(contentsOf: root.appendingPathComponent("verified.txt"), encoding: .utf8)) == manifestStamp else { return false }
        return files.allSatisfy { file in
            let values = try? root.appendingPathComponent(file.name).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            return values?.isRegularFile == true && values?.isSymbolicLink != true && Int64(values?.fileSize ?? -1) == file.bytes
        }
    }

    nonisolated static func validate(_ url: URL, file: AIModelFile) throws {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, Int64(values.fileSize ?? -1) == file.bytes else { throw ModelError.integrity }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while let chunk = try handle.read(upToCount: 1_024 * 1_024), !chunk.isEmpty {
            try Task.checkCancellation()
            digest.update(data: chunk)
        }
        let actual = digest.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == file.sha256 else { throw ModelError.integrity }
    }

    private enum ModelError: LocalizedError {
        case unavailable, integrity
        var errorDescription: String? {
            switch self {
            case .unavailable: return "下载服务器暂时不可用。"
            case .integrity: return "文件大小或 SHA‑256 校验未通过，已丢弃不完整声库。"
            }
        }
    }
}

private final class AIModelDownloadProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let update: @Sendable (Int64) -> Void
    init(update: @escaping @Sendable (Int64) -> Void) { self.update = update }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) { update(totalBytesWritten) }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) { }
}
