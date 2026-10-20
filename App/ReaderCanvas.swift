import SwiftUI
import UIKit
import ReadingCore

struct ReaderSeekRequest: Equatable {
    let id = UUID()
    let utf16Offset: Int
}

struct ReaderCanvasView: UIViewRepresentable {
    let content: ChapterContent
    let settings: ReaderSettings
    let initialOffset: Int
    var seek: ReaderSeekRequest?
    let onPosition: (Int, Double, Int, Int, Bool) -> Void
    let onToggleControls: () -> Void
    let onBoundary: (Int) -> Void
    let onExit: () -> Void

    func makeUIView(context: Context) -> ReaderCanvas {
        let view = ReaderCanvas()
        view.accessibilityIdentifier = "reader.text"
        return view
    }
    func updateUIView(_ view: ReaderCanvas, context: Context) {
        view.onPosition = onPosition
        view.onToggleControls = onToggleControls
        view.onBoundary = onBoundary
        view.onExit = onExit
        view.apply(content: content, settings: settings, initialOffset: initialOffset, seek: seek)
    }
}

/// One continuous TextKit layout supplies both page ranges and drawings. No text
/// is truncated or re-flowed after slicing a page, including paragraph indents.
final class ReaderCanvas: UIView, UITextViewDelegate, UIGestureRecognizerDelegate {
    var onPosition: ((Int, Double, Int, Int, Bool) -> Void)?
    var onToggleControls: (() -> Void)?
    var onBoundary: ((Int) -> Void)?
    var onExit: (() -> Void)?

