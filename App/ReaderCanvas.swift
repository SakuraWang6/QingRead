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
    var previousContent: ChapterContent? = nil
    var nextContent: ChapterContent? = nil
    let onPosition: (Int, Double, Int, Int, Bool) -> Void
    let onPageLayout: ([Int], Double, CGSize) -> Void
    let onTurn: () -> Void
    let onToggleControls: () -> Void
    let onBoundary: (Int) -> Void
    let onExit: () -> Void
    var onAnnotate: ((Int) -> Void)? = nil
    var annotationRanges: [NSRange] = []

    func makeUIView(context: Context) -> ReaderCanvas {
        let view = ReaderCanvas()
        view.accessibilityIdentifier = "reader.text"
        return view
    }
    func updateUIView(_ view: ReaderCanvas, context: Context) {
        view.onPosition = onPosition
        view.onPageLayout = onPageLayout
        view.onTurn = onTurn
        view.onToggleControls = onToggleControls
        view.onBoundary = onBoundary
        view.onExit = onExit
        view.onAnnotate = onAnnotate
        view.annotationRanges = annotationRanges
        view.apply(content: content, settings: settings, initialOffset: initialOffset, seek: seek,
                   previousContent: previousContent, nextContent: nextContent)
        view.highlightAnnotations()
    }
    static func dismantleUIView(_ view: ReaderCanvas, coordinator: ()) { view.cancelPreparation() }
}

/// One continuous TextKit layout supplies both page ranges and drawings. No text
/// is truncated or re-flowed after slicing a page, including paragraph indents.
final class ReaderCanvas: UIView, UITextViewDelegate, UIGestureRecognizerDelegate {
    var onPosition: ((Int, Double, Int, Int, Bool) -> Void)?
    var onPageLayout: (([Int], Double, CGSize) -> Void)?
    var onTurn: (() -> Void)?
    var onToggleControls: (() -> Void)?
    var onBoundary: ((Int) -> Void)?
    var onExit: (() -> Void)?
    var onAnnotate: ((Int) -> Void)?
    var annotationRanges: [NSRange] = []
    private var annotationKey = ""

