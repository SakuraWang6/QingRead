import Foundation

public struct Book: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let author: String
    public let summary: String
    public let coverURL: URL?
    public let sourceID: String
    public let sourceName: String
    public let url: URL

    public init(id: String? = nil, title: String, author: String = "", summary: String = "", coverURL: URL? = nil, sourceID: String, sourceName: String, url: URL) {
        self.id = id ?? "\(sourceID)|\(url.absoluteString)"
        self.title = title
        self.author = author
        self.summary = summary
        self.coverURL = coverURL
        self.sourceID = sourceID
        self.sourceName = sourceName
        self.url = url
    }
}

public struct Chapter: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let url: URL
    public let index: Int

    public init(id: String? = nil, title: String, url: URL, index: Int) {
        self.id = id ?? url.absoluteString
        self.title = title
        self.url = url
        self.index = index
    }
}

public struct ChapterContent: Codable, Hashable, Sendable {
    public let chapter: Chapter
    public let paragraphs: [String]

    public init(chapter: Chapter, paragraphs: [String]) {
        self.chapter = chapter
        self.paragraphs = paragraphs
    }
}

public struct SourceFailure: Codable, Hashable, Identifiable, Sendable {
    public var id: String { sourceID }
    public let sourceID: String
    public let sourceName: String
    public let message: String

    public init(sourceID: String, sourceName: String, message: String) {
        self.sourceID = sourceID
        self.sourceName = sourceName
        self.message = message
    }
}

public struct SearchResponse: Sendable {
    public let books: [Book]
    public let failures: [SourceFailure]

    public init(books: [Book], failures: [SourceFailure]) {
        self.books = books
        self.failures = failures
    }
}

public struct SourceDefinition: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case mediaWiki, html, staticCatalog }

    public let id: String
    public let name: String
    public let summary: String
    public let homeURL: URL
    public let kind: Kind
    public let apiURL: URL?
    public let html: HTMLSourceConfiguration?
    public let catalogBooks: [CatalogBookDefinition]

    public init(id: String, name: String, summary: String = "", homeURL: URL, kind: Kind, apiURL: URL? = nil, html: HTMLSourceConfiguration? = nil, catalogBooks: [CatalogBookDefinition] = []) {
        self.id = id
        self.name = name
        self.summary = summary
        self.homeURL = homeURL
        self.kind = kind
        self.apiURL = apiURL
        self.html = html
        self.catalogBooks = catalogBooks
    }

    public static let builtIn: [SourceDefinition] = WebSourceCatalog.sources + [
        SourceDefinition(
            id: "chinese-classics",
            name: "古典小说精选",
            summary: "收录三国演义、西游记、红楼梦三部经典，按书名或作者直接搜索；目录与章节从公开静态资料库加载。",
            homeURL: URL(string: "https://github.com/luoxuhai/chinese-novel")!,
            kind: .staticCatalog,
            catalogBooks: [
                CatalogBookDefinition(title: "三国演义", author: "罗贯中", summary: "东汉末年至西晋初年的历史演义，共一百二十回。", directoryURL: URL(string: "https://raw.githubusercontent.com/luoxuhai/chinese-novel/master/resources/历史演义/三国演义/")!),
                CatalogBookDefinition(title: "西游记", author: "吴承恩", summary: "唐僧师徒西行取经的神魔小说。", directoryURL: URL(string: "https://raw.githubusercontent.com/luoxuhai/chinese-novel/master/resources/鬼怪神魔/西游记/")!),
                CatalogBookDefinition(title: "红楼梦", author: "曹雪芹", summary: "以贾府兴衰为背景的古典长篇小说，共一百二十回。", directoryURL: URL(string: "https://raw.githubusercontent.com/luoxuhai/chinese-novel/master/resources/世态人情/红楼梦/")!)
            ]
        ),
        SourceDefinition(
            id: "zh-wikisource",
            name: "中文维基文库",
            summary: "免费文库，可直接搜索古典小说与公版作品。网络可达性因地区而异。",
            homeURL: URL(string: "https://zh.wikisource.org")!,
            kind: .mediaWiki,
            apiURL: URL(string: "https://zh.wikisource.org/w/api.php")!
        )
    ]

    private enum CodingKeys: String, CodingKey { case id, name, summary, homeURL, kind, apiURL, html, catalogBooks }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        summary = try values.decodeIfPresent(String.self, forKey: .summary) ?? ""
        homeURL = try values.decode(URL.self, forKey: .homeURL)
        kind = try values.decode(Kind.self, forKey: .kind)
        apiURL = try values.decodeIfPresent(URL.self, forKey: .apiURL)
        html = try values.decodeIfPresent(HTMLSourceConfiguration.self, forKey: .html)
        catalogBooks = try values.decodeIfPresent([CatalogBookDefinition].self, forKey: .catalogBooks) ?? []
    }
}

