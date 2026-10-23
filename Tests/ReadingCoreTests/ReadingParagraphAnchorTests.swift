import XCTest
@testable import ReadingCore

final class ReadingParagraphAnchorTests: XCTestCase {
    private let chapter = Chapter(id: "paragraphs", title: "第一章 标题🌙", url: URL(string: "https://example.com/chapter")!, index: 0)

    func testHitChoosesTouchedParagraphUsingBodyUTF16Offsets() throws {
        let content = ChapterContent(chapter: chapter, paragraphs: ["甲😀乙", "第二段文字", "第三段"])
        let first = try XCTUnwrap(ReadingParagraphAnchor.at(documentOffset: ReaderBodyAnchor.prefixLength(content) + 2, in: content))
        XCTAssertEqual(first.index, 0)
        XCTAssertEqual(first.characterOffset, 0)
        XCTAssertEqual(first.characterLength, 4)
        let second = try XCTUnwrap(ReadingParagraphAnchor.at(bodyOffset: 7, in: content))
        XCTAssertEqual(second.index, 1)
        XCTAssertEqual(second.characterOffset, 5)
        XCTAssertEqual(second.text, "第二段文字")
        XCTAssertEqual(ReadingParagraphAnchor.at(bodyOffset: 11, in: content)?.index, 2)
    }

    func testHeadingSeparatorsAndBlankParagraphsDoNotBecomeNotes() {
        let content = ChapterContent(chapter: chapter, paragraphs: ["正文", "", "  ", "末段"])
        XCTAssertNil(ReadingParagraphAnchor.at(documentOffset: 1, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(documentOffset: ReaderBodyAnchor.prefixLength(content) - 1, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: -1, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: 2, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: 3, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: 4, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: ReaderBodyAnchor.bodyLength(content), in: content))
        XCTAssertEqual(ReadingParagraphAnchor.at(bodyOffset: 7, in: content)?.index, 3)
    }

    func testLongParagraphKeepsFullAnchorAndOlderPartialNotesRemainUnchanged() throws {
        let long = String(repeating: "甲😀", count: 250)
        let content = ChapterContent(chapter: chapter, paragraphs: ["开头", long, "末段"])
        let paragraph = try XCTUnwrap(ReadingParagraphAnchor.at(bodyOffset: 500, in: content))
        XCTAssertEqual(paragraph.characterOffset, 3)
        XCTAssertEqual(paragraph.characterLength, 750)
        XCTAssertEqual(paragraph.text, long)
        let whole = annotation(offset: paragraph.characterOffset, length: paragraph.characterLength, quote: paragraph.text)
        XCTAssertEqual(whole.characterLength, 750)
        XCTAssertEqual(whole.quote.utf16.count, 499) // The 500-unit snapshot never splits the next emoji; the full range remains intact.
        XCTAssertFalse(whole.quote.contains("�"))
        let partial = annotation(offset: 6, length: 2, quote: "😀")
        XCTAssertTrue(paragraph.overlaps(partial))
        XCTAssertEqual(partial.characterOffset, 6)
        XCTAssertEqual(partial.characterLength, 2)
        XCTAssertFalse(paragraph.overlaps(annotation(offset: 0, length: 2)))
        XCTAssertTrue(paragraph.overlaps(annotation(offset: 2, length: 3)))
        XCTAssertFalse(paragraph.overlaps(annotation(offset: 753, length: 1)))
        var deleted = partial; deleted.deletedAt = Date()
        XCTAssertFalse(paragraph.overlaps(deleted))
    }

    func testMenuAtPageSeparatorsSkipsBlankParagraphsAndFallsBackAtChapterEnd() {
        let content = ChapterContent(chapter: chapter, paragraphs: ["", "首段", "  ", "次段😀", ""])
        // A native page starting in its heading clamps to body offset zero.
        let headingBodyOffset = ReaderBodyAnchor.bodyOffset(documentOffset: 0, content: content)
        XCTAssertEqual(ReadingParagraphAnchor.atOrFollowing(bodyOffset: headingBodyOffset, in: content)?.index, 1)
        XCTAssertEqual(ReadingParagraphAnchor.atOrFollowing(bodyOffset: 2, in: content)?.index, 1)
        XCTAssertEqual(ReadingParagraphAnchor.atOrFollowing(bodyOffset: 3, in: content)?.index, 3) // Paragraph separator.
        XCTAssertEqual(ReadingParagraphAnchor.atOrFollowing(bodyOffset: 5, in: content)?.index, 3) // Blank paragraph.
        XCTAssertEqual(ReadingParagraphAnchor.atOrFollowing(bodyOffset: ReaderBodyAnchor.bodyLength(content), in: content)?.index, 3)
        XCTAssertEqual(ReadingParagraphAnchor.atOrFollowing(bodyOffset: Int.max, in: content)?.index, 3)
        XCTAssertNil(ReadingParagraphAnchor.atOrFollowing(bodyOffset: 0, in: ChapterContent(chapter: chapter, paragraphs: ["", "  "])))
        // The menu fallback must not change strict, physical touch hit testing.
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: 3, in: content))
        XCTAssertNil(ReadingParagraphAnchor.at(bodyOffset: 5, in: content))
    }

    private func annotation(offset: Int, length: Int, quote: String = "") -> ReadingAnnotation {
        ReadingAnnotation(kind: .note, chapterID: chapter.id, chapterIndex: 0, chapterTitle: chapter.title, characterOffset: offset, characterLength: length, quote: quote, sourceID: "source", sourceURL: "https://example.com/book")
    }
}
