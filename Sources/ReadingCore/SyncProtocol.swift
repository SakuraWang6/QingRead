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
public enum ShelfReadingStatus: String, Codable, CaseIterable, Sendable { case reading, later, finished }
public struct ShelfOrganization: Codable, Hashable, Sendable {
    public var pinned: Bool
    public var status: ShelfReadingStatus
    public var group: String
    public var updatedAt: Date
    public init(pinned: Bool = false, status: ShelfReadingStatus = .reading, group: String = "", updatedAt: Date = Date()) {
        self.pinned = pinned; self.status = status; self.group = ReadingMetadataText.clipped(group, utf16Limit: 40); self.updatedAt = updatedAt
    }
}
public enum ReadingAnnotationKind: String, Codable, Sendable { case bookmark, note }
public struct ReadingAnnotation: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public var kind: ReadingAnnotationKind
    public var chapterID: String
    public var chapterIndex: Int
    public var chapterTitle: String
    public var characterOffset: Int
    public var characterLength: Int
    public var quote: String
    public var note: String
    public var updatedAt: Date
    public var deletedAt: Date?
    public var sourceID: String
    public var sourceURL: String
    public init(id: String = UUID().uuidString, kind: ReadingAnnotationKind, chapterID: String, chapterIndex: Int, chapterTitle: String, characterOffset: Int, characterLength: Int = 0, quote: String = "", note: String = "", updatedAt: Date = Date(), deletedAt: Date? = nil, sourceID: String, sourceURL: String) {
        self.id = id; self.kind = kind; self.chapterID = chapterID; self.chapterIndex = max(0, chapterIndex); self.chapterTitle = ReadingMetadataText.clipped(chapterTitle, utf16Limit: 500)
        self.characterOffset = max(0, characterOffset); self.characterLength = max(0, characterLength); self.quote = ReadingMetadataText.clipped(quote, utf16Limit: 500); self.note = ReadingMetadataText.clipped(note, utf16Limit: 1000)
        self.updatedAt = updatedAt; self.deletedAt = deletedAt; self.sourceID = sourceID; self.sourceURL = sourceURL
    }
}
public struct ShelfEntry: Codable, Identifiable, Sendable {
    public var id: String { book.id }
    public let book: Book
    public var position: ReadingPosition?
    public let addedAt: Date
    public var organization: ShelfOrganization?
    public var annotations: [ReadingAnnotation]?
    public init(book: Book, position: ReadingPosition? = nil, addedAt: Date, organization: ShelfOrganization? = nil, annotations: [ReadingAnnotation]? = nil) {
        self.book = book; self.position = position; self.addedAt = addedAt; self.organization = organization; self.annotations = annotations
    }
    public mutating func mergeMetadata(from other: ShelfEntry) {
        if let incoming = other.organization, organization == nil || incoming.updatedAt > organization!.updatedAt { organization = incoming }
        var notes = Dictionary((annotations ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in other.annotations ?? [] where notes[item.id] == nil || item.updatedAt > notes[item.id]!.updatedAt { notes[item.id] = item }
        if !notes.isEmpty { annotations = Array(notes.values).sorted { $0.updatedAt > $1.updatedAt }.prefix(256).map { $0 } }
    }
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

public enum ReadingMetadataText {
    public static func clipped(_ value: String, utf16Limit: Int) -> String {
        var units = Array(value.utf16.prefix(max(0, utf16Limit)))
        if let last = units.last, (0xD800...0xDBFF).contains(last) { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }
}
