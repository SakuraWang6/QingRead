import Foundation
import SwiftSoup

enum HTMLParsing {
    static func decode(_ data: Data, encoding: HTMLSourceConfiguration.Encoding) throws -> String {
        guard let string = String(data: data, encoding: encoding.stringEncoding) else { throw ReadingError.decodingFailed }
        return string
    }

    static func search(_ html: String, baseURL: URL, source: SourceDefinition, config: HTMLSourceConfiguration) throws -> [Book] {
        let document = try SwiftSoup.parse(html, baseURL.absoluteString)
        let rows = try document.select(config.resultSelector)
        var books: [Book] = []
        var seen = Set<URL>()
        for row in rows {
            try Task.checkCancellation()
            guard let titleElement = try row.select(config.titleSelector).first(),
                  let link = try row.select(config.linkSelector).first(),
                  let url = try? SourceURL.resolve(link.attr("href"), relativeTo: baseURL) else { continue }
            let title = try titleElement.text().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, seen.insert(url).inserted else { continue }
            let cover: URL?
            if let selector = config.coverSelector, let image = try row.select(selector).first() {
                let src = try image.hasAttr("data-src") ? image.attr("data-src") : image.attr("src")
                cover = try? SourceURL.resolve(src, relativeTo: baseURL)
            } else { cover = nil }
            books.append(Book(title: title,
                              author: try text(config.authorSelector, in: row),
                              summary: try text(config.summarySelector, in: row),
                              coverURL: cover, sourceID: source.id, sourceName: source.name, url: url))
        }
        if !rows.isEmpty(), books.isEmpty {
            throw ReadingError.parsingFailed("搜索结果中没有有效的书名或链接，请检查 CSS 规则。")
        }
        return books
    }

    static func catalogURL(_ html: String, baseURL: URL, selector: String?) throws -> URL? {
        guard let selector else { return nil }
        let document = try SwiftSoup.parse(html, baseURL.absoluteString)
        guard let link = try document.select(selector).first() else {
            throw ReadingError.parsingFailed("没有找到目录链接。")
        }
        return try SourceURL.resolve(link.attr("href"), relativeTo: baseURL)
    }

    static func chapters(_ html: String, baseURL: URL, config: HTMLSourceConfiguration) throws -> [Chapter] {
        let document = try SwiftSoup.parse(html, baseURL.absoluteString)
        var chapters: [Chapter] = []
        var seen = Set<URL>()
        for element in try document.select(config.chapterSelector) {
            let link = element.tagName() == "a" ? element : try element.select("a[href]").first()
            guard let link, let url = try? SourceURL.resolve(link.attr("href"), relativeTo: baseURL) else { continue }
            let title = try link.text().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, seen.insert(url).inserted else { continue }
            chapters.append(Chapter(title: title, url: url, index: chapters.count))
        }
        guard !chapters.isEmpty else { throw ReadingError.parsingFailed("没有找到章节目录，请检查 chapterSelector。") }
        return chapters
    }

    static func content(_ html: String, selector: String, removing selectors: [String] = []) throws -> [String] {
        let document = try SwiftSoup.parse(html)
        try document.select((["script", "style", "noscript", "iframe"] + selectors).joined(separator: ",")).remove()
        let elements = try document.select(selector)
        guard !elements.isEmpty() else { throw ReadingError.emptyContent }
        // Selectors may match both a parent and a child. Render only the outermost matches.
        let roots = elements.array().filter { element in
            !elements.array().contains { other in other !== element && element.parents().array().contains { $0 === other } }
        }
        let text = roots.map(render).joined(separator: "\n")
        let paragraphs = text.components(separatedBy: .newlines)
            .map { $0.replacingOccurrences(of: "\u{00a0}", with: " ").trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !paragraphs.isEmpty else { throw ReadingError.emptyContent }
        return paragraphs
    }

    static func plainText(_ html: String) throws -> String { try SwiftSoup.parseBodyFragment(html).text() }

    private static func text(_ selector: String?, in element: Element) throws -> String {
        guard let selector else { return "" }
        return try element.select(selector).first()?.text() ?? ""
    }

    private static let blockTags: Set<String> = ["p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr", "pre"]

    private static func render(_ node: Node) -> String {
        if let text = node as? TextNode { return text.getWholeText() }
        guard let element = node as? Element else { return "" }
        let tag = element.tagName().lowercased()
        if tag == "br" { return "\n" }
        let children = node.getChildNodes().map(render).joined()
        return blockTags.contains(tag) ? "\n" + children + "\n" : children
    }
}
