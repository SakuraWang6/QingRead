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
            assert(sparse.paragraphSpacing == 6 && sparse.kokoroVoiceID == 46)
            assert(sparse.font == .system && sparse.fontPreferenceVersion == 1)
            let legacySong = try JSONDecoder().decode(ReaderSettings.self, from: Data(#"{"font":"song"}"#.utf8))
            let legacyRounded = try JSONDecoder().decode(ReaderSettings.self, from: Data(#"{"font":"rounded"}"#.utf8))
            assert(legacySong.font == .system && legacyRounded.font == .rounded)
            var selectedSong = legacySong; selectedSong.font = .song
            let restoredSong = try JSONDecoder().decode(ReaderSettings.self, from: JSONEncoder().encode(selectedSong))
            assert(restoredSong.font == .song && restoredSong.fontPreferenceVersion == 1)
            verifyParagraphIndent()
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
            let indentation = ["", "  ", "\u{3000}\u{3000}", "\t\t"]
            let content = ChapterContent(chapter: chapter, paragraphs: (0..<25).map { indentation[$0 % indentation.count] + String(repeating: sentence, count: 8) })
            verifyAnnotationLayout(content: content)
            var settings = ReaderSettings()
            let canvas = ReaderCanvas(frame: CGRect(x: 0, y: 0, width: 393, height: 690))
            let document = ReaderDocument(content: content, settings: settings)
            let paragraphStyle = document.text.attribute(.paragraphStyle, at: document.paragraphRanges[0].location, effectiveRange: nil) as! NSParagraphStyle
            assert(paragraphStyle.paragraphSpacing == 6 && paragraphStyle.lineSpacing == 9)
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
            for mode in [ReaderTurnMode.slide, .cover] {
                settings.turnMode = mode
                canvas.apply(content: content, settings: settings, initialOffset: 0, seek: ReaderSeekRequest(utf16Offset: progressAnchor))
                canvas.layoutIfNeeded()
                let beforeTap = canvas.debugPagination()
                let beforeIndex = beforeTap.ranges.firstIndex(of: beforeTap.visible)!
                assert(beforeIndex > 0)
                var boundaryCalls = 0
                canvas.onBoundary = { _ in boundaryCalls += 1 }
                canvas.debugTap(at: 0.1)
                assert(canvas.debugPagination().visible == beforeTap.ranges[beforeIndex - 1], "Left tap must move to the previous page within the current chapter")
                assert(boundaryCalls == 0)
                canvas.apply(content: content, settings: settings, initialOffset: 0, seek: ReaderSeekRequest(utf16Offset: 0))
                canvas.layoutIfNeeded()
                canvas.debugTap(at: 0.1)
                assert(boundaryCalls == 1, "Only a left tap on the first page may cross the chapter boundary")
            }
            let nextChapter = Chapter(id: "diagnostic-next", title: "下一章", url: chapter.url, index: 1)
            let nextContent = ChapterContent(chapter: nextChapter, paragraphs: ["下一章正文。"])
            canvas.apply(content: nextContent, settings: settings, initialOffset: 0, seek: nil)
            canvas.layoutIfNeeded()
            canvas.apply(content: content, settings: settings, initialOffset: document.text.length - 1, seek: nil)
            canvas.frame.size.height += 1
            canvas.layoutIfNeeded()
            let restoredPrevious = canvas.debugPagination()
            assert(restoredPrevious.visible.location == restoredPrevious.ranges.last!.location, "Backwards chapter turn must restore the final page even when the viewport changes")
            print("QINGREAD_READER_SELFTEST migration=passed speechIntent=passed bookProgress=passed progressSeek=passed previousPageTap=passed backwardsChapterResize=passed utf16=\(document.text.length) slidePages=\(first.ranges.count) largeFontPages=\(resized.ranges.count) coverPages=\(covered.ranges.count) anchor=passed")
            Task { await verifyPreparedChapterTurns(content: content) }
        } catch { assertionFailure("Reader diagnostics failed: \(error)") }
    }

    private static func verifyParagraphIndent() {
        let chapter = Chapter(id: "diagnostic-indent", title: "段首缩进", url: URL(string: "https://example.invalid/indent")!, index: 0)
        let prefixes = ["", "  ", "\u{3000}\u{3000}", "\t\t", "\u{00a0}\u{3000} "]
        let body = "同一行正文。👩🏽‍🚀"
        let content = ChapterContent(chapter: chapter, paragraphs: prefixes.map { $0 + body })
        for mode in [ReaderTurnMode.slide, .cover, .scroll] {
            var settings = ReaderSettings(); settings.turnMode = mode
            let document = ReaderDocument(content: content, settings: settings)
            assert(document.text.string == chapter.title + "\n" + content.paragraphs.joined(separator: "\n"), "Display indentation must not change stored UTF-16 positions")
            let canvas = ReaderCanvas(frame: CGRect(x: 0, y: 0, width: 393, height: 690))
            canvas.apply(content: content, settings: settings, initialOffset: 0, seek: nil)
            canvas.layoutIfNeeded()
            let reference = canvas.debugPoint(atUTF16: document.paragraphRanges[0].location)!
            for index in prefixes.indices {
                let source = document.paragraphRanges[index]
                let visible = source.location + (prefixes[index] as NSString).length
                let point = canvas.debugPoint(atUTF16: visible)!
                assert(abs(point.x - reference.x) < 0.1, "Source spaces and tabs must not add to the two-character indent")
                assert(NSLocationInRange(canvas.debugAnnotationOffset(at: point) ?? NSNotFound, source), "Collapsed leading whitespace must preserve paragraph hit testing")
            }
            assert(canvas.debugValidatePageLayout())
            if mode != .scroll {
                assert(canvas.debugPagination().ranges.reduce(0) { $0 + $1.length } == document.text.length)
            }
            canvas.cancelPreparation()
        }
        print("QINGREAD_PARAGRAPH_INDENT twoCharacters=passed sourceUTF16=passed tabs=passed hitTest=passed")
    }

    private static func verifyAnnotationLayout(content: ChapterContent) {
        for mode in [ReaderTurnMode.slide, .cover, .scroll] {
            var settings = ReaderSettings(); settings.turnMode = mode
            let canvas = ReaderCanvas(frame: CGRect(x: 0, y: 0, width: 393, height: 690))
            let document = ReaderDocument(content: content, settings: settings)
            canvas.apply(content: content, settings: settings, initialOffset: 0, seek: nil)
            canvas.layoutIfNeeded()
            let paragraph = document.paragraphRanges[0]
            let bodyPoint = canvas.debugPoint(atUTF16: paragraph.location + 4)!
            assert(NSLocationInRange(canvas.debugAnnotationOffset(at: bodyPoint) ?? NSNotFound, paragraph), "Long press must identify the touched paragraph")
            assert(canvas.debugAnnotationOffset(at: CGPoint(x: 1, y: bodyPoint.y)) == nil, "Margins must not select the nearest paragraph")
            assert(canvas.debugAnnotationOffset(at: canvas.debugPoint(atUTF16: 0)!) == nil, "The chapter title must not select the first body paragraph")
            if mode != .scroll {
                let before = canvas.debugRenderedPage()!
                let laidGlyphs = canvas.debugFirstUnlaidGlyph
                assert(laidGlyphs > 0)
                canvas.annotationRanges = [paragraph]
                canvas.highlightAnnotations()
                assert(canvas.debugFirstUnlaidGlyph == laidGlyphs, "Adding a display underline must preserve the laid-out glyph positions")
                canvas.annotationRanges = []
                canvas.highlightAnnotations()
                assert(canvas.debugFirstUnlaidGlyph == laidGlyphs, "Removing an absent or existing underline must not invalidate pagination")
                assert(canvas.debugRenderedPage() == before, "Removing annotation marks must restore the exact page drawing")
                assert(canvas.debugValidatePageLayout(), "Every drawn line must still belong to its cached page and fit its viewport")
                let saved = canvas.debugPagination().visible.location
                settings.fontSize = 32; settings.paragraphSpacing = 14
                canvas.apply(content: content, settings: settings, initialOffset: saved, seek: nil)
                canvas.layoutIfNeeded()
                assert(canvas.debugValidatePageLayout())
                canvas.frame.size = CGSize(width: 690, height: 393)
                canvas.layoutIfNeeded()
                assert(canvas.debugValidatePageLayout(), "Rotation must rebuild all page containers for the new size")
            }
            let short = ChapterContent(chapter: Chapter(id: "diagnostic-short-\(mode.rawValue)", title: "短章节", url: content.chapter.url, index: 0), paragraphs: ["正文第一段。", "直接长按第二段。", "正文第三段。"])
            canvas.apply(content: short, settings: settings, initialOffset: 0, seek: nil)
            canvas.layoutIfNeeded()
            let secondParagraph = ReaderDocument(content: short, settings: settings).paragraphRanges[1]
            let secondPoint = canvas.debugPoint(atUTF16: secondParagraph.location + 2)!
            assert(NSLocationInRange(canvas.debugAnnotationOffset(at: secondPoint) ?? NSNotFound, secondParagraph), "Long-pressing the second paragraph must not select the first paragraph or the page anchor")
            assert(canvas.debugAnnotationOffset(at: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.height - 80)) == nil, "Blank space below a short chapter must not open a paragraph note")
            canvas.cancelPreparation()
            print("QINGREAD_ANNOTATION_LAYOUT mode=\(mode.rawValue) displayOnlyUnderline=passed exactDrawingRestore=passed paragraphHit=passed emptySpace=passed resize=passed")
        }
    }

    private static func verifyPreparedChapterTurns(content: ChapterContent) async {
        let previous = content
        let previousLength = ReaderDocument(content: previous, settings: ReaderSettings()).text.length
        let chapter = Chapter(id: "diagnostic-middle", title: "中间章", url: content.chapter.url, index: 1)
        let current = ChapterContent(chapter: chapter, paragraphs: content.paragraphs)
        let next = ChapterContent(chapter: Chapter(id: "diagnostic-last", title: "下一章", url: content.chapter.url, index: 2), paragraphs: content.paragraphs)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 690))
        let controller = UIViewController()
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        for mode in [ReaderTurnMode.slide, .cover] {
            for direction in [-1, 1] {
                let canvas = ReaderCanvas(frame: window.bounds)
                controller.view.addSubview(canvas)
                var settings = ReaderSettings(); settings.turnMode = mode
                let currentLength = ReaderDocument(content: current, settings: settings).text.length
                canvas.apply(content: current, settings: settings, initialOffset: direction < 0 ? 0 : currentLength - 1, seek: nil, previousContent: previous, nextContent: next)
                canvas.layoutIfNeeded()
                await canvas.debugAwaitPreparation()
                assert(canvas.debugPreparedEdges == 2)
                let builds = canvas.debugLayoutBuilds
                var boundaries = 0
                var installMilliseconds = 0.0
                canvas.onBoundary = { delta in
                    assert(delta == direction)
                    boundaries += 1
                    let start = CACurrentMediaTime()
                    if direction < 0 {
                        canvas.apply(content: previous, settings: settings, initialOffset: previousLength - 1, seek: nil, nextContent: current)
                    } else {
                        canvas.apply(content: next, settings: settings, initialOffset: 0, seek: nil, previousContent: current)
                    }
                    canvas.layoutIfNeeded()
                    installMilliseconds = (CACurrentMediaTime() - start) * 1000
                }
                canvas.debugTap(at: direction < 0 ? 0.1 : 0.9, animated: true)
                assert(boundaries == 0, "A prepared chapter must animate as a page before committing the chapter change")
                try? await Task.sleep(nanoseconds: 650_000_000)
                assert(boundaries == 1)
                let result = canvas.debugPagination()
                assert(result.visible == (direction < 0 ? result.ranges.last : result.ranges.first))
                assert(canvas.debugLayoutBuilds == builds, "A warm chapter turn must reuse layout rather than paginate during its animation")
                canvas.debugTap(at: direction < 0 ? 0.1 : 0.9, animated: true)
                try? await Task.sleep(nanoseconds: 500_000_000)
                assert(canvas.debugPagination().visible == result.ranges[direction < 0 ? result.ranges.count - 2 : 1])
                assert(boundaries == 1)
                print("QINGREAD_CHAPTER_TURN mode=\(mode.rawValue) direction=\(direction) warmLayoutReuse=passed animatedEdge=passed nextPage=passed installMs=\(String(format: "%.2f", installMilliseconds)) layoutBuilds=\(builds)")
                canvas.cancelPreparation()
                canvas.removeFromSuperview()
            }
        }
    }

    private static func verifyBookProgress() {
        let pages = [2, 8, 1]
        assert(ReaderBookProgress.destination(for: 0, pageCounts: []) == nil)
        assert(ReaderBookProgress.destination(for: 0, pageCounts: pages) == .init(chapterIndex: 0, pageIndex: 0))
        assert(ReaderBookProgress.destination(for: 1, pageCounts: pages) == .init(chapterIndex: 2, pageIndex: 0))
        assert(ReaderBookProgress.destination(for: .nan, pageCounts: pages) == .init(chapterIndex: 0, pageIndex: 0))
        for chapter in pages.indices {
            for page in 0..<pages[chapter] {
                let number = ReaderBookProgress.pageNumber(chapterIndex: chapter, pageIndex: page, pageCounts: pages)
                let fraction = ReaderBookProgress.fraction(pageNumber: number, totalPages: 11)
                assert(ReaderBookProgress.destination(for: fraction, pageCounts: pages) == .init(chapterIndex: chapter, pageIndex: page))
            }
        }
        assert(ReaderBookProgress.pageCounts(chapterCount: 3, lengths: [0: 100, 1: 900], measured: [0: 1], unitsPerPage: 300) == [1, 3, 3])
        assert(ReaderBookProgress.utf16Offset(for: 1, textLength: 7432) == 7431)
        assert(ReaderTurnGesture.commits(distance: 50, velocity: 100, extent: 393))
        assert(ReaderTurnGesture.commits(distance: -15, velocity: -650, extent: 393))
        assert(!ReaderTurnGesture.commits(distance: 8, velocity: 700, extent: 393))
    }
}
#endif
