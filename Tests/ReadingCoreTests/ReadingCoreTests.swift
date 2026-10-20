import Testing
@testable import ReadingCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@Suite struct ReadingCoreTests {
    @Test func testImportAcceptsSingleArrayAndEnvelope() throws {
        let source = htmlSource()
        let encoder = JSONEncoder()
        let single = try encoder.encode(source)
        #expect(try SourceImporter.decode(single) == [source])
        #expect(try SourceImporter.decode(encoder.encode([source])) == [source])
        let envelope = Data("{\"sources\":[\(String(decoding: single, as: UTF8.self))]}".utf8)
        #expect(try SourceImporter.decode(envelope) == [source])
    }

    @Test func testImportRejectsDuplicateIDsAndUnsafeURLsAndInvalidSelectors() throws {
        let source = htmlSource()
        #expect(throws: (any Error).self) { try SourceImporter.decode(JSONEncoder().encode([source, source])) }
        let unsafe = SourceDefinition(id: "unsafe", name: "Unsafe", homeURL: URL(string: "file:///tmp/books")!, kind: .html, html: source.html)
        #expect(throws: (any Error).self) { try SourceImporter.validate(unsafe) }
        let broken = htmlSource(config: configuration(resultSelector: "div["))
        #expect(throws: (any Error).self) { try SourceImporter.validate(broken) }
        let missingQuery = htmlSource(config: configuration(searchURL: "/search"))
        #expect(throws: (any Error).self) { try SourceImporter.validate(missingQuery) }
        #expect(throws: (any Error).self) { try SourceImporter.decode(Data("[]".utf8)) }
    }

    @Test func testSearchURLUsesUTF8AndEscapesQuerySeparators() throws {
        let source = htmlSource()
        let url = try SourceURL.search(query: "红楼梦 & page=2+#", source: source, config: source.html!)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.queryItems?.filter { $0.name == "q" }.first?.value == "红楼梦 & page=2+#")
        #expect(components.queryItems?.count == 1)
        #expect(components.fragment == nil)
        #expect(url.absoluteString.contains("%E7%BA%A2"))
    }

    @Test func testGBKSearchEncodingAndDecoding() throws {
        let config = configuration(encoding: .gbk)
        let url = try SourceURL.search(query: "三国演义", source: htmlSource(config: config), config: config)
        #expect(url.absoluteString.contains("%C8%FD%B9%FA%D1%DD%D2%E5"))
        let bytes = Data([0xC8, 0xFD, 0xB9, 0xFA, 0xD1, 0xDD, 0xD2, 0xE5])
        #expect(try HTMLParsing.decode(bytes, encoding: .gb18030) == "三国演义")
        #expect(throws: (any Error).self) { try HTMLParsing.decode(bytes, encoding: .utf8) }
    }

    @Test func testHTMLSearchCatalogAndContentPipeline() async throws {
        let source = htmlSource(config: configuration(catalogLinkSelector: ".catalog"))
        let client = StubClient { request in
            #expect(request.timeoutInterval == 15)
            #expect(request.value(forHTTPHeaderField: "User-Agent") != nil)
            switch request.url!.path {
            case "/search":
                return response(request, html: """
                <div class="book"><a class="title" href="/book/1">测试小说</a><span class="author">作者甲</span><p class="summary">简介</p><img src="/cover.jpg"></div>
                <div class="book"><a class="title" href="/book/1">重复结果</a></div>
                <div class="book"><a class="title" href="javascript:alert(1)">坏链接</a></div>
                """)
            case "/book/1": return response(request, html: "<a class='catalog' href='/toc/1'>目录</a>")
            case "/toc/1":
                return response(request, html: "<div id='list'><a href='../chapter/1'>第一章</a><a href='../chapter/1#top'>重复</a><a href='/chapter/2'>第二章</a></div>")
            case "/chapter/1":
                return response(request, html: "<div id='content'>第一段&nbsp;字<br>第二段<p>第三段<em>强调</em></p><div class='ad'>广告</div><script>bad()</script></div>")
            default: throw URLError(.badURL)
            }
        }
        let service = ReadingService(sources: [source], client: client)
        let search = await service.search(query: "小说")
        #expect(search.failures.isEmpty)
        let book = try #require(search.books.first)
        #expect(search.books.count == 1)
        #expect(book.author == "作者甲")
        #expect(book.coverURL?.absoluteString == "https://books.example/cover.jpg")
        let chapters = try await service.chapters(for: book)
        #expect(chapters.map(\.title) == ["第一章", "第二章"])
        #expect(chapters.map(\.index) == [0, 1])
        let content = try await service.content(for: chapters[0], in: book)
        #expect(content.paragraphs == ["第一段 字", "第二段", "第三段强调"])
    }

    @Test func testContentPreservesParagraphsAndAvoidsNestedSelectorDuplication() throws {
        let html = "<article><p>一</p><div>二<br>三</div></article>"
        #expect(try HTMLParsing.content(html, selector: "article, p") == ["一", "二", "三"])
        #expect(throws: (any Error).self) { try HTMLParsing.content("<div></div>", selector: "#missing") }
        #expect(throws: (any Error).self) { try HTMLParsing.content("<div id='content'><script>bad</script></div>", selector: "#content") }
    }

    @Test func testFailedSourceDoesNotEraseSuccessfulSearchAndEmptyEnabledSetMakesNoRequests() async throws {
        let bad = htmlSource()
        let good = SourceDefinition.builtIn.first { $0.kind == .staticCatalog }!
        let client = StubClient { request in response(request, html: "unavailable", status: 503) }
        let service = ReadingService(sources: [bad, good], client: client)
        let search = await service.search(query: "三国")
        #expect(search.books.map(\.title) == ["三国演义"])
        #expect(search.failures.map(\.sourceID) == [bad.id])
        #expect(search.failures[0].message.contains("503"))
        let disabled = await service.search(query: "三国", enabledSourceIDs: [])
        #expect(disabled.books.isEmpty)
        #expect(disabled.failures.isEmpty)
    }

    @Test func testSearchCancellationCancelsInflightRequest() async {
        let started = AsyncStream<Void>.makeStream()
        let client = StubClient { _ in
            started.continuation.yield(())
            try await Task.sleep(nanoseconds: 30_000_000_000)
            throw URLError(.timedOut)
        }
        let service = ReadingService(sources: [htmlSource()], client: client)
        let task = Task { await service.search(query: "取消") }
        var iterator = started.stream.makeAsyncIterator()
        _ = await iterator.next()
        task.cancel()
        let search = await task.value
        #expect(search.books.isEmpty)
        #expect(search.failures.isEmpty)
        started.continuation.finish()
    }

    @Test func testSearchPublishesFastSourceBeforeSlowSourceFinishes() async throws {
        let gate = AsyncGate()
        let updates = AsyncStream<SearchResponse>.makeStream()
        let good = SourceDefinition.builtIn.first { $0.kind == .staticCatalog }!
        let service = ReadingService(sources: [htmlSource(), good], client: StubClient { request in
            await gate.wait()
            return response(request, html: "unavailable", status: 503)
        })
        let task = Task {
            await service.search(query: "三国", onUpdate: { result in
                updates.continuation.yield(result)
            })
        }
        var iterator = updates.stream.makeAsyncIterator()
        let first = try #require(await iterator.next())
        #expect(first.books.map(\.title) == ["三国演义"])
        #expect(first.failures.isEmpty)
        await gate.release()
        let final = await task.value
        #expect(final.books.count == 1)
        #expect(final.failures.count == 1)
        updates.continuation.finish()
    }

    @Test func testMediaWikiSearchCatalogContentAndQueryEncoding() async throws {
        let source = SourceDefinition.builtIn.first { $0.kind == .mediaWiki }!
        let client = StubClient { request in
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
            if values["action"] == "query" {
                #expect(values["srsearch"] == "西遊記 & test")
                return response(request, html: #"{"query":{"search":[{"title":"西遊記","snippet":"<span>西遊記</span> 简介"}]}}"#)
            }
            if values["page"] == "西遊記" {
                let html = """
                <div class='mw-parser-output'><div id='headerContainer'><a href='/wiki/Author:吳承恩'>作者</a></div>
                <ul><li><a href='/wiki/西遊記/第001回'>第一回</a> 灵根育孕源流出</li>
                <li><a href='/wiki/西遊記/第002回'>第二回</a></li></ul>
                <a href='/wiki/其他作品'>相关</a><a href='/wiki/西遊記/第001回#top'>重复</a></div>
                """
                return try jsonResponse(request, object: ["parse": ["title": "西遊記", "text": html]])
            }
            #expect(values["page"] == "西遊記/第001回")
            return try jsonResponse(request, object: ["parse": ["title": "西遊記/第001回", "text": "<div class='mw-parser-output'><div id='headerContainer'>上一回</div><p>正文一。</p><p>正文二。</p><div class='noprint'>导航</div></div>"]])
        }
        let service = ReadingService(sources: [source], client: client)
        let result = await service.search(query: "西遊記 & test")
        let book = try #require(result.books.first)
        #expect(book.summary == "西遊記 简介")
        let chapters = try await service.chapters(for: book)
        #expect(chapters.count == 2)
        #expect(chapters[0].title.contains("灵根育孕源流出"))
        let content = try await service.content(for: chapters[0], in: book)
        #expect(content.paragraphs == ["正文一。", "正文二。"])
    }

    @Test func testRemoteAPIErrorIsReportedAsSourceFailure() async {
        let source = SourceDefinition.builtIn.first { $0.kind == .mediaWiki }!
        let service = ReadingService(sources: [source], client: StubClient { request in
            response(request, html: #"{"error":{"code":"ratelimited","info":"Please retry later"}}"#)
        })
        let result = await service.search(query: "西游记")
        #expect(result.books.isEmpty)
        #expect(result.failures.first?.message == "Please retry later")
    }

    @Test func testStaticCatalogSearchMatchesTraditionalAndFetchesActualFileConvention() async throws {
        let source = SourceDefinition.builtIn.first { $0.kind == .staticCatalog }!
        let service = ReadingService(sources: [source], client: StubClient { request in
            if request.url!.lastPathComponent == "info.json" {
                return response(request, html: #"{"catalogues":["第一回 桃园结义","第二回 怒鞭督邮"],"catalogueTotal":2}"#)
            }
            #expect(request.url!.lastPathComponent == "0.html")
            return response(request, html: "话说天下大势，分久必合。<br>合久必分。")
        })
        let result = await service.search(query: "《三國演義》")
        let book = try #require(result.books.first)
        #expect(book.title == "三国演义")
        let chapters = try await service.chapters(for: book)
        #expect(chapters.count == 2)
        let content = try await service.content(for: chapters[0], in: book)
        #expect(content.paragraphs == ["话说天下大势，分久必合。", "合久必分。"])
    }

    @Test func testCatalogHTTPErrorAndMissingSourcePropagate() async throws {
        let source = htmlSource()
        let book = Book(title: "书", sourceID: source.id, sourceName: source.name, url: source.homeURL)
        let service = ReadingService(sources: [source], client: StubClient { request in response(request, html: "", status: 429) })
        do {
            _ = try await service.chapters(for: book)
            Issue.record("Expected HTTP error")
        } catch ReadingError.httpStatus(let status) {
            #expect(status == 429)
        }
        let missing = ReadingService(sources: [])
        do {
            _ = try await missing.chapters(for: book)
            Issue.record("Expected missing source")
        } catch ReadingError.sourceUnavailable(let id) {
            #expect(id == source.id)
        }
    }
}

private struct StubClient: HTTPClient {
    let handler: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    init(_ handler: @escaping @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)) { self.handler = handler }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) { try await handler(request) }
}