    private var settings = ReaderSettings()
    private var chapterID: String?
    private var document: ReaderDocument?
    private var textStorage = NSTextStorage()
    private var layoutManager = NSLayoutManager()
    private var pageRanges: [NSRange] = []
    private var glyphRanges: [NSRange] = []
    private var pageViews: [ReaderPageDrawing] = []
    private let horizontal = ReaderPagingScrollView()
    private let vertical: UITextView = {
        let storage = NSTextStorage()
        let manager = ReaderAnnotationLayoutManager()
        let container = NSTextContainer(size: .zero)
        storage.addLayoutManager(manager)
        manager.addTextContainer(container)
        return UITextView(frame: .zero, textContainer: container)
    }()
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
    private var dragStartPage = 0
    private var dragAtTop = false
    private var dragAtBottom = false
    private var coverTarget: ReaderPageDrawing?
    private var coverDirection = 0
    private var adjacentContents: [ChapterContent] = []
    private var preparedLayouts: [String: ReaderChapterLayout] = [:]
    private var prepareTask: Task<Void, Never>?
    private var previousLayout: ReaderChapterLayout?
    private var nextLayout: ReaderChapterLayout?
    private var leadingPages: Int { previousLayout == nil ? 0 : 1 }
    #if DEBUG
    private var layoutBuilds = 0
    #endif
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
        let annotate = UILongPressGestureRecognizer(target: self, action: #selector(annotatePressed(_:)))
        annotate.minimumPressDuration = 0.5
        addGestureRecognizer(annotate)
        tap.require(toFail: annotate)
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

    func apply(content: ChapterContent, settings: ReaderSettings, initialOffset: Int, seek: ReaderSeekRequest?,
               previousContent: ChapterContent? = nil, nextContent: ChapterContent? = nil) {
        let visualChange = needsVisualUpdate(settings)
        if visualChange { preparedLayouts.removeAll() }
        let changed = chapterID != content.chapter.id || needsVisualUpdate(settings)
        if changed {
            prepareTask?.cancel()
            if chapterID != content.chapter.id { anchor = initialOffset }
            else { anchor = currentUTF16() }
            chapterID = content.chapter.id
            self.settings = settings
            document = preparedLayouts[content.chapter.id]?.document ?? ReaderDocument(content: content, settings: settings)
            needsPagination = true
            boundarySent = false
        }
        self.settings = settings
        let adjacent = [previousContent, nextContent].compactMap { $0 }
        let adjacencyChanged = adjacent.map(\.chapter.id) != adjacentContents.map(\.chapter.id)
        adjacentContents = adjacent
        let keep = Set(adjacent.map(\.chapter.id) + [content.chapter.id])
        preparedLayouts = preparedLayouts.filter { keep.contains($0.key) }
        if adjacencyChanged && !needsPagination { scheduleAdjacentLayouts() }
        if let seek, lastSeekID != seek.id {
            lastSeekID = seek.id
            boundarySent = false
            anchor = seek.utf16Offset
            if !needsPagination { restoreAnchor(); return }
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 80, bounds.height > 100, document != nil else { return }
        if lastSize != bounds.size {
            // A chapter load or explicit seek owns its target. Resizing must
            // never replace it with an offset from the previous document.
            if lastSize != .zero && !needsPagination { anchor = currentUTF16() }
            lastSize = bounds.size
            preparedLayouts.removeAll()
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
        defer { isUpdating = false; annotationKey = ""; highlightAnnotations() }
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
            let capacity = max(1, (Double(bounds.width) - settings.horizontalMargin * 2) / settings.fontSize * (Double(bounds.height) - 56) / (settings.fontSize + settings.lineSpacing))
            publishPageLayout(starts: [], capacity: capacity)
            restoreAnchor()
            return
        }
        let size = CGSize(width: max(1, bounds.width - settings.horizontalMargin * 2), height: max(1, bounds.height - insets.top - insets.bottom))
        let layout = preparedLayouts[document.content.chapter.id] ?? prepareLayout(document, size: size)
        preparedLayouts[document.content.chapter.id] = layout
        textStorage = layout.storage; layoutManager = layout.manager
        pageRanges = layout.characters; glyphRanges = layout.glyphs
        #if DEBUG
        var coveredCharacters = 0
        for range in pageRanges {
            assert(range.location == coveredCharacters, "Pagination must cover contiguous UTF-16 ranges")
            coveredCharacters = NSMaxRange(range)
        }
        assert(coveredCharacters == document.text.length, "Pagination must not discard text")
        print("QINGREAD_PAGINATION pages=\(pageRanges.count) utf16=\(document.text.length) covered=\(coveredCharacters) anchor=\(anchor)")
        #endif
        installHorizontalPages()
        let fallback = max(1, (Double(bounds.width) - settings.horizontalMargin * 2) / settings.fontSize * (Double(bounds.height) - 56) / (settings.fontSize + settings.lineSpacing))
        let capacity = pageRanges.count > 1 ? Double(pageRanges.dropLast().map(\.length).reduce(0, +)) / Double(pageRanges.count - 1) : max(Double(fallback), Double(document.text.length))
        publishPageLayout(starts: pageRanges.map(\.location), capacity: capacity)
        restoreAnchor()
        scheduleAdjacentLayouts()
    }

    /// Prepare only the two neighbouring chapters, while the reader is idle.
    /// Their edge pages become real scroll pages, so a chapter boundary uses
    /// the same scroll animation and never performs TextKit layout mid-turn.
    private func scheduleAdjacentLayouts() {
        prepareTask?.cancel()
        guard settings.turnMode != .scroll, !adjacentContents.isEmpty else { return }
        let generation = layoutGeneration
        prepareTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled, self.layoutGeneration == generation else { return }
            for content in self.adjacentContents {
                while self.isAnimating || self.horizontal.isDragging || self.horizontal.isDecelerating {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    guard !Task.isCancelled, self.layoutGeneration == generation else { return }
                }
                guard !Task.isCancelled, self.layoutGeneration == generation else { return }
                if self.preparedLayouts[content.chapter.id] == nil {
                    let size = CGSize(width: max(1, self.bounds.width - self.settings.horizontalMargin * 2), height: max(1, self.bounds.height - self.insets.top - self.insets.bottom))
                    self.preparedLayouts[content.chapter.id] = self.prepareLayout(ReaderDocument(content: content, settings: self.settings), size: size)
                }
                await Task.yield()
            }
            guard !Task.isCancelled, self.layoutGeneration == generation else { return }
            while self.isAnimating || self.horizontal.isDragging || self.horizontal.isDecelerating {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled, self.layoutGeneration == generation else { return }
            }
            self.isUpdating = true
            self.installHorizontalPages()
            self.horizontal.contentOffset.x = CGFloat(self.pageIndex + self.leadingPages) * self.bounds.width
            self.isUpdating = false
        }
    }

    func cancelPreparation() { prepareTask?.cancel(); prepareTask = nil }

    private func prepareLayout(_ document: ReaderDocument, size: CGSize) -> ReaderChapterLayout {
        #if DEBUG
        layoutBuilds += 1
        #endif
        return ReaderChapterLayout(document: document, size: size)
    }

    private func installHorizontalPages() {
        pageViews.forEach { $0.removeFromSuperview() }; pageViews.removeAll()
        let chapterIndex = document?.content.chapter.index ?? 0
        previousLayout = adjacentContents.first { $0.chapter.index < chapterIndex }.flatMap { preparedLayouts[$0.chapter.id] }
        nextLayout = adjacentContents.first { $0.chapter.index > chapterIndex }.flatMap { preparedLayouts[$0.chapter.id] }
        func append(_ view: ReaderPageDrawing) {
            view.frame = CGRect(x: CGFloat(pageViews.count) * bounds.width, y: 0, width: bounds.width, height: bounds.height)
            horizontal.addSubview(view); pageViews.append(view)
        }
        if let previousLayout { append(makePage(previousLayout, index: max(0, previousLayout.characters.count - 1))) }
        for index in pageRanges.indices { append(makePage(index)) }
        if let nextLayout { append(makePage(nextLayout, index: 0)) }
        horizontal.contentSize = CGSize(width: bounds.width * CGFloat(pageViews.count), height: bounds.height)
    }

    private func makePage(_ layout: ReaderChapterLayout, index: Int) -> ReaderPageDrawing {
        let page = ReaderPageDrawing()
        page.backgroundColor = UIColor(settings.activeTheme.background)
        page.manager = layout.manager
        page.container = layout.manager.textContainers[index]
        page.origin = CGPoint(x: settings.horizontalMargin, y: insets.top)
        page.isAccessibilityElement = true
        page.accessibilityTraits = [.staticText]
        page.accessibilityLabel = layout.document.text.attributedSubstring(from: layout.characters[index]).string
        return page
    }

    private func publishPageLayout(starts: [Int], capacity: Double) {
        let generation = layoutGeneration
        let size = CGSize(width: max(1, bounds.width - settings.horizontalMargin * 2), height: max(1, bounds.height - 56))
        DispatchQueue.main.async { [weak self] in
            guard let self, self.layoutGeneration == generation else { return }
            self.onPageLayout?(starts, capacity, size)
        }
    }

    private func makePage(_ index: Int) -> ReaderPageDrawing {
        let page = ReaderPageDrawing()
        page.backgroundColor = UIColor(settings.activeTheme.background)
        page.manager = layoutManager
        page.container = layoutManager.textContainers[index]
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
            horizontal.setContentOffset(CGPoint(x: CGFloat(pageIndex + leadingPages) * bounds.width, y: 0), animated: false)
            if settings.turnMode == .cover { showCoverPage(pageIndex) }
        }
        report(settled: true)
    }

