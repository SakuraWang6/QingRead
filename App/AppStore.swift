import Foundation
import SwiftUI
import CryptoKit
import ReadingCore
import PDFKit

enum ChapterCacheState { case uncached, loading, cached }

private struct SavedSources: Codable {
    var imported: [SourceDefinition] = []
    var disabledIDs: Set<String> = []
}

@MainActor
final class AppStore: ObservableObject {
    @Published private(set) var shelf: [ShelfEntry] = []
    @Published private(set) var sources: [SourceDefinition] = SourceDefinition.builtIn
    @Published private(set) var disabledSourceIDs: Set<String> = []
    @Published private(set) var settings = ReaderSettings()
    @Published private(set) var cacheRevision = 0
    @Published private(set) var profileRevision = 0
    @Published private(set) var importedBooks: [String: ImportedBookRecord] = [:]
    @Published var storageMessage: String?
    @Published private(set) var notificationPreferences = ReadingNotificationPreferences()
    @Published var notificationBook: Book?
    @Published private(set) var updateTracking: [String: BookUpdateTracking] = [:]
    @Published private(set) var checkingUpdates = false
    @Published private(set) var downloads: [ChapterDownloadTask] = []
    private var updateCheckTask: Task<Void, Never>?
    private var downloadWorker: Task<Void, Never>?
    private var downloadWorkerID: UUID?
    private var workflowGeneration = UUID()
    private var endCheckTimes: [String: Date] = [:]
    private var backgroundDownloads: BackgroundChapterDownloads?

    lazy var cloud = NativeCloudSync(store: self)

    private var importedSources: [SourceDefinition] = []
    private let guestRoot: URL
    private var root: URL
    private var cacheRoot: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var chapterProgresses: [String: [String: Double]] = [:]
    private struct ContentRequest {
        let id: UUID
        let bookID: String
        let task: Task<ChapterContent, Error>
        var downloadOnly: Bool
    }
    private var contentRequests: [String: ContentRequest] = [:]
    private var prefetchTask: Task<Void, Never>?
    private var prefetchBookID: String?
    private let contentClient: any HTTPClient
    private var cacheGeneration = UUID()
    private var bookCacheGenerations: [String: UUID] = [:]

