import Foundation
import SwiftSoup
import ZIPFoundation

public struct ImportedChapter: Codable, Sendable {
    public let title: String
    public let paragraphs: [String]
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
