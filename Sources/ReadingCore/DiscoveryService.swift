import Foundation
import SwiftSoup

public struct DiscoveryCategory: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String

    public static let all: [DiscoveryCategory] = [
        .init(id: "1", title: "玄幻奇幻"), .init(id: "2", title: "修真武侠"),
        .init(id: "3", title: "都市言情"), .init(id: "4", title: "穿越历史"),
        .init(id: "5", title: "网游竞技"), .init(id: "6", title: "科幻灵异")
    ]
}

public struct DiscoverySection: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let books: [Book]
}

public struct DiscoveryPage: Sendable {
    public let sections: [DiscoverySection]
}

/// Reads the source's published recommendations and category lists on demand.
/// The same source ID and canonical book URL are used by search, shelf and reader.
public actor DiscoveryService {
    private let fetcher: PageFetcher
    private let source: SourceDefinition

    public init(client: any HTTPClient = URLSessionHTTPClient()) {
        fetcher = PageFetcher(client: client)
        source = SourceDefinition.builtIn.first { $0.id == "biequgei" }!
    }

    public func recommendations() async throws -> DiscoveryPage {
        let html = try await load(source.homeURL)
        return try DiscoveryParsing.recommendations(html, source: source)
    }

    public func category(_ category: DiscoveryCategory) async throws -> [Book] {
        guard DiscoveryCategory.all.contains(category) else { throw ReadingError.invalidURL(category.id) }
        let url = source.homeURL.appendingPathComponent("lists/\(category.id).html")
        let html = try await load(url)
        return try DiscoveryParsing.category(html, baseURL: url, source: source)
    }

    private func load(_ url: URL) async throws -> String {
        let (data, _) = try await fetcher.data(at: url)
        return try HTMLParsing.decode(data, encoding: .utf8)
    }
}

enum DiscoveryParsing {
    static func recommendations(_ html: String, source: SourceDefinition) throws -> DiscoveryPage {
        let document = try SwiftSoup.parse(html, source.homeURL.absoluteString)
        let featured = try cards(in: document, source: source)
        // Later columns contain recent updates. Only the first recommendation
        // panel belongs to this section; do not relabel all update rows classic.
        let classic: [Book]
        if let panel = try document.select(".layout-col1").first() {
            classic = try rows(in: panel, selector: ".txt-list li", source: source)
        } else { classic = [] }
        let sections = [
            DiscoverySection(id: "featured", title: "热门推荐", books: featured),
            DiscoverySection(id: "classic", title: "经典推荐", books: classic)
        ].filter { !$0.books.isEmpty }
        guard !sections.isEmpty else { throw ReadingError.parsingFailed("暂时没有获取到推荐书目，请稍后重试。") }
        return DiscoveryPage(sections: sections)
    }

    static func category(_ html: String, baseURL: URL, source: SourceDefinition) throws -> [Book] {
        let document = try SwiftSoup.parse(html, baseURL.absoluteString)
        let result = unique(try cards(in: document, source: source) + rows(in: document, selector: ".txt-list li", source: source))
        guard !result.isEmpty else { throw ReadingError.parsingFailed("暂时没有获取到分类书目，请稍后重试。") }
        return result
    }

    private static func cards(in document: Document, source: SourceDefinition) throws -> [Book] {
        var result: [Book] = []
        for item in try document.select(".layout-col2 .item") {
            try Task.checkCancellation()
            guard let link = try item.select("dt a[href]").first(),
                  let url = try? SourceURL.resolve(link.attr("href"), relativeTo: source.homeURL) else { continue }
            let title = try link.text().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            let cover = try item.select(".image img").first().flatMap { image -> URL? in
                let src = try image.hasAttr("data-src") ? image.attr("data-src") : image.attr("src")
                return try? SourceURL.resolve(src, relativeTo: source.homeURL)
            }
            result.append(Book(title: title, author: try item.select("dt span").text(),
                               summary: try item.select("dd").text(), coverURL: cover,
                               sourceID: source.id, sourceName: source.name, url: url))
        }
        return unique(result)
    }

    private static func rows(in document: Element, selector: String, source: SourceDefinition) throws -> [Book] {
        var result: [Book] = []
        for item in try document.select(selector) {
            try Task.checkCancellation()
            guard let link = try item.select(".s2 a[href]").first(),
                  let url = try? SourceURL.resolve(link.attr("href"), relativeTo: source.homeURL) else { continue }
            let title = try link.text().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            // Full update tables put authors in s4 and dates in s5; compact
            // recommendation rows have only s5. Prefer the explicit author.
            let author = try item.select(".s4").text()
            result.append(Book(title: title, author: author.isEmpty ? try item.select(".s5").text() : author,
                               sourceID: source.id, sourceName: source.name, url: url))
        }
        return unique(result)
    }

    private static func unique(_ books: [Book]) -> [Book] {
        var seen = Set<String>()
        return books.filter { seen.insert($0.id).inserted }
    }
}