    func highlightAnnotations() {
        guard let document else { return }
        let key = "\(document.content.chapter.id)|\(ObjectIdentifier(textStorage))|\(settings.fontSize)|\(settings.turnMode)|" + annotationRanges.map { "\($0.location):\($0.length)" }.joined(separator: ",")
        guard key != annotationKey else { return }; annotationKey = key
        // Annotation marks are a display decoration. Editing NSTextStorage here
        // invalidates every page's layout, even when no underline was present.
        // Cached page ranges can then be drawn against unlaid glyph positions.
        for candidate in [layoutManager, vertical.layoutManager] {
            guard let manager = candidate as? ReaderAnnotationLayoutManager,
                  let storage = manager.textStorage, storage.length > 0 else { continue }
            let fullRange = NSRange(location: 0, length: storage.length)
            manager.annotationRanges = annotationRanges.filter { $0.location >= 0 && $0.length > 0 && NSMaxRange($0) <= storage.length }
            manager.invalidateDisplay(forCharacterRange: fullRange)
        }
        pageViews.forEach { $0.setNeedsDisplay() }
        cover.subviews.forEach { $0.setNeedsDisplay() }
        vertical.setNeedsDisplay()
    }

    @objc private func annotatePressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began,
              let offset = annotationOffset(at: gesture.location(in: self)) else { return }
        onAnnotate?(offset)
    }

    /// Hit test the displayed body, rather than the page's saved reading anchor.
    /// TextKit's nearest-glyph lookup also returns glyphs for margins and empty
    /// space, so accept only a point inside the actual glyph's line and bounds.
    private func annotationOffset(at point: CGPoint) -> Int? {
        guard bounds.contains(point), !needsPagination, !isAnimating, coverTarget == nil, let document else { return nil }
        let manager: NSLayoutManager
        let container: NSTextContainer
        let textPoint: CGPoint
        if settings.turnMode == .scroll {
            manager = vertical.layoutManager
            container = vertical.textContainer
            let local = vertical.convert(point, from: self)
            textPoint = CGPoint(x: local.x - vertical.textContainerInset.left,
                                y: local.y - vertical.textContainerInset.top)
        } else {
            guard !horizontal.isDragging, !horizontal.isDecelerating else { return nil }
            let page: ReaderPageDrawing?
            if settings.turnMode == .cover { page = cover.subviews.first as? ReaderPageDrawing }
            else { page = pageViews.indices.contains(pageIndex + leadingPages) ? pageViews[pageIndex + leadingPages] : nil }
            guard let page, let pageManager = page.manager, let pageContainer = page.container else { return nil }
            manager = pageManager
            container = pageContainer
            let local = page.convert(point, from: self)
            textPoint = CGPoint(x: local.x - page.origin.x, y: local.y - page.origin.y)
        }
        manager.ensureLayout(for: container)
        let glyph = manager.glyphIndex(for: textPoint, in: container)
        let pageGlyphs = manager.glyphRange(for: container)
        guard NSLocationInRange(glyph, pageGlyphs), glyph < manager.numberOfGlyphs else { return nil }
        let line = manager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        let ink = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard line.contains(textPoint), ink.insetBy(dx: -1, dy: -1).contains(textPoint) else { return nil }
        let offset = manager.characterIndexForGlyph(at: glyph)
        guard document.paragraphRanges.contains(where: { NSLocationInRange(offset, $0) }) else { return nil }
        return offset
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
        let step = max(1, vertical.bounds.height)
        let count = settings.turnMode == .scroll ? max(1, Int(ceil(vertical.contentSize.height / step))) : pageRanges.count
        let currentPage = settings.turnMode == .scroll ? min(count, max(1, Int(max(0, vertical.contentOffset.y) / step) + 1)) : pageIndex + 1
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
    func debugTap(at x: CGFloat, animated: Bool = false) { tapped(at: x, animated: animated) }
    func debugAwaitPreparation() async { await prepareTask?.value }
    var debugLayoutBuilds: Int { layoutBuilds }
    var debugPreparedEdges: Int { (previousLayout == nil ? 0 : 1) + (nextLayout == nil ? 0 : 1) }
    func debugPagination() -> (ranges: [NSRange], visible: NSRange, utf16Count: Int) {
        (pageRanges, pageRanges.indices.contains(pageIndex) ? pageRanges[pageIndex] : NSRange(), document?.text.length ?? 0)
    }
    var debugFirstUnlaidGlyph: Int { layoutManager.firstUnlaidGlyphIndex() }
    func debugAnnotationOffset(at point: CGPoint) -> Int? { annotationOffset(at: point) }
    func debugPoint(atUTF16 offset: Int) -> CGPoint? {
        guard let document, offset >= 0, offset < document.text.length else { return nil }
        if settings.turnMode == .scroll {
            let manager = vertical.layoutManager
            manager.ensureLayout(for: vertical.textContainer)
            let range = manager.glyphRange(forCharacterRange: NSRange(location: offset, length: 1), actualCharacterRange: nil)
            let rect = manager.boundingRect(forGlyphRange: range, in: vertical.textContainer)
            return vertical.convert(CGPoint(x: rect.midX + vertical.textContainerInset.left,
                                            y: rect.midY + vertical.textContainerInset.top), to: self)
        }
        guard pageRanges.indices.contains(pageIndex), NSLocationInRange(offset, pageRanges[pageIndex]) else { return nil }
        let range = layoutManager.glyphRange(forCharacterRange: NSRange(location: offset, length: 1), actualCharacterRange: nil)
        let rect = layoutManager.boundingRect(forGlyphRange: range, in: layoutManager.textContainers[pageIndex])
        return CGPoint(x: rect.midX + settings.horizontalMargin, y: rect.midY + insets.top)
    }
    func debugValidatePageLayout() -> Bool {
        guard settings.turnMode != .scroll else { return true }
        for (index, container) in layoutManager.textContainers.enumerated() {
            layoutManager.ensureLayout(for: container)
            let glyphs = layoutManager.glyphRange(for: container)
            guard glyphRanges.indices.contains(index), glyphRanges[index] == glyphs,
                  pageRanges[index] == layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil) else { return false }
            var valid = true
            var previousBottom: CGFloat = 0
            layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, owner, _, _ in
                if owner !== container || rect.minY < previousBottom - 0.5 || rect.maxY > container.size.height + 0.5 { valid = false }
                previousBottom = rect.maxY
            }
            if !valid { return false }
        }
        return true
    }
    func debugRenderedPage() -> Data? {
        let page: ReaderPageDrawing?
        if settings.turnMode == .cover { page = cover.subviews.first as? ReaderPageDrawing }
        else { page = pageViews.indices.contains(pageIndex + leadingPages) ? pageViews[pageIndex + leadingPages] : nil }
        guard let page else { return nil }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: page.bounds.size, format: format).image { context in
            (page.backgroundColor ?? .white).setFill()
            context.fill(page.bounds)
            page.draw(page.bounds)
        }.pngData()
    }
    #endif

    private func turn(_ delta: Int, animated: Bool = true) {
        guard !isAnimating else { return }
        boundarySent = false
        layoutIfNeeded()
        guard !needsPagination else { return }
        onTurn?()
        if settings.turnMode == .scroll {
            let target = vertical.contentOffset.y + CGFloat(delta) * (bounds.height - 70)
            let maximum = max(0, vertical.contentSize.height - bounds.height)
            if (delta > 0 && vertical.contentOffset.y >= maximum - 2) || (delta < 0 && vertical.contentOffset.y <= 0) { onBoundary?(delta); return }
            vertical.setContentOffset(CGPoint(x: 0, y: min(maximum, max(0, target))), animated: true)
        } else {
            let target = pageIndex + delta
            if !pageRanges.indices.contains(target) {
                if animated && settings.turnMode == .slide && (delta < 0 ? previousLayout != nil : nextLayout != nil) {
                    isAnimating = true
                    horizontal.setContentOffset(CGPoint(x: CGFloat(target + leadingPages) * bounds.width, y: 0), animated: true)
                } else if animated && settings.turnMode == .cover && (delta < 0 ? previousLayout != nil : nextLayout != nil) {
                    beginCover(delta); finishCover(commit: true)
                } else { sendBoundary(delta) }
                return
            }
            if !animated {
                pageIndex = target
                horizontal.setContentOffset(CGPoint(x: CGFloat(target + leadingPages) * bounds.width, y: 0), animated: false)
                if settings.turnMode == .cover { showCoverPage(target) }
                report(settled: true)
            } else if settings.turnMode == .slide {
                isAnimating = true
                horizontal.setContentOffset(CGPoint(x: CGFloat(target + leadingPages) * bounds.width, y: 0), animated: true)
            } else {
                beginCover(delta)
                finishCover(commit: true)
            }
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        tapped(at: gesture.location(in: self).x / max(1, bounds.width))
    }
    private func tapped(at x: CGFloat, animated: Bool = true) {
        if x > 0.28 && x < 0.72 { onToggleControls?() }
        else if settings.turnMode != .scroll { turn(x <= 0.28 ? -1 : 1, animated: animated) }
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
            let next = min(max(0, Int((horizontal.contentOffset.x / max(1, bounds.width)).rounded()) - leadingPages), max(0, pageRanges.count - 1))
            guard next != pageIndex else { return }
            pageIndex = next
        }
        report(settled: false)
    }
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        isAnimating = false
        boundarySent = false; dragStartPage = pageIndex
        dragAtTop = scrollView.contentOffset.y <= 2
        dragAtBottom = scrollView.contentOffset.y >= max(0, scrollView.contentSize.height - scrollView.bounds.height) - 2
        onTurn?()
    }
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        let translation = scrollView.panGestureRecognizer.translation(in: scrollView)
        let speed = scrollView.panGestureRecognizer.velocity(in: scrollView)
        if scrollView === horizontal {
            let direction = translation.x < 0 ? 1 : -1
            guard ReaderTurnGesture.commits(distance: translation.x, velocity: speed.x, extent: bounds.width) else { targetContentOffset.pointee.x = CGFloat(dragStartPage + leadingPages) * bounds.width; return }
            let next = dragStartPage + direction
            if !pageRanges.indices.contains(next) {
                if direction < 0 ? previousLayout != nil : nextLayout != nil {
                    targetContentOffset.pointee.x = CGFloat(next + leadingPages) * bounds.width
                } else {
                    targetContentOffset.pointee.x = CGFloat(dragStartPage + leadingPages) * bounds.width
                    sendBoundary(direction)
                }
            } else { targetContentOffset.pointee.x = CGFloat(next + leadingPages) * bounds.width }
        } else if (translation.y < 0 && dragAtBottom) || (translation.y > 0 && dragAtTop) {
            if ReaderTurnGesture.commits(distance: translation.y, velocity: speed.y, extent: bounds.height) {
                boundarySent = true; onBoundary?(translation.y < 0 ? 1 : -1)
            }
        }
    }
    private func sendBoundary(_ delta: Int) {
        guard !boundarySent else { return }
        boundarySent = true
        onBoundary?(delta)
    }
    private func finishScroll(_ scrollView: UIScrollView) {
        isAnimating = false
        if scrollView === horizontal {
            let slot = Int((horizontal.contentOffset.x / max(1, bounds.width)).rounded()) - leadingPages
            if slot < 0 { sendBoundary(-1); return }
            if slot >= pageRanges.count { sendBoundary(1); return }
        }
        report(settled: true)
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { finishScroll(scrollView) }
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { finishScroll(scrollView) }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate && !boundarySent { finishScroll(scrollView) }
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
        guard let current = cover.subviews.first else { return }
        let target: ReaderPageDrawing
        if pageRanges.indices.contains(targetIndex) { target = makePage(targetIndex) }
        else if delta < 0, let previousLayout { target = makePage(previousLayout, index: previousLayout.characters.count - 1) }
        else if delta > 0, let nextLayout { target = makePage(nextLayout, index: 0) }
        else { return }
        target.frame = cover.bounds.offsetBy(dx: delta < 0 ? -bounds.width : 0, dy: 0)
        target.layer.shadowOpacity = 0.18
        target.layer.shadowRadius = 8
        if delta > 0 { cover.insertSubview(target, belowSubview: current) }
        else { cover.addSubview(target) }
        coverTarget = target
    }
    @objc private func coverPanned(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: cover).x
        if pan.state == .began { boundarySent = false; onTurn?(); beginCover(pan.velocity(in: cover).x < 0 ? 1 : -1) }
        if pan.state == .changed, let target = coverTarget {
            if coverDirection > 0 {
                cover.subviews.last?.transform = CGAffineTransform(translationX: min(0, translation), y: 0)
            } else { target.transform = CGAffineTransform(translationX: max(0, translation), y: 0) }
        }
        if pan.state == .ended || pan.state == .cancelled {
            guard coverTarget != nil else {
                if pan.state == .ended && (coverDirection > 0 ? translation < 0 : translation > 0) && ReaderTurnGesture.commits(distance: translation, velocity: pan.velocity(in: cover).x, extent: bounds.width) { sendBoundary(coverDirection) }
                return
            }
            let correctDirection = coverDirection > 0 ? translation < 0 : translation > 0
            finishCover(commit: pan.state == .ended && correctDirection && ReaderTurnGesture.commits(distance: translation, velocity: pan.velocity(in: cover).x, extent: bounds.width))
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
            if commit && !self.pageRanges.indices.contains(self.pageIndex + direction) {
                self.coverTarget = nil; self.isAnimating = false
                self.sendBoundary(direction)
                return
            }
            if commit { self.pageIndex += direction }
            self.coverTarget = nil
            self.isAnimating = false
            self.showCoverPage(self.pageIndex)
            self.report(settled: true)
        }
    }
}

