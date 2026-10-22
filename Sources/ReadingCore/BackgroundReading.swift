import Foundation

public struct BackgroundChapterFailure: Codable, Sendable {
    public let chapterID: String
    public let message: String
    public init(chapterID: String, message: String) { self.chapterID = chapterID; self.message = message }
}
public struct BackgroundChapterBatch: Codable, Sendable {
    public let contents: [ChapterContent]
    public let failures: [BackgroundChapterFailure]
    public init(contents: [ChapterContent], failures: [BackgroundChapterFailure] = []) { self.contents = contents; self.failures = failures }
}
public struct BackgroundChapterTransfer: Codable, Identifiable, Sendable {
    public let id: UUID
    public let profileScope: String
    public let jobID: UUID
    public let book: Book
    public let chapters: [Chapter]
    public let createdAt: Date
    public var throttlingAttempts: Int?
    public var notBefore: Date?
    public init(profileScope: String, jobID: UUID, book: Book, chapters: [Chapter]) {
        id = UUID(); self.profileScope = profileScope; self.jobID = jobID; self.book = book; self.chapters = chapters; createdAt = Date()
    }
    /// Rate limits are transport backpressure, not failed chapter reads. Persist
    /// the daemon's next start date so an app restart does not reset the delay.
    public mutating func deferForThrottling(now: Date = Date(), retryAfter: TimeInterval? = nil) -> Bool {
        let attempts = throttlingAttempts ?? 0
        guard attempts < 3 else { return false }
        let backoff = 60.0 * pow(2, Double(attempts))
        throttlingAttempts = attempts + 1
        notBefore = now.addingTimeInterval(max(backoff, min(3600, retryAfter ?? 0)))
        return true
    }
    public func matches(scope: String, job: ChapterDownloadTask?) -> Bool {
        guard let job, profileScope == scope, job.id == jobID, [.queued, .running].contains(job.status),
              job.book.id == book.id, job.book.sourceID == book.sourceID, job.book.url == book.url else { return false }
        let ids = Set(job.chapters.map(\.id))
        return !chapters.isEmpty && chapters.count <= 10 && Set(chapters.map(\.id)).count == chapters.count && chapters.allSatisfy { ids.contains($0.id) }
    }
    public func validatedContents(_ batch: BackgroundChapterBatch) -> [ChapterContent] {
        let expected = Dictionary(chapters.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        return batch.contents.compactMap { content in
            guard let chapter = expected[content.chapter.id], seen.insert(chapter.id).inserted,
                  !content.paragraphs.isEmpty, content.paragraphs.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { return nil }
            return ChapterContent(chapter: chapter, paragraphs: content.paragraphs)
        }
    }
}
