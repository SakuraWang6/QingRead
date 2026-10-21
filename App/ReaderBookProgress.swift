import Foundation

/// Page weights use measured layouts where available and cached text elsewhere.
/// Unloaded chapters share the median cached length; no whole-book crawl is needed.
enum ReaderBookProgress {
    struct Destination: Equatable { let chapterIndex: Int; let pageIndex: Int }

    static func pageCounts(chapterCount: Int, lengths: [Int: Int], measured: [Int: Int], unitsPerPage: Double) -> [Int] {
        guard chapterCount > 0 else { return [] }
        let capacity = unitsPerPage.isFinite ? max(1, unitsPerPage) : 350
        let samples = lengths.values.filter { $0 > 0 }.sorted()
        let typical = samples.isEmpty ? Int(capacity) : samples[samples.count / 2]
        let known: [Int?] = (0..<chapterCount).map { index in
            if let count = measured[index] { return max(1, count) }
            return lengths[index].map { max(1, Int(ceil(Double($0) / capacity))) }
        }
        let pageSamples = known.compactMap { $0 }.sorted()
        let typicalPages = pageSamples.isEmpty ? max(1, Int(ceil(Double(typical) / capacity))) : pageSamples[pageSamples.count / 2]
        return known.map { $0 ?? typicalPages }
    }
    static func pageNumber(chapterIndex: Int, pageIndex: Int, pageCounts: [Int]) -> Int {
        guard !pageCounts.isEmpty else { return 1 }
        let index = min(max(0, chapterIndex), pageCounts.count - 1)
        return pageCounts.prefix(index).reduce(0, +) + min(max(0, pageIndex), pageCounts[index] - 1) + 1
    }
    static func fraction(pageNumber: Int, totalPages: Int) -> Double {
        totalPages > 1 ? bounded(Double(pageNumber - 1) / Double(totalPages - 1)) : 0
    }
    static func pageNumber(for fraction: Double, totalPages: Int) -> Int {
        Int((bounded(fraction) * Double(max(0, totalPages - 1))).rounded()) + 1
    }
    static func destination(for fraction: Double, pageCounts: [Int]) -> Destination? {
        guard !pageCounts.isEmpty else { return nil }
        var page = pageNumber(for: fraction, totalPages: pageCounts.reduce(0, +)) - 1
        for (index, count) in pageCounts.enumerated() {
            if page < count { return Destination(chapterIndex: index, pageIndex: page) }
            page -= count
        }
        return Destination(chapterIndex: pageCounts.count - 1, pageIndex: max(0, pageCounts.last! - 1))
    }
    static func utf16Offset(for fraction: Double, textLength: Int) -> Int {
        guard textLength > 0 else { return 0 }
        return min(textLength - 1, Int(bounded(fraction) * Double(textLength)))
    }
    static func label(for fraction: Double) -> String { String(format: "%.1f%%", bounded(fraction) * 100) }
    private static func bounded(_ value: Double) -> Double { value.isFinite ? min(1, max(0, value)) : 0 }
}

enum ReaderTurnGesture {
    static func commits(distance: CGFloat, velocity: CGFloat, extent: CGFloat) -> Bool {
        abs(distance) >= min(48, max(24, extent * 0.14)) || (abs(distance) >= 12 && abs(velocity) >= 450)
    }
}
