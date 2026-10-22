import Foundation
import UIKit
import ReadingCore

enum BackgroundChapterDownloadError: LocalizedError {
    case rateLimited
    var errorDescription: String? { "服务器繁忙，下载已暂停，请稍后继续。" }
}

/// The OS owns transfers; the manifest owns their account and logical-book scope.
/// Download callbacks never write directly into the currently selected account.
@MainActor final class BackgroundChapterDownloads: NSObject, URLSessionDownloadDelegate {
    static let identifier = "app.qingread.chapter-downloads.v1"
    private let directory: URL
    private var records: [UUID: BackgroundChapterTransfer] = [:]
    private var completionHandler: (() -> Void)?
    private var pendingCallbacks = 0
    private var finishedEvents = false
    private var restoration = UUID()
    private(set) var ready = false
    var request: ((Book, [Chapter]) throws -> URLRequest)?
    var receive: ((BackgroundChapterTransfer, Result<BackgroundChapterBatch, Error>) -> Void)?
    var restored: (([BackgroundChapterTransfer]) -> Void)?
    var changed: (() -> Void)?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()
    init(directory: URL) {
        self.directory = directory
        super.init()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            if let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")) {
                let saved = try JSONDecoder().decode([BackgroundChapterTransfer].self, from: data)
                records = Dictionary(saved.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            }
        } catch { /* Jobs remain paused if a transfer manifest cannot be restored. */ }
    }
    var transfers: [BackgroundChapterTransfer] { Array(records.values) }
    func restore() {
        ready = false
        let revision = UUID(); restoration = revision
        session.getAllTasks { tasks in
            DispatchQueue.main.async {
                guard self.restoration == revision else { return }
                let active = Set(tasks.compactMap { $0.taskDescription.flatMap(UUID.init(uuidString:)) })
                for task in tasks where task.taskDescription.flatMap(UUID.init(uuidString:)).flatMap({ self.records[$0] }) == nil { task.cancel() }
                for record in self.records.values where !active.contains(record.id) && !FileManager.default.fileExists(atPath: self.spool(record.id).path) { self.records.removeValue(forKey: record.id) }
                self.persist(); self.ready = true
                self.restored?(self.transfers)
                for record in self.transfers where FileManager.default.fileExists(atPath: self.spool(record.id).path) { self.consume(record, at: self.spool(record.id)) }
                self.changed?()
            }
        }
    }
    func handleEvents(completion: @escaping () -> Void) {
        completionHandler = completion; finishedEvents = false
        _ = session
    }
    /// Persist descriptions before starting any request, so relaunch can reconnect.
    func submit(_ values: [BackgroundChapterTransfer]) throws {
        guard ready else { return }
        let prepared = try values.map { value -> (BackgroundChapterTransfer, URLRequest) in
            guard let request else { throw AppError.message("请先配置下载服务器。") }
            return (value, try request(value.book, value.chapters))
        }
        for (value, _) in prepared { records[value.id] = value }
        do { try saveManifest() }
        catch { for (value, _) in prepared { records.removeValue(forKey: value.id) }; throw error }
        for (value, request) in prepared {
            resume(value, request: request)
        }
    }
    private func resume(_ value: BackgroundChapterTransfer, request: URLRequest) {
        let task = session.downloadTask(with: request)
        task.taskDescription = value.id.uuidString
        task.earliestBeginDate = value.notBefore
        task.resume()
    }
    private func retryThrottled(_ record: BackgroundChapterTransfer, response: HTTPURLResponse) {
        guard records[record.id] != nil else { return }
        var delayed = record
        var retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
        if retryAfter == nil, let value = response.value(forHTTPHeaderField: "Retry-After") {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
            retryAfter = formatter.date(from: value)?.timeIntervalSinceNow
        }
        guard delayed.deferForThrottling(retryAfter: retryAfter) else { fail(record, error: BackgroundChapterDownloadError.rateLimited); return }
        do {
            guard let request else { throw AppError.message("请先配置下载服务器。") }
            let prepared = try request(delayed.book, delayed.chapters)
            records[record.id] = delayed
            try saveManifest()
            resume(delayed, request: prepared)
        } catch { fail(record, error: error) }
    }
    func cancel(jobID: UUID? = nil, scope: String) {
        let ids = Set(records.values.filter { $0.profileScope == scope && (jobID == nil || $0.jobID == jobID) }.map(\.id))
        guard !ids.isEmpty else { return }
        for id in ids { records.removeValue(forKey: id); try? FileManager.default.removeItem(at: spool(id)) }
        persist()
        session.getAllTasks { tasks in
            for task in tasks where task.taskDescription.flatMap(UUID.init(uuidString:)).map(ids.contains) == true { task.cancel() }
        }
    }
    func retain(scope: String) {
        for old in Set(records.values.map(\.profileScope)) where old != scope { cancel(scope: old) }
    }
    private func spool(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".json") }
    private func saveManifest() throws {
        let data = try JSONEncoder().encode(transfers)
        try data.write(to: directory.appendingPathComponent("manifest.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func persist() { try? saveManifest() }
    private func consume(_ record: BackgroundChapterTransfer, at url: URL) {
        guard records[record.id] != nil else { try? FileManager.default.removeItem(at: url); return }
        let result: Result<BackgroundChapterBatch, Error>
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= 5 * 1024 * 1024 else { throw AppError.message("下载响应为空或超过 5 MB。") }
            result = .success(try JSONDecoder().decode(BackgroundChapterBatch.self, from: Data(contentsOf: url)))
        } catch { result = .failure(error) }
        receive?(record, result)
        records.removeValue(forKey: record.id); try? FileManager.default.removeItem(at: url); persist()
        changed?()
    }
    private func fail(_ record: BackgroundChapterTransfer, error: Error) {
        guard records.removeValue(forKey: record.id) != nil else { return }
        persist(); receive?(record, .failure(error)); changed?()
    }
    private func finishEventsIfReady() {
        guard finishedEvents, pendingCallbacks == 0, let completionHandler else { return }
        self.completionHandler = nil; finishedEvents = false
        completionHandler()
    }
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temporary file disappears when this delegate method returns.
        guard let id = downloadTask.taskDescription.flatMap(UUID.init(uuidString:)) else { return }
        let owned = FileManager.default.temporaryDirectory.appendingPathComponent("qingread-background-" + id.uuidString)
        let response = downloadTask.response as? HTTPURLResponse
        do {
            try? FileManager.default.removeItem(at: owned)
            try FileManager.default.moveItem(at: location, to: owned)
            DispatchQueue.main.async {
                self.pendingCallbacks += 1
                defer { self.pendingCallbacks -= 1; self.finishEventsIfReady() }
                guard let record = self.records[id] else { try? FileManager.default.removeItem(at: owned); return }
                if let response, response.statusCode == 429 {
                    try? FileManager.default.removeItem(at: owned)
                    self.retryThrottled(record, response: response); return
                }
                guard let response, (200..<300).contains(response.statusCode) else {
                    try? FileManager.default.removeItem(at: owned)
                    self.fail(record, error: AppError.message(response?.statusCode == 401 ? "请重新登录后继续下载。" : "下载暂时不可用（\(response?.statusCode ?? 0)）。")); return
                }
                do {
                    let destination = self.spool(id)
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: owned, to: destination)
                    self.consume(record, at: destination)
                } catch { self.fail(record, error: error) }
            }
        } catch {
            DispatchQueue.main.async { if let record = self.records[id] { self.fail(record, error: error) } }
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let id = task.taskDescription.flatMap(UUID.init(uuidString:)) else { return }
        DispatchQueue.main.async { if let record = self.records[id] { self.fail(record, error: error) } }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { self.finishedEvents = true; self.finishEventsIfReady() }
    }
}
