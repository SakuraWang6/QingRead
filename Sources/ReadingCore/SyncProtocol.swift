import Foundation

public struct ReadingPosition: Codable, Hashable, Sendable {
    public var chapterID: String
    public var chapterIndex: Int
    public var characterOffset: Int
    public var chapterFraction: Double
    public var updatedAt: Date
    public init(chapterID: String, chapterIndex: Int, characterOffset: Int, chapterFraction: Double, updatedAt: Date) {
        self.chapterID = chapterID; self.chapterIndex = chapterIndex; self.characterOffset = characterOffset; self.chapterFraction = chapterFraction; self.updatedAt = updatedAt
    }
}
public struct ShelfEntry: Codable, Identifiable, Sendable {
    public var id: String { book.id }
    public let book: Book
    public var position: ReadingPosition?
    public let addedAt: Date
    public init(book: Book, position: ReadingPosition? = nil, addedAt: Date) { self.book = book; self.position = position; self.addedAt = addedAt }
}
public struct CloudUser: Codable, Sendable { public let id: String; public let username: String }
public struct CloudSession: Codable, Sendable { public let user: CloudUser; public let token: String; public let expiresAt: Date; public let serverTime: Date }
public struct CloudRecord: Codable, Sendable { public let bookID: String; public let entry: ShelfEntry?; public let revision: Int; public let changedAt: Date }
public struct CloudRejection: Codable, Sendable { public let id: String; public let reason: String }
public enum CloudAction: String, Codable, Sendable { case add, progress, remove }
public struct CloudMutation: Codable, Sendable {
    public let id: String
    public var action: CloudAction
    public let bookID: String
    public let baseRevision: Int
    public let changedAt: Date
    public let entry: ShelfEntry?
    public init(id: String = UUID().uuidString, action: CloudAction, bookID: String, baseRevision: Int, changedAt: Date = Date(), entry: ShelfEntry? = nil) {
        self.id=id; self.action=action; self.bookID=bookID; self.baseRevision=baseRevision; self.changedAt=changedAt; self.entry=entry
    }
}
public struct CloudSnapshot: Codable, Sendable {
    public let anchorFormat: String
    public let cursor: Int
    public let records: [CloudRecord]
    public let acknowledged: [String]
    public let rejected: [CloudRejection]
    public let hasMore: Bool
    public let serverTime: Date
}
public struct CloudSyncRequest: Encodable, Sendable {
    public let anchorFormat = "body-utf16-v1"
    public let cursor: Int
    public let mutations: [CloudMutation]
    public init(cursor: Int, mutations: [CloudMutation]) { self.cursor=cursor; self.mutations=mutations }
}
public enum CloudJSON {
    public static func encoder() -> JSONEncoder {
        let encoder=JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            var container=encoder.singleValueContainer();try container.encode(formatter.string(from: date))
        }
        return encoder
    }
    public static func decoder() -> JSONDecoder {
        let decoder=JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container=try decoder.singleValueContainer(), value=try container.decode(String.self)
            let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            if let date=formatter.date(from:value) { return date }
            formatter.formatOptions=[.withInternetDateTime]
            if let date=formatter.date(from:value) { return date }
            throw DecodingError.dataCorruptedError(in:container,debugDescription:"Invalid sync timestamp")
        }
        return decoder
    }
}

public struct CloudFile: Codable, Sendable {
    public let bookID: String
    public let hash: String
    public let bytes: Int
    public let format: BookFileFormat
    public let updatedAt: Date
}
public struct CloudFileSnapshot: Codable, Sendable {
    public let files: [CloudFile]
    public let usedBytes: Int
    public let limitBytes: Int
    public let maxFileBytes: Int
}
