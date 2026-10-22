import XCTest
@testable import ReadingCore
final class ShelfMetadataTests: XCTestCase {
    private let book = Book(id:"metadata-book",title:"标注测试",sourceID:"one",sourceName:"源",url:URL(string:"https://example.com/book")!)
    func testOldEntriesDecodeAndNewCloudFieldsRoundTrip() throws {
        let old = ShelfEntry(book:book,addedAt:Date(timeIntervalSince1970:100))
        let data = try CloudJSON.encoder().encode(old)
        let restored = try CloudJSON.decoder().decode(ShelfEntry.self,from:data)
        XCTAssertNil(restored.organization); XCTAssertNil(restored.annotations)
        var entry = restored
        entry.organization = ShelfOrganization(pinned:true,status:.later,group:"文学",updatedAt:Date(timeIntervalSince1970:200))
        entry.annotations = [ReadingAnnotation(kind:.note,chapterID:"1",chapterIndex:0,chapterTitle:"章节",characterOffset:3,quote:"甲😀乙",note:"想法",updatedAt:Date(timeIntervalSince1970:210),sourceID:book.sourceID,sourceURL:book.url.absoluteString)]
        let roundtrip = try CloudJSON.decoder().decode(ShelfEntry.self,from:CloudJSON.encoder().encode(entry))
        XCTAssertEqual(roundtrip.organization,entry.organization); XCTAssertEqual(roundtrip.annotations,entry.annotations)
    }
    func testMetadataMergeKeepsNewerDeletionAndIndependentOrganization() {
        let date = Date(timeIntervalSince1970:200)
        let original = ReadingAnnotation(id:"same-note",kind:.bookmark,chapterID:"1",chapterIndex:0,chapterTitle:"章",characterOffset:2,updatedAt:date,sourceID:book.sourceID,sourceURL:book.url.absoluteString)
        var deleted = original; deleted.updatedAt = date.addingTimeInterval(10); deleted.deletedAt = deleted.updatedAt
        var first = ShelfEntry(book:book,addedAt:date,organization:ShelfOrganization(pinned:true,group:"旧组",updatedAt:date),annotations:[original])
        let incoming = ShelfEntry(book:book,addedAt:date,organization:ShelfOrganization(status:.finished,group:"新组",updatedAt:date.addingTimeInterval(20)),annotations:[deleted])
        first.mergeMetadata(from:incoming)
        XCTAssertEqual(first.organization?.status,.finished); XCTAssertEqual(first.organization?.group,"新组")
        XCTAssertNotNil(first.annotations?.first?.deletedAt)
        first.mergeMetadata(from:ShelfEntry(book:book,addedAt:date,annotations:[original]))
        XCTAssertNotNil(first.annotations?.first?.deletedAt)
    }
    func testMetadataBoundsUseSharedUTF16LimitsWithoutSplittingEmoji() {
        let quote = String(repeating: "😀", count: 400)
        let annotation = ReadingAnnotation(kind:.note,chapterID:"1",chapterIndex:0,chapterTitle:quote,characterOffset:0,quote:quote,note:String(repeating:"😀",count:800),sourceID:book.sourceID,sourceURL:book.url.absoluteString)
        XCTAssertEqual(annotation.quote.utf16.count,500)
        XCTAssertEqual(annotation.note.utf16.count,1000)
        XCTAssertEqual(annotation.chapterTitle.utf16.count,500)
        XCTAssertFalse(annotation.quote.contains("�"))
        XCTAssertEqual(ReadingMetadataText.clipped("甲😀乙",utf16Limit:2),"甲")
    }

}
