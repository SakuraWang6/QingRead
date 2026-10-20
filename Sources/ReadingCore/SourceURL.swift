import Foundation
import CoreFoundation

enum SourceURL {
    static func resolve(_ value: String, relativeTo base: URL) throws -> URL {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: value, relativeTo: base)?.absoluteURL, url.isHTTP else {
            throw ReadingError.invalidURL(value)
        }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        components?.fragment = nil
        return components?.url ?? url
    }

    static func search(query: String, source: SourceDefinition, config: HTMLSourceConfiguration) throws -> URL {
        guard let data = query.data(using: config.encoding.stringEncoding, allowLossyConversion: false) else {
            throw ReadingError.decodingFailed
        }
        let unreserved = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".utf8)
        let encoded = data.map { unreserved.contains($0) ? String(UnicodeScalar($0)) : String(format: "%%%02X", $0) }.joined()
        return try resolve(config.searchURL.replacingOccurrences(of: "{query}", with: encoded), relativeTo: source.homeURL)
    }

    static func wiki(title: String, source: SourceDefinition) throws -> URL {
        var components = URLComponents(url: source.homeURL, resolvingAgainstBaseURL: true)
        components?.path = "/wiki/" + title.replacingOccurrences(of: " ", with: "_")
        components?.query = nil
        components?.fragment = nil
        guard let url = components?.url else { throw ReadingError.invalidURL(title) }
        return url
    }

    static func wikiTitle(from url: URL) throws -> String {
        if url.path.hasPrefix("/wiki/") {
            return String(url.path.dropFirst(6)).replacingOccurrences(of: "_", with: " ")
        }
        if let title = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "title" })?.value {
            return title
        }
        throw ReadingError.invalidURL(url.absoluteString)
    }

    static func api(_ source: SourceDefinition, parameters: [String: String]) throws -> URL {
        guard let apiURL = source.apiURL, var components = URLComponents(url: apiURL, resolvingAgainstBaseURL: false) else {
            throw ReadingError.invalidSource("缺少 apiURL。")
        }
        var items = parameters
        items["format"] = "json"
        items["formatversion"] = "2"
        items["utf8"] = "1"
        components.queryItems = items.keys.sorted().map { URLQueryItem(name: $0, value: items[$0]) }
        guard let url = components.url else { throw ReadingError.invalidURL(apiURL.absoluteString) }
        return url
    }
}

extension HTMLSourceConfiguration.Encoding {
    var stringEncoding: String.Encoding {
        switch self {
        case .utf8: return .utf8
        case .gb18030, .gbk:
            return String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))
        }
    }
}
