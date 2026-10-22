import XCTest
@testable import ReadingCore

final class ReadingWorkflowTests: XCTestCase {
    private func chapter(_ title: String, _ index: Int) -> Chapter { Chapter(id: "\(index)", title: title, url: URL(string: "https://example.com/\(index)")!, index: index) }
    func testCandidateRejectsAuthorCollisionAndFileBooks() {
        let original = Book(title: "同名小说", author: "作者甲", sourceID: "a", sourceName: "A", url: URL(string:"https://a.example")!)
        let wrong = Book(title: "同名小说", author: "作者乙", sourceID: "b", sourceName: "B", url: URL(string:"https://b.example")!)
        let good = Book(title: "同 名小说", author: "作者甲", sourceID: "b", sourceName: "B", url: URL(string:"https://b.example")!)
        XCTAssertFalse(SourceProgressMatcher.isCandidate(wrong, for: original))
        XCTAssertTrue(SourceProgressMatcher.isCandidate(good, for: original))
    }
    func testMatchesDifferentNumberingButRefusesAmbiguity() {
        let chapters = [chapter("第十二章 初见", 0), chapter("第十三章 重逢", 1)]
        XCTAssertEqual(SourceProgressMatcher.matchedIndex(title: "第12章 初见", in: chapters), 0)
        XCTAssertEqual(SourceProgressMatcher.chapterNumber("第一万零二十章 天地"), 10020)
        XCTAssertEqual(SourceProgressMatcher.chapterNumber("第一〇二章 天地"), 102)
        XCTAssertEqual(SourceProgressMatcher.chapterNumber("第一零二章 天地"), 102)
        XCTAssertEqual(SourceProgressMatcher.matchedIndex(title: "第一〇二章", in: [chapter("第102章 天地",0),chapter("第2章 开始",1)]), 0)
        XCTAssertNil(SourceProgressMatcher.matchedIndex(title: "第12章 另一标题", in: [chapter("第十二章 甲",0),chapter("第12章 乙",1)]))
        XCTAssertNil(SourceProgressMatcher.matchedIndex(title: "序言", in: [chapter("序言",0),chapter("序言",1)]))
    }
    func testFirstCheckDoesNotDeclareWholeBookNewAndReadClearsBadges() {
        let old = [chapter("第一章",0),chapter("第二章",1)]
        let new = old + [chapter("第三章",2),chapter("第四章",3)]
        var first = BookUpdateTracking(); first.refreshed(new, previous:nil, readIndex:nil)
        XCTAssertEqual(first.newChapterIDs, [])
        var known = BookUpdateTracking(); known.refreshed(new, previous:old, readIndex:2)
        XCTAssertEqual(known.newChapterIDs, ["3"])
        known.refreshed(new, previous:new, readIndex:3)
        XCTAssertEqual(known.newChapterIDs, [])
    }
    func testBodyAnchorRoundTripIncludesChineseHeadingButCloudDoesNot() {
        let content = ChapterContent(chapter:chapter("第十二章 月色🌙",0), paragraphs:["甲😀乙", "后段"])
        for bodyOffset in [0, 1, 3, 4, 5, 7] {
            let document = ReaderBodyAnchor.documentOffset(bodyOffset: bodyOffset, content: content)
            XCTAssertEqual(ReaderBodyAnchor.bodyOffset(documentOffset: document, content: content), bodyOffset)
        }
        XCTAssertEqual(ReaderBodyAnchor.bodyOffset(documentOffset: 1, content: content), 0)
        XCTAssertEqual(ReaderBodyAnchor.fraction(documentOffset: ReaderBodyAnchor.prefixLength(content), content: content), 0)
        XCTAssertEqual(ReaderBodyAnchor.fraction(documentOffset: 10000, content: content), 1)
        let twoUnits = ChapterContent(chapter:chapter("很长的标题",0), paragraphs:["😀"])
        XCTAssertEqual(SourceProgressMatcher.utf16Offset(fraction: 0.5, content: twoUnits), 0)
    }
    func testReorderedCatalogIsNotMisreportedAsUpdate() {
        let old = [chapter("第一章",0),chapter("第二章",1)]
        var tracking = BookUpdateTracking()
        tracking.refreshed([chapter("不同目录甲",2),chapter("不同目录乙",3),chapter("不同目录丙",4)], previous: old, readIndex:nil)
        XCTAssertTrue(tracking.newChapterIDs.isEmpty)
    }
    func testOffsetUsesUTF16WithoutSplittingEmoji() {
        let content = ChapterContent(chapter:chapter("题",0), paragraphs:["😀甲乙"])
        let offset = SourceProgressMatcher.utf16Offset(fraction:0.5, content:content)
        XCTAssertEqual(offset,2)
    }
}
