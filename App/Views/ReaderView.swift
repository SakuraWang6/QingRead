import SwiftUI
import UIKit
import ReadingCore

struct ReaderView: View {
    let book: Book
    var initialChapterID: String? = nil
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var chapters: [Chapter] = []
    @State private var index = 0
    @State private var content: ChapterContent?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showSettings = false
    @State private var showCatalog = false
    @State private var characterOffset = 0
    @State private var chapterFraction = 0.0
    @State private var loadTask: Task<Void, Never>?
    @State private var loadGeneration = UUID()

    private var theme: ReadingTheme { store.settings.theme }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button { persistPosition(); dismiss() } label: {
                    Image(systemName: "chevron.down").font(.system(size: 18, weight: .regular)).frame(width: 34, height: 40)
                }.accessibilityLabel("关闭阅读器")
                Text(book.title).font(.bookTitle(16)).lineLimit(1)
                Spacer(minLength: 0)
                Button { showCatalog = true } label: {
                    Image(systemName: "list.bullet").frame(width: 34, height: 40)
                }.accessibilityLabel("打开目录").disabled(chapters.isEmpty)
                Button { showSettings = true } label: {
                    Image(systemName: "textformat.size").frame(width: 34, height: 40)
                }.accessibilityLabel("阅读排版设置")
            }
            .foregroundStyle(theme.foreground.opacity(0.8))
            .padding(.horizontal, 13).padding(.top, 4)

            Rectangle().fill(theme.foreground.opacity(0.10)).frame(height: 0.5)
            ZStack {
                if isLoading {
                    VStack(spacing: 18) {
                        ProgressView().tint(theme.foreground)
                        Text("正在翻开这一章…").font(.bookTitle(18)).foregroundStyle(theme.foreground.opacity(0.7))
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    ScrollView {
                        VStack(spacing: 20) {
                            Image(systemName: "wifi.exclamationmark").font(.system(size: 32, weight: .ultraLight))
                            Text("这一章暂时打不开").font(.bookTitle(25))
                            Text(errorMessage).font(.footnote).lineSpacing(5).multilineTextAlignment(.center).textSelection(.enabled)
                            Button("重新加载") {
                                if chapters.isEmpty { loadTask = Task { await openBook() } }
                                else { beginLoadChapter(index, restore: true) }
                            }.buttonStyle(.bordered)
                            Text("已缓存章节可离线阅读。也可以从目录选择其他章节。")
                                .font(.caption).multilineTextAlignment(.center).opacity(0.7)
                        }.foregroundStyle(theme.foreground).padding(32).padding(.top, 70)
                    }
                } else if let content {
                    ReaderTextView(content: content, settings: store.settings,
                                   initialCharacterOffset: characterOffset) { offset, fraction, settled in
                        guard self.content?.chapter.id == content.chapter.id else { return }
                        characterOffset = offset
                        chapterFraction = fraction
                        if settled { persistPosition() }
                    }
                    .id(content.chapter.id)
                    .accessibilityIdentifier("reader.text")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Rectangle().fill(theme.foreground.opacity(0.10)).frame(height: 0.5)
            HStack {
                Button { moveChapter(-1) } label: {
                    Label("上一章", systemImage: "chevron.left").font(.caption)
                }.disabled(index <= 0 || isLoading)
                Spacer()
                Text(chapters.isEmpty ? "—" : "\(index + 1) / \(chapters.count) · \(Int(chapterFraction * 100))%")
                    .font(.system(size: 11, design: .monospaced)).accessibilityLabel("第 \(index + 1) 章，共 \(chapters.count) 章，章内进度百分之 \(Int(chapterFraction * 100))")
                Spacer()
                Button { moveChapter(1) } label: {
                    HStack(spacing: 4) { Text("下一章"); Image(systemName: "chevron.right") }.font(.caption)
                }.disabled(chapters.isEmpty || index >= chapters.count - 1 || isLoading)
            }
            .foregroundStyle(theme.foreground.opacity(0.75))
            .padding(.horizontal, 24).padding(.vertical, 15)
        }
        .background(theme.background)
        .preferredColorScheme(theme == .night ? .dark : .light)
        .task { await openBook() }
        .onDisappear { loadTask?.cancel(); persistPosition() }
        .onChange(of: scenePhase) { phase in if phase != .active { persistPosition() } }
        .sheet(isPresented: $showSettings) {
            ReaderSettingsView().presentationDetents([.height(345)])
        }
        .sheet(isPresented: $showCatalog) {
            NavigationStack {
                ScrollViewReader { proxy in
                    List(chapters) { chapter in
                        Button {
                            showCatalog = false
                            if let selected = chapters.firstIndex(where: { $0.id == chapter.id }) {
                                persistPosition()
                                beginLoadChapter(selected, restore: false)
                            }
                        } label: {
                            HStack {
                                Text(chapter.title).foregroundStyle(Palette.ink)
                                Spacer()
                                if chapter.id == content?.chapter.id { Image(systemName: "bookmark.fill").foregroundStyle(Palette.cinnabar) }
                            }.padding(.vertical, 7)
                        }.id(chapter.id)
                    }
                    .onAppear { if chapters.indices.contains(index) { proxy.scrollTo(chapters[index].id, anchor: .center) } }
                }
                .navigationTitle("目录").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showCatalog = false } } }
            }.preferredColorScheme(.light)
        }
    }

    private func openBook() async {
        isLoading = true
        errorMessage = nil
        do {
            chapters = try await store.chapters(for: book)
            try Task.checkCancellation()
            guard !chapters.isEmpty else { throw AppError.message("来源没有返回可读章节。") }
            let saved = store.position(for: book)
            let targetID = initialChapterID ?? saved?.chapterID
            if let targetID, let found = chapters.firstIndex(where: { $0.id == targetID }) { index = found }
            else { index = min(max(0, saved?.chapterIndex ?? 0), chapters.count - 1) }
            let restore = initialChapterID == nil && saved?.chapterID == chapters[index].id
            await loadChapter(index, restore: restore)
        } catch is CancellationError { }
        catch { errorMessage = error.localizedDescription; isLoading = false }
    }

    private func beginLoadChapter(_ requestedIndex: Int, restore: Bool) {
        guard chapters.indices.contains(requestedIndex) else { return }
        loadTask?.cancel()
        loadTask = Task { await loadChapter(requestedIndex, restore: restore) }
    }

    private func loadChapter(_ requestedIndex: Int, restore: Bool) async {
        let generation = UUID()
        loadGeneration = generation
        index = requestedIndex
        isLoading = true
        content = nil
        errorMessage = nil
        characterOffset = 0
        chapterFraction = 0
        let chapter = chapters[requestedIndex]
        if restore, let saved = store.position(for: book), saved.chapterID == chapter.id {
            characterOffset = saved.characterOffset
            chapterFraction = saved.chapterFraction
        }
        do {
            let loaded = try await store.content(for: chapter, in: book)
            try Task.checkCancellation()
            guard loadGeneration == generation else { return }
            content = loaded
            isLoading = false
            persistPosition()
        } catch is CancellationError { }
        catch {
            guard loadGeneration == generation else { return }
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func moveChapter(_ delta: Int) {
        let next = index + delta
        guard chapters.indices.contains(next) else { return }
        persistPosition()
        beginLoadChapter(next, restore: false)
    }

    private func persistPosition() {
        guard let content, chapters.indices.contains(index), content.chapter.id == chapters[index].id else { return }
        store.savePosition(book: book, chapter: content.chapter, index: index,
                           characterOffset: characterOffset, fraction: chapterFraction)
    }
}

private struct ReaderSettingsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Text("舒适地读下去").font(.bookTitle(24)).foregroundStyle(Palette.ink)
                Spacer()
                Button("完成") { dismiss() }.font(.subheadline).tint(Palette.cinnabar)
            }
            HStack(spacing: 14) {
                ForEach(ReadingTheme.allCases) { theme in
                    Button {
                        var updated = store.settings
                        updated.theme = theme
                        store.updateSettings(updated)
                    } label: {
                        Text(theme.name).font(.subheadline).foregroundStyle(theme.foreground)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(theme.background, in: RoundedRectangle(cornerRadius: 6))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(store.settings.theme == theme ? Palette.cinnabar : Palette.rule, lineWidth: store.settings.theme == theme ? 2 : 0.5))
                    }.accessibilityAddTraits(store.settings.theme == theme ? .isSelected : [])
                }
            }
            VStack(spacing: 14) {
                HStack {
                    Text("字号").frame(width: 34, alignment: .leading)
                    Slider(value: Binding(get: { store.settings.fontSize }, set: {
                        var updated = store.settings; updated.fontSize = $0; store.updateSettings(updated)
                    }), in: 16...34, step: 1).tint(Palette.ink).accessibilityLabel("字号")
                    Text("\(Int(store.settings.fontSize))").monospacedDigit().frame(width: 28)
                }
                HStack {
                    Text("行距").frame(width: 34, alignment: .leading)
                    Slider(value: Binding(get: { store.settings.lineSpacing }, set: {
                        var updated = store.settings; updated.lineSpacing = $0; store.updateSettings(updated)
                    }), in: 4...22, step: 1).tint(Palette.ink).accessibilityLabel("行距")
                    Text("\(Int(store.settings.lineSpacing))").monospacedDigit().frame(width: 28)
                }
            }.font(.subheadline).foregroundStyle(Palette.secondary)
            Text("阅读位置按文字保存，调整排版后仍可接着读。")
                .font(.caption).foregroundStyle(Palette.secondary)
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.surface).preferredColorScheme(.light)
    }
}

