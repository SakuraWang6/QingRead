import Foundation
import SwiftSoup

struct MediaWikiSource: Sendable {
    let source: SourceDefinition
    let fetcher: PageFetcher

    func search(query: String) async throws -> [Book] {
        let url = try SourceURL.api(source, parameters: [
            "action": "query", "list": "search", "srsearch": query,
            "srnamespace": "0", "srlimit": "20", "srprop": "snippet"
        ])
        let (data, _) = try await fetcher.data(at: url)
        let response = try JSONDecoder().decode(SearchEnvelope.self, from: data)
        if let error = response.error { throw ReadingError.remote(error.info) }
        guard let results = response.query?.search else { throw ReadingError.invalidResponse }
        var seen = Set<String>()
        return try results.filter { seen.insert($0.title).inserted }.map { result in
            Book(title: result.title, summary: try HTMLParsing.plainText(result.snippet ?? ""),
                 sourceID: source.id, sourceName: source.name,
                 url: try SourceURL.wiki(title: result.title, source: source))
        }
    }

    func chapters(for book: Book) async throws -> [Chapter] {
        let title = try SourceURL.wikiTitle(from: book.url)
        let page = try await page(title: title)
        let document = try SwiftSoup.parse(page.html, source.homeURL.absoluteString)
        try document.select("#headerContainer, .ws-header, .noprint, .catlinks, #licenseContainer, .ws-footer").remove()
        var chapters: [Chapter] = []
        var seen = Set<URL>()
        for anchor in try document.select("a[href]") {
            guard let url = try? SourceURL.resolve(anchor.attr("href"), relativeTo: source.homeURL),
                  url.host == source.homeURL.host,
                  let linkedTitle = try? SourceURL.wikiTitle(from: url),
                  linkedTitle.hasPrefix(page.title + "/"),
                  !anchor.hasClass("new"), seen.insert(url).inserted else { continue }
            let text = try anchor.text()
            guard !text.isEmpty else { continue }
            let label = try anchor.parent()?.tagName() == "li" ? anchor.parent()?.text() ?? text : text
            chapters.append(Chapter(title: label, url: url, index: chapters.count))
        }
        // Short works can consist of one page rather than a table of contents.
        if chapters.isEmpty { return [Chapter(title: page.title, url: book.url, index: 0)] }
        return chapters
    }

    func content(for chapter: Chapter) async throws -> ChapterContent {
        let title = try SourceURL.wikiTitle(from: chapter.url)
        let page = try await page(title: title)
        let paragraphs = try HTMLParsing.content(page.html, selector: ".mw-parser-output", removing: [
            "#headerContainer", "#header", "#footer", ".ws-header", ".ws-footer", ".noprint",
            ".mw-editsection", ".catlinks", "#licenseContainer", ".licensetpl", ".navigation-not-searchable",
            ".sistersitebox", ".ws-noexport", ".printfooter", ".reference", ".references", ".variant-tooltip"
        ])
        return ChapterContent(chapter: chapter, paragraphs: paragraphs)
    }

    private func page(title: String) async throws -> (title: String, html: String) {
        let url = try SourceURL.api(source, parameters: [
            "action": "parse", "page": title, "prop": "text", "redirects": "1", "disableeditsection": "1"
        ])
        let (data, _) = try await fetcher.data(at: url)
        let response = try JSONDecoder().decode(ParseEnvelope.self, from: data)
        if let error = response.error { throw ReadingError.remote(error.info) }
        guard let page = response.parse else { throw ReadingError.invalidResponse }
        return (page.title, page.text)
    }

    private struct APIError: Decodable { let info: String }
    private struct SearchEnvelope: Decodable {
        let query: Query?
        let error: APIError?
        struct Query: Decodable { let search: [Result] }
        struct Result: Decodable { let title: String; let snippet: String? }
    }
    private struct ParseEnvelope: Decodable {
        let parse: Page?
        let error: APIError?
        struct Page: Decodable { let title: String; let text: String }
    }
}
