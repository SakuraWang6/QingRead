import Foundation

/// Same canonical whitespace and UTF-16 page offsets as web/src/lib/pdfText.ts.
public enum PDFTextAnchor {
    public static func pageID(_ index: Int) -> String { "pdf-page-\(index)" }
    private static func whitespace(_ unit: UInt16) -> Bool {
        (0x09...0x0d).contains(unit) || [0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].contains(unit) || (0x2000...0x200a).contains(unit)
    }
    private static func mapping(_ value: String) -> (String, [Int]) {
        var result: [UInt16] = [], origins: [Int] = [], space: Int?
        for (index, unit) in value.utf16.enumerated() {
            if whitespace(unit) { if !result.isEmpty && space == nil { space = index }; continue }
            if let position = space { result.append(0x20); origins.append(position); space = nil }
            result.append(unit); origins.append(index)
        }
        origins.append(value.utf16.count)
        return (String(decoding: result, as: UTF16.self), origins)
    }
    public static func canonical(_ value: String) -> String { mapping(value).0 }
    public static func canonicalOffset(_ rawOffset: Int, in value: String) -> Int {
        let offsets = mapping(value).1
        return offsets.dropLast().prefix { $0 < max(0, rawOffset) }.count
    }
    public static func rawRange(offset: Int, length: Int, in value: String) -> NSRange {
        let offsets = mapping(value).1, count = offsets.count - 1
        let start = min(count, max(0, offset)), end = min(count, start + max(0, min(length, count)))
        return NSRange(location: offsets[start], length: max(0, offsets[end] - offsets[start]))
    }
}
