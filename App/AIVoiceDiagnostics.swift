#if DEBUG
import Foundation
import CryptoKit

@MainActor enum AIVoiceDiagnostics {
    static func run(downloadModel: Bool) async {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("QingRead-model-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let data = Data("diagnostic model integrity".utf8)
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let file = AIModelFile(name: "test-model", bytes: Int64(data.count), sha256: digest)
            let abandoned = root.deletingLastPathComponent().appendingPathComponent(".\(root.lastPathComponent)-download-abandoned")
            try FileManager.default.createDirectory(at: abandoned, withIntermediateDirectories: true)
            let url = root.appendingPathComponent(file.name)
            try data.write(to: url)
            try AIModelManager.validate(url, file: file)
            let stamp = "\(file.name):\(file.bytes):\(file.sha256)"
            try Data(stamp.utf8).write(to: root.appendingPathComponent("verified.txt"))
            let complete = AIModelManager(root: root, files: [file])
            assert(!FileManager.default.fileExists(atPath: abandoned.path))
            assert(complete.readyDirectory == root)
            try Data(repeating: 0, count: data.count).write(to: url)
            do {
                try AIModelManager.validate(url, file: file)
                assertionFailure("A corrupt model must be rejected")
            } catch { }
            try data.dropLast().write(to: url)
            assert(AIModelManager(root: root, files: [file]).readyDirectory == nil)
            print("QINGREAD_AI_MODEL_SELFTEST checksum=passed incomplete=passed manifest=passed")
        } catch { assertionFailure("AI model integrity diagnostics failed: \(error)") }
        let manager = AIModelManager.shared
        if downloadModel && manager.readyDirectory == nil {
            manager.download()
            while case .downloading = manager.state {
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        guard let directory = manager.readyDirectory else {
            print("QINGREAD_AI_SYNTHESIS_SELFTEST skipped=modelUnavailable state=\(manager.state)")
            return
        }
        let passed = await OfflineSpeechEngine.runDiagnostics(modelDirectory: directory)
        assert(passed, "Real offline AI synthesis must produce valid audio")
    }
}
#endif
