import Foundation
import SwiftSoup

struct WholeBookSources {
    let source: SourceDefinition
    let fetcher: PageFetcher
    static let definitions: [SourceDefinition] = [
        .init(id: "gutenberg", name: "Project Gutenberg · 文学", summary: "中外经典文学，整本 EPUB。", homeURL: URL(string: "https://www.gutenberg.org")!, kind: .gutenberg),
        .init(id: "standard-ebooks", name: "Standard Ebooks · 英文文学", summary: "精校英文公版作品，整本 EPUB。", homeURL: URL(string: "https://standardebooks.org")!, kind: .standardEbooks),
        .init(id: "openstax", name: "OpenStax · 大学教材", summary: "开放教材，主要为英文，整本 PDF。", homeURL: URL(string: "https://openstax.org")!, kind: .openStax)
    ]

    func search(_ query: String) async throws -> [Book] {
        var components = URLComponents(url: source.homeURL, resolvingAgainstBaseURL: false)!
        switch source.kind {
        case .gutenberg:
            components.path = "/ebooks/search/"
            components.queryItems = [.init(name: "query", value: query.applyingTransform(StringTransform("Simplified-Traditional"), reverse: false) ?? query)]
        case .standardEbooks:
            components.path = "/ebooks"
            components.queryItems = [.init(name: "query", value: Self.literatureAliases[query] ?? query)]
        case .openStax:
            components.path = "/apps/cms/api/v2/pages/"
            components.queryItems = [.init(name: "type", value: "books.Book"), .init(name: "fields", value: "title,description,pdf_url,cover_url,book_state,authors,require_login_message_text"), .init(name: "limit", value: "200")]
        default: throw ReadingError.invalidSource("不是整本书来源。")
        }
        let (data, response) = try await fetcher.data(at: components.url!)
        return try Self.parse(data, query: query, source: source, baseURL: response.url ?? components.url!)
    }

    static func parse(_ data: Data, query: String, source: SourceDefinition, baseURL: URL) throws -> [Book] {
        if source.kind == .openStax {
            guard let page = try JSONSerialization.jsonObject(with: data) as? [String: Any], let items = page["items"] as? [[String: Any]] else { throw ReadingError.invalidResponse }
            let term = textbookAliases[query] ?? query
            return try items.compactMap { item in
                guard item["book_state"] as? String == "live", let title = item["title"] as? String,
                      let pdf = item["pdf_url"] as? String, let fileURL = URL(string: pdf), fileURL.isHTTP,
                      ((item["require_login_message_text"] as? String) ?? "").isEmpty else { return nil }
                let description = try HTMLParsing.plainText((item["description"] as? String) ?? "")
                let authors = (item["authors"] as? [[String: Any]] ?? []).compactMap { ($0["value"] as? [String: Any])?["name"] as? String }.joined(separator: ", ")
                guard (title + " " + authors + " " + description).localizedCaseInsensitiveContains(term) else { return nil }
                let meta = item["meta"] as? [String: Any] ?? [:]
                guard let pageURL = URL(string: meta["html_url"] as? String ?? ""), pageURL.isHTTP else { return nil }
                return Book(title: title, author: authors.isEmpty ? "OpenStax" : authors, summary: description,
                            coverURL: URL(string: item["cover_url"] as? String ?? ""), sourceID: source.id, sourceName: source.name,
                            url: pageURL, publicationFormat: .pdf, fileDownloadURL: fileURL)
            }
        }
        let html = String(decoding: data, as: UTF8.self)
        let document = try SwiftSoup.parse(html, baseURL.absoluteString)
        let rows = try document.select(source.kind == .gutenberg ? "li.booklink" : "li[typeof='schema:Book']")
        return try rows.array().compactMap { row in
            let titleSelector = source.kind == .gutenberg ? ".title" : "p > a [property='schema:name']"
            let linkSelector = source.kind == .gutenberg ? "a.link[href]" : "p > a[property='schema:url']"
            guard let link = try row.select(linkSelector).first(), let url = try? SourceURL.resolve(link.attr("href"), relativeTo: baseURL) else { return nil }
            let title = try row.select(titleSelector).first()?.text() ?? ""
            guard !title.isEmpty else { return nil }
            let author = try row.select(source.kind == .gutenberg ? ".subtitle" : ".author").text()
            let cover = try row.select("img[src]").first().flatMap { try? SourceURL.resolve($0.attr("src"), relativeTo: baseURL) }
            return Book(title: title, author: author, coverURL: cover, sourceID: source.id, sourceName: source.name, url: url, publicationFormat: .epub)
        }
    }

    func downloadURL(for book: Book) async throws -> URL {
        let (data, response) = try await fetcher.data(at: book.url)
        let base = response.url ?? book.url
        let doc = try SwiftSoup.parse(String(decoding: data, as: UTF8.self), base.absoluteString)
        let links = try doc.select("a[type='application/epub+zip'], a[href*='.epub']")
        for link in links {
            let href = try link.attr("href")
            if href.contains("advanced") { continue }
            if let url = try? SourceURL.resolve(href, relativeTo: base) {
                if source.kind == .standardEbooks {
                    // This publisher serves a download landing page first.
                    // Follow its declared refresh URL instead of importing HTML.
                    let (landing, response) = try await fetcher.data(at: url)
                    if landing.starts(with: [0x50, 0x4b]) { return url }
                    let page = try SwiftSoup.parse(String(decoding: landing, as: UTF8.self))
                    let refresh = try page.select("meta[http-equiv=refresh]").first()?.attr("content") ?? ""
                    if let marker = refresh.range(of: "url=", options: .caseInsensitive),
                       let target = try? SourceURL.resolve(String(refresh[marker.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: " '\"")), relativeTo: response.url ?? url),
                       target.host == url.host, target.pathExtension == "epub" { return target }
                    throw ReadingError.parsingFailed("来源未返回有效的 EPUB 下载地址。")
                }
                return url
            }
        }
        throw ReadingError.parsingFailed("来源没有返回可直接下载的 EPUB，请在原站点查看。");
    }

    private static let textbookAliases = ["统计": "statistics", "统计学": "statistics", "数学": "math", "微积分": "calculus", "物理": "physics", "化学": "chemistry", "生物": "biology", "经济": "economics", "经济学": "economics", "心理学": "psychology", "心理": "psychology", "金融": "finance", "会计": "accounting", "社会学": "sociology", "计算机": "computer", "商业": "business"]
    private static let literatureAliases = ["托尔斯泰": "Tolstoy", "战争与和平": "War and Peace", "傲慢与偏见": "Pride and Prejudice", "莎士比亚": "Shakespeare", "狄更斯": "Dickens", "福尔摩斯": "Sherlock Holmes"]
}
