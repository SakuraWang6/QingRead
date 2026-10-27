import Testing
@testable import ReadingCore
import Foundation
import CoreFoundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@Suite struct SourceExpansionTests {
    @Test func literatureSearchAcceptsAnchorCardsWithoutInventingMetadata() async throws {
        let source = try #require(SourceDefinition.builtIn.first { $0.id == "bailushuyuan" })
        try SourceImporter.validate(source)
        let service = ReadingService(sources: [source], client: ExpansionStub { request in
            let url = request.url!
            if url.path.hasPrefix("/novel/traditional/categories/4/search/") {
                #expect(url.lastPathComponent == "测试")
                return expansionHTML(request, """
                <aside><a class="col-6" title="广告书" href="/advertisement"><div class="text-truncate">广告书</div></a></aside>
                <main><div class="card-body"><div class="row">
                <a class="col-4" title="测试作者" href="/author"><div class="text-truncate">测试作者</div></a>
                <a class="col-6 col-sm-4" title="测试文学" href="/literature">
                <div class="bg-body-tertiary"></div><div class="text-truncate">测试文学</div></a>
                </div></div></main>
                """)
            }
            if url.path == "/literature" {
                return expansionHTML(request, """
                <a href="/novel/traditional/chapters/999">最新章节</a>
                <main><article><ol>
                <li><a href="/novel/traditional/chapters/42">第一节</a></li>
                <li><a href="/novel/traditional/chapters/7">第二节</a></li>
                <li><a href="/novel/traditional/chapters/19">第三节</a></li>
                </ol></article><a href="/novel/traditional/chapters/999">推荐章节</a></main>
                """)
            }
            #expect(url.path == "/novel/traditional/chapters/42")
            return expansionHTML(request, """
            <nav>上一章 下一章</nav><h1>第一节</h1>
            <div id="chaptersShowContent"><p>测试甲段</p><p>测试乙段</p><script>advertisement()</script></div>
            <aside>相关推荐</aside>
            """)
        })
        let result = await service.search(query: "测试")
        #expect(result.failures.isEmpty)
        #expect(result.books.map(\.title) == ["测试文学"])
        let book = try #require(result.books.first)
        #expect(book.url.path == "/literature")
        #expect(book.author.isEmpty)
        #expect(book.coverURL == nil)
        let chapters = try await service.chapters(for: book)
        #expect(chapters.map(\.title) == ["第一节", "第二节", "第三节"])
        #expect(chapters.map(\.index) == [0, 1, 2])
        #expect(chapters.map(\.url.lastPathComponent) == ["42", "7", "19"])
        let content = try await service.content(for: #require(chapters.first), in: book)
        #expect(content.paragraphs == ["测试甲段", "测试乙段"])
    }

    @Test func literatureRuleCanBeImportedIntoAnExistingClient() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let sources = try SourceImporter.decode(Data(contentsOf: root.appendingPathComponent("docs/book-sources/bailushuyuan.json")))
        let source = try #require(sources.first)
        let builtIn = try #require(SourceDefinition.builtIn.first { $0.id == "bailushuyuan" })
        #expect(sources.count == 1)
        #expect(source.id == builtIn.id)
        #expect(source.homeURL == builtIn.homeURL)
        #expect(source.kind == builtIn.kind)
        #expect(source.html == builtIn.html)
    }

    @Test func mixedPageEncodingsUseDeclaredCharsetAndRetainConfiguredFallback() throws {
        let big5 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.big5.rawValue)))
        let search = "<meta charset='UTF-8'><h1>超神机械师</h1>"
        let chapter = "<meta http-equiv='Content-Type' content='text/html; charset=big5'><p>繁體章節</p>"
        let chapterData = try #require(chapter.data(using: big5))
        #expect(try HTMLParsing.decode(Data(search.utf8), encoding: .gbk) == search)
        #expect(try HTMLParsing.decode(chapterData, encoding: .utf8) == chapter)
        var extendedBig5 = Data("<meta charset='big5'><p>".utf8)
        extendedBig5.append(contentsOf: [0xC6, 0xA7])
        extendedBig5.append(Data("</p>".utf8))
        #expect(try HTMLParsing.decode(extendedBig5, encoding: .utf8) == "<meta charset='big5'><p>⑦</p>")

        let gbk = HTMLSourceConfiguration.Encoding.gbk.stringEncoding
        let unknown = "<meta charset='made-up'><p>中文章节</p>"
        #expect(try HTMLParsing.decode(#require(unknown.data(using: gbk)), encoding: .gbk) == unknown)
        let incorrect = "<meta charset='utf-8'><p>中文章节</p>"
        #expect(try HTMLParsing.decode(#require(incorrect.data(using: gbk)), encoding: .gbk) == incorrect)
        let metaLikeText = "<script>const charset='big5'</script><p>中文</p>"
        #expect(try HTMLParsing.decode(Data(metaLikeText.utf8), encoding: .utf8) == metaLikeText)
    }

    @Test func wikiTitleSearchNormalizesTraditionalAndRejectsLegalDocumentsAndChapterNoise() async throws {
        let source = try #require(SourceDefinition.builtIn.first { $0.kind == .mediaWiki })
        let service = ReadingService(sources: [source], client: ExpansionStub { request in
            let values = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            #expect(values.first { $0.name == "srsearch" }?.value == "intitle:\"三國演義\"")
            #expect(!values.contains { $0.name == "srwhat" })
            let titles = ["三国演义公司租赁合同纠纷民事判决书", "三國演義/第001回", "三國演義 (消歧義)", "反三國演義", "三國演義", "三国演义", "武汉市文化公司民事判决书"]
            return try expansionJSON(request, ["query": ["search": titles.map { ["title": $0, "snippet": "测试摘要"] }]])
        })
        let result = await service.search(query: "《三国演义》")
        #expect(result.failures.isEmpty)
        #expect(result.books.map(\.title) == ["三國演義", "反三國演義"])
    }

    @Test func wikiMissingNovelReturnsNoUnrelatedFullTextHitsAndPreservesShortWorks() async throws {
        let source = try #require(SourceDefinition.builtIn.first { $0.kind == .mediaWiki })
        let service = ReadingService(sources: [source], client: ExpansionStub { request in
            let term = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "srsearch" }!.value!
            if term.contains("桃花源記") {
                return try expansionJSON(request, ["query": ["search": [
                    ["title": "西安桃花源记有限公司民事判决书", "snippet": ""],
                    ["title": "桃花源記", "snippet": "古文"]
                ]]])
            }
            return try expansionJSON(request, ["query": ["search": [["title": "武汉市人民法院民事判决书", "snippet": "提到超神机械师"]]]])
        })
        #expect(await service.search(query: "超神机械师").books.isEmpty)
        #expect(await service.search(query: "桃花源记").books.map(\.title) == ["桃花源記"])
    }

    @Test(arguments: ["canghaishuge", "biquge-tw", "piaotia"])
    func newWebSourceSelectorsFollowSeparateCatalogsAndIgnoreLatestChapterLinks(sourceID: String) async throws {
        let source = try #require(SourceDefinition.builtIn.first { $0.id == sourceID })
        try SourceImporter.validate(source)
        let client = ExpansionStub { request in
            let url = request.url!
            if url.path == "/search.html" {
                return expansionHTML(request, "<article class='shiguang-search-book'><h3><a href='/book/'>测试书</a></h3><div class='meta'><span>测试作者</span></div><a class='cover'><img src='/cover.webp'></a></article>")
            }
            if url.path == "/search" || url.path == "/search/" {
                return expansionHTML(request, "<div class='result-card'><a class='book-title' href='/book.html'>测试书</a><span class='author'>测试作者</span><div class='book-cover'><img src='/cover.webp'></div></div>")
            }
            if url.path == "/modules/article/search.php" {
                return expansionHTML(request, "<div id='centerm'><div id='content'><h1>测试书</h1><a title='点击阅读测试书' href='/book/'>开始阅读</a><img src='/files/article/image/cover.webp'></div></div>")
            }
            if url.path == "/book.html" {
                return expansionHTML(request, "<a class='chapterlist' href='/book/'>目录</a><span class='btopt'><a href='/book/'>开始阅读</a></span><a href='/latest.html'>最新章节</a>")
            }
            if url.path == "/book" || url.path == "/book/" {
                return expansionHTML(request, "<a href='/latest.html'>最新章节</a><section id='catalog'><div class='list'><a href='/chapter.html'>第一章</a></div></section><div class='booklist'><ul><li><a href='/chapter.html'>第一章</a></li></ul></div><div class='centent'><ul><li><a href='/chapter.html'>第一章</a></li></ul></div>")
            }
            #expect(url.path == "/chapter.html")
            return expansionHTML(request, "<div class='shiguang-reader-content'><p>甲段</p></div><div id='chaptercontent'>乙段</div>丙段<br>丁段")
        }
        let service = ReadingService(sources: [source], client: client)
        let result = await service.search(query: "测试")
        #expect(result.failures.isEmpty)
        let book = try #require(result.books.first)
        #expect(book.title == "测试书")
        #expect(book.coverURL?.lastPathComponent == "cover.webp")
        let chapters = try await service.chapters(for: book)
        #expect(chapters.count == 1)
        #expect(chapters[0].url.lastPathComponent == "chapter.html")
        #expect(!(try await service.content(for: chapters[0], in: book)).paragraphs.isEmpty)
    }

    @Test func piaotiaAcceptsSearchListsAndRedirectedBookPagesWithoutCommentNoise() throws {
        let source = try #require(SourceDefinition.builtIn.first { $0.id == "piaotia" })
        let config = try #require(source.html)
        let list = """
        <table class="grid"><tr><th>书名</th></tr><tr>
        <td class="odd"><a href="/bookinfo/1/2.html">机械故事</a></td>
        <td class="even"><a href="/html/1/2/index.html">最新章节</a></td>
        <td class="odd">作者甲</td></tr></table>
        """
        let books = try HTMLParsing.search(list, baseURL: source.homeURL, source: source, config: config)
        #expect(books.count == 1)
        #expect(books.first?.title == "机械故事")
        #expect(books.first?.author == "作者甲")
        #expect(books.first?.url.path == "/html/1/2/index.html")
        let detail = """
        <div id="left"><div id="content"><img src="/files/article/image/wrong-cover.jpg"></div></div>
        <div id="centerm"><div id="content"><h1>超神机械师</h1>
        <a title="点击阅读《超神机械师》" href="/html/9/9051/">阅读</a>
        <img src="/files/article/image/correct-cover.jpg">
        <table class="grid"><tr><td class="odd">评论者</td><td class="even"><a href="/comments/1">评论</a></td></tr></table>
        </div></div>
        """
        let exact = try HTMLParsing.search(detail, baseURL: source.homeURL, source: source, config: config)
        #expect(exact.count == 1)
        #expect(exact.first?.title == "超神机械师")
        #expect(exact.first?.url.path == "/html/9/9051")
        #expect(exact.first?.coverURL?.lastPathComponent == "correct-cover.jpg")
        let paragraphs = try HTMLParsing.content("<div>网站导航</div>甲段<br>乙段<script>ad()</script><div>推荐广告</div>", selector: config.contentSelector, removing: config.removeSelectors)
        #expect(paragraphs == ["甲段", "乙段"])
    }

    // An explicit network smoke test, excluded from normal offline regression runs.
    // Run with QINGREAD_LIVE_SOURCES=1 swift test --filter liveSourcePipelines.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["QINGREAD_LIVE_SOURCES"] == "1"))
    func liveSourcePipelines() async throws {
        let service = ReadingService()
        for sourceID in ["canghaishuge", "biquge-tw", "piaotia"] {
            let search = await service.search(query: "超神机械师", enabledSourceIDs: [sourceID])
            let book = try #require(search.books.first { normalize($0.title) == "超神机械师" })
            let chapters = try await service.chapters(for: book)
            #expect(!chapters.isEmpty)
            let first = try #require(chapters.first)
            let content = try await service.content(for: first, in: book)
            #expect(content.paragraphs.joined().count > 100)
            print("LIVE \(sourceID): search \(search.books.count), catalog \(chapters.count), first chapter \(content.paragraphs.count) paragraphs")
        }
        for query in ["三国演义", "桃花源记"] {
            let search = await service.search(query: query, enabledSourceIDs: ["zh-wikisource"])
            let book = try #require(search.books.first { normalize($0.title) == query })
            let chapters = try await service.chapters(for: book)
            let content = try await service.content(for: #require(chapters.first), in: book)
            #expect(!content.paragraphs.isEmpty)
            print("LIVE Wiki \(query): \(search.books.count) results, \(chapters.count) chapters")
        }
        let absentNovel = await service.search(query: "超神机械师", enabledSourceIDs: ["zh-wikisource"])
        #expect(absentNovel.books.isEmpty)
        #expect(absentNovel.failures.isEmpty)
    }
}

private func normalize(_ value: String) -> String {
    (value.applyingTransform(StringTransform("Traditional-Simplified"), reverse: false) ?? value)
        .filter { $0.isLetter || $0.isNumber }
}

private struct ExpansionStub: HTTPClient {
    let handler: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    init(_ handler: @escaping @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)) { self.handler = handler }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) { try await handler(request) }
}

private func expansionHTML(_ request: URLRequest, _ html: String) -> (Data, HTTPURLResponse) {
    (Data(("<meta charset='utf-8'>" + html).utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
}

private func expansionJSON(_ request: URLRequest, _ object: [String: Any]) throws -> (Data, HTTPURLResponse) {
    (try JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
}
