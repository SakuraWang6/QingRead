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
    @State private var activeBook: Book?
    @State private var openedProfileRevision = 0
    @State private var wasSavedAtOpen = false
    @State private var showSourceSwitch = false
    @State private var showDownload = false
    @State private var showAnnotations = false
    @State private var showTextSelection = false
    @State private var showOriginalEPUB = false
    @State private var selectionOffset = 0
    @State private var checkingEnd = false
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
    @State private var chapterPage = 1
    @State private var chapterPageStarts: [Int] = []
    @State private var chapterLengths: [Int: Int] = [:]
    @State private var measuredPages: [Int: Int] = [:]
    @State private var estimatedPages: [Int: Int] = [:]
    @State private var pageSize = CGSize.zero
    @State private var unitsPerPage = 350.0
    @State private var adjacentContents: [Int: ChapterContent] = [:]
    @State private var progressEstimateTask: Task<Void, Never>?
    @State private var seek: ReaderSeekRequest?
    @State private var loadTask: Task<Void, Never>?
    @State private var loadGeneration = UUID()
    @State private var isVisible = false
    @State private var initialBrightness: CGFloat?
    @State private var customBrightnessApplied = false

    private var currentBook: Book { activeBook ?? book }
    private var librarySource: String { store.sourceFingerprint(store.currentBook(book)) }
    private var theme: ReadingTheme { store.settings.activeTheme }
    private var originalEPUBURL: URL? {
        guard store.importedBooks[currentBook.id]?.format == .epub else { return nil }
        return store.publicationURL(for: currentBook)
    }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            readingSurface.accessibilityHidden(showCatalog)
            VStack(spacing: 0) {
                if controlsVisible {
                    ReaderTopBar(title: currentBook.title, theme: theme, onClose: exitReader,
                                 onSource: currentBook.publicationFormat == nil ? { persistPosition(); speech.pause(); showSourceSwitch = true } : nil,
                                 onDownload: currentBook.publicationFormat == nil ? { showDownload = true } : nil,
                                 onAnnotations: { persistPosition(); speech.pause(); showAnnotations = true },
                                 onOriginalEPUB: originalEPUBURL == nil ? nil : { persistPosition(); speech.stop(); showOriginalEPUB = true })
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else {
                    HStack {
                        Text(content?.chapter.title ?? currentBook.title).lineLimit(1)
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
                                    chapters: chapters, bookFraction: bookFraction, pageCounts: bookPageCounts,
                                    isLoading: isLoading, isNight: store.settings.isNightMode, theme: theme,
                                    onPrevious: { moveChapter(-1) }, onNext: { moveChapter(1) },
                                    onCatalog: openCatalog, onSettings: { showSettings = true },
                                    onAudio: { speech.alignIfStopped(toUTF16: characterOffset); showAudio = true }, onNight: toggleNight,
                                    onSeek: seekBook)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    HStack {
                        Text("\(bookPageNumber) / \(totalBookPages)").monospacedDigit()
                            .accessibilityLabel("阅读进度，第 \(bookPageNumber) 页，共 \(totalBookPages) 页")
                            .accessibilityIdentifier("reader.progress")
                        Spacer()
                        ReaderDeviceStatus()
                    }
                    .font(.system(size: 12)).foregroundStyle(theme.foreground.opacity(0.52))
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
            openedProfileRevision = store.profileRevision
            wasSavedAtOpen = store.isSaved(book)
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
            progressEstimateTask?.cancel()
            store.cancelPrefetch(for: currentBook)
            persistPosition()
            speech.stop()
            if customBrightnessApplied, let initialBrightness { UIScreen.main.brightness = initialBrightness }
        }
        .onChange(of: scenePhase) { phase in if phase != .active { persistPosition() } }
        .onChange(of: store.isSaved(book)) { saved in
            if wasSavedAtOpen && !saved {
                content = nil; isVisible = false; loadGeneration = UUID(); loadTask?.cancel(); speech.stop(); dismiss()
            }
        }
        .onChange(of: store.profileRevision) { _ in
            loadGeneration = UUID(); loadTask?.cancel(); progressEstimateTask?.cancel(); speech.stop()
            content = nil; chapters = []; isVisible = false; dismiss()
        }
        .onChange(of: librarySource) { _ in
            let updated = store.currentBook(book)
            guard store.sourceFingerprint(updated) != store.sourceFingerprint(currentBook) else { return }
            loadGeneration = UUID(); loadTask?.cancel(); speech.stop()
            content = nil; chapters = []; adjacentContents = [:]; measuredPages = [:]; estimatedPages = [:]; chapterLengths = [:]
            activeBook = updated
            loadTask = Task { await openBook() }
        }
        .onChange(of: store.cacheRevision) { _ in refreshAdjacentContents(); schedulePageEstimates() }
        .onChange(of: paginationKey) { _ in measuredPages = [:]; estimatedPages = [:]; schedulePageEstimates() }
        .onChange(of: store.settings) { updated in
            applyBrightness()
            speech.updateSettings(updated)
        }
        .sheet(isPresented: $showAnnotations) {
            ReaderAnnotationsView(book: currentBook, chapters: chapters, currentChapter: content?.chapter,
                                  bodyOffset: content.map { ReaderBodyAnchor.bodyOffset(documentOffset: characterOffset, content: $0) } ?? 0,
                                  onSelect: openAnnotation, onSelectText: { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { selectionOffset = characterOffset; showTextSelection = true } })
        }
        .sheet(isPresented: $showTextSelection) {
            if let content { ReaderTextSelectionView(book: currentBook, content: content, initialBodyOffset: ReaderBodyAnchor.bodyOffset(documentOffset: selectionOffset, content: content)) }
        }
        .fullScreenCover(isPresented: $showOriginalEPUB) {
            if let url = originalEPUBURL {
                EPUBBookReader(book: currentBook, url: url, initialChapterID: content?.chapter.id, onText: { showOriginalEPUB = false })
            }
        }
        .sheet(isPresented: $showSourceSwitch) { SourceSwitchView(book: currentBook, currentChapters: chapters) }
        .sheet(isPresented: $showDownload) { DownloadSelectionView(book: currentBook, chapters: chapters) }
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
                             previousContent: adjacentContents[index - 1], nextContent: adjacentContents[index + 1],
                             onPosition: { offset, fraction, page, count, settled in
                guard !isLoading, self.content?.chapter.id == content.chapter.id else { return }
                characterOffset = offset
                chapterFraction = fraction >= 1 ? 1 : ReaderBodyAnchor.fraction(documentOffset: offset, content: content)
                chapterPage = max(1, page)
                measuredPages[index] = max(1, count)
                if settled { persistPosition() }
            }, onPageLayout: { starts, capacity, size in
                chapterPageStarts = starts; unitsPerPage = capacity
                if pageSize != size { pageSize = size; estimatedPages = [:] }
                schedulePageEstimates()
            }, onTurn: hideControls, onToggleControls: toggleControls, onBoundary: { moveChapter($0, fromPageBoundary: true) }, onExit: exitReader,
                             onAnnotate: { offset in speech.pause(); selectionOffset = offset; showTextSelection = true },
                             annotationRanges: store.annotations(for: currentBook).filter { $0.kind == .note && $0.chapterID == content.chapter.id && $0.sourceID == currentBook.sourceID && $0.sourceURL == currentBook.url.absoluteString }.map { NSRange(location: ReaderBodyAnchor.prefixLength(content) + $0.characterOffset, length: $0.characterLength) })

        }
    }

    private var paginationKey: String {
        let s = store.settings
        return "\(s.fontSize)|\(s.lineSpacing)|\(s.paragraphSpacing)|\(s.horizontalMargin)|\(s.font)|\(s.isBold)|\(s.turnMode)"
    }
    private var bookPageCounts: [Int] {
        ReaderBookProgress.pageCounts(chapterCount: chapters.count, lengths: chapterLengths, measured: estimatedPages.merging(measuredPages) { _, actual in actual }, unitsPerPage: unitsPerPage)
    }
    private var totalBookPages: Int { max(1, bookPageCounts.reduce(0, +)) }
    private var bookPageNumber: Int { ReaderBookProgress.pageNumber(chapterIndex: index, pageIndex: chapterPage - 1, pageCounts: bookPageCounts) }
    private var bookFraction: Double { ReaderBookProgress.fraction(pageNumber: bookPageNumber, totalPages: totalBookPages) }
    private func refreshAdjacentContents() {
        var nearby: [Int: ChapterContent] = [:]
        for candidate in [index - 1, index + 1] where chapters.indices.contains(candidate) {
            if let cached = adjacentContents[candidate] ?? store.cachedContent(for: chapters[candidate], in: currentBook) { nearby[candidate] = cached }
        }
        if let content, let current = chapters.firstIndex(where: { $0.id == content.chapter.id }) { nearby[current] = content }
        adjacentContents = nearby
    }
    private func schedulePageEstimates() {
        progressEstimateTask?.cancel()
        progressEstimateTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, isVisible else { return }
            await refreshCachedLengths()
        }
    }
    private func refreshCachedLengths() async {
        guard !chapters.isEmpty else { return }
        let candidates = chapters.count <= 64 ? Array(chapters.indices) : Array(max(0, index - 10)...min(chapters.count - 1, index + 10))
        for i in candidates where chapterLengths[i] == nil || estimatedPages[i] == nil {
            guard !Task.isCancelled, isVisible else { return }
            if let cached = store.cachedContent(for: chapters[i], in: currentBook) {
                chapterLengths[i] = cached.paragraphs.joined(separator: "\n").utf16.count
                if pageSize.width > 0, pageSize.height > 0 {
                    let document = ReaderDocument(content: cached, settings: store.settings)
                    let height = document.text.boundingRect(with: CGSize(width: pageSize.width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height
                    estimatedPages[i] = max(1, Int(ceil(height / pageSize.height)))
                }
            }
            await Task.yield()
        }
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
                    ReaderCatalogDrawer(book: currentBook, chapters: chapters,
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
        guard let target = ReaderBookProgress.destination(for: fraction, pageCounts: bookPageCounts) else { return }
        persistPosition()
        let targetFraction = Double(target.pageIndex) / Double(max(1, bookPageCounts[target.chapterIndex]))
        let shouldContinue = speech.wantsContinuation
        if target.chapterIndex == index, let content, !isLoading {
            let intent = speech.beginChapterTransition(autoplay: shouldContinue)
            characterOffset = chapterPageStarts.indices.contains(target.pageIndex) ? chapterPageStarts[target.pageIndex] : ReaderBookProgress.utf16Offset(for: targetFraction, textLength: chapterTextLength)
            chapterFraction = ReaderBodyAnchor.fraction(documentOffset: characterOffset, content: content)
            seek = ReaderSeekRequest(utf16Offset: characterOffset)
            speech.prepare(content: content, settings: store.settings, anchor: characterOffset, bookTitle: currentBook.title,
                           autoplay: intent.map { speech.permitsAutoplay($0) } ?? false)
            persistPosition()
        } else {
            beginLoadChapter(target.chapterIndex, restore: false, autoplay: shouldContinue, targetFraction: targetFraction)
        }
    }

    private func openAnnotation(chapterID: String, bodyOffset: Int) {
        guard let target = chapters.firstIndex(where: { $0.id == chapterID }) else { return }
        persistPosition(); showAnnotations = false
        if target == index, let content {
            characterOffset = ReaderBodyAnchor.documentOffset(bodyOffset: bodyOffset, content: content)
            chapterFraction = ReaderBodyAnchor.fraction(documentOffset: characterOffset, content: content)
            seek = ReaderSeekRequest(utf16Offset: characterOffset); persistPosition()
        } else { beginLoadChapter(target, restore: false, targetBodyOffset: bodyOffset) }
    }

    private func hideControls() { if controlsVisible { withAnimation(.easeOut(duration: 0.15)) { controlsVisible = false } } }
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
            if let content { chapterFraction = ReaderBodyAnchor.fraction(documentOffset: offset, content: content) }
            seek = offset >= chapterTextLength ? nil : ReaderSeekRequest(utf16Offset: offset)
            persistPosition()
        }
        speech.onChapterCompleted = {
            guard isVisible, chapters.indices.contains(index), let content,
                  content.chapter.id == chapters[index].id else { return }
            chapterFraction = 1
            persistPosition()
            store.markChapterCompleted(content.chapter, in: currentBook)
        }
        speech.onChapterBoundary = { delta in
            guard isVisible else { return }
            let next = index + delta
            guard chapters.indices.contains(next) else {
                if delta > 0 { checkEndForUpdates(autoplay: speech.wantsContinuation) } else { speech.stop() }
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
            let loaded = try await store.chapters(for: currentBook)
            try Task.checkCancellation()
            guard isVisible, openedProfileRevision == store.profileRevision, loadGeneration == generation else { return }
            chapters = loaded
            guard !chapters.isEmpty else { throw AppError.message("来源没有返回可读章节。") }
            let saved = store.position(for: currentBook)
            let targetID = initialChapterID ?? saved?.chapterID
            if let targetID, let found = chapters.firstIndex(where: { $0.id == targetID }) { index = found }
            else { index = min(max(0, saved?.chapterIndex ?? 0), chapters.count - 1) }
            let restore = initialChapterID == nil && saved?.chapterID == chapters[index].id
            let speechIntent = speech.beginChapterTransition(autoplay: debugListen)
            await loadChapter(index, restore: restore, speechIntent: speechIntent)
        } catch is CancellationError { }
        catch {
            guard isVisible, openedProfileRevision == store.profileRevision, loadGeneration == generation else { return }
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func beginLoadChapter(_ requestedIndex: Int, restore: Bool, autoplay: Bool = false, startAtEnd: Bool = false,
                                  targetFraction: Double? = nil, targetBodyOffset: Int? = nil) {
        guard chapters.indices.contains(requestedIndex), isVisible else { return }
        loadTask?.cancel()
        progressEstimateTask?.cancel()
        store.cancelPrefetch(for: currentBook)
        let speechIntent = speech.beginChapterTransition(autoplay: autoplay)
        loadTask = Task { await loadChapter(requestedIndex, restore: restore, speechIntent: speechIntent,
                                          startAtEnd: startAtEnd, targetFraction: targetFraction, targetBodyOffset: targetBodyOffset) }
    }

    private func loadChapter(_ requestedIndex: Int, restore: Bool, speechIntent: UUID?, startAtEnd: Bool = false,
                             targetFraction: Double? = nil, targetBodyOffset: Int? = nil) async {
        guard chapters.indices.contains(requestedIndex) else { return }
        let generation = UUID()
        loadGeneration = generation
        let cached = store.cachedContent(for: chapters[requestedIndex], in: currentBook)
        index = requestedIndex
        isLoading = cached == nil
        if cached == nil { content = nil }
        chapterPage = 1
        chapterPageStarts = []
        errorMessage = nil
        characterOffset = 0
        chapterFraction = targetFraction ?? 0
        chapterTextLength = 0
        seek = nil
        let chapter = chapters[requestedIndex]
        if restore, let saved = store.position(for: currentBook), saved.chapterID == chapter.id {
            characterOffset = saved.characterOffset
            chapterFraction = saved.chapterFraction
        }
        do {
            let loaded: ChapterContent
            if let cached { loaded = cached } else { loaded = try await store.content(for: chapter, in: currentBook) }
            try Task.checkCancellation()
            guard isVisible, openedProfileRevision == store.profileRevision, loadGeneration == generation else { return }
            // Count UTF-16 units without building a second attributed document.
            chapterTextLength = loaded.chapter.title.utf16.count + 1 + loaded.paragraphs.joined(separator: "\n").utf16.count
            chapterLengths[requestedIndex] = loaded.paragraphs.joined(separator: "\n").utf16.count
            if restore, let saved = store.position(for: currentBook), saved.chapterID == chapter.id {
                characterOffset = ReaderBodyAnchor.documentOffset(bodyOffset: saved.characterOffset, content: loaded)
                chapterFraction = saved.chapterFraction
            }
            if let targetBodyOffset {
                characterOffset = ReaderBodyAnchor.documentOffset(bodyOffset: targetBodyOffset, content: loaded)
                chapterFraction = ReaderBodyAnchor.fraction(documentOffset: characterOffset, content: loaded)
            }
            if let fraction = targetFraction ?? (startAtEnd ? 1 : nil) {
                let bodyOffset = SourceProgressMatcher.utf16Offset(fraction: fraction, content: loaded)
                characterOffset = ReaderBodyAnchor.documentOffset(bodyOffset: bodyOffset, content: loaded)
                chapterFraction = fraction
            }
            content = loaded
            refreshAdjacentContents()
            schedulePageEstimates()
            isLoading = false
            let autoplay = speechIntent.map { speech.permitsAutoplay($0) } ?? false
            speech.prepare(content: loaded, settings: store.settings, anchor: characterOffset, bookTitle: currentBook.title, autoplay: autoplay)
            persistPosition()
            store.prefetchChapters(after: requestedIndex, chapters: chapters, in: currentBook)
        } catch is CancellationError { }
        catch {
            guard isVisible, openedProfileRevision == store.profileRevision, loadGeneration == generation else { return }
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
        if fromPageBoundary && delta > 0 { store.markChapterCompleted(chapters[index], in: currentBook) }
        guard chapters.indices.contains(next) else {
            if delta > 0 { checkEndForUpdates() }
            return
        }
        hideControls()
        beginLoadChapter(next, restore: false, autoplay: speech.wantsContinuation, startAtEnd: fromPageBoundary && delta < 0)
    }
    private func checkEndForUpdates(autoplay: Bool = false) {
        guard !checkingEnd else { return }
        guard currentBook.publicationFormat == nil, store.enabledSourceIDs.contains(currentBook.sourceID) else { if autoplay { speech.endOfBook() }; return }
        checkingEnd = true
        let openingBook = currentBook
        let last = content?.chapter.id
        loadTask = Task {
            defer { checkingEnd = false }
            do {
                let updated = try await store.refreshedEndCatalog(for: openingBook)
                guard isVisible, store.sourceFingerprint(currentBook) == store.sourceFingerprint(openingBook) else { return }
                let oldIndex = last.flatMap { id in updated.firstIndex(where: { $0.id == id }) } ?? index
                chapters = updated
                if updated.indices.contains(oldIndex + 1) {
                    beginLoadChapter(oldIndex + 1, restore: false, autoplay: autoplay || speech.wantsContinuation)
                } else if autoplay { speech.endOfBook() }
            } catch is CancellationError { }
            catch { controlsVisible = true; if autoplay { speech.endOfBook() } }
        }
    }
    private func persistPosition() {
        guard openedProfileRevision == store.profileRevision, let content, chapters.indices.contains(index), content.chapter.id == chapters[index].id else { return }
        let isListening = speech.state == .playing || speech.state == .paused
        let offset = (isListening ? speech.currentUTF16Anchor : nil) ?? characterOffset
        let fraction = isListening && chapterFraction < 1 ? ReaderBodyAnchor.fraction(documentOffset: offset, content: content) : chapterFraction
        store.savePosition(book: currentBook, chapter: content.chapter, index: index,
                           characterOffset: ReaderBodyAnchor.bodyOffset(documentOffset: offset, content: content), fraction: fraction)
    }
    private func exitReader() {
        persistPosition()
        speech.stop()
        store.cancelPrefetch(for: currentBook)
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