private actor AsyncGate {
    private var isOpen = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() {
        isOpen = true
        continuation?.resume()
        continuation = nil
    }
}

private func response(_ request: URLRequest, html: String, status: Int = 200) -> (Data, HTTPURLResponse) {
    (Data(html.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!)
}

private func jsonResponse(_ request: URLRequest, object: [String: Any]) throws -> (Data, HTTPURLResponse) {
    (try JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!)
}

private func htmlSource(config: HTMLSourceConfiguration? = nil) -> SourceDefinition {
    SourceDefinition(id: "test-html", name: "测试源", homeURL: URL(string: "https://books.example")!, kind: .html, html: config ?? configuration())
}

private func configuration(searchURL: String = "/search?q={query}", encoding: HTMLSourceConfiguration.Encoding = .utf8, resultSelector: String = ".book", catalogLinkSelector: String? = nil) -> HTMLSourceConfiguration {
    HTMLSourceConfiguration(searchURL: searchURL, encoding: encoding, resultSelector: resultSelector,
                            titleSelector: "a.title", linkSelector: "a.title", authorSelector: ".author",
                            summarySelector: ".summary", coverSelector: "img", catalogLinkSelector: catalogLinkSelector,
                            chapterSelector: "#list a", contentSelector: "#content", removeSelectors: [".ad"])
}
