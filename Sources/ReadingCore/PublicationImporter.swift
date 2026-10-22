import Foundation
import SwiftSoup
import ZIPFoundation

public struct ImportedChapter: Codable, Sendable {
    public let title: String
    public let paragraphs: [String]
}

/// Independent original-layout assets. The existing text chapters and UTF-16
/// anchors remain unchanged; an original view never rewrites their positions.
public struct EPUBOriginalChapter: Codable, Sendable, Identifiable {
    public var id: String { path }
    public let path: String
    public let title: String
    public let textChapterIndex: Int?
}
public struct EPUBOutlineItem: Codable, Sendable, Identifiable {
    public var id: String { path + "#" + fragment }
    public let path: String
    public let fragment: String
    public let title: String
    public let depth: Int
}
public struct EPUBOriginalPublication: Codable, Sendable {
    public let title: String
    public let chapters: [EPUBOriginalChapter]
    public let outline: [EPUBOutlineItem]
}

public enum EPUBOriginalImporter {
    /// Writes only into a new caller-owned directory. Never modifies the EPUB,
    /// its file hash, or the existing plain-text import beside it.
    public static func prepare(_ url: URL, directory: URL) throws -> EPUBOriginalPublication {
        let fileManager = FileManager.default
        guard !fileManager.fileExists(atPath: directory.path) else { throw ReadingError.remote("原版阅读缓存目录已存在。") }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 250 * 1024 * 1024 else { throw ReadingError.remote("EPUB 文件为空或超过 250 MB。") }
        let archive = try Archive(url: url, accessMode: .read)
        let entries = Array(archive)
        guard entries.count <= 10_000 else { throw ReadingError.remote("EPUB 文件项目过多。") }
        var total: UInt64 = 0
        var names = Set<String>()
        for entry in entries {
            let path = try PublicationImporter.checkedPath(entry.path)
            guard entry.type != .symlink, entry.uncompressedSize <= 100 * 1024 * 1024,
                  total <= 250 * 1024 * 1024 - UInt64(entry.uncompressedSize) else { throw ReadingError.remote("EPUB 解压内容过大或包含无效路径。") }
            total += UInt64(entry.uncompressedSize)
            if entry.type == .file { guard names.insert(path).inserted else { throw ReadingError.remote("EPUB 包含重复资源路径。") } }
        }
        func read(_ path: String, limit: Int = 4 * 1024 * 1024) throws -> Data {
            guard let entry = archive[try PublicationImporter.checkedPath(path)], entry.type == .file,
                  entry.uncompressedSize <= limit else { throw ReadingError.parsingFailed("EPUB 缺少或无法读取 \(path)。") }
            var data = Data()
            _ = try archive.extract(entry) { chunk in
                guard data.count <= limit - chunk.count else { throw ReadingError.remote("EPUB 资源超过读取上限。") }
                data.append(chunk)
            }
            return data
        }
        let container = try SwiftSoup.parse(String(decoding: read("META-INF/container.xml"), as: UTF8.self), "", Parser.xmlParser())
        guard let opfPath = try container.select("rootfile").first()?.attr("full-path"), !opfPath.isEmpty else { throw ReadingError.parsingFailed("EPUB 没有有效的出版清单。") }
        let opf = try SwiftSoup.parse(String(decoding: read(opfPath), as: UTF8.self), "", Parser.xmlParser())
        var manifest: [String: String] = [:]
        for item in try opf.select("manifest item") {
            guard let path = resourcePath(try item.attr("href"), relativeTo: opfPath), names.contains(path) else { continue }
            manifest[try item.attr("id")] = path
        }
        var chapters: [EPUBOriginalChapter] = [], outline: [EPUBOutlineItem] = [], rendered: [String: Data] = [:]
        var textIndex = 0
        for reference in try opf.select("spine itemref") {
            try Task.checkCancellation()
            guard try reference.attr("linear") != "no", let path = manifest[try reference.attr("idref")],
                  ["xhtml", "html", "htm"].contains((path as NSString).pathExtension.lowercased()) else { continue }
            let html = String(decoding: try read(path), as: UTF8.self)
            let document = try SwiftSoup.parse(html)
            let title = try (document.select("h1,h2,h3").first() ?? document.select("title").first())?.text() ?? "第 \(chapters.count + 1) 节"
            let paragraphs = (try? HTMLParsing.content(html, selector: "body", removing: ["nav"])) ?? []
            chapters.append(.init(path: path, title: title.isEmpty ? "第 \(chapters.count + 1) 节" : title, textChapterIndex: paragraphs.isEmpty ? nil : textIndex))
            if !paragraphs.isEmpty { textIndex += 1 }
            let headings = try document.select("h1,h2,h3,h4,h5,h6")
            for (index, heading) in headings.enumerated() {
                let title = try heading.text(); guard !title.isEmpty else { continue }
                var id = try heading.attr("id")
                if id.isEmpty { id = "qingread-heading-\(chapters.count)-\(index)"; try heading.attr("id", id) }
                outline.append(.init(path: path, fragment: id, title: title, depth: max(0, (Int(heading.tagName().dropFirst()) ?? 1) - 1)))
            }
            if headings.isEmpty() { outline.append(.init(path: path, fragment: "", title: chapters.last!.title, depth: 0)) }
            rendered[path] = try sanitize(document, path: path, available: names)
        }
        guard !chapters.isEmpty else { throw ReadingError.parsingFailed("EPUB 没有可读取的正文页面。") }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        do {
            let allowed = Set(["xhtml", "html", "htm", "css", "png", "jpg", "jpeg", "gif", "webp", "svg", "woff", "woff2", "ttf", "otf"])
            for entry in entries where entry.type == .file {
                try Task.checkCancellation()
                let path = try PublicationImporter.checkedPath(entry.path), ext = (path as NSString).pathExtension.lowercased()
                guard allowed.contains(ext) else { continue }
                let target = directory.appendingPathComponent(path)
                try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let data: Data
                if let value = rendered[path] { data = value }
                else if ["xhtml", "html", "htm", "svg"].contains(ext) {
                    let source = String(decoding: try read(path), as: UTF8.self)
                    let document = try ext == "svg" ? SwiftSoup.parse(source, "", Parser.xmlParser()) : SwiftSoup.parse(source)
                    data = try sanitize(document, path: path, available: names)
                } else { data = try read(path, limit: 24 * 1024 * 1024) }
                try data.write(to: target, options: .atomic)
                try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            }
            return .init(title: try opf.getElementsByTag("dc:title").first()?.text() ?? url.deletingPathExtension().lastPathComponent, chapters: chapters, outline: outline)
        } catch { try? fileManager.removeItem(at: directory); throw error }
    }

