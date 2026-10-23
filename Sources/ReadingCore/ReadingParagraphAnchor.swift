import Foundation

/// A whole paragraph in the body-only UTF-16 coordinate system shared by all clients.
/// The heading is part of native layout, but never part of a stored annotation.
public struct ReadingParagraphAnchor: Hashable, Sendable {
    public let index: Int
    public let characterOffset: Int
    public let characterLength: Int
    public let text: String

    public static func at(documentOffset: Int, in content: ChapterContent) -> Self? {
        let prefix = ReaderBodyAnchor.prefixLength(content)
        guard documentOffset >= prefix else { return nil }
        return at(bodyOffset: documentOffset - prefix, in: content)
    }

    public static func at(bodyOffset: Int, in content: ChapterContent) -> Self? {
        guard bodyOffset >= 0 else { return nil }
        var start = 0
        for (index, text) in content.paragraphs.enumerated() {
            let length = text.utf16.count
            if bodyOffset >= start, bodyOffset < start + length {
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return Self(index: index, characterOffset: start, characterLength: length, text: text)
            }
            start += length + 1 // ChapterContent's body joins paragraphs with one newline.
        }
        return nil
    }

    /// A page's first character can be a newline or a blank paragraph. Menu actions
    /// choose the following body paragraph, or the last one at the end of a chapter.
    /// Direct touch selection deliberately uses `at` instead, so blank space stays inert.
    public static func atOrFollowing(bodyOffset: Int, in content: ChapterContent) -> Self? {
        let offset = max(0, bodyOffset)
        var start = 0
        var previous: Self?
        for (index, text) in content.paragraphs.enumerated() {
            let length = text.utf16.count
            defer { start += length + 1 }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let paragraph = Self(index: index, characterOffset: start, characterLength: length, text: text)
            if offset < start + length { return paragraph }
            previous = paragraph
        }
        return previous
    }

    /// Include older, precisely selected quotes without changing their stored ranges.
    public func overlaps(_ annotation: ReadingAnnotation) -> Bool {
        guard annotation.kind == .note, annotation.deletedAt == nil else { return false }
        let start = annotation.characterOffset
        guard start < characterOffset + characterLength else { return false }
        if annotation.characterLength == 0 { return start >= characterOffset }
        return start >= characterOffset || annotation.characterLength > characterOffset - start
    }
}
