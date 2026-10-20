import Foundation

/// Chapters have equal weight because sources do not publish reliable word counts.
/// The position inside a chapter uses the reader's actual UTF-16 text anchor.
enum ReaderBookProgress {
    struct Destination: Equatable {
        let chapterIndex: Int
        let chapterFraction: Double
    }

    static func fraction(chapterIndex: Int, chapterFraction: Double, chapterCount: Int) -> Double {
        guard chapterCount > 0 else { return 0 }
        let index = min(max(0, chapterIndex), chapterCount - 1)
        return (Double(index) + bounded(chapterFraction)) / Double(chapterCount)
    }

    static func destination(for fraction: Double, chapterCount: Int) -> Destination? {
        guard chapterCount > 0 else { return nil }
        let rawPosition = bounded(fraction) * Double(chapterCount)
        // Division/multiplication can put an exact chapter boundary one ULP
        // below its index. Snap only that rounding noise, not real text positions.
        let nearestBoundary = rawPosition.rounded()
        let tolerance = Double.ulpOfOne * max(1, rawPosition) * 4
        let position = abs(rawPosition - nearestBoundary) <= tolerance ? nearestBoundary : rawPosition
        let index = min(Int(position), chapterCount - 1)
        return Destination(chapterIndex: index, chapterFraction: min(1, position - Double(index)))
    }

    static func utf16Offset(for fraction: Double, textLength: Int) -> Int {
        guard textLength > 0 else { return 0 }
        return min(textLength - 1, Int(bounded(fraction) * Double(textLength)))
    }

    static func label(for fraction: Double) -> String {
        String(format: "%.1f%%", bounded(fraction) * 100)
    }

    private static func bounded(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(1, max(0, value))
    }
}
