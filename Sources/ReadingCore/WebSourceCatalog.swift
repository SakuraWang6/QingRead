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
        ),
        SourceDefinition(
            id: "canghaishuge", name: "沧海书阁",
            summary: "站内搜索与公开章节。部分书目章节不全，可与其他来源对照。",
            homeURL: URL(string: "https://www.canghaishuge.com/")!, kind: .html,
            html: HTMLSourceConfiguration(
                searchURL: "/search.html?q={query}",
                resultSelector: "article.shiguang-search-book", titleSelector: "h3 a", linkSelector: "h3 a",
                authorSelector: ".meta span:first-child", summarySelector: "p.summary", coverSelector: ".cover img",
                chapterSelector: "#catalog .list a", contentSelector: ".shiguang-reader-content"
            )
        ),
        SourceDefinition(
            id: "biquge-tw", name: "笔趣阁 · biquge.tw",
            summary: "独立站内搜索，支持繁简书名。目录与内容质量取决于该网站。",
            homeURL: URL(string: "https://www.biquge.tw/")!, kind: .html,
            html: HTMLSourceConfiguration(
                searchURL: "/search/?searchkey={query}",
                resultSelector: ".result-card", titleSelector: "a.book-title", linkSelector: "a.book-title",
                authorSelector: ".author", summarySelector: ".book-intro", coverSelector: ".book-cover img",
                catalogLinkSelector: "a.chapterlist",
                chapterSelector: ".booklist > ul > li > a", contentSelector: "#chaptercontent"
            )
        ),
        SourceDefinition(
            id: "piaotia", name: "飘天文学",
            summary: "GBK 站内搜索。精确命中与多结果搜索都使用网站给出的完整目录链接。",
            homeURL: URL(string: "https://www.piaotia.com/")!, kind: .html,
            html: HTMLSourceConfiguration(
                searchURL: "/modules/article/search.php?searchkey={query}", encoding: .gbk,
                resultSelector: "#centerm #content:has(h1), table.grid tr:has(td.odd:first-child > a[href*='/bookinfo/'])",
                titleSelector: "h1, td.odd:first-child a",
                linkSelector: "a[title^='点击阅读'], td.even a[href*='/html/']",
                authorSelector: "td.odd:nth-child(3)", coverSelector: "img[src*='/files/article/image/']",
                chapterSelector: ".centent li a", contentSelector: "body",
                removeSelectors: ["body > :not(br)"]
            )
        )
    ]
}