    init(storageRoot: URL? = nil, client: any HTTPClient = URLSessionHTTPClient()) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        guestRoot = storageRoot ?? base.appendingPathComponent("QingRead", isDirectory: true)
        root = guestRoot
        cacheRoot = root.appendingPathComponent("ChapterCache", isDirectory: true)
        contentClient = client
        encoder.outputFormatting = [.sortedKeys]
        loadProfileStorage()
    }

    private func loadProfileStorage() {
        updateTracking=[:];downloads=[];checkingUpdates=false;notificationPreferences=ReadingNotificationPreferences();notificationBook=nil;
        shelf=[];importedBooks=[:];importedSources=[];disabledSourceIDs=[];chapterProgresses=[:];settings=ReaderSettings();sources=SourceDefinition.builtIn
        do {
            try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
            shelf = try read([ShelfEntry].self, name: "library.json") ?? []
            importedBooks = try read([String: ImportedBookRecord].self, name: "imported-books.json") ?? [:]
            let library = root.appendingPathComponent("ImportedBooks", isDirectory: true)
            for url in (try? FileManager.default.contentsOfDirectory(at: library, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent.hasPrefix(".import-") {
                try? FileManager.default.removeItem(at: url)
            }
            if let saved = try read(SavedSources.self, name: "sources.json") {
                importedSources = saved.imported
                disabledSourceIDs = saved.disabledIDs
                rebuildSources()
            }
            settings = try read(ReaderSettings.self, name: "reader-settings.json") ?? ReaderSettings()
            chapterProgresses = try read([String: [String: Double]].self, name: "chapter-progress.json") ?? [:]
            notificationPreferences = try read(ReadingNotificationPreferences.self, name: "notification-preferences.json") ?? ReadingNotificationPreferences()
            updateTracking = try read([String: BookUpdateTracking].self, name: "update-tracking.json") ?? [:]
            downloads = try read([ChapterDownloadTask].self, name: "chapter-downloads.json") ?? []
            for index in downloads.indices where [.running, .queued].contains(downloads[index].status) && downloads[index].backgroundManaged != true { downloads[index].status = .paused }
            persistDownloads()
            // A legacy position proves only that specific chapter was visited.
            for entry in shelf {
                if let position = entry.position, chapterProgresses[entry.id]?[position.chapterID] == nil {
                    chapterProgresses[entry.id, default: [:]][position.chapterID] = min(1, max(0, position.chapterFraction))
                }
            }
            settings.fontSize = min(34, max(16, settings.fontSize))
            settings.lineSpacing = min(22, max(4, settings.lineSpacing))
        } catch {
            storageMessage = "读取本地资料失败：\(error.localizedDescription)。原文件保留在应用的本地目录。"
        }
    }

    func selectCloudProfile(_ key: String?) throws {
        ReadingNotifications.shared.clear(scope: backgroundProfileScope)
        profileRevision += 1
        stopProfileWorkflows();cacheGeneration=UUID();prefetchTask?.cancel();cancelContentRequests()
        root=key.map { guestRoot.appendingPathComponent("Accounts/"+stableKey($0),isDirectory:true) } ?? guestRoot
        cacheRoot=root.appendingPathComponent("ChapterCache",isDirectory:true)
        try FileManager.default.createDirectory(at:cacheRoot,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        loadProfileStorage();cacheRevision += 1
        QingReadApplicationDelegate.scheduleRefresh(enabled: notificationPreferences.updates)
        backgroundDownloads?.restore()
    }
    func loadCloudState() throws -> NativeCloudLocalState { try read(NativeCloudLocalState.self,name:"cloud-state.json") ?? NativeCloudLocalState() }
    func saveCloudState(_ value: NativeCloudLocalState) throws { try encoder.encode(value).write(to:root.appendingPathComponent("cloud-state.json"),options:.atomic) }
    func replaceCloudShelf(_ value: [ShelfEntry]) throws {
        try encoder.encode(value).write(to:root.appendingPathComponent("library.json"),options:.atomic)
        for old in shelf {
            if let incoming = value.first(where: { $0.id == old.id }) {
                if sourceFingerprint(old.book) != sourceFingerprint(incoming.book) { invalidateSourceCache(old.book) }
            } else { invalidateSourceCache(old.book) }
        }
        shelf=value
        for entry in value { if let p=entry.position { chapterProgresses[entry.id,default:[:]][p.chapterID]=max(chapterProgresses[entry.id]?[p.chapterID] ?? 0,p.chapterFraction) } }
        persist(chapterProgresses,name:"chapter-progress.json")
    }
    func mergeGuestLibrary() throws {
        guard root != guestRoot else { return }
        let source=guestRoot.appendingPathComponent("library.json")
        guard FileManager.default.fileExists(atPath:source.path) else { return }
        let entries=try decoder.decode([ShelfEntry].self,from:Data(contentsOf:source))
        let importURL=guestRoot.appendingPathComponent("imported-books.json")
        let imports=FileManager.default.fileExists(atPath:importURL.path) ? try decoder.decode([String:ImportedBookRecord].self,from:Data(contentsOf:importURL)) : [:]
        for entry in entries {
            var book=entry.book
            if let imported=imports[book.id] {
                let original=guestRoot.appendingPathComponent("ImportedBooks/"+stableKey(book.id),isDirectory:true),destination=importedDirectory(book)
                if !FileManager.default.fileExists(atPath:destination.path) && FileManager.default.fileExists(atPath:original.path) {
                    try FileManager.default.createDirectory(at:destination.deletingLastPathComponent(),withIntermediateDirectories:true)
                    let stage=destination.deletingLastPathComponent().appendingPathComponent(".import-"+UUID().uuidString,isDirectory:true)
                    do { try FileManager.default.copyItem(at:original,to:stage);try FileManager.default.moveItem(at:stage,to:destination) }
                    catch { try? FileManager.default.removeItem(at:stage);throw error }
                }
                importedBooks[book.id]=imported
                if book.fileHash==nil,let url=publicationURL(for:book),let handle=try? FileHandle(forReadingFrom:url) {
                    defer { try? handle.close() }
                    var hash=SHA256()
                    while let data=try handle.read(upToCount:1024*1024),!data.isEmpty { hash.update(data:data) }
                    book=book.withFileHash(hash.finalize().map { String(format:"%02x",$0) }.joined())
                }
            }
            let merged=ShelfEntry(book:book,position:entry.position,addedAt:entry.addedAt,organization:entry.organization,annotations:entry.annotations)
            if let index=shelf.firstIndex(where:{$0.id==book.id}) {
                if (merged.position?.updatedAt ?? merged.addedAt) > (shelf[index].position?.updatedAt ?? shelf[index].addedAt) {
                    var combined = merged; combined.mergeMetadata(from: shelf[index]); shelf[index] = combined
                } else { shelf[index].mergeMetadata(from: merged) }
            } else { shelf.append(merged) }
            cloud.localChanged(.add,book:book)
        }
        persist(importedBooks,name:"imported-books.json");persist(shelf,name:"library.json")
    }

    var enabledSourceIDs: Set<String> { Set(sources.map(\.id)).subtracting(disabledSourceIDs) }
    var recentEntry: ShelfEntry? {
        shelf.filter { $0.position != nil }.max { ($0.position?.updatedAt ?? .distantPast) < ($1.position?.updatedAt ?? .distantPast) }
    }
    var sortedShelf: [ShelfEntry] {
        shelf.sorted {
            if ($0.organization?.pinned ?? false) != ($1.organization?.pinned ?? false) { return $0.organization?.pinned == true }
            return ($0.position?.updatedAt ?? $0.addedAt) > ($1.position?.updatedAt ?? $1.addedAt)
        }
    }

    func isSaved(_ book: Book) -> Bool { shelf.contains { $0.id == book.id } }
    func position(for book: Book) -> ReadingPosition? { shelf.first { $0.id == book.id }?.position }

    func add(_ book: Book) {
        guard !isSaved(book) else { return }
        shelf.append(ShelfEntry(book: book, position: nil, addedAt: Date()))
        cloud.localChanged(.add, book: book)
        persist(shelf, name: "library.json")
    }

    func remove(_ book: Book) {
        cancelDownloads(for: book.id)
        updateTracking.removeValue(forKey: book.id); persist(updateTracking, name: "update-tracking.json")
        bookCacheGenerations[book.id] = UUID()
        cancelPrefetch(for: book)
        cancelContentRequests(for: book.id)
        shelf.removeAll { $0.id == book.id }
        cloud.localChanged(.remove, book: book)
        persist(shelf, name: "library.json")
        chapterProgresses.removeValue(forKey: book.id)
        persist(chapterProgresses, name: "chapter-progress.json")
        if importedBooks.removeValue(forKey: book.id) != nil {
            try? FileManager.default.removeItem(at: importedDirectory(book))
            persist(importedBooks, name: "imported-books.json")
        }
        do {
            let directory = bookCacheDirectory(book)
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            cacheRevision += 1
        } catch { storageMessage = "书架已移除，但该书缓存删除失败：\(error.localizedDescription)" }
    }

    func savePosition(book: Book, chapter: Chapter, index: Int, characterOffset: Int, fraction: Double) {
        if let current = shelf.first(where: { $0.id == book.id }), sourceFingerprint(current.book) != sourceFingerprint(book) { return }
        let position = ReadingPosition(chapterID: chapter.id, chapterIndex: index,
                                       characterOffset: max(0, characterOffset),
                                       chapterFraction: min(1, max(0, fraction)), updatedAt: Date())
        if let item = shelf.firstIndex(where: { $0.id == book.id }) {
            shelf[item].position = position
        } else {
            shelf.append(ShelfEntry(book: book, position: position, addedAt: Date()))
        }
        cloud.localChanged(.progress, book: book)
        persist(shelf, name: "library.json")
        let furthest = max(chapterProgresses[book.id]?[chapter.id] ?? 0, position.chapterFraction)
        chapterProgresses[book.id, default: [:]][chapter.id] = furthest
        persist(chapterProgresses, name: "chapter-progress.json")
        acknowledgeUpdates(book: book, through: index)
    }

    func chapterProgress(for chapter: Chapter, in book: Book) -> Double? { chapterProgresses[book.id]?[chapter.id] }

    func markChapterCompleted(_ chapter: Chapter, in book: Book) {
        chapterProgresses[book.id, default: [:]][chapter.id] = 1
        persist(chapterProgresses, name: "chapter-progress.json")
        cacheRevision += 1
    }

    func updateSettings(_ updated: ReaderSettings) {
        settings = updated
        persist(settings, name: "reader-settings.json")
    }

    func setEnabled(_ enabled: Bool, source: SourceDefinition) {
        if enabled { disabledSourceIDs.remove(source.id) } else {
            disabledSourceIDs.insert(source.id)
            for id in downloads.filter({ $0.book.sourceID == source.id && [.queued, .running].contains($0.status) }).map(\.id) { pauseDownload(id) }
        }
        persistSources()
    }

    func importSources(data: Data) throws -> Int {
        let definitions = try SourceImporter.decode(data)
        let builtInIDs = Set(SourceDefinition.builtIn.map(\.id))
        guard !definitions.contains(where: { builtInIDs.contains($0.id) }) else {
            throw AppError.message("导入项与内置书源 ID 重复，请更换该书源的 ID 后重试。")
        }
        for source in definitions {
            importedSources.removeAll { $0.id == source.id }
            importedSources.append(source)
            disabledSourceIDs.remove(source.id)
        }
        rebuildSources()
        persistSources()
        return definitions.count
    }

    func isBuiltIn(_ source: SourceDefinition) -> Bool { SourceDefinition.builtIn.contains { $0.id == source.id } }

    func removeSource(_ source: SourceDefinition) {
        guard !isBuiltIn(source) else { return }
        for id in downloads.filter({ $0.book.sourceID == source.id && [.queued, .running].contains($0.status) }).map(\.id) { pauseDownload(id) }
        importedSources.removeAll { $0.id == source.id }
        disabledSourceIDs.remove(source.id)
        rebuildSources()
        persistSources()
    }

    func search(_ query: String, onUpdate: @escaping @MainActor @Sendable (SearchResponse) -> Void = { _ in }) async -> SearchResponse {
        await ReadingService(sources: sources).search(query: query, enabledSourceIDs: enabledSourceIDs) { response in
            await onUpdate(response)
        }
    }

    func chapters(for book: Book, refresh: Bool = false) async throws -> [Chapter] {
        if book.id == LocalSample.book.id { return LocalSample.chapters }
        if importedBooks[book.id] != nil {
            return try decoder.decode([Chapter].self, from: Data(contentsOf: importedDirectory(book).appendingPathComponent("catalog.json")))
        }
        let cache = bookCacheDirectory(book).appendingPathComponent("catalog.json")
        if !refresh, let chapters = try? decoder.decode([Chapter].self, from: Data(contentsOf: cache)), !chapters.isEmpty { return chapters }
        let previous = try? decoder.decode([Chapter].self, from: Data(contentsOf: cache))
        let generation = cacheGeneration
        let bookGeneration = bookCacheGenerations[book.id]
        let chapters = try await ReadingService(sources: sources, client: contentClient).chapters(for: book)
        try Task.checkCancellation()
        guard cacheGeneration == generation, bookCacheGenerations[book.id] == bookGeneration else { throw CancellationError() }
        guard !chapters.isEmpty else { throw AppError.message("来源没有返回可读章节。") }
        if isSaved(book), book.publicationFormat == nil {
            var tracking = updateTracking[book.id] ?? BookUpdateTracking()
            let alreadyMarked = Set(tracking.newChapterIDs)
            tracking.refreshed(chapters, previous: previous, readIndex: position(for: book)?.chapterIndex)
            updateTracking[book.id] = tracking; persist(updateTracking, name: "update-tracking.json")
            let newlyAdded = tracking.newChapterIDs.filter { !alreadyMarked.contains($0) }.count
            if notificationPreferences.updates && newlyAdded > 0 { ReadingNotifications.shared.post(scope: backgroundProfileScope, book: book, kind: "updates", body: "更新 \(newlyAdded) 章") }
        }
        do { try writeCache(chapters, to: cache) }
        catch { storageMessage = "目录已获取，但离线保存失败：\(error.localizedDescription)" }
        return chapters
    }

    func cachedContent(for chapter: Chapter, in book: Book) -> ChapterContent? {
        if book.id == LocalSample.book.id { return LocalSample.content }
        let url = importedBooks[book.id] != nil ? importedDirectory(book).appendingPathComponent("chapter-\(chapter.index).json") : contentURL(chapter: chapter, book: book)
        guard let data = try? Data(contentsOf: url), let content = try? decoder.decode(ChapterContent.self, from: data), !content.paragraphs.isEmpty else { return nil }
        return content
    }

    func content(for chapter: Chapter, in book: Book, forDownload: Bool = false) async throws -> ChapterContent {
        if book.id == LocalSample.book.id { return LocalSample.content }
        if importedBooks[book.id] != nil {
            return try decoder.decode(ChapterContent.self, from: Data(contentsOf: importedDirectory(book).appendingPathComponent("chapter-\(chapter.index).json")))
        }
        let cache = contentURL(chapter: chapter, book: book)
        if let content = try? decoder.decode(ChapterContent.self, from: Data(contentsOf: cache)), !content.paragraphs.isEmpty { return content }
        let key = cache.path
        if let existing = contentRequests[key] {
            if !forDownload { contentRequests[key]?.downloadOnly = false }
            let result = try await existing.task.value
            try Task.checkCancellation()
            return result
        }
        let id = UUID()
        let service = ReadingService(sources: sources, client: contentClient)
        let generation = cacheGeneration, bookGeneration = bookCacheGenerations[book.id]
        let task = Task { @MainActor [weak self] () throws -> ChapterContent in
            defer {
                if self?.contentRequests[key]?.id == id {
                    self?.contentRequests.removeValue(forKey: key)
                    self?.cacheRevision += 1
                }
            }
            let content = try await service.content(for: chapter, in: book)
            try Task.checkCancellation()
            guard let self, self.cacheGeneration == generation, self.bookCacheGenerations[book.id] == bookGeneration else { throw CancellationError() }
            do {
                try self.writeCache(content, to: cache)
                self.cacheRevision += 1
            } catch { self.storageMessage = "正文已获取，但离线保存失败：\(error.localizedDescription)" }
            return content
        }
        contentRequests[key] = ContentRequest(id: id, bookID: book.id, task: task, downloadOnly: forDownload)
        cacheRevision += 1
        let content = try await task.value
        try Task.checkCancellation()
        return content
    }

    func cacheState(for chapter: Chapter, in book: Book) -> ChapterCacheState {
        if hasCachedContent(for: chapter, in: book) { return .cached }
        return contentRequests[contentURL(chapter: chapter, book: book).path] == nil ? .uncached : .loading
    }

    /// A small sequential look-ahead, never a whole-book crawl. Foreground loads
    /// share requests with this queue instead of downloading a chapter twice.
    func prefetchChapters(after index: Int, chapters: [Chapter], in book: Book, count: Int = 10) {
        prefetchTask?.cancel()
        prefetchBookID = book.id
        guard book.id != LocalSample.book.id, chapters.indices.contains(index), enabledSourceIDs.contains(book.sourceID) else { return }
        let upcoming = Array(chapters.dropFirst(index + 1).prefix(min(10, max(0, count))))
        prefetchTask = Task { @MainActor [weak self] in
            for chapter in upcoming {
                guard !Task.isCancelled, let self, self.enabledSourceIDs.contains(book.sourceID) else { return }
                if self.hasCachedContent(for: chapter, in: book) { continue }
                do { _ = try await self.content(for: chapter, in: book) }
                catch is CancellationError { return }
                catch { return } // An unavailable source must not cause repeated background traffic.
            }
        }
    }

    func cancelPrefetch(for book: Book) {
        guard prefetchBookID == book.id else { return }
        prefetchTask?.cancel()
        prefetchTask = nil
        prefetchBookID = nil
    }

    private func cancelContentRequests(for bookID: String? = nil) {
        for (key, request) in contentRequests where bookID == nil || request.bookID == bookID {
            request.task.cancel()
            contentRequests.removeValue(forKey: key)
        }
    }

    func cachedCount(for book: Book) -> Int {
        if let record = importedBooks[book.id] { return record.chapterCount }
        if book.id == LocalSample.book.id { return LocalSample.chapters.count }
        let urls = (try? FileManager.default.contentsOfDirectory(at: bookCacheDirectory(book), includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.lastPathComponent.hasPrefix("chapter-") && $0.pathExtension == "json" }.count
    }

    func hasCachedContent(for chapter: Chapter, in book: Book) -> Bool {
        if importedBooks[book.id] != nil { return FileManager.default.fileExists(atPath: importedDirectory(book).appendingPathComponent("chapter-\(chapter.index).json").path) }
        if book.id == LocalSample.book.id { return true }
        return FileManager.default.fileExists(atPath: contentURL(chapter: chapter, book: book).path)
    }

    func clearCache() {
        stopAllDownloads()
        updateCheckTask?.cancel(); updateCheckTask = nil; checkingUpdates = false
        cacheGeneration = UUID()
        prefetchTask?.cancel()
        prefetchTask = nil
        cancelContentRequests()
        do {
            if FileManager.default.fileExists(atPath: cacheRoot.path) { try FileManager.default.removeItem(at: cacheRoot) }
            try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
            cacheRevision += 1
        } catch { storageMessage = "清理缓存失败：\(error.localizedDescription)" }
    }

    var cacheSizeDescription: String {
        guard let enumerator = FileManager.default.enumerator(at: cacheRoot, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return "0 KB" }
        var size: Int64 = 0
        for case let url as URL in enumerator {
            if let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), values.isRegularFile == true {
                size += Int64(values.fileSize ?? 0)
            }
        }
        return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    private func rebuildSources() {
        let builtInIDs = Set(SourceDefinition.builtIn.map(\.id))
        sources = SourceDefinition.builtIn + importedSources.filter { !builtInIDs.contains($0.id) }
    }
    private func persistSources() { persist(SavedSources(imported: importedSources, disabledIDs: disabledSourceIDs), name: "sources.json") }
    private func read<T: Decodable>(_ type: T.Type, name: String) throws -> T? {
        let url = root.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(type, from: Data(contentsOf: url))
    }
    private func persist<T: Encodable>(_ value: T, name: String) {
        do { try encoder.encode(value).write(to: root.appendingPathComponent(name), options: .atomic) }
        catch { storageMessage = "保存本地资料失败：\(error.localizedDescription)" }
    }
    private func writeCache<T: Encodable>(_ value: T, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(value).write(to: url, options: .atomic)
    }
    private func bookCacheDirectory(_ book: Book) -> URL { cacheRoot.appendingPathComponent(stableKey(book.id), isDirectory: true) }
    private func contentURL(chapter: Chapter, book: Book) -> URL { bookCacheDirectory(book).appendingPathComponent("chapter-\(stableKey(chapter.id)).json") }
    private func stableKey(_ string: String) -> String { SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined() }
}

struct ImportedBookRecord: Codable {
    let format: BookFileFormat
    let chapterCount: Int
}

extension AppStore {
    private func importedDirectory(_ book: Book) -> URL { root.appendingPathComponent("ImportedBooks/\(stableKey(book.id))", isDirectory: true) }
    func publicationURL(for book: Book) -> URL? {
        guard let record = importedBooks[book.id] else { return nil }
        let url = importedDirectory(book).appendingPathComponent("original.\(record.format.rawValue)")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    func importedCover(for book: Book) -> URL? {
        let url = importedDirectory(book).appendingPathComponent("cover.jpg")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private func saveImportedMetadata(_ book: Book) {
        if let index = shelf.firstIndex(where: { $0.id == book.id }) {
            guard let hash = book.fileHash, shelf[index].book.fileHash != hash else { return }
            let previous = shelf[index]
            shelf[index] = ShelfEntry(book: previous.book.withFileHash(hash), position: previous.position, addedAt: previous.addedAt, organization: previous.organization, annotations: previous.annotations)
            cloud.localChanged(.add, book: shelf[index].book)
            persist(shelf, name: "library.json")
        } else { add(book) }
    }

    func importPublication(at url: URL, format: BookFileFormat? = nil, metadata: Book? = nil) async throws -> Book {
        let format = format ?? BookFileFormat(rawValue: url.pathExtension.lowercased())
        guard let format else { throw AppError.message("请选择 EPUB、PDF 或 TXT 文件。") }
        let library = root.appendingPathComponent("ImportedBooks", isDirectory: true)
        let stage = library.appendingPathComponent(".import-" + UUID().uuidString, isDirectory: true)
        let importRoot = root
        let knownBooks = shelf.map(\.book)
        let prepared = try await Task.detached(priority: .userInitiated) { () throws -> (Book, ImportedBookRecord) in
            do {
                try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0, size <= 250 * 1024 * 1024 else { throw AppError.message("文件为空或超过 250 MB。") }
                let original = stage.appendingPathComponent("original.\(format.rawValue)")
                try FileManager.default.copyItem(at: url, to: original)
                let handle = try FileHandle(forReadingFrom: original)
                defer { try? handle.close() }
                var hash = SHA256()
                while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
                let identity = hash.finalize().map { String(format: "%02x", $0) }.joined()
                if let expected = metadata?.fileHash, expected != identity { throw AppError.message("文件与云端书籍不一致，请选择原来导入的同一份文件。") }
                let publication: ImportedPublication?
                let pageCount: Int
                var title = url.deletingPathExtension().lastPathComponent
                var author = ""
                var cover: Data?
                if format == .pdf {
                    guard let pdf = PDFDocument(url: original), !pdf.isLocked, pdf.pageCount > 0 else { throw AppError.message("无法打开此 PDF，文件可能损坏或需要密码。") }
                    pageCount = pdf.pageCount
                    title = pdf.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String ?? title
                    author = pdf.documentAttributes?[PDFDocumentAttribute.authorAttribute] as? String ?? ""
                    cover = pdf.page(at: 0)?.thumbnail(of: CGSize(width: 320, height: 460), for: .mediaBox).jpegData(compressionQuality: 0.82)
                    publication = nil
                } else {
                    let result = try PublicationImporter.read(original, format: format)
                    publication = result; pageCount = result.chapters.count
                    title = result.title == "original" ? title : result.title; author = result.author; cover = result.cover
                }
                let originalBook = metadata ?? knownBooks.first(where: { $0.fileHash == identity }) ?? Book(id: "file|" + identity, title: title, author: author, summary: "", sourceID: "local-file", sourceName: "本地文件", url: URL(string: "qingread-import://" + identity)!, publicationFormat: format)
                let book = originalBook.withFileHash(identity)
                let encoder = JSONEncoder()
                let chapters = (0..<pageCount).map { index in
                    Chapter(id: book.id + "|\(index)", title: publication?.chapters[index].title ?? "第 \(index + 1) 页", url: URL(string: "qingread-import://\(identity)/\(index)")!, index: index)
                }
                try encoder.encode(chapters).write(to: stage.appendingPathComponent("catalog.json"), options: .atomic)
                if let publication {
                    for (index, chapter) in chapters.enumerated() {
                        try encoder.encode(ChapterContent(chapter: chapter, paragraphs: publication.chapters[index].paragraphs))
                            .write(to: stage.appendingPathComponent("chapter-\(index).json"), options: .atomic)
                    }
                }
                if let cover, let image = UIImage(data: cover), let data = image.jpegData(compressionQuality: 0.82) { try data.write(to: stage.appendingPathComponent("cover.jpg")) }
                return (book, ImportedBookRecord(format: format, chapterCount: pageCount))
            } catch { try? FileManager.default.removeItem(at: stage); throw error }
        }.value
        defer { try? FileManager.default.removeItem(at: stage) }
        guard root == importRoot else { throw CancellationError() }
        try Task.checkCancellation()
        let book = prepared.0
        if publicationURL(for: book) != nil { saveImportedMetadata(book); return shelf.first(where: { $0.id == book.id })?.book ?? book }
        let destination = importedDirectory(book)
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        try FileManager.default.moveItem(at: stage, to: destination)
        importedBooks[book.id] = prepared.1
        persist(importedBooks, name: "imported-books.json")
        saveImportedMetadata(book)
        cacheRevision += 1
        return book
    }

    func downloadPublication(_ book: Book, onProgress: @escaping @MainActor (Double) -> Void) async throws -> Book {
        let downloadRoot = root
        let url = try await ReadingService(sources: sources).downloadURL(for: book)
        var request = URLRequest(url: url)
        request.setValue(book.url.absoluteString, forHTTPHeaderField: "Referer")
        let delegate = BookFileProgress(update: onProgress)
        let (temporary, response) = try await URLSession.shared.download(for: request, delegate: delegate)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw AppError.message("整本文件下载失败。") }
        let owned = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + (book.publicationFormat?.rawValue ?? "epub"))
        try FileManager.default.moveItem(at: temporary, to: owned)
        defer { try? FileManager.default.removeItem(at: owned) }
        guard root == downloadRoot else { throw CancellationError() }
        return try await importPublication(at: owned, format: book.publicationFormat, metadata: book)
    }
}

private final class BookFileProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let update: @MainActor (Double) -> Void
    init(update: @escaping @MainActor (Double) -> Void) { self.update = update }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) { }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > 250 * 1024 * 1024 { downloadTask.cancel(); return }
        let value = totalBytesExpectedToWrite > 0 ? Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) : 0
        Task { @MainActor in update(min(1, max(0, value))) }
    }
}

