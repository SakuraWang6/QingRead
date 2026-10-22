import Foundation

/// Conservative matching: ambiguity is surfaced to the reader instead of guessing by index.
public enum SourceProgressMatcher {
    public static func normalized(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
    }
    public static func isCandidate(_ candidate: Book, for original: Book) -> Bool {
        guard original.publicationFormat == nil, candidate.publicationFormat == nil,
              original.fileDownloadURL == nil, candidate.fileDownloadURL == nil,
              candidate.sourceID != "local-file", original.sourceID != "local-file",
              candidate.sourceID != original.sourceID || candidate.url != original.url,
              normalized(candidate.title) == normalized(original.title) else { return false }
        let old = normalized(original.author), new = normalized(candidate.author)
        return old.isEmpty || new.isEmpty || old == new
    }
    public static func matchedIndex(title: String, in chapters: [Chapter]) -> Int? {
        let name = normalized(title)
        let exact = chapters.indices.filter { normalized(chapters[$0].title) == name }
        if exact.count == 1 { return exact[0] }
        let body = normalized(removingNumber(title))
        if !body.isEmpty {
            let matches = chapters.indices.filter { normalized(removingNumber(chapters[$0].title)) == body }
            if matches.count == 1 { return matches[0] }
        }
        guard let number = chapterNumber(title) else { return nil }
        let numbered = chapters.indices.filter { chapterNumber(chapters[$0].title) == number }
        return numbered.count == 1 ? numbered[0] : nil
    }
    private static let numberPattern = #"^\s*第?\s*([0-9０-９零〇一二三四五六七八九十百千万两]+)\s*[章回节集卷]"#
    public static func chapterNumber(_ title: String) -> Int? {
        guard let range = title.range(of: numberPattern, options: .regularExpression) else { return nil }
        let prefix = String(title[range]).precomposedStringWithCompatibilityMapping
        let digits = prefix.filter { "0123456789零〇一二三四五六七八九十百千万两".contains($0) }
        if let value = Int(digits) { return value }
        let values: [Character: Int] = ["零":0,"〇":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9]
        if !digits.contains(where: { "十百千万".contains($0) }) {
            let decimal = digits.compactMap { values[$0].map(String.init) }.joined()
            return decimal.isEmpty ? nil : Int(decimal)
        }
        var result = 0, section = 0, digit = 0
        for character in digits {
            if let value = values[character] { digit = value; continue }
            guard let unit = ["十":10,"百":100,"千":1000,"万":10000][String(character)] else { return nil }
            if unit == 10000 { section += digit; result += max(1, section) * unit; section = 0; digit = 0 }
            else { section += max(1, digit) * unit; digit = 0 }
        }
        return result + section + digit
    }
    private static func removingNumber(_ title: String) -> String { title.replacingOccurrences(of: numberPattern, with: "", options: .regularExpression) }
    public static func utf16Offset(fraction: Double, content: ChapterContent) -> Int {
        let text = content.paragraphs.joined(separator: "\n")
        let target = Int(Double(text.utf16.count) * min(1, max(0, fraction.isFinite ? fraction : 0)))
        let units = Array(text.utf16)
        // Avoid placing the restored anchor inside an emoji's surrogate pair.
        return target > 0 && target < units.count && (0xDC00...0xDFFF).contains(units[target]) ? target - 1 : target
    }
}

public struct BookUpdateTracking: Codable, Equatable, Sendable {
    public var chapterIDs: [String]
    public var newChapterIDs: [String]
    public var checkedAt: Date?
    public var lastChapterTitle: String?
    public var lastAttemptAt: Date?
    public init(chapterIDs: [String] = [], newChapterIDs: [String] = [], checkedAt: Date? = nil) {
        self.chapterIDs = chapterIDs; self.newChapterIDs = newChapterIDs; self.checkedAt = checkedAt; self.lastChapterTitle = nil; self.lastAttemptAt = nil
    }
    public mutating func refreshed(_ chapters: [Chapter], previous: [Chapter]?, readIndex: Int?, at date: Date = Date()) {
        let ids = chapters.map(\.id)
        let baseline = chapterIDs.isEmpty ? (previous?.map(\.id) ?? []) : chapterIDs
        var appended: [String] = []
        if let last = baseline.last {
            if let index = ids.firstIndex(of: last) { appended = Array(ids.dropFirst(index + 1)) }
            else if let title = lastChapterTitle ?? previous?.last?.title {
                let normalized = SourceProgressMatcher.normalized(title)
                let matches = chapters.indices.filter { SourceProgressMatcher.normalized(chapters[$0].title) == normalized }
                if matches.count == 1 { appended = Array(ids.dropFirst(matches[0] + 1)) }
            }
        }
        let pending = Set(newChapterIDs + appended)
        newChapterIDs = ids.enumerated().filter { pending.contains($0.element) && $0.offset > (readIndex ?? -1) }.map(\.element)
        chapterIDs = ids; checkedAt = date; lastChapterTitle = chapters.last?.title
    }
}

public enum ChapterDownloadStatus: String, Codable, Sendable { case queued, running, paused, completed, failed, cancelled }
public struct ChapterDownloadTask: Codable, Identifiable, Sendable {
    public let id: UUID
    public let book: Book
    public let chapters: [Chapter]
    public var completedIDs: Set<String>
    public var failedIDs: Set<String>
    public var status: ChapterDownloadStatus
    public var lastError: String?
    public let createdAt: Date
    public init(book: Book, chapters: [Chapter]) {
        id = UUID(); self.book = book; self.chapters = chapters; completedIDs = []; failedIDs = []
        status = .queued; createdAt = Date()
    }
    public var completedCount: Int { completedIDs.count }
}

/// The shared/cloud anchor counts only正文 UTF-16 units; the native layout also
/// contains its heading. Convert only at the native reader boundary.
public enum ReaderBodyAnchor {
    public static func prefixLength(_ content: ChapterContent) -> Int { content.chapter.title.utf16.count + 1 }
    public static func bodyLength(_ content: ChapterContent) -> Int { content.paragraphs.joined(separator: "\n").utf16.count }
    public static func bodyOffset(documentOffset: Int, content: ChapterContent) -> Int {
        min(bodyLength(content), max(0, documentOffset - prefixLength(content)))
    }
    public static func documentOffset(bodyOffset: Int, content: ChapterContent) -> Int {
        min(bodyLength(content), max(0, bodyOffset)) + prefixLength(content)
    }
    public static func fraction(documentOffset: Int, content: ChapterContent) -> Double {
        Double(bodyOffset(documentOffset: documentOffset, content: content)) / Double(max(1, bodyLength(content)))
    }
}