/// Retains TextKit's storage, containers and glyph ranges for three chapters at
/// most. Prepared chapters can be installed without repeating text layout.
private final class ReaderChapterLayout {
    let document: ReaderDocument
    let storage: NSTextStorage
    let manager: NSLayoutManager
    var characters: [NSRange] = []
    var glyphs: [NSRange] = []
    init(document: ReaderDocument, size: CGSize) {
        self.document = document
        storage = NSTextStorage(attributedString: document.text)
        manager = ReaderAnnotationLayoutManager()
        storage.addLayoutManager(manager)
        manager.ensureGlyphs(forCharacterRange: NSRange(location: 0, length: storage.length))
        var covered = 0
        while covered < manager.numberOfGlyphs {
            let container = NSTextContainer(size: size)
            container.lineFragmentPadding = 0
            manager.addTextContainer(container)
            let range = manager.glyphRange(for: container)
            guard range.length > 0 else { break }
            glyphs.append(range)
            characters.append(manager.characterRange(forGlyphRange: range, actualGlyphRange: nil))
            covered = NSMaxRange(range)
        }
    }
}

/// Display-only underlines keep the immutable text storage and cached page
/// geometry intact. UIKit's layout manager has no temporary-attribute API.
private final class ReaderAnnotationLayoutManager: NSLayoutManager {
    var annotationRanges: [NSRange] = []

