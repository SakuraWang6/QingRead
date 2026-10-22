import Foundation
import Testing
@testable import ReadingCore

struct PDFTextAnchorTests {
    @Test func canonicalWhitespaceMatchesTheWebContractAndKeepsUTF16Offsets() {
        let raw = " 𠀀🙂\n\t中文\u{00a0}\u{0085}书 "
        #expect(PDFTextAnchor.canonical(raw) == "𠀀🙂 中文 书")
        #expect(PDFTextAnchor.pageID(0) == "pdf-page-0")
        let range = (raw as NSString).range(of: "中文")
        #expect(PDFTextAnchor.canonicalOffset(range.location, in: raw) == 5)
        #expect(PDFTextAnchor.rawRange(offset: 5, length: 2, in: raw) == range)
    }
    @Test func boundsInvalidOffsetsWithoutChangingOriginalPageText() {
        let value = "\n甲  乙\t"
        #expect(PDFTextAnchor.canonicalOffset(-1, in: value) == 0)
        #expect(PDFTextAnchor.rawRange(offset: -10, length: 1, in: value) == NSRange(location: 1, length: 1))
        #expect(PDFTextAnchor.rawRange(offset: 1000, length: 1000, in: value) == NSRange(location: value.utf16.count, length: 0))
    }
}
