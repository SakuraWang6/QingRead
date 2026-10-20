import Foundation
import Testing
@testable import ReadingCore

@Test func sharedCloudContractUsesISOTimeAndUTF16Anchors() throws {
    let fixture=URL(fileURLWithPath:#filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/cloud-snapshot.json")
    let snapshot=try CloudJSON.decoder().decode(CloudSnapshot.self,from:Data(contentsOf:fixture))
    let entry=try #require(snapshot.records.first?.entry)
    #expect(snapshot.anchorFormat=="body-utf16-v1")
    #expect(entry.position?.characterOffset==Array("𠀀🙂中é".utf16).count)
    #expect(entry.book.fileHash?.count==64)
    let mutation=CloudMutation(id:"fixture-op-0001",action:.progress,bookID:entry.id,baseRevision:2,entry:entry)
    let data=try CloudJSON.encoder().encode(CloudSyncRequest(cursor:2,mutations:[mutation]))
    let object=try #require(JSONSerialization.jsonObject(with:data) as? [String:Any])
    let mutations=try #require(object["mutations"] as? [[String:Any]])
    let encodedEntry=try #require(mutations.first?["entry"] as? [String:Any])
    #expect(encodedEntry["addedAt"] as? String=="2026-10-20T12:00:00.000Z")
    #expect(object["anchorFormat"] as? String=="body-utf16-v1")
}

@Test func legacyNativeShelfRemainsReadableWithoutFileHash() throws {
    let data=Data(#"{"book":{"id":"legacy","title":"旧书架","author":"","summary":"","sourceID":"local-file","sourceName":"本地文件","url":"qingread-import://legacy","publicationFormat":"txt"},"addedAt":0}"#.utf8)
    let entry=try JSONDecoder().decode(ShelfEntry.self,from:data)
    #expect(entry.book.fileHash==nil)
    #expect(entry.book.id=="legacy")
}