    /// Canonical archive-local paths; fragments stay on anchors, never on disk.
    public static func resourcePath(_ reference: String, relativeTo path: String) -> String? {
        let value = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.hasPrefix("/"), !value.contains(":"), !value.contains("\\"), !value.contains("\0") else { return nil }
        let relative = String(value.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        guard !relative.contains("?"), let decoded = relative.removingPercentEncoding,
              !decoded.hasPrefix("/"), !decoded.contains("\\"), !decoded.contains("\0"), !decoded.contains(":") else { return nil }
        if decoded.isEmpty { return try? PublicationImporter.checkedPath(path) }
        var components = (path as NSString).deletingLastPathComponent.split(separator: "/").map(String.init)
        for part in decoded.split(separator: "/") {
            if part == ".." { guard !components.isEmpty else { return nil }; components.removeLast() }
            else if part != "." { components.append(String(part)) }
        }
        return try? PublicationImporter.checkedPath(components.joined(separator: "/"))
    }

    private static func sanitize(_ document: Document, path: String, available: Set<String>) throws -> Data {
        try document.select("script,iframe,frame,object,embed,form,input,button,audio,video,source,track,base,meta[http-equiv]").remove()
        for element in try document.select("*") {
            for attribute in element.getAttributes()?.asList() ?? [] {
                let key = attribute.getKey().lowercased(), value = attribute.getValue()
                if key.hasPrefix("on") || ["srcdoc", "srcset", "action", "formaction"].contains(key) { try element.removeAttr(attribute.getKey()); continue }
                if ["href", "src", "xlink:href", "poster"].contains(key) {
                    let rasterData = key == "src" && ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"].contains(where: value.lowercased().hasPrefix)
                    if !rasterData && !(resourcePath(value, relativeTo: path).map(available.contains) ?? false) { try element.removeAttr(attribute.getKey()) }
                }
            }
        }
        let policy = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        try document.head()?.prepend("<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>:root{color-scheme:light dark}body{padding:16px;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{max-width:100%}</style>")
        return Data(try document.outerHtml().utf8)
    }
}

public struct ImportedPublication: Sendable {
    public let title: String
    public let author: String
    public let chapters: [ImportedChapter]
    public let cover: Data?
}

public enum PublicationImporter {
    public static func read(_ url: URL, format: BookFileFormat) throws -> ImportedPublication {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 250 * 1024 * 1024 else { throw ReadingError.remote("文件为空或超过 250 MB。") }
        if format == .txt { return try text(Data(contentsOf: url), title: url.deletingPathExtension().lastPathComponent) }
        guard format == .epub else { throw ReadingError.remote("PDF 由原排版阅读器打开。") }
        let archive = try Archive(url: url, accessMode: .read)
        let entries = Array(archive)
        guard entries.count <= 10_000 else { throw ReadingError.remote("EPUB 文件项目过多。") }
        var total: UInt64 = 0
        for entry in entries {
            _ = try checkedPath(entry.path)
            guard entry.type != .symlink, entry.uncompressedSize <= 100 * 1024 * 1024,
                  total <= 250 * 1024 * 1024 - UInt64(entry.uncompressedSize) else { throw ReadingError.remote("EPUB 解压内容过大或包含无效路径。") }
            total += UInt64(entry.uncompressedSize)
        }
        func readEntry(_ path: String, limit: Int = 4 * 1024 * 1024) throws -> Data {
            let path = try checkedPath(path)
            guard let entry = archive[path], entry.type == .file, entry.uncompressedSize <= limit else { throw ReadingError.parsingFailed("EPUB 缺少或无法读取 \(path)。") }
            var data = Data()
            _ = try archive.extract(entry) { chunk in
                guard data.count <= limit - chunk.count else { throw ReadingError.remote("EPUB 项目超过读取上限。") }
                data.append(chunk)
            }
            return data
        }
        let container = try SwiftSoup.parse(String(decoding: readEntry("META-INF/container.xml"), as: UTF8.self), "", Parser.xmlParser())
        guard let opfPath = try container.select("rootfile").first()?.attr("full-path"), !opfPath.isEmpty else { throw ReadingError.parsingFailed("EPUB 没有有效的出版清单。") }
        let opf = try SwiftSoup.parse(String(decoding: readEntry(opfPath), as: UTF8.self), "", Parser.xmlParser())
        let title = try opf.getElementsByTag("dc:title").first()?.text() ?? url.deletingPathExtension().lastPathComponent
        let author = try opf.getElementsByTag("dc:creator").first()?.text() ?? ""
        let directory = (opfPath as NSString).deletingLastPathComponent
        func itemPath(_ href: String) throws -> String {
            let relative = String(href.split(separator: "#", maxSplits: 1).first ?? "")
            guard !relative.contains("://"), !relative.hasPrefix("/"), let decoded = relative.removingPercentEncoding else { throw ReadingError.parsingFailed("EPUB 资源路径无效。") }
            var components = directory.isEmpty ? [] : directory.components(separatedBy: "/")
            for part in decoded.components(separatedBy: "/") {
                if part == ".." {
                    guard !components.isEmpty else { throw ReadingError.parsingFailed("电子书包含越界资源路径。") }
                    components.removeLast()
                } else if part != "." && !part.isEmpty { components.append(part) }
            }
            return try checkedPath(components.joined(separator: "/"))
        }
        var manifest: [String: Element] = [:]
        for item in try opf.select("manifest item") { manifest[try item.attr("id")] = item }
        var chapters: [ImportedChapter] = []
        for reference in try opf.select("spine itemref") {
            try Task.checkCancellation()
            guard try reference.attr("linear") != "no", let item = manifest[try reference.attr("idref")],
                  try item.attr("media-type").contains("html") else { continue }
            let data = try readEntry(itemPath(item.attr("href")))
            let html = String(decoding: data, as: UTF8.self)
            let document = try SwiftSoup.parse(html)
            let heading = try (document.select("h1, h2, h3").first() ?? document.select("title").first())?.text() ?? ""
            let paragraphs = (try? HTMLParsing.content(html, selector: "body", removing: ["nav"])) ?? []
            guard !paragraphs.isEmpty else { continue }
            chapters.append(ImportedChapter(title: heading.isEmpty ? "第 \(chapters.count + 1) 节" : heading, paragraphs: paragraphs))
        }
        guard !chapters.isEmpty else { throw ReadingError.parsingFailed("没有可读取的 EPUB 正文；文件可能已加密或仅包含图片。") }
        let coverID = try opf.select("metadata meta[name=cover]").first()?.attr("content")
        let coverItem = manifest.values.first { (try? $0.attr("properties").split(separator: " ").contains("cover-image")) == true } ?? coverID.flatMap { manifest[$0] }
        let cover: Data?
        if let item = coverItem, let path = try? itemPath(item.attr("href")) { cover = try? readEntry(path, limit: 8 * 1024 * 1024) } else { cover = nil }
        return ImportedPublication(title: title, author: author, chapters: chapters, cover: cover)
    }

