import SwiftUI
import UIKit
import ReadingCore

struct ReaderView: View {
    let book: Book
    var initialChapterID: String? = nil
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var speech = ReaderSpeechController()
    @State private var chapters: [Chapter] = []
    @State private var index = 0
    @State private var content: ChapterContent?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var controlsVisible = false
    @State private var showSettings = false
    @State private var showCatalog = false
    @State private var showAudio = false
    @State private var characterOffset = 0
    @State private var chapterFraction = 0.0
    @State private var chapterTextLength = 0
    @State private var seek: ReaderSeekRequest?
    @State private var loadTask: Task<Void, Never>?
    @State private var loadGeneration = UUID()
    @State private var isVisible = false
    @State private var initialBrightness: CGFloat?
    @State private var customBrightnessApplied = false

    private var theme: ReadingTheme { store.settings.activeTheme }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            readingSurface.accessibilityHidden(showCatalog)
            VStack(spacing: 0) {
                if controlsVisible {
                    ReaderTopBar(title: book.title, theme: theme, onClose: exitReader)
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else {
                    HStack {
                        Text(content?.chapter.title ?? book.title).lineLimit(1)
                        Spacer(minLength: 16)
                        if speech.state == .playing { Image(systemName: "headphones") }
                    }
                    .font(.system(size: 11)).foregroundStyle(theme.foreground.opacity(0.42))
                    .padding(.horizontal, store.settings.horizontalMargin).padding(.top, 4)
                    .allowsHitTesting(false)
                }
                Spacer(minLength: 0)
                if controlsVisible {
                    ReaderBottomBar(chapterTitle: content?.chapter.title ?? "正在打开", chapterIndex: index,
                                    chapters: chapters, bookFraction: bookFraction,
                                    isLoading: isLoading, isNight: store.settings.isNightMode, theme: theme,
                                    onPrevious: { moveChapter(-1) }, onNext: { moveChapter(1) },
                                    onCatalog: openCatalog, onSettings: { showSettings = true },
                                    onAudio: { speech.alignIfStopped(toUTF16: characterOffset); showAudio = true }, onNight: toggleNight,
                                    onSeek: seekBook)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    HStack {
                        Text(Date(), style: .time)
                        Spacer()
                        Text(ReaderBookProgress.label(for: bookFraction)).monospacedDigit()
                            .accessibilityLabel("整书进度 \(ReaderBookProgress.label(for: bookFraction))，基于章节估算")
                            .accessibilityIdentifier("reader.progress")
                    }
                    .font(.system(size: 10)).foregroundStyle(theme.foreground.opacity(0.42))
                    .padding(.horizontal, store.settings.horizontalMargin).padding(.bottom, 6)
                    .allowsHitTesting(false)
                }
            }.accessibilityHidden(showCatalog)
            catalogDrawer.zIndex(2).allowsHitTesting(showCatalog)
        }
        .preferredColorScheme(store.settings.isNightMode ? .dark : .light)
        .statusBarHidden(true)
        .task {
            isVisible = true
            initialBrightness = UIScreen.main.brightness
            configureSpeech()
            applyDebugArguments()
            applyBrightness()
            await openBook()
        }
        .onDisappear {
            isVisible = false
            loadGeneration = UUID()
            loadTask?.cancel()
            store.cancelPrefetch(for: book)
            persistPosition()
            speech.stop()
            if customBrightnessApplied, let initialBrightness { UIScreen.main.brightness = initialBrightness }
        }
        .onChange(of: scenePhase) { phase in if phase != .active { persistPosition() } }
        .onChange(of: store.settings) { updated in
            applyBrightness()
            speech.updateSettings(updated)
        }
        .sheet(isPresented: $showSettings) {
            ReaderSettingsPanel().presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAudio) {
            ReaderAudioPanel(speech: speech, chapterTitle: content?.chapter.title ?? "正在打开",
                             chapterIndex: index, chapterCount: chapters.count)
                .presentationDetents([.height(520), .large]).presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder private var readingSurface: some View {
        if isLoading {
            VStack(spacing: 18) {
                ProgressView().tint(theme.foreground)
                Text("正在翻开这一章…").font(.bookTitle(18)).foregroundStyle(theme.foreground.opacity(0.7))
                Button("显示阅读菜单") { toggleControls() }.font(.caption).tint(theme.foreground)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            VStack(spacing: 20) {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 32, weight: .ultraLight))
                Text("这一章暂时打不开").font(.bookTitle(25))
                Text(errorMessage).font(.footnote).lineSpacing(5).multilineTextAlignment(.center).textSelection(.enabled)
                Button("重新加载") {
                    if chapters.isEmpty { loadTask = Task { await openBook() } }
                    else { beginLoadChapter(index, restore: true) }
                }.buttonStyle(.bordered).accessibilityIdentifier("reader.retry")
                Button("打开目录", action: openCatalog).disabled(chapters.isEmpty)
                Button("返回书架", action: exitReader)
            }.foregroundStyle(theme.foreground).padding(32)
        } else if let content {
            ReaderCanvasView(content: content, settings: store.settings, initialOffset: characterOffset, seek: seek,
                             onPosition: { offset, fraction, _, _, settled in
                guard !isLoading, self.content?.chapter.id == content.chapter.id else { return }
                characterOffset = offset
                chapterFraction = fraction
                if settled { persistPosition() }
            }, onToggleControls: toggleControls, onBoundary: { moveChapter($0, fromPageBoundary: true) }, onExit: exitReader)
                .id(content.chapter.id)
        }
    }

