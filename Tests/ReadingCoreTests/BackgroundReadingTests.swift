import XCTest
@testable import ReadingCore

final class BackgroundReadingTests: XCTestCase {
    private let book = Book(id:"logical-book",title:"测试",sourceID:"one",sourceName:"来源",url:URL(string:"https://example.com/book")!)
    private var chapters: [Chapter] { (0..<3).map { Chapter(id:"chapter-\($0)",title:"第\($0 + 1)章",url:URL(string:"https://example.com/\($0)")!,index:$0) } }
    func testResumeRequiresMatchingAccountJobAndSource() {
        var job = ChapterDownloadTask(book:book,chapters:chapters); job.status = .running
        let transfer = BackgroundChapterTransfer(profileScope:"account-a",jobID:job.id,book:book,chapters:chapters)
        XCTAssertTrue(transfer.matches(scope:"account-a",job:job))
        XCTAssertFalse(transfer.matches(scope:"account-b",job:job))
        XCTAssertFalse(transfer.matches(scope:"account-a",job:nil))
        job.status = .paused; XCTAssertFalse(transfer.matches(scope:"account-a",job:job))
        job.status = .cancelled; XCTAssertFalse(transfer.matches(scope:"account-a",job:job))
        let replacement = Book(id:book.id,title:book.title,sourceID:"two",sourceName:"另源",url:URL(string:"https://other.example/book")!)
        let stale = BackgroundChapterTransfer(profileScope:"account-a",jobID:job.id,book:replacement,chapters:chapters)
        job.status = .running; XCTAssertFalse(stale.matches(scope:"account-a",job:job))
    }
    func testUntrustedBatchCannotInjectAnotherChapterOrDuplicate() {
        let job = ChapterDownloadTask(book:book,chapters:chapters)
        let transfer = BackgroundChapterTransfer(profileScope:"guest",jobID:job.id,book:book,chapters:Array(chapters.prefix(1)))
        let valid = ChapterContent(chapter:chapters[0],paragraphs:["合法正文"])
        let unrelated = ChapterContent(chapter:chapters[2],paragraphs:["其他章节"])
        let accepted = transfer.validatedContents(BackgroundChapterBatch(contents:[valid,valid,unrelated]))
        XCTAssertEqual(accepted,[valid])
        XCTAssertTrue(transfer.validatedContents(BackgroundChapterBatch(contents:[ChapterContent(chapter:chapters[0],paragraphs:[" "])] )).isEmpty)
    }
    func testTransferRecordSurvivesRestart() throws {
        let job = ChapterDownloadTask(book:book,chapters:chapters)
        let transfer = BackgroundChapterTransfer(profileScope:"profile-hash",jobID:job.id,book:book,chapters:chapters)
        let restored = try JSONDecoder().decode(BackgroundChapterTransfer.self,from:JSONEncoder().encode(transfer))
        XCTAssertEqual(restored.id,transfer.id)
        XCTAssertEqual(restored.jobID,job.id)
        XCTAssertEqual(restored.profileScope,"profile-hash")
        XCTAssertEqual(restored.chapters,chapters)
    }
    func testRateLimitBackoffSurvivesRestartAndIsBounded() throws {
        let job = ChapterDownloadTask(book: book, chapters: chapters)
        var transfer = BackgroundChapterTransfer(profileScope: "guest", jobID: job.id, book: book, chapters: chapters)
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(transfer.deferForThrottling(now: now))
        XCTAssertEqual(transfer.notBefore, now.addingTimeInterval(60))
        transfer = try JSONDecoder().decode(BackgroundChapterTransfer.self, from: JSONEncoder().encode(transfer))
        XCTAssertTrue(transfer.deferForThrottling(now: now))
        XCTAssertEqual(transfer.notBefore, now.addingTimeInterval(120))
        XCTAssertTrue(transfer.deferForThrottling(now: now, retryAfter: 300))
        XCTAssertEqual(transfer.notBefore, now.addingTimeInterval(300))
        XCTAssertFalse(transfer.deferForThrottling(now: now))
        XCTAssertEqual(transfer.throttlingAttempts, 3)
        XCTAssertTrue(job.failedIDs.isEmpty)
    }
}