    override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
        guard !annotationRanges.isEmpty, let context = UIGraphicsGetCurrentContext() else { return }
        context.saveGState()
        context.setStrokeColor(UIColor(Palette.cinnabar).cgColor)
        context.setLineWidth(1)
        for characters in annotationRanges {
            let glyphs = NSIntersectionRange(glyphRange(forCharacterRange: characters, actualCharacterRange: nil), glyphsToShow)
            guard glyphs.length > 0 else { continue }
            enumerateLineFragments(forGlyphRange: glyphs) { _, _, container, lineGlyphs, _ in
                let marked = NSIntersectionRange(glyphs, lineGlyphs)
                guard marked.length > 0 else { return }
                let rect = self.boundingRect(forGlyphRange: marked, in: container)
                let y = rect.maxY - 1 + origin.y
                context.move(to: CGPoint(x: rect.minX + origin.x, y: y))
                context.addLine(to: CGPoint(x: rect.maxX + origin.x, y: y))
                context.strokePath()
            }
        }
        context.restoreGState()
    }
}

private final class ReaderPageDrawing: UIView {
    var manager: NSLayoutManager?
    var container: NSTextContainer?
    var origin = CGPoint.zero
    override func draw(_ rect: CGRect) {
        guard let manager, let container, let context = UIGraphicsGetCurrentContext() else { return }
        manager.ensureLayout(for: container)
        let range = manager.glyphRange(for: container)
        context.saveGState()
        context.clip(to: CGRect(origin: origin, size: container.size))
        manager.drawBackground(forGlyphRange: range, at: origin)
        manager.drawGlyphs(forGlyphRange: range, at: origin)
        context.restoreGState()
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