enum AppError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}

enum LocalSample {
    static let book = Book(id: "local-taohuayuanji", title: "桃花源记", author: "陶渊明",
                           summary: "本地公版示例，用于离线体验排版与阅读进度。它不是在线搜索结果。",
                           sourceID: "local-sample", sourceName: "本地公版示例", url: URL(string: "qingread-local://taohuayuanji")!)
    static let chapters = [Chapter(id: "local-taohuayuanji-1", title: "桃花源记", url: book.url, index: 0)]
    static let content = ChapterContent(chapter: chapters[0], paragraphs: [
        "晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近。忽逢桃花林，夹岸数百步，中无杂树，芳草鲜美，落英缤纷。渔人甚异之，复前行，欲穷其林。",
        "林尽水源，便得一山，山有小口，仿佛若有光。便舍船，从口入。初极狭，才通人。复行数十步，豁然开朗。土地平旷，屋舍俨然，有良田、美池、桑竹之属。阡陌交通，鸡犬相闻。其中往来种作，男女衣着，悉如外人。黄发垂髫，并怡然自乐。",
        "见渔人，乃大惊，问所从来。具答之。便要还家，设酒杀鸡作食。村中闻有此人，咸来问讯。自云先世避秦时乱，率妻子邑人来此绝境，不复出焉，遂与外人间隔。问今是何世，乃不知有汉，无论魏晋。此人一一为具言所闻，皆叹惋。余人各复延至其家，皆出酒食。停数日，辞去。此中人语云：『不足为外人道也。』",
        "既出，得其船，便扶向路，处处志之。及郡下，诣太守，说如此。太守即遣人随其往，寻向所志，遂迷，不复得路。",
        "南阳刘子骥，高尚士也，闻之，欣然规往。未果，寻病终。后遂无问津者。"
    ])
}

