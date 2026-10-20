import Testing
@testable import ReadingCore
import Foundation

@Suite struct DiscoveryTests {
    private let source = SourceDefinition.builtIn.first { $0.id == "biequgei" }!

    @Test func categoriesMatchPublishedRoutes() {
        #expect(DiscoveryCategory.all.map(\.id) == ["1", "2", "3", "4", "5", "6"])
        #expect(Set(DiscoveryCategory.all.map(\.title)).count == 6)
    }

    @Test func recommendationsPreserveBookIdentityAndResolveCovers() throws {
        let page = try DiscoveryParsing.recommendations("""
        <div class='layout-col2'><div class='item'>
          <div class='image'><img data-src='/covers/test.jpg'></div>
          <dl><dt><span>作者甲</span><a href='/novel/1.html'>测试书甲</a></dt><dd>书籍简介</dd></dl>
        </div></div>
        <div class='layout-col1'><ul class='txt-list'>
          <li><span class='s2'><a href='/novel/2.html'>测试书乙</a></span><span class='s5'>作者乙</span></li>
          <li><span class='s2'><a href='/novel/2.html#top'>重复书乙</a></span></li>
          <li><span class='s2'><a href='javascript:alert(1)'>坏链接</a></span></li>
        </ul></div>
        <div class='layout-col1'><ul class='txt-list'>
          <li><span class='s2'><a href='/novel/3.html'>更新列表的书</a></span></li>
        </ul></div>
        """, source: source)
        #expect(page.sections.map(\.id) == ["featured", "classic"])
        let book = try #require(page.sections.first?.books.first)
        #expect(book.id == "biequgei|https://www.biequgei.com/novel/1.html")
        #expect(book.coverURL?.absoluteString == "https://www.biequgei.com/covers/test.jpg")
        #expect(book.author == "作者甲")
        #expect(page.sections[1].books.count == 1)
        #expect(page.sections[1].books[0].author == "作者乙")
    }

    @Test func categoryMergesFeaturedAndListWithoutLosingRicherMetadata() throws {
        let books = try DiscoveryParsing.category("""
        <div class='layout-col2'><div class='item'><div class='image'><img src='/c.jpg'></div>
        <dt><span>作者甲</span><a href='/novel/1.html'>测试书甲</a></dt><dd>简介</dd></div></div>
        <ul class='txt-list'>
        <li><span class='s2'><a href='/novel/1.html'>重复书甲</a></span></li>
        <li><span class='s2'><a href='/novel/2.html'>测试书乙</a></span><span class='s4'>作者乙</span><span class='s5'>04-29</span></li>
        </ul>
        """, baseURL: source.homeURL.appendingPathComponent("lists/5.html"), source: source)
        #expect(books.map(\.title) == ["测试书甲", "测试书乙"])
        #expect(books[0].summary == "简介")
        #expect(books[0].coverURL != nil)
        #expect(books[1].author == "作者乙")
    }

    @Test func sourceMarkupChangesSurfaceAsErrorsInsteadOfAnEmptySuccess() {
        #expect(throws: (any Error).self) { try DiscoveryParsing.recommendations("<p>unavailable</p>", source: source) }
        #expect(throws: (any Error).self) { try DiscoveryParsing.category("<p>unavailable</p>", baseURL: source.homeURL, source: source) }
    }
}