    private var bookFraction: Double {
        ReaderBookProgress.fraction(chapterIndex: index, chapterFraction: chapterFraction, chapterCount: chapters.count)
    }

    private var catalogDrawer: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                if showCatalog {
                    Color.black.opacity(0.32).ignoresSafeArea()
                        .onTapGesture(perform: closeCatalog)
                        .accessibilityLabel("关闭目录").accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("reader.catalog.dismissArea")
                        .transition(.opacity)
                }
                if showCatalog {
                    ReaderCatalogDrawer(book: book, chapters: chapters,
                                        currentID: chapters.indices.contains(index) ? chapters[index].id : nil,
                                        onSelect: selectChapter, onClose: closeCatalog)
                        .frame(width: min(400, geometry.size.width * 0.88), height: geometry.size.height)
                        .shadow(color: .black.opacity(0.18), radius: 20, x: 5)
                        .transition(.move(edge: .leading))
                }
            }
        }
    }

    private func openCatalog() {
        guard !chapters.isEmpty else { return }
        persistPosition()
        withAnimation(.easeOut(duration: 0.22)) { showCatalog = true }
    }
    private func closeCatalog() { withAnimation(.easeOut(duration: 0.2)) { showCatalog = false } }
    private func selectChapter(_ selected: Int) {
        closeCatalog()
        guard selected != index || content == nil else { return }
        persistPosition()
        beginLoadChapter(selected, restore: false, autoplay: speech.wantsContinuation)
    }

    private func seekBook(to fraction: Double) {
        guard let target = ReaderBookProgress.destination(for: fraction, chapterCount: chapters.count) else { return }
        persistPosition()
        let shouldContinue = speech.wantsContinuation
        if target.chapterIndex == index, let content, !isLoading {
            let intent = speech.beginChapterTransition(autoplay: shouldContinue)
            characterOffset = ReaderBookProgress.utf16Offset(for: target.chapterFraction, textLength: chapterTextLength)
            chapterFraction = target.chapterFraction
            seek = ReaderSeekRequest(utf16Offset: characterOffset)
            speech.prepare(content: content, settings: store.settings, anchor: characterOffset, bookTitle: book.title,
                           autoplay: intent.map { speech.permitsAutoplay($0) } ?? false)
            persistPosition()
        } else {
            beginLoadChapter(target.chapterIndex, restore: false, autoplay: shouldContinue, targetFraction: target.chapterFraction)
        }
    }

    private func toggleControls() { withAnimation(.easeInOut(duration: 0.2)) { controlsVisible.toggle() } }
    private func toggleNight() {
        var updated = store.settings
        updated.isNightMode.toggle()
        store.updateSettings(updated)
    }
    private func applyBrightness() {
        guard isVisible else { return }
        if store.settings.followsSystemBrightness {
            if customBrightnessApplied, let initialBrightness { UIScreen.main.brightness = initialBrightness }
            customBrightnessApplied = false
        } else {
            UIScreen.main.brightness = store.settings.brightness
            customBrightnessApplied = true
        }
    }
    private func configureSpeech() {
        speech.onParagraph = { offset in
            guard isVisible, !isLoading, content != nil else { return }
            characterOffset = offset
            chapterFraction = chapterTextLength > 0 ? Double(offset) / Double(chapterTextLength) : 0
            seek = offset >= chapterTextLength ? nil : ReaderSeekRequest(utf16Offset: offset)
            persistPosition()
        }
        speech.onChapterCompleted = {
            guard isVisible, chapters.indices.contains(index), let content,
                  content.chapter.id == chapters[index].id else { return }
            chapterFraction = 1
            persistPosition()
            store.markChapterCompleted(content.chapter, in: book)
        }
        speech.onChapterBoundary = { delta in
            guard isVisible else { return }
            let next = index + delta
            guard chapters.indices.contains(next) else {
                if delta > 0 { speech.endOfBook() } else { speech.stop() }
                return
            }
            persistPosition()
            beginLoadChapter(next, restore: false, autoplay: speech.wantsContinuation)
        }
    }

    private func openBook() async {
        let generation = UUID()
        loadGeneration = generation
        isLoading = true
        errorMessage = nil
        do {
            let loaded = try await store.chapters(for: book)
            try Task.checkCancellation()
            guard isVisible, loadGeneration == generation else { return }
            chapters = loaded
            guard !chapters.isEmpty else { throw AppError.message("来源没有返回可读章节。") }
            let saved = store.position(for: book)
            let targetID = initialChapterID ?? saved?.chapterID
            if let targetID, let found = chapters.firstIndex(where: { $0.id == targetID }) { index = found }
            else { index = min(max(0, saved?.chapterIndex ?? 0), chapters.count - 1) }
            let restore = initialChapterID == nil && saved?.chapterID == chapters[index].id
            let speechIntent = speech.beginChapterTransition(autoplay: debugListen)
            await loadChapter(index, restore: restore, speechIntent: speechIntent)
        } catch is CancellationError { }
        catch {
            guard isVisible, loadGeneration == generation else { return }
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func beginLoadChapter(_ requestedIndex: Int, restore: Bool, autoplay: Bool = false, startAtEnd: Bool = false,
                                  targetFraction: Double? = nil) {
        guard chapters.indices.contains(requestedIndex), isVisible else { return }
        loadTask?.cancel()
        store.cancelPrefetch(for: book)
        let speechIntent = speech.beginChapterTransition(autoplay: autoplay)
        loadTask = Task { await loadChapter(requestedIndex, restore: restore, speechIntent: speechIntent,
                                          startAtEnd: startAtEnd, targetFraction: targetFraction) }
    }

    private func loadChapter(_ requestedIndex: Int, restore: Bool, speechIntent: UUID?, startAtEnd: Bool = false,
                             targetFraction: Double? = nil) async {
        guard chapters.indices.contains(requestedIndex) else { return }
        let generation = UUID()
        loadGeneration = generation
        index = requestedIndex
        isLoading = true
        content = nil
        errorMessage = nil
        characterOffset = 0
        chapterFraction = targetFraction ?? 0
        chapterTextLength = 0
        seek = nil
        let chapter = chapters[requestedIndex]
        if restore, let saved = store.position(for: book), saved.chapterID == chapter.id {
            characterOffset = saved.characterOffset
            chapterFraction = saved.chapterFraction
        }
        do {
            let loaded = try await store.content(for: chapter, in: book)
            try Task.checkCancellation()
            guard isVisible, loadGeneration == generation else { return }
            chapterTextLength = ReaderDocument(content: loaded, settings: store.settings).text.length
            if let fraction = targetFraction ?? (startAtEnd ? 1 : nil) {
                characterOffset = ReaderBookProgress.utf16Offset(for: fraction, textLength: chapterTextLength)
                chapterFraction = fraction
            }
            content = loaded
            isLoading = false
            let autoplay = speechIntent.map { speech.permitsAutoplay($0) } ?? false
            speech.prepare(content: loaded, settings: store.settings, anchor: characterOffset, bookTitle: book.title, autoplay: autoplay)
            persistPosition()
            store.prefetchChapters(after: requestedIndex, chapters: chapters, in: book)
        } catch is CancellationError { }
        catch {
            guard isVisible, loadGeneration == generation else { return }
            errorMessage = error.localizedDescription
            isLoading = false
            speech.stop()
            controlsVisible = true
        }
    }

    private func moveChapter(_ delta: Int, fromPageBoundary: Bool = false) {
        let next = index + delta
        guard !isLoading, chapters.indices.contains(index) else { return }
        if fromPageBoundary && delta > 0 { chapterFraction = 1 }
        persistPosition()
        if fromPageBoundary && delta > 0 { store.markChapterCompleted(chapters[index], in: book) }
        guard chapters.indices.contains(next) else { return }
        beginLoadChapter(next, restore: false, autoplay: speech.wantsContinuation, startAtEnd: fromPageBoundary && delta < 0)
    }
    private func persistPosition() {
        guard let content, chapters.indices.contains(index), content.chapter.id == chapters[index].id else { return }
        let isListening = speech.state == .playing || speech.state == .paused
        let offset = (isListening ? speech.currentUTF16Anchor : nil) ?? characterOffset
        let fraction = isListening && chapterFraction < 1 && chapterTextLength > 0 ? Double(offset) / Double(chapterTextLength) : chapterFraction
        store.savePosition(book: book, chapter: content.chapter, index: index,
                           characterOffset: offset, fraction: fraction)
    }
    private func exitReader() {
        persistPosition()
        speech.stop()
        store.cancelPrefetch(for: book)
        dismiss()
    }

    private var debugListen: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("--reader-listen")
        #else
        return false
        #endif
    }
    private func applyDebugArguments() {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--reader-self-test") { ReaderDiagnostics.run() }
        controlsVisible = arguments.contains("--reader-controls")
        showSettings = arguments.contains("--reader-settings")
        showCatalog = arguments.contains("--reader-catalog")
        showAudio = arguments.contains("--reader-audio")
        var settings = store.settings
        if let flag = arguments.firstIndex(of: "--reader-mode"), arguments.indices.contains(flag + 1), let mode = ReaderTurnMode(rawValue: arguments[flag + 1]) { settings.turnMode = mode }
        if arguments.contains("--reader-night") { settings.isNightMode = true }
        if arguments.contains("--reader-ai"), AIModelManager.shared.readyDirectory != nil { settings.speechEngine = .melo }
        store.updateSettings(settings)
        #endif
    }
}
