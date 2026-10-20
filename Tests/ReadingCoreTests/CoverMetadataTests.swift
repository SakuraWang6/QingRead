import Foundation
import Testing
@testable import ReadingCore

struct CoverMetadataTests {
    @Test func detailMetadataResolvesRelativeCoverWithoutChoosingLogo() throws {
        let base = URL(string: "https://books.example/book/12/")!
        #expect(try HTMLParsing.coverURL("<img src='/logo.png'><meta property='og:image' content='../../covers/12.jpg'>", baseURL: base)?.absoluteString == "https://books.example/covers/12.jpg")
        #expect(try HTMLParsing.coverURL("<img src='/advert.jpg'>", baseURL: base) == nil)
    }

    @Test func lazyCoverSkipsEmptyAndPlaceholderAttributes() throws {
        let base = URL(string: "https://books.example/book/12")!
        let html = "<div class='book-cover'><img data-original='' data-src='//cdn.example/12.webp' src='/loading.gif'></div>"
        #expect(try HTMLParsing.coverURL(html, baseURL: base)?.absoluteString == "https://cdn.example/12.webp")
        #expect(try HTMLParsing.coverURL("<div id='fmimg'><img src='data:image/png;base64,x'></div>", baseURL: base) == nil)
        #expect(try HTMLParsing.coverURL("<meta property='og:image' content='/images/nocover.jpg'>", baseURL: base) == nil)
    }

    @Test func searchCoverFallsBackFromEmptyLazyAttributeToActualSource() throws {
        let config = HTMLSourceConfiguration(searchURL: "/?q={query}", resultSelector: ".book", titleSelector: "a", linkSelector: "a", coverSelector: "img", chapterSelector: "a", contentSelector: "article")
        let source = SourceDefinition(id: "cover-test", name: "cover", homeURL: URL(string: "https://books.example")!, kind: .html, html: config)
        let html = "<div class='book'><a href='/1'>书名</a><img data-src='' src='/1.jpg'></div>"
        #expect(try HTMLParsing.search(html, baseURL: source.homeURL, source: source, config: config).first?.coverURL?.absoluteString == "https://books.example/1.jpg")
    }
}