/// Static catalog metadata; actual chapter lists and prose are always fetched from the remote source.
public struct CatalogBookDefinition: Codable, Hashable, Sendable {
    public let title: String
    public let author: String
    public let summary: String
    public let directoryURL: URL

    public init(title: String, author: String, summary: String = "", directoryURL: URL) {
        self.title = title
        self.author = author
        self.summary = summary
        self.directoryURL = directoryURL
    }
}

/// A small, declarative CSS-rule format. It deliberately does not execute imported JavaScript.
public struct HTMLSourceConfiguration: Codable, Hashable, Sendable {
    public enum Encoding: String, Codable, Sendable { case utf8, gb18030, gbk }

    /// An absolute or home-relative URL containing `{query}`; substitution percent-encodes the search term.
    public let searchURL: String
    public let encoding: Encoding
    public let resultSelector: String
    public let titleSelector: String
    public let linkSelector: String
    public let authorSelector: String?
    public let summarySelector: String?
    public let coverSelector: String?
    /// Optional book-detail link to a separate table of contents.
    public let catalogLinkSelector: String?
    public let chapterSelector: String
    public let contentSelector: String
    public let removeSelectors: [String]

    public init(searchURL: String, encoding: Encoding = .utf8, resultSelector: String, titleSelector: String, linkSelector: String, authorSelector: String? = nil, summarySelector: String? = nil, coverSelector: String? = nil, catalogLinkSelector: String? = nil, chapterSelector: String, contentSelector: String, removeSelectors: [String] = []) {
        self.searchURL = searchURL
        self.encoding = encoding
        self.resultSelector = resultSelector
        self.titleSelector = titleSelector
        self.linkSelector = linkSelector
        self.authorSelector = authorSelector
        self.summarySelector = summarySelector
        self.coverSelector = coverSelector
        self.catalogLinkSelector = catalogLinkSelector
        self.chapterSelector = chapterSelector
        self.contentSelector = contentSelector
        self.removeSelectors = removeSelectors
    }

    private enum CodingKeys: String, CodingKey {
        case searchURL, encoding, resultSelector, titleSelector, linkSelector, authorSelector, summarySelector, coverSelector, catalogLinkSelector, chapterSelector, contentSelector, removeSelectors
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        searchURL = try values.decode(String.self, forKey: .searchURL)
        encoding = try values.decodeIfPresent(Encoding.self, forKey: .encoding) ?? .utf8
        resultSelector = try values.decode(String.self, forKey: .resultSelector)
        titleSelector = try values.decode(String.self, forKey: .titleSelector)
        linkSelector = try values.decode(String.self, forKey: .linkSelector)
        authorSelector = try values.decodeIfPresent(String.self, forKey: .authorSelector)
        summarySelector = try values.decodeIfPresent(String.self, forKey: .summarySelector)
        coverSelector = try values.decodeIfPresent(String.self, forKey: .coverSelector)
        catalogLinkSelector = try values.decodeIfPresent(String.self, forKey: .catalogLinkSelector)
        chapterSelector = try values.decode(String.self, forKey: .chapterSelector)
        contentSelector = try values.decode(String.self, forKey: .contentSelector)
        removeSelectors = try values.decodeIfPresent([String].self, forKey: .removeSelectors) ?? []
    }
}
