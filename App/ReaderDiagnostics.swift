#if DEBUG
import UIKit
import ReadingCore

/// Explicit simulator diagnostics; never runs during normal reading.
@MainActor enum ReaderDiagnostics {
    static func run() {
        do {
            let old = try JSONDecoder().decode(ReaderSettings.self, from: Data(#"{"fontSize":25,"lineSpacing":13,"theme":"night"}"#.utf8))
            assert(old.theme == .paper && old.isNightMode && old.fontSize == 25 && old.lineSpacing == 13)
            let sparse = try JSONDecoder().decode(ReaderSettings.self, from: Data("{}".utf8))
            assert(sparse.turnMode == .slide && sparse.followsSystemBrightness)
            let roundTrip = try JSONDecoder().decode(ReaderSettings.self, from: JSONEncoder().encode(old))
            assert(roundTrip == old)
            ReaderSpeechController.runDiagnostics()
            verifyBookProgress()
            let speech = ReaderSpeechController()
            let pendingIntent = speech.beginChapterTransition(autoplay: true)!
            assert(speech.permitsAutoplay(pendingIntent))
            speech.stop()
            assert(!speech.permitsAutoplay(pendingIntent), "Stop during loading must prevent later autoplay")
            let pausedIntent = speech.beginChapterTransition(autoplay: true)!
            speech.pause()
            assert(!speech.permitsAutoplay(pausedIntent))
            speech.resume()
            assert(speech.permitsAutoplay(pausedIntent))
            speech.stop()
            let chapter = Chapter(id: "diagnostic-utf16", title: "分页与文字位置", url: URL(string: "https://example.invalid/diagnostic")!, index: 0)
            let sentence = "这是独立的分页测试文字。👩🏽‍🚀联合字形、𠮷与e\u{301}都必须完整保留。"
            let content = ChapterContent(chapter: chapter, paragraphs: Array(repeating: String(repeating: sentence, count: 8), count: 25))
            var settings = ReaderSettings()
            let canvas = ReaderCanvas(frame: CGRect(x: 0, y: 0, width: 393, height: 690))
            let document = ReaderDocument(content: content, settings: settings)
            let desiredAnchor = document.text.length / 3
            canvas.apply(content: content, settings: settings, initialOffset: desiredAnchor, seek: nil)
            canvas.layoutIfNeeded()
            let first = canvas.debugPagination()
            assert(first.ranges.count > 1 && first.utf16Count == document.text.length)
            assert(NSLocationInRange(desiredAnchor, first.visible))
            let savedAnchor = first.visible.location
            settings.fontSize = 32
            settings.lineSpacing = 19
            canvas.apply(content: content, settings: settings, initialOffset: savedAnchor, seek: nil)
            canvas.layoutIfNeeded()
            let resized = canvas.debugPagination()
            assert(NSLocationInRange(savedAnchor, resized.visible))
            assert(resized.ranges.reduce(0) { $0 + $1.length } == document.text.length)
            settings.turnMode = .cover
            canvas.apply(content: content, settings: settings, initialOffset: savedAnchor, seek: nil)
            canvas.layoutIfNeeded()
            let covered = canvas.debugPagination()
            assert(covered.ranges.reduce(0) { $0 + $1.length } == document.text.length)
            let progressAnchor = ReaderBookProgress.utf16Offset(for: 0.73, textLength: document.text.length)
            canvas.apply(content: content, settings: settings, initialOffset: savedAnchor,
                         seek: ReaderSeekRequest(utf16Offset: progressAnchor))
            canvas.layoutIfNeeded()
            assert(NSLocationInRange(progressAnchor, canvas.debugPagination().visible), "Progress must seek to the page containing the requested text")
            print("QINGREAD_READER_SELFTEST migration=passed speechIntent=passed bookProgress=passed progressSeek=passed utf16=\(document.text.length) slidePages=\(first.ranges.count) largeFontPages=\(resized.ranges.count) coverPages=\(covered.ranges.count) anchor=passed")
        } catch { assertionFailure("Reader diagnostics failed: \(error)") }
    }

    private static func verifyBookProgress() {
        assert(ReaderBookProgress.fraction(chapterIndex: 0, chapterFraction: 0, chapterCount: 0) == 0)
        assert(ReaderBookProgress.destination(for: 0.5, chapterCount: 0) == nil)
        assert(ReaderBookProgress.fraction(chapterIndex: 2, chapterFraction: 0.5, chapterCount: 10) == 0.25)
        assert(ReaderBookProgress.destination(for: 0.25, chapterCount: 10) == .init(chapterIndex: 2, chapterFraction: 0.5))
        assert(ReaderBookProgress.destination(for: 1, chapterCount: 10) == .init(chapterIndex: 9, chapterFraction: 1))
        assert(ReaderBookProgress.destination(for: -1, chapterCount: 10) == .init(chapterIndex: 0, chapterFraction: 0))
        assert(ReaderBookProgress.destination(for: .nan, chapterCount: 10) == .init(chapterIndex: 0, chapterFraction: 0))
        assert(ReaderBookProgress.utf16Offset(for: 1, textLength: 7432) == 7431)
        assert(ReaderBookProgress.utf16Offset(for: 0.5, textLength: 7432) == 3716)
        assert(ReaderBookProgress.utf16Offset(for: 0.5, textLength: 0) == 0)
        for index in 0..<120 {
            let boundary = ReaderBookProgress.fraction(chapterIndex: index, chapterFraction: 0, chapterCount: 120)
            assert(ReaderBookProgress.destination(for: boundary, chapterCount: 120) == .init(chapterIndex: index, chapterFraction: 0))
            let fraction = ReaderBookProgress.fraction(chapterIndex: index, chapterFraction: 0.37, chapterCount: 120)
            let target = ReaderBookProgress.destination(for: fraction, chapterCount: 120)!
            assert(target.chapterIndex == index && abs(target.chapterFraction - 0.37) < 0.00001)
        }
    }
}
#endif