    private var settings = ReaderSettings()
    private var chapterID: String?
    private var document: ReaderDocument?
    private var textStorage = NSTextStorage()
    private var layoutManager = NSLayoutManager()
    private var pageRanges: [NSRange] = []
    private var glyphRanges: [NSRange] = []
    private var pageViews: [ReaderPageDrawing] = []
    private let horizontal = ReaderPagingScrollView()
    private let vertical = UITextView()
    private let cover = UIView()
    private var pageIndex = 0
    private var anchor = 0
    private var lastSize = CGSize.zero
    private var lastSeekID: UUID?
    private var needsPagination = true
    private var layoutGeneration = UUID()
    private var isUpdating = false
    private var isAnimating = false
    private var boundarySent = false
    private var coverTarget: ReaderPageDrawing?
    private var coverDirection = 0
    private let insets = UIEdgeInsets(top: 22, left: 24, bottom: 34, right: 24)

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        horizontal.isPagingEnabled = true
        horizontal.showsHorizontalScrollIndicator = false
        horizontal.alwaysBounceHorizontal = true
        horizontal.delegate = self
        horizontal.contentInsetAdjustmentBehavior = .never
        addSubview(horizontal)
        vertical.isEditable = false
        vertical.isSelectable = false
        vertical.showsVerticalScrollIndicator = false
        vertical.alwaysBounceVertical = true
        vertical.contentInsetAdjustmentBehavior = .never
        vertical.textContainer.lineFragmentPadding = 0
        vertical.delegate = self
        vertical.accessibilityIdentifier = "reader.scroll"
        addSubview(vertical)
        addSubview(cover)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        addGestureRecognizer(tap)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(coverPanned(_:)))
        pan.delegate = self
        cover.addGestureRecognizer(pan)
        for edge in [UIRectEdge.left, .right] {
            let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgePanned(_:)))
            back.edges = edge
            back.delegate = self
            addGestureRecognizer(back)
            horizontal.panGestureRecognizer.require(toFail: back)
            vertical.panGestureRecognizer.require(toFail: back)
            pan.require(toFail: back)
        }
        accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: "上一页", target: self, selector: #selector(accessiblePrevious)),
            UIAccessibilityCustomAction(name: "下一页", target: self, selector: #selector(accessibleNext)),
            UIAccessibilityCustomAction(name: "显示阅读控制栏", target: self, selector: #selector(accessibleControls))
        ]
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(content: ChapterContent, settings: ReaderSettings, initialOffset: Int, seek: ReaderSeekRequest?) {
        let changed = chapterID != content.chapter.id || needsVisualUpdate(settings)
        if changed {
            if chapterID != content.chapter.id { anchor = initialOffset }
            else { anchor = currentUTF16() }
            chapterID = content.chapter.id
            self.settings = settings
            document = ReaderDocument(content: content, settings: settings)
            needsPagination = true
            boundarySent = false
        }
        self.settings = settings
        if let seek, lastSeekID != seek.id {
            lastSeekID = seek.id
            anchor = seek.utf16Offset
            if !needsPagination { restoreAnchor(); return }
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 80, bounds.height > 100, document != nil else { return }
        if lastSize != bounds.size {
            if lastSize != .zero { anchor = currentUTF16() }
            lastSize = bounds.size
            needsPagination = true
        }
        horizontal.frame = bounds
        vertical.frame = bounds
        cover.frame = bounds
        if needsPagination { rebuildLayout() }
    }

    private func rebuildLayout() {
        guard let document else { return }
        isUpdating = true
        defer { isUpdating = false }
        needsPagination = false
        layoutGeneration = UUID()
        backgroundColor = UIColor(settings.activeTheme.background)
        vertical.backgroundColor = backgroundColor
        vertical.textColor = UIColor(settings.activeTheme.foreground)
        horizontal.isHidden = settings.turnMode != .slide
        cover.isHidden = settings.turnMode != .cover
        vertical.isHidden = settings.turnMode != .scroll
        pageViews.forEach { $0.removeFromSuperview() }
        cover.subviews.forEach { $0.removeFromSuperview() }
        pageViews.removeAll()
        coverTarget = nil
        isAnimating = false
        if settings.turnMode == .scroll {
            vertical.textContainerInset = UIEdgeInsets(top: insets.top, left: settings.horizontalMargin, bottom: insets.bottom, right: settings.horizontalMargin)
            vertical.attributedText = document.text
            vertical.layoutManager.ensureLayout(for: vertical.textContainer)
            restoreAnchor()
            return
        }
        textStorage = NSTextStorage(attributedString: document.text)
        layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)
        let size = CGSize(width: max(1, bounds.width - settings.horizontalMargin * 2), height: max(1, bounds.height - insets.top - insets.bottom))
        pageRanges.removeAll()
        glyphRanges.removeAll()
        layoutManager.ensureGlyphs(forCharacterRange: NSRange(location: 0, length: textStorage.length))
        var coveredGlyphs = 0
        while coveredGlyphs < layoutManager.numberOfGlyphs {
            let container = NSTextContainer(size: size)
            container.lineFragmentPadding = 0
            layoutManager.addTextContainer(container)
            let range = layoutManager.glyphRange(for: container)
            guard range.length > 0 else { break }
            glyphRanges.append(range)
            pageRanges.append(layoutManager.characterRange(forGlyphRange: range, actualGlyphRange: nil))
            coveredGlyphs = NSMaxRange(range)
        }
        #if DEBUG
        var coveredCharacters = 0
        for range in pageRanges {
            assert(range.location == coveredCharacters, "Pagination must cover contiguous UTF-16 ranges")
            coveredCharacters = NSMaxRange(range)
        }
        assert(coveredCharacters == document.text.length, "Pagination must not discard text")
        print("QINGREAD_PAGINATION pages=\(pageRanges.count) utf16=\(document.text.length) covered=\(coveredCharacters) anchor=\(anchor)")
        #endif
        for page in pageRanges.indices {
            let view = makePage(page)
            view.frame = CGRect(x: CGFloat(page) * bounds.width, y: 0, width: bounds.width, height: bounds.height)
            horizontal.addSubview(view)
            pageViews.append(view)
        }
        horizontal.contentSize = CGSize(width: bounds.width * CGFloat(pageRanges.count), height: bounds.height)
        restoreAnchor()
    }

    private func makePage(_ index: Int) -> ReaderPageDrawing {
        let page = ReaderPageDrawing()
        page.backgroundColor = UIColor(settings.activeTheme.background)
        page.manager = layoutManager
        page.range = glyphRanges[index]
        page.origin = CGPoint(x: settings.horizontalMargin, y: insets.top)
        page.isAccessibilityElement = true
        page.accessibilityTraits = [.staticText]
        page.accessibilityLabel = document?.text.attributedSubstring(from: pageRanges[index]).string
        page.accessibilityIdentifier = "reader.page.\(index + 1)"
        return page
    }

    private func restoreAnchor() {
        guard let document else { return }
        anchor = min(max(0, anchor), max(0, document.text.length - 1))
        if settings.turnMode == .scroll {
            vertical.layoutManager.ensureLayout(for: vertical.textContainer)
            let glyph = vertical.layoutManager.glyphRange(forCharacterRange: NSRange(location: anchor, length: min(1, document.text.length)), actualCharacterRange: nil)
            let rect = vertical.layoutManager.boundingRect(forGlyphRange: glyph, in: vertical.textContainer)
            let maximum = max(0, vertical.contentSize.height - vertical.bounds.height)
            vertical.setContentOffset(CGPoint(x: 0, y: anchor == 0 ? 0 : min(maximum, rect.minY + vertical.textContainerInset.top)), animated: false)
        } else {
            pageIndex = pageRanges.lastIndex { $0.location <= anchor } ?? 0
            horizontal.setContentOffset(CGPoint(x: CGFloat(pageIndex) * bounds.width, y: 0), animated: false)
            if settings.turnMode == .cover { showCoverPage(pageIndex) }
        }
        report(settled: true)
    }

    private func currentUTF16() -> Int {
        if settings.turnMode == .scroll {
            guard vertical.textStorage.length > 0 else { return anchor }
            let point = CGPoint(x: 0, y: max(0, vertical.contentOffset.y - vertical.textContainerInset.top + 1))
            let glyph = vertical.layoutManager.glyphIndex(for: point, in: vertical.textContainer)
            return glyph < vertical.layoutManager.numberOfGlyphs ? vertical.layoutManager.characterIndexForGlyph(at: glyph) : max(0, vertical.textStorage.length - 1)
        }
        return pageRanges.indices.contains(pageIndex) ? pageRanges[pageIndex].location : anchor
    }

    private func report(settled: Bool) {
        guard let document else { return }
        anchor = currentUTF16()
        // Arriving at the last page does not prove that page has been read.
        // Chapter completion is recorded only when moving past its boundary.
        let atEnd = settings.turnMode == .scroll && vertical.contentOffset.y >= max(0, vertical.contentSize.height - vertical.bounds.height) - 2
        let fraction = atEnd ? 1 : Double(anchor) / Double(max(1, document.text.length))
        let offset = anchor
        let currentPage = settings.turnMode == .scroll ? 0 : pageIndex + 1
        let count = pageRanges.count
        let chapter = chapterID
        DispatchQueue.main.async { [weak self] in
            guard let self, self.chapterID == chapter else { return }
            self.onPosition?(offset, min(1, max(0, fraction)), currentPage, count, settled)
        }
    }

    private func needsVisualUpdate(_ value: ReaderSettings) -> Bool {
        settings.fontSize != value.fontSize || settings.lineSpacing != value.lineSpacing || settings.paragraphSpacing != value.paragraphSpacing
            || settings.theme != value.theme || settings.isNightMode != value.isNightMode
            || settings.turnMode != value.turnMode || settings.font != value.font
            || settings.isBold != value.isBold || settings.horizontalMargin != value.horizontalMargin
    }

    #if DEBUG
    func debugPagination() -> (ranges: [NSRange], visible: NSRange, utf16Count: Int) {
        (pageRanges, pageRanges.indices.contains(pageIndex) ? pageRanges[pageIndex] : NSRange(), document?.text.length ?? 0)
    }
    #endif

    private func turn(_ delta: Int) {
        guard !isAnimating else { return }
        if settings.turnMode == .scroll {
            let target = vertical.contentOffset.y + CGFloat(delta) * (bounds.height - 70)
            let maximum = max(0, vertical.contentSize.height - bounds.height)
            if (delta > 0 && vertical.contentOffset.y >= maximum - 2) || (delta < 0 && vertical.contentOffset.y <= 0) { onBoundary?(delta); return }
            vertical.setContentOffset(CGPoint(x: 0, y: min(maximum, max(0, target))), animated: true)
        } else {
            let target = pageIndex + delta
            guard pageRanges.indices.contains(target) else { onBoundary?(delta); return }
            if settings.turnMode == .slide {
                horizontal.setContentOffset(CGPoint(x: CGFloat(target) * bounds.width, y: 0), animated: true)
            } else {
                beginCover(delta)
                finishCover(commit: true)
            }
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let x = gesture.location(in: self).x / max(1, bounds.width)
        if x > 0.28 && x < 0.72 { onToggleControls?() }
        else if settings.turnMode != .scroll { turn(x <= 0.28 ? -1 : 1) }
    }
    @objc private func edgePanned(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended else { return }
        let x = gesture.translation(in: self).x
        if (gesture.edges == .left && x > 65) || (gesture.edges == .right && x < -65) { onExit?() }
    }
    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        if let pan = gesture as? UIScreenEdgePanGestureRecognizer {
            let velocity = pan.velocity(in: self)
            return abs(velocity.x) > abs(velocity.y)
        }
        if let pan = gesture as? UIPanGestureRecognizer {
            let point = pan.location(in: self), velocity = pan.velocity(in: self)
            return !isAnimating && point.x > 28 && point.x < bounds.width - 28 && abs(velocity.x) > abs(velocity.y)
        }
        return true
    }
    @objc private func accessibleNext() -> Bool { turn(1); return true }
    @objc private func accessiblePrevious() -> Bool { turn(-1); return true }
    @objc private func accessibleControls() -> Bool { onToggleControls?(); return true }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard !isUpdating else { return }
        if scrollView === horizontal {
            pageIndex = min(max(0, Int((horizontal.contentOffset.x / max(1, bounds.width)).rounded())), max(0, pageRanges.count - 1))
        }
        report(settled: false)
    }
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { boundarySent = false }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { report(settled: true) }
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { report(settled: true) }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !boundarySent {
            if scrollView === horizontal {
                if horizontal.contentOffset.x < -55 { boundarySent = true; onBoundary?(-1) }
                else if horizontal.contentOffset.x > max(0, horizontal.contentSize.width - bounds.width) + 55 { boundarySent = true; onBoundary?(1) }
            } else {
                if vertical.contentOffset.y < -75 { boundarySent = true; onBoundary?(-1) }
                else if vertical.contentOffset.y > max(0, vertical.contentSize.height - bounds.height) + 75 { boundarySent = true; onBoundary?(1) }
            }
        }
        if !decelerate { report(settled: true) }
    }

    private func showCoverPage(_ index: Int) {
        cover.subviews.forEach { $0.removeFromSuperview() }
        guard pageRanges.indices.contains(index) else { return }
        let page = makePage(index)
        page.frame = cover.bounds
        cover.addSubview(page)
    }
    private func beginCover(_ delta: Int) {
        coverDirection = delta
        let targetIndex = pageIndex + delta
        guard pageRanges.indices.contains(targetIndex), let current = cover.subviews.first else { return }
        let target = makePage(targetIndex)
        target.frame = cover.bounds.offsetBy(dx: delta < 0 ? -bounds.width : 0, dy: 0)
        target.layer.shadowOpacity = 0.18
        target.layer.shadowRadius = 8
        if delta > 0 { cover.insertSubview(target, belowSubview: current) }
        else { cover.addSubview(target) }
        coverTarget = target
    }
    @objc private func coverPanned(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: cover).x
        if pan.state == .began { beginCover(pan.velocity(in: cover).x < 0 ? 1 : -1) }
        if pan.state == .changed, let target = coverTarget {
            if coverDirection > 0 {
                cover.subviews.last?.transform = CGAffineTransform(translationX: min(0, translation), y: 0)
            } else { target.transform = CGAffineTransform(translationX: max(0, translation), y: 0) }
        }
        if pan.state == .ended || pan.state == .cancelled {
            guard coverTarget != nil else {
                if pan.state == .ended && abs(translation) > 65 { onBoundary?(coverDirection) }
                return
            }
            let correctDirection = coverDirection > 0 ? translation < 0 : translation > 0
            finishCover(commit: pan.state == .ended && correctDirection && (abs(translation) > bounds.width * 0.22 || abs(pan.velocity(in: cover).x) > 550))
        }
    }
    private func finishCover(commit: Bool) {
        guard let target = coverTarget else { return }
        isAnimating = true
        let direction = coverDirection
        let generation = layoutGeneration
        UIView.animate(withDuration: 0.23, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            if direction > 0 { self.cover.subviews.last?.transform = CGAffineTransform(translationX: commit ? -self.bounds.width : 0, y: 0) }
            else { target.transform = CGAffineTransform(translationX: commit ? self.bounds.width : 0, y: 0) }
        } completion: { _ in
            guard self.layoutGeneration == generation else { return }
            if commit { self.pageIndex += direction }
            self.coverTarget = nil
            self.isAnimating = false
            self.showCoverPage(self.pageIndex)
            self.report(settled: true)
        }
    }
}

private final class ReaderPageDrawing: UIView {
    var manager: NSLayoutManager?
    var range = NSRange()
    var origin = CGPoint.zero
    override func draw(_ rect: CGRect) {
        manager?.drawBackground(forGlyphRange: range, at: origin)
        manager?.drawGlyphs(forGlyphRange: range, at: origin)
    }
}

private final class ReaderPagingScrollView: UIScrollView {
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let x = gestureRecognizer.location(in: self).x.truncatingRemainder(dividingBy: max(1, bounds.width))
            if x < 28 || x > bounds.width - 28 { return false }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}