struct SourceSwitchPlan {
    let book: Book
    let candidate: Book
    let chapters: [Chapter]
    let matchedIndex: Int?
    let fraction: Double
    fileprivate let profileGeneration: UUID
    fileprivate let cacheGeneration: UUID
    fileprivate let sourceFingerprint: String
    fileprivate let requiresSavedBook: Bool
    fileprivate let bookGeneration: UUID?
}

extension AppStore {
    func sourceFingerprint(_ book: Book) -> String { book.sourceID + "|" + book.url.absoluteString }
    func currentBook(_ book: Book) -> Book { shelf.first(where: { $0.id == book.id })?.book ?? book }
    func cachedChapters(for book: Book) -> [Chapter]? {
        try? decoder.decode([Chapter].self, from: Data(contentsOf: bookCacheDirectory(book).appendingPathComponent("catalog.json")))
    }
    func newChapterCount(for book: Book) -> Int { updateTracking[book.id]?.newChapterIDs.count ?? 0 }
    private func acknowledgeUpdates(book: Book, through index: Int) {
        guard var tracking = updateTracking[book.id], !tracking.newChapterIDs.isEmpty else { return }
        let consumed = Set(tracking.chapterIDs.prefix(max(0, index + 1)))
        tracking.newChapterIDs.removeAll { consumed.contains($0) }
        updateTracking[book.id] = tracking; persist(updateTracking, name: "update-tracking.json")
    }
    func checkShelfUpdates(force: Bool = false, maximumBooks: Int? = nil) async {
        if let updateCheckTask { await updateCheckTask.value; return }
        let generation = workflowGeneration
        checkingUpdates = true
        let work = Task { @MainActor [weak self] in
            guard let self else { return }
            let allBooks = self.sortedShelf.map(\.book).filter { $0.publicationFormat == nil && $0.fileDownloadURL == nil && self.enabledSourceIDs.contains($0.sourceID) }
            let books = maximumBooks.map { Array(allBooks.prefix(max(0, $0))) } ?? allBooks
            for book in books {
                guard !Task.isCancelled, self.workflowGeneration == generation else { return }
                let cooldown: TimeInterval = force ? 60 : 15 * 60
                if let last = self.updateTracking[book.id]?.lastAttemptAt ?? self.updateTracking[book.id]?.checkedAt, Date().timeIntervalSince(last) < cooldown { continue }
                var tracking = self.updateTracking[book.id] ?? BookUpdateTracking()
                tracking.lastAttemptAt = Date(); self.updateTracking[book.id] = tracking
                self.persist(self.updateTracking, name: "update-tracking.json")
                do { _ = try await self.chapters(for: book, refresh: true) }
                catch is CancellationError { return }
                catch { /* Keep the last successful catalog and badge. */ }
            }
        }
        updateCheckTask = work
        await work.value
        if generation == workflowGeneration { updateCheckTask = nil; checkingUpdates = false }
    }
    func refreshedEndCatalog(for book: Book) async throws -> [Chapter] {
        if let date = endCheckTimes[book.id], Date().timeIntervalSince(date) < 60, let cached = cachedChapters(for: book) { return cached }
        endCheckTimes[book.id] = Date()
        return try await chapters(for: book, refresh: true)
    }
    private func stopProfileWorkflows() {
        workflowGeneration = UUID(); endCheckTimes = [:]
        updateCheckTask?.cancel(); updateCheckTask = nil; checkingUpdates = false
        stopAllDownloads()
    }
    private func invalidateSourceCache(_ book: Book) {
        bookCacheGenerations[book.id] = UUID()
        cancelPrefetch(for: book); cancelContentRequests(for: book.id); cancelDownloads(for: book.id)
        try? FileManager.default.removeItem(at: bookCacheDirectory(book))
        chapterProgresses.removeValue(forKey: book.id)
        updateTracking.removeValue(forKey: book.id)
        persist(chapterProgresses, name: "chapter-progress.json"); persist(updateTracking, name: "update-tracking.json")
        cacheRevision += 1
    }
    func sourceCandidates(for book: Book) async -> [Book] {
        guard book.publicationFormat == nil, book.fileDownloadURL == nil else { return [] }
        let response = await search(book.title)
        return response.books.filter { enabledSourceIDs.contains($0.sourceID) && SourceProgressMatcher.isCandidate($0, for: book) }
    }
    func prepareSourceSwitch(from book: Book, to candidate: Book, currentChapters: [Chapter]? = nil) async throws -> SourceSwitchPlan {
        guard enabledSourceIDs.contains(candidate.sourceID), SourceProgressMatcher.isCandidate(candidate, for: book) else { throw AppError.message("此来源不适合当前书籍。") }
        let profile = workflowGeneration, generation = cacheGeneration, fingerprint = sourceFingerprint(book)
        let saved = position(for: book), wasSaved = isSaved(book), bookGeneration = bookCacheGenerations[book.id]
        let old = currentChapters ?? cachedChapters(for: book) ?? []
        let current = saved.flatMap { position in old.first(where: { $0.id == position.chapterID }) ?? (old.indices.contains(position.chapterIndex) ? old[position.chapterIndex] : nil) }
        let chapters = try await ReadingService(sources: sources, client: contentClient).chapters(for: candidate)
        try Task.checkCancellation()
        guard profile == workflowGeneration, generation == cacheGeneration, !chapters.isEmpty else { throw CancellationError() }
        let matched = current.flatMap { SourceProgressMatcher.matchedIndex(title: $0.title, in: chapters) }
        return SourceSwitchPlan(book: book, candidate: candidate, chapters: chapters, matchedIndex: saved == nil ? 0 : matched,
                                fraction: saved?.chapterFraction ?? 0, profileGeneration: profile, cacheGeneration: generation,
                                sourceFingerprint: fingerprint, requiresSavedBook: wasSaved, bookGeneration: bookGeneration)
    }
    private func validate(_ plan: SourceSwitchPlan) throws {
        guard plan.profileGeneration == workflowGeneration, plan.cacheGeneration == cacheGeneration,
              enabledSourceIDs.contains(plan.candidate.sourceID), (!plan.requiresSavedBook || isSaved(plan.book)),
              sourceFingerprint(currentBook(plan.book)) == plan.sourceFingerprint,
              bookCacheGenerations[plan.book.id] == plan.bookGeneration else { throw CancellationError() }
    }
    func commitSourceSwitch(_ plan: SourceSwitchPlan, chapterIndex: Int) async throws -> Book {
        try validate(plan)
        guard plan.chapters.indices.contains(chapterIndex) else { throw AppError.message("请选择章节。") }
        let chapter = plan.chapters[chapterIndex]
        let content = try await ReadingService(sources: sources, client: contentClient).content(for: chapter, in: plan.candidate)
        try Task.checkCancellation(); try validate(plan)
        guard !content.paragraphs.isEmpty else { throw AppError.message("此来源没有返回正文。") }
        let candidate = plan.candidate
        let replacement = Book(id: plan.book.id, title: candidate.title, author: candidate.author.isEmpty ? plan.book.author : candidate.author,
                               summary: candidate.summary, coverURL: candidate.coverURL, sourceID: candidate.sourceID, sourceName: candidate.sourceName, url: candidate.url)
        let destination = bookCacheDirectory(plan.book)
        let stage = cacheRoot.appendingPathComponent(".source-" + UUID().uuidString, isDirectory: true)
        let backup = cacheRoot.appendingPathComponent(".previous-" + UUID().uuidString, isDirectory: true)
        var removeBackup = false
        defer { try? FileManager.default.removeItem(at: stage); if removeBackup { try? FileManager.default.removeItem(at: backup) } }
        try writeCache(plan.chapters, to: stage.appendingPathComponent("catalog.json"))
        try writeCache(content, to: stage.appendingPathComponent(contentURL(chapter: chapter, book: replacement).lastPathComponent))
        bookCacheGenerations[plan.book.id] = UUID(); cancelPrefetch(for: plan.book); cancelContentRequests(for: plan.book.id)
        cancelDownloads(for: plan.book.id)
        let exists = FileManager.default.fileExists(atPath: destination.path)
        if exists { try FileManager.default.moveItem(at: destination, to: backup) }
        do { try FileManager.default.moveItem(at: stage, to: destination) }
        catch { if exists { try? FileManager.default.moveItem(at: backup, to: destination) }; throw error }
        let fraction = min(1, max(0, plan.fraction))
        let position = ReadingPosition(chapterID: chapter.id, chapterIndex: chapterIndex,
                                       characterOffset: SourceProgressMatcher.utf16Offset(fraction: fraction, content: content), chapterFraction: fraction, updatedAt: Date())
        let oldEntry = shelf.first { $0.id == plan.book.id }
        var updatedShelf = shelf.filter { $0.id != plan.book.id }
        updatedShelf.append(ShelfEntry(book: replacement, position: position, addedAt: oldEntry?.addedAt ?? Date(), organization: oldEntry?.organization, annotations: oldEntry?.annotations))
        do {
            try encoder.encode(updatedShelf).write(to: root.appendingPathComponent("library.json"), options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            if exists { try? FileManager.default.moveItem(at: backup, to: destination) }
            throw error
        }
        removeBackup = true
        shelf = updatedShelf
        chapterProgresses[plan.book.id] = [chapter.id: fraction]
        var tracking = BookUpdateTracking(chapterIDs: plan.chapters.map(\.id), checkedAt: Date())
        tracking.lastChapterTitle = plan.chapters.last?.title; updateTracking[plan.book.id] = tracking
        persist(chapterProgresses, name: "chapter-progress.json"); persist(updateTracking, name: "update-tracking.json")
        cloud.localChanged(.add, book: replacement); cacheRevision += 1
        return replacement
    }
    private func persistDownloads() {
        let ended: Set<ChapterDownloadStatus> = [.completed, .cancelled, .failed]
        let retained = Set(downloads.filter { ended.contains($0.status) }.sorted { $0.createdAt > $1.createdAt }.prefix(20).map(\.id))
        downloads.removeAll { ended.contains($0.status) && !retained.contains($0.id) }
        persist(downloads, name: "chapter-downloads.json")
    }
    private func canDownloadBookInBackground(_ book: Book) -> Bool {
        backgroundDownloads != nil && cloud.canDownloadInBackground && SourceDefinition.builtIn.contains(where: { $0.id == book.sourceID })
    }
    func pauseDownloadsForBackground() {
        guard backgroundDownloads != nil else { stopAllDownloads(); return }
        downloadWorker?.cancel(); downloadWorker = nil; downloadWorkerID = nil; cancelDownloadRequests()
        for index in downloads.indices where [.queued, .running].contains(downloads[index].status) && downloads[index].backgroundManaged != true {
            downloads[index].status = .paused; downloads[index].lastError = "当前书源需在前台下载。"
        }
        persistDownloads(); scheduleBackgroundDownloads()
    }
    private func cancelDownloadRequests(for bookID: String? = nil) {
        var cancelled = false
        for (key, request) in contentRequests where request.downloadOnly && (bookID == nil || request.bookID == bookID) {
            request.task.cancel(); contentRequests.removeValue(forKey: key); cancelled = true
        }
        if cancelled { cacheRevision += 1 }
    }
    func enqueueDownload(book: Book, chapters: [Chapter], range: ClosedRange<Int>) {
        guard book.publicationFormat == nil, enabledSourceIDs.contains(book.sourceID), !chapters.isEmpty,
              sourceFingerprint(currentBook(book)) == sourceFingerprint(book) else { return }
        let selected = chapters.enumerated().filter { range.contains($0.offset + 1) }.map(\.element)
        guard !selected.isEmpty else { return }
        let chapterIDs = selected.map(\.id)
        if let duplicate = downloads.first(where: {
            $0.book.id == book.id && sourceFingerprint($0.book) == sourceFingerprint(book)
                && [.queued, .running, .paused].contains($0.status) && $0.chapters.map(\.id) == chapterIDs
        }) {
            if duplicate.status == .paused { resumeDownload(duplicate.id) }
            return
        }
        add(book)
        var job = ChapterDownloadTask(book: book, chapters: selected)
        job.backgroundManaged = canDownloadBookInBackground(book)
        job.backgroundAttempts = [:]
        job.completedIDs = Set(selected.filter { hasCachedContent(for: $0, in: book) }.map(\.id))
        downloads.append(job); persistDownloads(); startDownloadWorker()
    }
    func pauseDownload(_ id: UUID) {
        guard let index = downloads.firstIndex(where: { $0.id == id }), [.queued, .running].contains(downloads[index].status) else { return }
        let running = downloads[index].status == .running, bookID = downloads[index].book.id
        downloads[index].status = .paused; persistDownloads()
        backgroundDownloads?.cancel(jobID: id, scope: backgroundProfileScope)
        if running { downloadWorker?.cancel(); downloadWorker = nil; downloadWorkerID = nil; cancelDownloadRequests(for: bookID); startDownloadWorker() }
    }
    func resumeDownload(_ id: UUID) {
        guard let index = downloads.firstIndex(where: { $0.id == id }), [.paused, .failed].contains(downloads[index].status),
              isSaved(downloads[index].book), enabledSourceIDs.contains(downloads[index].book.sourceID), sourceFingerprint(currentBook(downloads[index].book)) == sourceFingerprint(downloads[index].book) else { return }
        downloads[index].status = .queued; downloads[index].failedIDs = []; downloads[index].lastError = nil
        downloads[index].backgroundManaged = canDownloadBookInBackground(downloads[index].book)
        downloads[index].backgroundAttempts = [:]
        persistDownloads(); startDownloadWorker()
    }
    func cancelDownload(_ id: UUID) {
        guard let index = downloads.firstIndex(where: { $0.id == id }) else { return }
        let running = downloads[index].status == .running, bookID = downloads[index].book.id
        downloads[index].status = .cancelled; persistDownloads()
        backgroundDownloads?.cancel(jobID: id, scope: backgroundProfileScope)
        if running { downloadWorker?.cancel(); downloadWorker = nil; downloadWorkerID = nil; cancelDownloadRequests(for: bookID); startDownloadWorker() }
    }
    func dismissDownload(_ id: UUID) {
        cancelDownload(id); downloads.removeAll { $0.id == id }; persistDownloads()
    }
    private func cancelDownloads(for bookID: String) {
        let ids = downloads.filter { $0.book.id == bookID && [.queued, .running, .paused].contains($0.status) }.map(\.id)
        ids.forEach(cancelDownload)
    }
    private func stopAllDownloads() {
        backgroundDownloads?.cancel(scope: backgroundProfileScope)
        downloadWorker?.cancel(); downloadWorker = nil; downloadWorkerID = nil
        cancelDownloadRequests()
        for index in downloads.indices where [.queued, .running].contains(downloads[index].status) { downloads[index].status = .paused }
        persistDownloads()
    }
    private func startDownloadWorker() {
        guard downloadWorker == nil else { return }
        if backgroundDownloads != nil, downloads.contains(where: { $0.backgroundManaged == true && [.queued, .running].contains($0.status) }) { scheduleBackgroundDownloads(); return }
        guard let next = downloads.first(where: { $0.status == .queued }) else { return }
        let worker = UUID(), profile = workflowGeneration
        downloadWorkerID = worker
        downloadWorker = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.downloadWorkerID == worker {
                    self.downloadWorker = nil; self.downloadWorkerID = nil; self.startDownloadWorker()
                }
            }
            // A queued worker may not run until after Pause, Cancel, cache clearing
            // or a profile switch. Revalidate before its first state write.
            guard !Task.isCancelled, profile == self.workflowGeneration, self.downloadWorkerID == worker,
                  let i = self.downloads.firstIndex(where: { $0.id == next.id }), self.downloads[i].status == .queued else { return }
            self.downloads[i].status = .running; self.persistDownloads()
            for chapter in next.chapters {
                guard !Task.isCancelled, profile == self.workflowGeneration, self.downloadWorkerID == worker,
                      let index = self.downloads.firstIndex(where: { $0.id == next.id }), self.downloads[index].status == .running,
                      self.enabledSourceIDs.contains(next.book.sourceID) else { return }
                var failure: Error?
                if !self.hasCachedContent(for: chapter, in: next.book) {
                    for attempt in 0..<3 {
                        do {
                            _ = try await self.content(for: chapter, in: next.book, forDownload: true)
                            try Task.checkCancellation()
                            guard self.hasCachedContent(for: chapter, in: next.book) else { throw AppError.message("章节未能保存。") }
                            failure = nil; break
                        } catch is CancellationError { return }
                        catch {
                            failure = error
                            if attempt < 2 { try? await Task.sleep(nanoseconds: UInt64(attempt + 1) * 1_000_000_000) }
                            if Task.isCancelled { return }
                        }
                    }
                }
                guard !Task.isCancelled, profile == self.workflowGeneration, self.downloadWorkerID == worker,
                      let index = self.downloads.firstIndex(where: { $0.id == next.id }), self.downloads[index].status == .running,
                      self.enabledSourceIDs.contains(next.book.sourceID) else { return }
                if let failure { self.downloads[index].failedIDs.insert(chapter.id); self.downloads[index].lastError = failure.localizedDescription }
                else { self.downloads[index].completedIDs.insert(chapter.id); self.downloads[index].failedIDs.remove(chapter.id) }
                self.persistDownloads()
            }
            guard profile == self.workflowGeneration, self.downloadWorkerID == worker,
                  let index = self.downloads.firstIndex(where: { $0.id == next.id }) else { return }
            self.downloads[index].status = self.downloads[index].failedIDs.isEmpty ? .completed : .failed
            self.persistDownloads()
        }
    }
}

