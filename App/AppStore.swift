import Foundation
import SwiftUI
import CryptoKit
import ReadingCore

struct ReadingPosition: Codable, Hashable {
    var chapterID: String
    var chapterIndex: Int
    var characterOffset: Int
    var chapterFraction: Double
    var updatedAt: Date
}

struct ShelfEntry: Codable, Identifiable {
    var id: String { book.id }
    let book: Book
    var position: ReadingPosition?
    let addedAt: Date
}

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
    @Published var storageMessage: String?

    private var importedSources: [SourceDefinition] = []
    private let root: URL
    private let cacheRoot: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var chapterProgresses: [String: [String: Double]] = [:]
    private struct ContentRequest {
        let id: UUID
        let bookID: String
        let task: Task<ChapterContent, Error>
    }
    private var contentRequests: [String: ContentRequest] = [:]
    private var prefetchTask: Task<Void, Never>?
    private var prefetchBookID: String?
    private let contentClient: any HTTPClient
    private var cacheGeneration = UUID()
    private var bookCacheGenerations: [String: UUID] = [:]

    init(storageRoot: URL? = nil, client: any HTTPClient = URLSessionHTTPClient()) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        root = storageRoot ?? base.appendingPathComponent("QingRead", isDirectory: true)
        cacheRoot = root.appendingPathComponent("ChapterCache", isDirectory: true)
        contentClient = client
        encoder.outputFormatting = [.sortedKeys]
        do {
            try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
            shelf = try read([ShelfEntry].self, name: "library.json") ?? []
            if let saved = try read(SavedSources.self, name: "sources.json") {
                importedSources = saved.imported
                disabledSourceIDs = saved.disabledIDs
                rebuildSources()
            }
            settings = try read(ReaderSettings.self, name: "reader-settings.json") ?? ReaderSettings()
            chapterProgresses = try read([String: [String: Double]].self, name: "chapter-progress.json") ?? [:]
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

    var enabledSourceIDs: Set<String> { Set(sources.map(\.id)).subtracting(disabledSourceIDs) }
    var recentEntry: ShelfEntry? {
        shelf.filter { $0.position != nil }.max { ($0.position?.updatedAt ?? .distantPast) < ($1.position?.updatedAt ?? .distantPast) }
    }
    var sortedShelf: [ShelfEntry] {
        shelf.sorted { ($0.position?.updatedAt ?? $0.addedAt) > ($1.position?.updatedAt ?? $1.addedAt) }
    }

    func isSaved(_ book: Book) -> Bool { shelf.contains { $0.id == book.id } }
    func position(for book: Book) -> ReadingPosition? { shelf.first { $0.id == book.id }?.position }

    func add(_ book: Book) {
        guard !isSaved(book) else { return }
        shelf.append(ShelfEntry(book: book, position: nil, addedAt: Date()))
        persist(shelf, name: "library.json")
    }

    func remove(_ book: Book) {
        bookCacheGenerations[book.id] = UUID()
        cancelPrefetch(for: book)
        cancelContentRequests(for: book.id)
        shelf.removeAll { $0.id == book.id }
        persist(shelf, name: "library.json")
        chapterProgresses.removeValue(forKey: book.id)
        persist(chapterProgresses, name: "chapter-progress.json")
        do {
            let directory = bookCacheDirectory(book)
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            cacheRevision += 1
        } catch { storageMessage = "书架已移除，但该书缓存删除失败：\(error.localizedDescription)" }
    }

    func savePosition(book: Book, chapter: Chapter, index: Int, characterOffset: Int, fraction: Double) {
        let position = ReadingPosition(chapterID: chapter.id, chapterIndex: index,
                                       characterOffset: max(0, characterOffset),
                                       chapterFraction: min(1, max(0, fraction)), updatedAt: Date())
        if let item = shelf.firstIndex(where: { $0.id == book.id }) {
            shelf[item].position = position
        } else {
            shelf.append(ShelfEntry(book: book, position: position, addedAt: Date()))
        }
        persist(shelf, name: "library.json")
        let furthest = max(chapterProgresses[book.id]?[chapter.id] ?? 0, position.chapterFraction)
        chapterProgresses[book.id, default: [:]][chapter.id] = furthest
        persist(chapterProgresses, name: "chapter-progress.json")
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
        if enabled { disabledSourceIDs.remove(source.id) } else { disabledSourceIDs.insert(source.id) }
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
        let cache = bookCacheDirectory(book).appendingPathComponent("catalog.json")
        if !refresh, let chapters = try? decoder.decode([Chapter].self, from: Data(contentsOf: cache)), !chapters.isEmpty { return chapters }
        let generation = cacheGeneration
        let bookGeneration = bookCacheGenerations[book.id]
        let chapters = try await ReadingService(sources: sources, client: contentClient).chapters(for: book)
        try Task.checkCancellation()
        guard cacheGeneration == generation, bookCacheGenerations[book.id] == bookGeneration else { return chapters }
        do { try writeCache(chapters, to: cache) }
        catch { storageMessage = "目录已获取，但离线保存失败：\(error.localizedDescription)" }
        return chapters
    }

    func content(for chapter: Chapter, in book: Book) async throws -> ChapterContent {
        if book.id == LocalSample.book.id { return LocalSample.content }
        let cache = contentURL(chapter: chapter, book: book)
        if let content = try? decoder.decode(ChapterContent.self, from: Data(contentsOf: cache)), !content.paragraphs.isEmpty { return content }
        let key = cache.path
        if let existing = contentRequests[key] {
            let result = try await existing.task.value
            try Task.checkCancellation()
            return result
        }
        let id = UUID()
        let service = ReadingService(sources: sources, client: contentClient)
        let task = Task { @MainActor [weak self] () throws -> ChapterContent in
            defer {
                if self?.contentRequests[key]?.id == id {
                    self?.contentRequests.removeValue(forKey: key)
                    self?.cacheRevision += 1
                }
            }
            let content = try await service.content(for: chapter, in: book)
            try Task.checkCancellation()
            guard let self else { throw CancellationError() }
            do {
                try self.writeCache(content, to: cache)
                self.cacheRevision += 1
            } catch { self.storageMessage = "正文已获取，但离线保存失败：\(error.localizedDescription)" }
            return content
        }
        contentRequests[key] = ContentRequest(id: id, bookID: book.id, task: task)
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
        if book.id == LocalSample.book.id { return LocalSample.chapters.count }
        let urls = (try? FileManager.default.contentsOfDirectory(at: bookCacheDirectory(book), includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.lastPathComponent.hasPrefix("chapter-") && $0.pathExtension == "json" }.count
    }

    func hasCachedContent(for chapter: Chapter, in book: Book) -> Bool {
        if book.id == LocalSample.book.id { return true }
        return FileManager.default.fileExists(atPath: contentURL(chapter: chapter, book: book).path)
    }

    func clearCache() {
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

    private func rebuildSources() { sources = SourceDefinition.builtIn + importedSources }
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
