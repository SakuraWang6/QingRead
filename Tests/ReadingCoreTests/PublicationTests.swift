import Foundation
import Testing
@testable import ReadingCore

struct PublicationTests {
    @Test func epubUsesSpineOrderAndResolvesParentPathsWithinArchive() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/import.epub")
        let book = try PublicationImporter.read(url, format: .epub)
        #expect(book.title == "测试文学")
        #expect(book.author == "作者")
        #expect(book.chapters.map(\.title) == ["第一章", "第二章"])
        #expect(book.chapters[0].paragraphs == ["第一段正文。", "第二段正文。"])
    }

    @Test func rejectsArchiveEscapePaths() {
        for path in ["../evil", "/evil", "a/../../evil", "a\\evil", "a\0evil"] {
            #expect(throws: (any Error).self) { try PublicationImporter.checkedPath(path) }
        }
    }

    @Test func textRecognizesHeadingsAndBoundsUnbrokenExports() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(("第一章 开始\n正文。\n第二章 继续\n" + String(repeating: "长", count: 90_000)).utf8).write(to: url)
        let result = try PublicationImporter.read(url, format: .txt)
        #expect(result.chapters[0].title == "第一章 开始")
        #expect(result.chapters[0].paragraphs == ["正文。"])
        #expect(result.chapters.count >= 4)
        #expect(result.chapters.allSatisfy { $0.paragraphs.joined().utf16.count <= 40_000 })
        #expect(result.chapters.dropFirst().flatMap(\.paragraphs).joined().count == 90_000)
    }

    @Test func existingBookJSONStillDecodesWithoutFileMetadata() throws {
        let old = Data(#"{"id":"old","title":"书","author":"作者","summary":"","sourceID":"one","sourceName":"来源","url":"https://example.com/book"}"#.utf8)
        let book = try JSONDecoder().decode(Book.self, from: old)
        #expect(book.publicationFormat == nil)
        #expect(book.fileDownloadURL == nil)
    }

    @Test func officialTextbooksFilterLiveAnonymousPDFsAndMapChineseSearch() throws {
        let data = Data(#"{"items":[{"title":"Statistics","book_state":"live","pdf_url":"https://assets.openstax.org/book.pdf","meta":{"html_url":"https://openstax.org/details/books/statistics"}},{"title":"Statistics draft","book_state":"draft","pdf_url":"https://assets.openstax.org/draft.pdf"},{"title":"Statistics restricted","book_state":"live","require_login_message_text":"Login","pdf_url":"https://assets.openstax.org/locked.pdf"}]}"#.utf8)
        let source = SourceDefinition.builtIn.first { $0.id == "openstax" }!
        let books = try WholeBookSources.parse(data, query: "统计", source: source, baseURL: source.homeURL)
        #expect(books.count == 1)
        #expect(books.first?.publicationFormat == .pdf)
        #expect(books.first?.fileDownloadURL?.lastPathComponent == "book.pdf")
    }

    @Test func publisherDownloadLandingFollowsItsDeclaredSameHostRefresh() async throws {
        let source = SourceDefinition.builtIn.first { $0.id == "standard-ebooks" }!
        let book = Book(title: "Test", sourceID: source.id, sourceName: source.name, url: source.homeURL.appendingPathComponent("ebooks/test"), publicationFormat: .epub)
        let service = ReadingService(sources: [source], client: PublisherDownloadClient())
        let url = try await service.downloadURL(for: book)
        #expect(url.absoluteString == "https://standardebooks.org/downloads/test.epub?source=download")
        let unsafe = ReadingService(sources: [source], client: PublisherDownloadClient(unsafe: true))
        await #expect(throws: (any Error).self) { try await unsafe.downloadURL(for: book) }
    }
}

private struct PublisherDownloadClient: HTTPClient {
    var unsafe = false
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let html = url.path == "/ebooks/test" ? "<a href='/downloads/test.epub'>Compatible EPUB</a>" : "<meta http-equiv='refresh' content='0; url=\(unsafe ? "https://other.invalid" : "")/downloads/test.epub?source=download'>"
        return (Data(html.utf8), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