extension AppStore {
    var backgroundProfileScope: String { root == guestRoot ? "guest" : root.lastPathComponent }
    func startBackgroundDownloads() {
        guard backgroundDownloads == nil else { return }
        let manager = BackgroundChapterDownloads(directory: guestRoot.appendingPathComponent("BackgroundTransfers", isDirectory: true))
        backgroundDownloads = manager
        manager.request = { [weak self] book, chapters in
            guard let self else { throw CancellationError() }
            return try self.cloud.backgroundChapterRequest(book: book, chapters: chapters)
        }
        manager.receive = { [weak self] transfer, result in self?.receiveBackgroundBatch(transfer, result: result) }
        manager.restored = { [weak self] records in self?.reconcileBackgroundDownloads(records) }
        manager.changed = { [weak self] in self?.scheduleBackgroundDownloads() }
        manager.restore()
    }
    func handleBackgroundDownloadEvents(completion: @escaping () -> Void) {
        startBackgroundDownloads()
        backgroundDownloads?.handleEvents(completion: completion)
    }
    private func reconcileBackgroundDownloads(_ records: [BackgroundChapterTransfer]) {
        backgroundDownloads?.retain(scope: backgroundProfileScope)
        for record in records {
            let job = downloads.first { $0.id == record.jobID }
            if !record.matches(scope: backgroundProfileScope, job: job) { backgroundDownloads?.cancel(jobID: record.jobID, scope: record.profileScope) }
        }
        for index in downloads.indices where downloads[index].backgroundManaged == true && [.queued, .running].contains(downloads[index].status) {
            let job = downloads[index]
            if job.completedIDs.count == job.chapters.count { downloads[index].status = .completed }
            else if job.completedIDs.union(job.failedIDs).count == job.chapters.count { downloads[index].status = .failed }
            else { downloads[index].status = records.contains { $0.matches(scope: backgroundProfileScope, job: job) } ? .running : .paused }
        }
        persistDownloads()
    }
    private func scheduleBackgroundDownloads() {
        guard let manager = backgroundDownloads, manager.ready, cloud.canDownloadInBackground, downloadWorker == nil else { return }
        manager.retain(scope: backgroundProfileScope)
        guard let index = downloads.firstIndex(where: { $0.backgroundManaged == true && [.queued, .running].contains($0.status) }) else { startDownloadWorker(); return }
        let job = downloads[index]
        guard isSaved(job.book), enabledSourceIDs.contains(job.book.sourceID), sourceFingerprint(currentBook(job.book)) == sourceFingerprint(job.book) else { pauseDownload(job.id); return }
        let active = manager.transfers.filter { $0.jobID == job.id && $0.profileScope == backgroundProfileScope }
        let pending = Set(active.flatMap { $0.chapters.map(\.id) })
        var missing: [Chapter] = []
        for chapter in job.chapters where !job.completedIDs.contains(chapter.id) && !job.failedIDs.contains(chapter.id) && !pending.contains(chapter.id) {
            if hasCachedContent(for: chapter, in: job.book) { downloads[index].completedIDs.insert(chapter.id) }
            else { missing.append(chapter) }
        }
        if missing.isEmpty && active.isEmpty {
            downloads[index].status = downloads[index].failedIDs.isEmpty ? .completed : .failed
            if downloads[index].status == .completed && notificationPreferences.downloads { ReadingNotifications.shared.post(scope: backgroundProfileScope, book: job.book, kind: "download", body: "下载完成，可离线阅读") }
            persistDownloads(); scheduleBackgroundDownloads(); return
        }
        downloads[index].status = .running
        // Twenty larger transfers are pre-registered, rather than waking once
        // for every chapter. The OS may delay later windows while suspended.
        var planned: [BackgroundChapterTransfer] = []
        while !missing.isEmpty && planned.count + active.count < 20 {
            var count = min(10, missing.count)
            var selected = Array(missing.prefix(count))
            while count > 1 && (try? cloud.backgroundChapterRequest(book: job.book, chapters: selected)) == nil {
                count -= 1; selected = Array(missing.prefix(count))
            }
            do {
                _ = try cloud.backgroundChapterRequest(book: job.book, chapters: selected)
                planned.append(BackgroundChapterTransfer(profileScope: backgroundProfileScope, jobID: job.id, book: job.book, chapters: selected))
            } catch {
                for chapter in selected { downloads[index].failedIDs.insert(chapter.id) }
                downloads[index].lastError = error.localizedDescription
            }
            missing.removeFirst(count)
        }
        if planned.isEmpty && active.isEmpty {
            downloads[index].status = .failed; persistDownloads(); scheduleBackgroundDownloads(); return
        }
        persistDownloads()
        do { try manager.submit(planned) }
        catch {
            if let index = downloads.firstIndex(where: { $0.id == job.id }) { downloads[index].status = .paused; downloads[index].lastError = error.localizedDescription; persistDownloads() }
        }
    }
    private func receiveBackgroundBatch(_ transfer: BackgroundChapterTransfer, result: Result<BackgroundChapterBatch, Error>) {
        guard let index = downloads.firstIndex(where: { $0.id == transfer.jobID }), transfer.matches(scope: backgroundProfileScope, job: downloads[index]),
              isSaved(transfer.book), sourceFingerprint(currentBook(transfer.book)) == sourceFingerprint(transfer.book), enabledSourceIDs.contains(transfer.book.sourceID) else { return }
        let contents: [ChapterContent]
        let messages: [String: String]
        switch result {
        case .success(let batch):
            contents = transfer.validatedContents(batch)
            messages = Dictionary(batch.failures.map { ($0.chapterID, String($0.message.prefix(200))) }, uniquingKeysWith: { first, _ in first })
        case .failure(let error):
            if error is BackgroundChapterDownloadError {
                downloads[index].status = .paused; downloads[index].lastError = error.localizedDescription
                backgroundDownloads?.cancel(jobID: transfer.jobID, scope: backgroundProfileScope)
                persistDownloads(); return
            }
            contents = []; messages = Dictionary(uniqueKeysWithValues: transfer.chapters.map { ($0.id, error.localizedDescription) })
        }
        var saved = Set<String>()
        for content in contents {
            do {
                try writeCache(content, to: contentURL(chapter: content.chapter, book: transfer.book))
                downloads[index].completedIDs.insert(content.chapter.id); downloads[index].failedIDs.remove(content.chapter.id)
                saved.insert(content.chapter.id)
            } catch { downloads[index].lastError = error.localizedDescription }
        }
        for chapter in transfer.chapters where !saved.contains(chapter.id) {
            let attempt = (downloads[index].backgroundAttempts?[chapter.id] ?? 0) + 1
            downloads[index].backgroundAttempts = (downloads[index].backgroundAttempts ?? [:]).merging([chapter.id: attempt]) { _, new in new }
            if attempt >= 3 { downloads[index].failedIDs.insert(chapter.id) }
            downloads[index].lastError = messages[chapter.id] ?? "章节未能保存，稍后可重试。"
        }
        cacheRevision += 1; persistDownloads()
    }
}