/// UITextView exposes its actual visible character. Saving that anchor preserves
/// progress when text size, line spacing or device orientation changes.
private struct ReaderTextView: UIViewRepresentable {
    let content: ChapterContent
    let settings: ReaderSettings
    let initialCharacterOffset: Int
    let onPositionChange: (Int, Double, Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPositionChange: onPositionChange) }

    func makeUIView(context: Context) -> UITextView {
        let view = LayoutAwareTextView()
        view.isEditable = false
        view.isSelectable = true
        view.alwaysBounceVertical = true
        view.showsVerticalScrollIndicator = false
        view.textContainerInset = UIEdgeInsets(top: 28, left: 22, bottom: 55, right: 22)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = false
        view.delegate = context.coordinator
        context.coordinator.textView = view
        view.layoutChanged = { [weak coordinator = context.coordinator] in coordinator?.restoreAfterLayout() }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.onPositionChange = onPositionChange
        guard context.coordinator.appliedSettings != settings || context.coordinator.chapterID != content.chapter.id else { return }
        let anchor = context.coordinator.chapterID == content.chapter.id ? context.coordinator.visibleCharacter(in: view) : initialCharacterOffset
        context.coordinator.isRestoring = true
        context.coordinator.appliedSettings = settings
        context.coordinator.chapterID = content.chapter.id
        context.coordinator.pendingAnchor = anchor
        view.backgroundColor = UIColor(settings.theme.background)
        view.textColor = UIColor(settings.theme.foreground)
        view.tintColor = UIColor(Palette.cinnabar)
        view.attributedText = attributedText()
        view.layoutManager.ensureLayout(for: view.textContainer)
        view.setNeedsLayout()
        DispatchQueue.main.async { context.coordinator.restoreAfterLayout() }
    }

    private func attributedText() -> NSAttributedString {
        let color = UIColor(settings.theme.foreground)
        let bodyFont = UIFont(name: "SongtiSC-Regular", size: settings.fontSize) ?? UIFont.systemFont(ofSize: settings.fontSize)
        let titleFont = UIFont(name: "SongtiSC-Regular", size: settings.fontSize + 7) ?? UIFont.systemFont(ofSize: settings.fontSize + 7, weight: .medium)
        let titleParagraph = NSMutableParagraphStyle()
        titleParagraph.paragraphSpacing = 28
        titleParagraph.lineSpacing = 6
        let bodyParagraph = NSMutableParagraphStyle()
        bodyParagraph.lineSpacing = settings.lineSpacing
        bodyParagraph.paragraphSpacing = settings.fontSize * 0.75
        bodyParagraph.firstLineHeadIndent = settings.fontSize * 2
        bodyParagraph.lineBreakMode = .byWordWrapping
        let result = NSMutableAttributedString(string: content.chapter.title + "\n\n", attributes: [.font: titleFont, .foregroundColor: color, .paragraphStyle: titleParagraph])
        result.append(NSAttributedString(string: content.paragraphs.joined(separator: "\n\n"), attributes: [.font: bodyFont, .foregroundColor: color, .paragraphStyle: bodyParagraph]))
        return result
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        weak var textView: UITextView?
        var onPositionChange: (Int, Double, Bool) -> Void
        var appliedSettings: ReaderSettings?
        var chapterID: String?
        var pendingAnchor: Int?
        var isRestoring = false
        private var lastWidth: CGFloat = 0
        private var lastHeight: CGFloat = 0
        private var lastReportedCharacter = 0

        init(onPositionChange: @escaping (Int, Double, Bool) -> Void) { self.onPositionChange = onPositionChange }

        func visibleCharacter(in view: UITextView) -> Int {
            guard view.textStorage.length > 0 else { return 0 }
            let point = CGPoint(x: 0, y: max(0, view.contentOffset.y - view.textContainerInset.top + 2))
            let glyph = view.layoutManager.glyphIndex(for: point, in: view.textContainer)
            guard glyph < view.layoutManager.numberOfGlyphs else { return max(0, view.textStorage.length - 1) }
            return view.layoutManager.characterIndexForGlyph(at: glyph)
        }

        func restoreAfterLayout() {
            guard let view = textView, view.bounds.width > 0, view.bounds.height > 0 else { return }
            let resized = lastWidth != 0 && (abs(lastWidth - view.bounds.width) > 1 || abs(lastHeight - view.bounds.height) > 1)
            lastWidth = view.bounds.width
            lastHeight = view.bounds.height
            if resized && pendingAnchor == nil { pendingAnchor = lastReportedCharacter; isRestoring = true }
            guard let pending = pendingAnchor else { return }
            pendingAnchor = nil
            view.layoutManager.ensureLayout(for: view.textContainer)
            let anchor = min(max(0, pending), max(0, view.textStorage.length - 1))
            if anchor == 0 {
                view.setContentOffset(CGPoint(x: 0, y: -view.adjustedContentInset.top), animated: false)
            } else {
                let range = NSRange(location: anchor, length: 1)
                let glyphRange = view.layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                let rect = view.layoutManager.boundingRect(forGlyphRange: glyphRange, in: view.textContainer)
                let maximum = max(-view.adjustedContentInset.top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
                let y = min(maximum, max(-view.adjustedContentInset.top, rect.minY + view.textContainerInset.top))
                view.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            }
            isRestoring = false
            report(view, settled: true)
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard !isRestoring, let view = scrollView as? UITextView else { return }
            report(view, settled: false)
        }
        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            if let view = scrollView as? UITextView { report(view, settled: true) }
        }
        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate, let view = scrollView as? UITextView { report(view, settled: true) }
        }
        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
            if let view = scrollView as? UITextView { report(view, settled: true) }
        }
        private func report(_ view: UITextView, settled: Bool) {
            let offset = visibleCharacter(in: view)
            lastReportedCharacter = offset
            let maximum = max(0, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
            let atBottom = view.contentOffset.y >= maximum - 2
            let fraction = atBottom ? 1.0 : Double(offset) / Double(max(1, view.textStorage.length))
            onPositionChange(offset, min(1, max(0, fraction)), settled)
        }
    }
}

private final class LayoutAwareTextView: UITextView {
    var layoutChanged: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        layoutChanged?()
    }
}
