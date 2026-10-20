import Foundation

/// Uses each site's real search form; no results or chapters are bundled here.
enum WebSourceCatalog {
    static let sources: [SourceDefinition] = [
        SourceDefinition(
            id: "biequgei", name: "笔趣阁 · biequgei",
            summary: "网络小说来源，支持站内搜书。目录与章节由来源网站提供。",
            homeURL: URL(string: "https://www.biequgei.com/")!, kind: .html,
            html: HTMLSourceConfiguration(
                searchURL: "/search.html?keyword={query}",
                resultSelector: ".txt-list li", titleSelector: ".s2 a", linkSelector: ".s2 a",
                authorSelector: ".s4",
                chapterSelector: ".row-section .section-box:last-of-type .section-list a",
                contentSelector: ".read-content"
            )
        ),
        SourceDefinition(
            id: "woshuge", name: "我书阁",
            summary: "网络小说来源，支持站内搜书。书目覆盖与其他来源有所不同。",
            homeURL: URL(string: "https://www.woshuge.com/")!, kind: .html,
            html: HTMLSourceConfiguration(
                searchURL: "/search.html?keyword={query}",
                resultSelector: ".search-result-item", titleSelector: ".book-info-title a",
                linkSelector: ".book-info-title a", authorSelector: ".author-name",
                chapterSelector: ".chapter-list-container ol a", contentSelector: "#TextContent"
            )
        )
    ]
}