extension AppStore {
    func updateNotificationPreferences(_ value: ReadingNotificationPreferences) {
        notificationPreferences = value; persist(value, name: "notification-preferences.json")
        QingReadApplicationDelegate.scheduleRefresh(enabled: value.updates)
        if !value.updates && !value.downloads { ReadingNotifications.shared.clear(scope: backgroundProfileScope) }
    }
    func openNotificationBook(scope: String, id: String) {
        guard scope == backgroundProfileScope, let entry = shelf.first(where: { $0.id == id }) else { return }
        notificationBook = entry.book
    }
    func cancelBackgroundUpdateCheck() { updateCheckTask?.cancel() }
}

#if DEBUG
extension AppStore {
    func seedBackgroundDiagnostic(book: Book, chapters: [Chapter]) -> BackgroundChapterTransfer {
        add(book)
        var job = ChapterDownloadTask(book: book, chapters: chapters)
        job.backgroundManaged = true; job.backgroundAttempts = [:]; job.status = .running
        downloads.append(job); persistDownloads()
        return BackgroundChapterTransfer(profileScope: backgroundProfileScope, jobID: job.id, book: book, chapters: chapters)
    }
    func receiveBackgroundDiagnostic(_ transfer: BackgroundChapterTransfer, batch: BackgroundChapterBatch) { receiveBackgroundBatch(transfer, result: .success(batch)) }
    func throttleBackgroundDiagnostic(_ transfer: BackgroundChapterTransfer) { receiveBackgroundBatch(transfer, result: .failure(BackgroundChapterDownloadError.rateLimited)) }
    func restoreBackgroundDiagnostic(_ records: [BackgroundChapterTransfer]) { reconcileBackgroundDownloads(records) }
}
#endif