    public static func checkedPath(_ path: String) throws -> String {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0"),
              !path.split(separator: "/").contains("..") else { throw ReadingError.parsingFailed("电子书包含越界资源路径。") }
        return path.hasPrefix("./") ? String(path.dropFirst(2)) : path
    }

    private static func text(_ data: Data, title: String) throws -> ImportedPublication {
        guard data.count <= 20 * 1024 * 1024 else { throw ReadingError.remote("TXT 文件超过 20 MB。") }
        let value: String?
        if data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]) { value = String(data: data, encoding: .utf16) }
        else { value = String(data: data, encoding: .utf8) ?? String(data: data, encoding: HTMLSourceConfiguration.Encoding.gb18030.stringEncoding) }
        guard let value else { throw ReadingError.decodingFailed }
        let lines = value.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let pattern = #"^(第[零〇一二三四五六七八九十百千万两0-9]{1,16}[章回节卷部].{0,60}|[Cc][Hh][Aa][Pp][Tt][Ee][Rr]\s+[0-9IVXLC]+.{0,60})$"#
        var chapters: [ImportedChapter] = []
        var current: [String] = []
        var heading = title
        var length = 0
        func append() { if !current.isEmpty { chapters.append(.init(title: heading, paragraphs: current)); current = []; length = 0 } }
        for line in lines {
            if line.range(of: pattern, options: .regularExpression) != nil { append(); heading = line }
            else {
                if length > 40_000 { append(); heading = "\(title) · \(chapters.count + 1)" }
                // Unbroken TXT exports still need bounded layout units.
                var remaining = line[...]
                while !remaining.isEmpty {
                    let end = remaining.index(remaining.startIndex, offsetBy: 4000, limitedBy: remaining.endIndex) ?? remaining.endIndex
                    let part = String(remaining[..<end])
                    if length + part.utf16.count > 40_000 { append(); heading = "\(title) · \(chapters.count + 1)" }
                    current.append(part); length += part.utf16.count
                    remaining = remaining[end...]
                }
            }
        }
        append()
        guard !chapters.isEmpty else { throw ReadingError.emptyContent }
        return .init(title: title, author: "", chapters: chapters, cover: nil)
    }
}
