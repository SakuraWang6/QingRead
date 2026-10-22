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
            _ = try? await catalog.value
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
            try await ReadingWorkflowDiagnostics.run()
            try BackgroundTransferDiagnostics.run()
            try ShelfMetadataDiagnostics.run()
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

@MainActor private enum ReadingWorkflowDiagnostics {
    static func run() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("QingRead-workflows-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = WorkflowContentClient()
        let book = Book(id: "workflow-book", title: "工作流测试", author: "作者", sourceID: "biequgei", sourceName: "原来源", url: URL(string: "https://example.invalid/book-old")!)
        let candidate = Book(title: book.title, author: book.author, sourceID: book.sourceID, sourceName: "新来源", url: URL(string: "https://example.invalid/book-new")!)
        let store = AppStore(storageRoot: directory, client: client)
        store.add(book)
        let baseline = try await store.chapters(for: book)
        assert(baseline.count == 2 && store.newChapterCount(for: book) == 0)
        await client.setCount(3)
        let updated = try await store.refreshedEndCatalog(for: book)
        assert(updated.count == 3 && store.newChapterCount(for: book) == 1)
        store.savePosition(book: book, chapter: updated[2], index: 2, characterOffset: 4, fraction: 0.5)
        store.organizeBooks([book.id], pinned: true, status: .later, group: "测试组")
        try store.saveAnnotation(book: book, kind: .note, chapter: updated[2], offset: 4, length: 2, quote: "正文", note: "换源前笔记")
        assert(store.newChapterCount(for: book) == 0)
        _ = try await store.content(for: updated[0], in: book)
        let firstCalls = await client.calls(updated[0].url)
        store.enqueueDownload(book: book, chapters: updated, range: 1...3)
        for _ in 0..<200 {
            if store.downloads.first?.status == .completed { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        assert(store.downloads.first?.completedCount == 3)
        let afterCalls = await client.calls(updated[0].url)
        assert(firstCalls == afterCalls, "A cached chapter must be skipped")
        let search = await store.searchCachedText("离线缓存", book: book, chapters: updated)
        assert(search.count == 3 && search.allSatisfy { $0.characterOffset > 0 }, "Search must use downloaded chapter bodies")
        let plan = try await store.prepareSourceSwitch(from: book, to: candidate, currentChapters: updated)
        assert(plan.matchedIndex == 2)
        await client.setBlocked(true)
        do { _ = try await store.commitSourceSwitch(plan, chapterIndex: 2); assertionFailure("Missing target body must not commit a source switch") }
        catch { }
        assert(store.shelf.first?.book.url == book.url && store.position(for: book)?.chapterID == updated[2].id)
        assert(store.cachedChapters(for: book)?.count == 3)
        await client.setBlocked(false)
        let switched = try await store.commitSourceSwitch(plan, chapterIndex: 2)
        assert(switched.id == book.id && switched.url == candidate.url && store.shelf.count == 1)
        assert(store.shelf.first?.organization?.pinned == true && store.shelf.first?.organization?.group == "测试组")
        assert(store.annotations(for: switched).first?.sourceURL == book.url.absoluteString, "Source switching must preserve annotations with their original source anchors")
        let switchedPosition = store.position(for: switched)!
        assert(switchedPosition.chapterFraction == 0.5 && switchedPosition.characterOffset > 0)
        store.savePosition(book: book, chapter: updated[0], index: 0, characterOffset: 0, fraction: 0)
        assert(store.position(for: switched) == switchedPosition, "The old reader must not overwrite a newly selected source")
        let stalePlan = try await store.prepareSourceSwitch(from: switched, to: book, currentChapters: plan.chapters)
        let remotePosition = ReadingPosition(chapterID: updated[1].id, chapterIndex: 1, characterOffset: 2, chapterFraction: 0.2, updatedAt: Date())
        try store.replaceCloudShelf([ShelfEntry(book: book, position: remotePosition, addedAt: Date())])
        assert(store.cachedChapters(for: book) == nil && store.position(for: book) == remotePosition)
        do { _ = try await store.commitSourceSwitch(stalePlan, chapterIndex: 1); assertionFailure("An old source plan must not overwrite a cloud source change") }
        catch is CancellationError { }
        store.enqueueDownload(book: book, chapters: updated, range: 1...3)
        let active = store.downloads.last!.id
        store.pauseDownload(active)
        assert(store.downloads.last?.status == .paused)
        // Let the scheduled worker actually execute. Pause must still win even
        // when it happened before the worker's first MainActor turn.
        try await Task.sleep(nanoseconds: 100_000_000)
        assert(store.downloads.last?.status == .paused && store.cachedCount(for: book) == 0, "A scheduled queued worker must not restart a paused task")
        let taskCount = store.downloads.count
        let beforeBackground = await client.calls(updated[0].url)
        store.enqueueDownload(book: book, chapters: updated, range: 1...3)
        assert(store.downloads.count == taskCount && store.downloads.last?.id == active, "Repeating a paused range must resume the same task")
        store.enqueueDownload(book: book, chapters: updated, range: 1...3)
        assert(store.downloads.count == taskCount, "Repeating a queued range must not create another task")
        for _ in 0..<100 {
            if await client.calls(updated[0].url) > beforeBackground { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        store.pauseDownloadsForBackground()
        try await Task.sleep(nanoseconds: 100_000_000)
        assert(store.downloads.last?.status == .paused && store.cachedCount(for: book) == 0, "Background pause must cancel download-only requests before a late cache write")
        store.enqueueDownload(book: book, chapters: updated, range: 1...3)
        store.pauseDownloadsForBackground()
        try await Task.sleep(nanoseconds: 100_000_000)
        assert(store.downloads.count == taskCount && store.downloads.last?.status == .paused && store.cachedCount(for: book) == 0, "Immediate background pause must also stop a scheduled worker")
        let reopened = AppStore(storageRoot: directory, client: client)
        assert(reopened.downloads.last?.status == .paused)
        reopened.resumeDownload(active)
        try reopened.selectCloudProfile("second-account")
        try await Task.sleep(nanoseconds: 100_000_000)
        assert(reopened.downloads.isEmpty && reopened.shelf.isEmpty && reopened.updateTracking.isEmpty && reopened.cachedCount(for: book) == 0)
        try reopened.selectCloudProfile(nil)
        assert(reopened.downloads.last?.status == .paused)
        assert(store.downloads.last?.status == .paused && reopened.cachedCount(for: book) == 0, "Late old-account work must neither change queue status nor write chapter files")
        for _ in 0..<25 {
            reopened.enqueueDownload(book: book, chapters: updated, range: 1...1)
            reopened.cancelDownload(reopened.downloads.last!.id)
        }
        let ended: Set<ChapterDownloadStatus> = [.completed, .cancelled, .failed]
        assert(reopened.downloads.filter { ended.contains($0.status) }.count == 20 && reopened.downloads.contains { $0.id == active && $0.status == .paused }, "History must retain at most 20 ended tasks without dropping an active task")
        print("QINGREAD_WORKFLOW_SELFTEST tracking=passed cachedSkip=passed sourceAtomicity=passed staleReader=passed cloudSource=passed pausedPersistence=passed accountIsolation=passed backgroundPause=passed downloadDedup=passed historyLimit=passed")
    }
}

private actor WorkflowContentClient: HTTPClient {
    private var count = 2
    private var blocked = false
    private var counts: [URL: Int] = [:]
    func setCount(_ value: Int) { count = value }
    func setBlocked(_ value: Bool) { blocked = value }
    func calls(_ url: URL) -> Int { counts[url] ?? 0 }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        counts[url, default: 0] += 1
        try await Task.sleep(nanoseconds: 20_000_000)
        let html: String
        var code = 200
        if url.path.hasPrefix("/book-") {
            let prefix = url.path.hasSuffix("new") ? "new" : "old"
            let links = (0..<count).map { "<a href='/\(prefix)/\($0)'>第\($0 + 1)章</a>" }.joined()
            html = "<div class='row-section'><div class='section-box'><div class='section-list'>" + links + "</div></div></div>"
        } else {
            if blocked && url.path.hasPrefix("/new/") { code = 503 }
            html = "<div class='read-content'>这是用于换源和离线缓存的正文。<br>下一段继续。</div>"
        }
        return (Data(html.utf8), HTTPURLResponse(url: url, statusCode: code, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor private enum BackgroundTransferDiagnostics {
    static func run() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("QingRead-background-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let book = Book(id: "background-book", title: "后台测试", sourceID: "biequgei", sourceName: "测试", url: URL(string: "https://example.invalid/book")!)
        let chapters = (0..<2).map { Chapter(id: "background-\($0)", title: "第\($0 + 1)章", url: URL(string: "https://example.invalid/\($0)")!, index: $0) }
        let store = AppStore(storageRoot: directory)
        store.cloud.address = "https://example.invalid"
        let verbose = Book(id: book.id, title: book.title, summary: String(repeating: "长摘要", count: 4000), coverURL: URL(string: "https://example.invalid/cover")!, sourceID: book.sourceID, sourceName: book.sourceName, url: book.url)
        let request = try store.cloud.backgroundChapterRequest(book: verbose, chapters: chapters)
        let encoded = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!
        var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        let payload = try JSONSerialization.jsonObject(with: Data(base64Encoded: base64)!) as! [String: Any]
        let payloadBook = payload["book"] as! [String: Any]
        assert(encoded.count < 12_000 && payloadBook["summary"] as? String == "" && payloadBook["coverURL"] == nil && payloadBook["id"] as? String == book.id)
        let transfer = store.seedBackgroundDiagnostic(book: book, chapters: chapters)
        let reopened = AppStore(storageRoot: directory)
        reopened.restoreBackgroundDiagnostic([transfer])
        assert(reopened.downloads.last?.status == .running)
        reopened.receiveBackgroundDiagnostic(transfer, batch: BackgroundChapterBatch(contents: [ChapterContent(chapter: chapters[0], paragraphs: ["第一章正文"])]))
        assert(reopened.hasCachedContent(for: chapters[0], in: book) && reopened.downloads.last?.completedCount == 1)
        reopened.pauseDownload(transfer.jobID)
        reopened.receiveBackgroundDiagnostic(transfer, batch: BackgroundChapterBatch(contents: [ChapterContent(chapter: chapters[1], paragraphs: ["迟到的正文"])]))
        assert(!reopened.hasCachedContent(for: chapters[1], in: book))
        try reopened.selectCloudProfile("second-account")
        reopened.receiveBackgroundDiagnostic(transfer, batch: BackgroundChapterBatch(contents: [ChapterContent(chapter: chapters[0], paragraphs: ["错误账户正文"])]))
        assert(reopened.shelf.isEmpty && reopened.cachedCount(for: book) == 0)
        try reopened.selectCloudProfile(nil)
        assert(reopened.downloads.last?.status == .paused && reopened.hasCachedContent(for: chapters[0], in: book))
        let orphan = reopened.seedBackgroundDiagnostic(book: book, chapters: chapters)
        let afterRestart = AppStore(storageRoot: directory)
        afterRestart.restoreBackgroundDiagnostic([])
        assert(afterRestart.downloads.first(where: { $0.id == orphan.jobID })?.status == .paused)
        let beforeClear = afterRestart.seedBackgroundDiagnostic(book: book, chapters: chapters)
        afterRestart.clearCache()
        afterRestart.receiveBackgroundDiagnostic(beforeClear, batch: BackgroundChapterBatch(contents: [ChapterContent(chapter: chapters[0], paragraphs: ["清理之后迟到"])]))
        assert(afterRestart.cachedCount(for: book) == 0)
        let throttled = afterRestart.seedBackgroundDiagnostic(book: book, chapters: chapters)
        afterRestart.throttleBackgroundDiagnostic(throttled)
        assert(afterRestart.downloads.last?.status == .paused && afterRestart.downloads.last?.failedIDs.isEmpty == true)
        afterRestart.receiveBackgroundDiagnostic(throttled, batch: BackgroundChapterBatch(contents: [ChapterContent(chapter: chapters[0], paragraphs: ["暂停后迟到"])]))
        assert(afterRestart.cachedCount(for: book) == 0)
        print("QINGREAD_BACKGROUND_SELFTEST compactPayload=passed persistedReconnect=passed stagedBody=passed pausedLateResponse=passed accountIsolation=passed orphanPause=passed clearLateResponse=passed rateLimitPause=passed")
    }
}

@MainActor private enum ShelfMetadataDiagnostics {
    static func run() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("QingRead-metadata-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let book = Book(id: "metadata-book", title: "笔记测试", sourceID: "biequgei", sourceName: "测试", url: URL(string: "https://example.invalid/book")!)
        let chapter = Chapter(id: "metadata-chapter", title: "中文😀章节", url: URL(string: "https://example.invalid/chapter")!, index: 0)
        let store = AppStore(storageRoot: directory)
        store.add(book); store.organizeBooks([book.id], pinned: true, status: .finished, group: "文学")
        try store.saveAnnotation(book: book, kind: .note, chapter: chapter, offset: 3, length: 2, quote: "😀", note: "笔记")
        let note = store.annotations(for: book).first!
        store.savePosition(book: book, chapter: chapter, index: 0, characterOffset: 8, fraction: 0.5)
        assert(store.shelf.first?.organization?.pinned == true && store.annotations(for: book).first?.characterOffset == 3)
        store.deleteAnnotation(note, in: book)
        let reopened = AppStore(storageRoot: directory)
        assert(reopened.shelf.first?.organization?.status == .finished && reopened.annotations(for: book).isEmpty && reopened.shelf.first?.annotations?.first?.deletedAt != nil)
        try reopened.selectCloudProfile("other-account")
        assert(reopened.shelf.isEmpty)
        try reopened.selectCloudProfile(nil)
        assert(reopened.shelf.first?.organization?.group == "文学" && reopened.shelf.first?.annotations?.first?.deletedAt != nil)
        print("QINGREAD_METADATA_SELFTEST progressPreserves=passed organizationPersistence=passed deletionTombstone=passed accountIsolation=passed")
    }
}
#endif
