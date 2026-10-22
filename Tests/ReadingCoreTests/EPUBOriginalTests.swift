import Foundation
import Testing
import ZIPFoundation
@testable import ReadingCore

struct EPUBOriginalTests {
    @Test func preservesIllustrationsHierarchyAndFootnoteLinksWithoutChangingTheTextImport() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("epub-original-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("book.epub")
        try fixture(source)
        let originalBytes = try Data(contentsOf: source), textBefore = try PublicationImporter.read(source, format: .epub)
        let destination = root.appendingPathComponent("rendered", isDirectory: true)
        let result = try EPUBOriginalImporter.prepare(source, directory: destination)
        #expect(result.chapters.map(\.title) == ["第一章"])
        #expect(result.chapters[0].textChapterIndex == 0)
        #expect(result.outline.map(\.depth) == [0, 1])
        let html = try String(contentsOf: destination.appendingPathComponent("OEBPS/Text/ch1.xhtml"), encoding: .utf8)
        #expect(html.contains("<h2 id=\"sub\""))
        #expect(html.contains("../Images/figure.svg"))
        #expect(html.contains("notes.xhtml#foot1"))
        #expect(html.contains("Content-Security-Policy"))
        #expect(html.contains("script-src 'none'"))
        #expect(!html.contains("<script"))
        #expect(!html.contains("onerror"))
        #expect(!html.contains("https://remote.invalid"))
        #expect(!FileManager.default.fileExists(atPath: destination.appendingPathComponent("OEBPS/code.js").path))
        let svg = try String(contentsOf: destination.appendingPathComponent("OEBPS/Images/figure.svg"), encoding: .utf8)
        #expect(svg.contains("<svg"))
        #expect(!svg.contains("<html"))
        #expect(!svg.contains("<script"))
        #expect(!svg.contains("https://remote.invalid"))
        #expect(FileManager.default.fileExists(atPath: destination.appendingPathComponent("OEBPS/Text/notes.xhtml").path))
        #expect(try Data(contentsOf: source) == originalBytes)
        let textAfter = try PublicationImporter.read(source, format: .epub)
        #expect(textAfter.chapters.map(\.paragraphs) == textBefore.chapters.map(\.paragraphs))
    }

    @Test func rejectsEscapesAndExternalSchemesAndDoesNotOverwriteAnExistingDestination() throws {
        for value in ["../../../secret", "%2e%2e/%2e%2e/%2e%2e/secret", "https://example.com/a", "file:///private/a", "//example.com/a", "javascript:alert(1)", "a\\b"] {
            #expect(EPUBOriginalImporter.resourcePath(value, relativeTo: "OEBPS/Text/ch1.xhtml") == nil)
        }
        #expect(EPUBOriginalImporter.resourcePath("../Images/a%20b.png", relativeTo: "OEBPS/Text/ch1.xhtml") == "OEBPS/Images/a b.png")
        #expect(EPUBOriginalImporter.resourcePath("#footnote", relativeTo: "OEBPS/Text/ch1.xhtml") == "OEBPS/Text/ch1.xhtml")
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/import.epub")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let existing = directory.appendingPathComponent("keep.txt"); try Data("keep".utf8).write(to: existing)
        #expect(throws: (any Error).self) { try EPUBOriginalImporter.prepare(source, directory: directory) }
        #expect(try String(contentsOf: existing, encoding: .utf8) == "keep")
    }

    private func fixture(_ url: URL) throws {
        let archive = try Archive(url: url, accessMode: .create)
        let files = [
            "META-INF/container.xml": "<container><rootfiles><rootfile full-path='OEBPS/content.opf'/></rootfiles></container>",
            "OEBPS/content.opf": "<package><metadata><dc:title>插图与脚注</dc:title></metadata><manifest><item id='one' href='Text/ch1.xhtml' media-type='application/xhtml+xml'/><item id='notes' href='Text/notes.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='one'/></spine></package>",
            "OEBPS/Text/ch1.xhtml": "<html><head><title>书名</title><link rel='stylesheet' href='../Styles/book.css'/></head><body><h1>第一章</h1><p>正文𠀀🙂。</p><h2 id='sub'>小节</h2><img src='../Images/figure.svg'/><a href='notes.xhtml#foot1'>[1]</a><img src='https://remote.invalid/a' onerror='alert(1)'/><script>alert(1)</script><iframe src='https://remote.invalid/'></iframe></body></html>",
            "OEBPS/Text/notes.xhtml": "<html><body><aside id='foot1'>脚注内容<a href='ch1.xhtml#sub'>返回</a></aside></body></html>",
            "OEBPS/Images/figure.svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='30' height='30'/><image href='https://remote.invalid/a'/><script>alert(1)</script></svg>",
            "OEBPS/Styles/book.css": "h2{font-size:1.2em} img{display:block}",
            "OEBPS/code.js": "alert(1)",
        ]
        for (path, value) in files {
            let data = Data(value.utf8)
            try archive.addEntry(with: path, type: .file, uncompressedSize: Int64(data.count)) { position, size in data.subdata(in: Int(position)..<min(data.count, Int(position) + size)) }
        }
    }
}
