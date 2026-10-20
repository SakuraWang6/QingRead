import Foundation
import SwiftSoup

public enum ReadingError: LocalizedError, Sendable {
    case invalidSource(String)
    case invalidURL(String)
    case sourceUnavailable(String)
    case httpStatus(Int)
    case invalidResponse
    case decodingFailed
    case parsingFailed(String)
    case emptyContent
    case remote(String)

    public var errorDescription: String? {
        switch self {
        case .invalidSource(let detail): return "书源格式有误：\(detail)"
        case .invalidURL(let value): return "无效的网址：\(value)"
        case .sourceUnavailable(let id): return "找不到书源 \(id)，请重新启用或导入。"
        case .httpStatus(let code): return "网站返回 HTTP \(code)。"
        case .invalidResponse: return "网站返回了无法识别的数据。"
        case .decodingFailed: return "网页编码不匹配，请检查书源的 encoding。"
        case .parsingFailed(let detail): return "网页解析失败：\(detail)"
        case .emptyContent: return "没有解析到正文；网站可能已改版或需要登录。"
        case .remote(let detail): return detail
        }
    }
}

public enum SourceImporter {
    /// Accepts one source, an array of sources, or {"sources": [...]}.
    public static func decode(_ data: Data) throws -> [SourceDefinition] {
        let decoder = JSONDecoder()
        let json: Any
        do { json = try JSONSerialization.jsonObject(with: data) }
        catch { throw ReadingError.invalidSource("文件不是有效 JSON。") }

        let sources: [SourceDefinition]
        do {
            if json is [Any] {
                sources = try decoder.decode([SourceDefinition].self, from: data)
            } else if let object = json as? [String: Any], object["sources"] != nil {
                sources = try decoder.decode(Envelope.self, from: data).sources
            } else {
                sources = [try decoder.decode(SourceDefinition.self, from: data)]
            }
        } catch {
            throw ReadingError.invalidSource("字段缺失或类型不匹配：\(error.localizedDescription)")
        }

        guard !sources.isEmpty else { throw ReadingError.invalidSource("没有书源。") }
        guard sources.count <= 100 else { throw ReadingError.invalidSource("一次最多导入 100 个书源。") }
        var ids = Set<String>()
        for source in sources {
            try validate(source)
            guard ids.insert(source.id).inserted else {
                throw ReadingError.invalidSource("重复的书源 id：\(source.id)")
            }
        }
        return sources
    }

    public static func validate(_ source: SourceDefinition) throws {
        guard !source.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !source.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReadingError.invalidSource("id 和 name 不能为空。")
        }
        guard source.homeURL.isHTTP else { throw ReadingError.invalidSource("homeURL 需要 HTTP 或 HTTPS 网址。") }
        switch source.kind {
        case .staticCatalog:
            guard !source.catalogBooks.isEmpty else { throw ReadingError.invalidSource("静态书源的 catalogBooks 不能为空。") }
            guard source.catalogBooks.allSatisfy({ !$0.title.isEmpty && $0.directoryURL.isHTTP && $0.directoryURL.absoluteString.hasSuffix("/") }) else {
                throw ReadingError.invalidSource("每本书需要 title 及以 / 结尾的 HTTP directoryURL。")
            }
        case .mediaWiki:
            guard let apiURL = source.apiURL, apiURL.isHTTP else {
                throw ReadingError.invalidSource("mediaWiki 书源需要有效的 apiURL。")
            }
        case .html:
            guard let config = source.html else { throw ReadingError.invalidSource("缺少 html 配置。") }
            guard config.searchURL.contains("{query}") else {
                throw ReadingError.invalidSource("searchURL 必须包含 {query}。")
            }
            let selectors = [config.resultSelector, config.titleSelector, config.linkSelector,
                             config.chapterSelector, config.contentSelector]
                + [config.authorSelector, config.summarySelector, config.coverSelector, config.catalogLinkSelector].compactMap { $0 }
                + config.removeSelectors
            let document = try SwiftSoup.parse("")
            for selector in selectors {
                guard !selector.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ReadingError.invalidSource("CSS 选择器不能为空。")
                }
                do { _ = try document.select(selector) }
                catch { throw ReadingError.invalidSource("CSS 选择器无效：\(selector)") }
            }
            _ = try SourceURL.search(query: "测试", source: source, config: config)
        }
    }

    private struct Envelope: Decodable { let sources: [SourceDefinition] }
}

extension URL {
    var isHTTP: Bool {
        ["http", "https"].contains(scheme?.lowercased() ?? "") && host != nil
    }
}