struct CachedBookMatch: Identifiable {
    var id: String { chapter.id + "|" + String(characterOffset) }
    let chapter: Chapter
    let characterOffset: Int
    let excerpt: String
}
extension AppStore {
    var shelfGroups: [String] { Array(Set(shelf.compactMap { $0.organization?.group }.filter { !$0.isEmpty })).sorted() }
    func organizeBooks(_ ids: Set<String>, pinned: Bool? = nil, status: ShelfReadingStatus? = nil, group: String? = nil) {
        for index in shelf.indices where ids.contains(shelf[index].id) {
            var value = shelf[index].organization ?? ShelfOrganization()
            if let pinned { value.pinned = pinned }; if let status { value.status = status }; if let group { value.group = ReadingMetadataText.clipped(group.trimmingCharacters(in: .whitespacesAndNewlines), utf16Limit: 40) }
            value.updatedAt = Date(); shelf[index].organization = value
            cloud.localChanged(.add, book: shelf[index].book)
        }
        persist(shelf, name: "library.json")
    }
    func annotations(for book: Book) -> [ReadingAnnotation] { (shelf.first { $0.id == book.id }?.annotations ?? []).filter { $0.deletedAt == nil }.sorted { $0.updatedAt > $1.updatedAt } }
    func saveAnnotation(book: Book, kind: ReadingAnnotationKind, chapter: Chapter, offset: Int, length: Int = 0, quote: String = "", note: String = "", replacing id: String? = nil) throws {
        guard sourceFingerprint(currentBook(book)) == sourceFingerprint(book) else { throw AppError.message("书源已变更，请重新选择正文。") }
        add(book)
        guard let index = shelf.firstIndex(where: { $0.id == book.id }) else { return }
        var values = shelf[index].annotations ?? []
        if id == nil && values.count >= 256 { throw AppError.message("这本书的标注已达 256 条。") }
        let annotation = ReadingAnnotation(id: id ?? UUID().uuidString, kind: kind, chapterID: chapter.id, chapterIndex: chapter.index, chapterTitle: chapter.title, characterOffset: offset, characterLength: length, quote: quote, note: note, sourceID: book.sourceID, sourceURL: book.url.absoluteString)
        values.removeAll { $0.id == annotation.id }; values.append(annotation); shelf[index].annotations = values
        cloud.localChanged(.add, book: book); persist(shelf, name: "library.json")
    }
    func deleteAnnotation(_ annotation: ReadingAnnotation, in book: Book) {
        guard let index = shelf.firstIndex(where: { $0.id == book.id }), var values = shelf[index].annotations, let note = values.firstIndex(where: { $0.id == annotation.id }) else { return }
        values[note].deletedAt = Date(); values[note].updatedAt = Date(); shelf[index].annotations = values
        cloud.localChanged(.add, book: shelf[index].book); persist(shelf, name: "library.json")
    }
    func searchCachedText(_ query: String, book: Book, chapters: [Chapter]) async -> [CachedBookMatch] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        let profile = profileRevision, fingerprint = sourceFingerprint(book)
        var matches: [CachedBookMatch] = []
        for chapter in chapters {
            guard !Task.isCancelled, profile == profileRevision, fingerprint == sourceFingerprint(currentBook(book)) else { return [] }
            if let content = cachedContent(for: chapter, in: book) {
                let text = content.paragraphs.joined(separator: "\n") as NSString
                var start = 0
                while start < text.length, matches.count < 100 {
                    let range = text.range(of: query, options: .caseInsensitive, range: NSRange(location: start, length: text.length - start))
                    if range.location == NSNotFound { break }
                    let context = NSRange(location: max(0, range.location - 25), length: min(text.length, range.location + range.length + 55) - max(0, range.location - 25))
                    matches.append(CachedBookMatch(chapter: chapter, characterOffset: range.location, excerpt: text.substring(with: context)))
                    start = range.location + max(1, range.length)
                }
            }
            if matches.count >= 100 { break }
            await Task.yield()
        }
        return matches
    }
}

extension AppStore {
    func editAnnotation(_ id: String, in book: Book, note: String) {
        guard let index = shelf.firstIndex(where: { $0.id == book.id }), var values = shelf[index].annotations, let item = values.firstIndex(where: { $0.id == id && $0.deletedAt == nil }) else { return }
        values[item].note = ReadingMetadataText.clipped(note, utf16Limit: 1000); values[item].kind = .note; values[item].updatedAt = Date(); shelf[index].annotations = values
        cloud.localChanged(.add, book: shelf[index].book); persist(shelf, name: "library.json")
    }
}
