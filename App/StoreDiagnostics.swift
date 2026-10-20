#if DEBUG
import Foundation
import ReadingCore
import PDFKit
import UIKit

/// Exercises migration, independent chapter progress, coalesced network reads,
/// bounded prefetch and clearing during a request in a throw-away local store.
@MainActor enum StoreDiagnostics {
    static func run() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("QingRead-storage-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = DiagnosticContentClient()
        let book = Book(id: "storage-diagnostic", title: "存储诊断", sourceID: "biequgei", sourceName: "诊断", url: URL(string: "https://example.invalid/book")!)
        let chapters = (0..<14).map { Chapter(id: "diagnostic-\($0)", title: "第\($0 + 1)章", url: URL(string: "https://example.invalid/chapter/\($0)")!, index: $0) }
        let store = AppStore(storageRoot: directory, client: client)
        store.savePosition(book: book, chapter: chapters[0], index: 0, characterOffset: 70, fraction: 0.7)
        store.savePosition(book: book, chapter: chapters[8], index: 8, characterOffset: 20, fraction: 0.2)
        store.markChapterCompleted(chapters[8], in: book)
        store.savePosition(book: book, chapter: chapters[8], index: 8, characterOffset: 10, fraction: 0.1)
        assert(store.chapterProgress(for: chapters[0], in: book) == 0.7)
        assert(store.chapterProgress(for: chapters[7], in: book) == nil, "Jumping over a chapter must not mark it read")
        assert(store.chapterProgress(for: chapters[8], in: book) == 1)
        let reopened = AppStore(storageRoot: directory, client: client)
        assert(reopened.position(for: book)?.chapterFraction == 0.1)
        assert(reopened.chapterProgress(for: chapters[8], in: book) == 1)
        do {
            async let first = store.content(for: chapters[0], in: book)
            async let second = store.content(for: chapters[0], in: book)
            let results = try await (first, second)
            assert(results.0 == results.1)
            let calls = await client.calls(for: chapters[0].url)
            assert(calls == 1, "Foreground and prefetch must share an in-flight read")
            store.prefetchChapters(after: 0, chapters: chapters, in: book)
            for _ in 0..<150 {
                if store.cachedCount(for: book) == 11 { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            assert(store.cachedCount(for: book) == 11)
            assert(!store.hasCachedContent(for: chapters[11], in: book))
            store.cancelPrefetch(for: book)
            let pending = Task { try await store.content(for: chapters[12], in: book) }
            while await client.calls(for: chapters[12].url) == 0 { await Task.yield() }
            assert(store.cacheState(for: chapters[12], in: book) == .loading)
            store.clearCache()
            _ = try? await pending.value
            assert(store.cachedCount(for: book) == 0, "Clear must cancel pending writes")
            assert(store.cacheState(for: chapters[12], in: book) == .uncached)
            let catalog = Task { try await store.chapters(for: book, refresh: true) }
            while await client.calls(for: book.url) == 0 { await Task.yield() }
            store.clearCache()
            _ = try await catalog.value
            let cacheFiles = FileManager.default.enumerator(at: directory.appendingPathComponent("ChapterCache"), includingPropertiesForKeys: nil)!
            assert(!cacheFiles.contains { ($0 as? URL)?.lastPathComponent == "catalog.json" }, "A late catalog response must not repopulate a cleared cache")
            try FileManager.default.removeItem(at: directory.appendingPathComponent("chapter-progress.json"))
            let legacy = AppStore(storageRoot: directory, client: client)
            assert(legacy.chapterProgress(for: chapters[8], in: book) == 0.1)
            assert(legacy.chapterProgress(for: chapters[7], in: book) == nil)
            let textURL = directory.appendingPathComponent("导入测试.txt")
            try Data("第一章 开始\n正文甲。\n第二章 继续\n正文乙。".utf8).write(to: textURL)
            let imported = try await store.importPublication(at: textURL)
            let localChapters = try await store.chapters(for: imported)
            assert(localChapters.count == 2 && store.cachedCount(for: imported) == 2)
            let duplicate = try await store.importPublication(at: textURL)
            assert(duplicate.id == imported.id && store.shelf.filter { $0.id == imported.id }.count == 1)
            let localContent = try await store.content(for: localChapters[1], in: imported)
            assert(localContent.paragraphs == ["正文乙。"])
            store.clearCache()
            let offline = AppStore(storageRoot: directory, client: client)
            let reopenedChapters = try await offline.chapters(for: imported)
            assert(reopenedChapters == localChapters && offline.publicationURL(for: imported) != nil)
            let pdfURL = directory.appendingPathComponent("图表测试.pdf")
            try UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 300, height: 400)).writePDF(to: pdfURL) { context in
                context.beginPage(); ("PDF original layout" as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: nil)
                context.beginPage()
            }
            let pdf = try await store.importPublication(at: pdfURL)
            assert(store.importedBooks[pdf.id]?.format == .pdf && store.cachedCount(for: pdf) == 2)
            assert(store.importedCover(for: pdf) != nil && store.publicationURL(for: pdf) != nil)
            store.remove(imported)
            assert(store.importedBooks[imported.id] == nil && store.publicationURL(for: imported) == nil)
            print("QINGREAD_IMPORT_SELFTEST txt=passed pdf=passed dedup=passed offlineReopen=passed cachePreservation=passed removal=passed")
            print("QINGREAD_STORAGE_SELFTEST progress=passed legacy=passed coalescing=passed prefetch10=passed clearInflight=passed catalogGeneration=passed")
        } catch { assertionFailure("Storage diagnostics failed: \(error)") }
    }
}

private actor DiagnosticContentClient: HTTPClient {
    private var requests: [URL: Int] = [:]
    func calls(for url: URL) -> Int { requests[url] ?? 0 }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        requests[url, default: 0] += 1
        try await Task.sleep(nanoseconds: 30_000_000)
        let html = url.path == "/book" ? "<div class='row-section'><div class='section-box'><div class='section-list'><a href='/chapter/1'>第一章</a></div></div></div>" : "<div class='read-content'>缓存诊断正文<br>第二段</div>"
        return (Data(html.utf8), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
#endif
