import SwiftUI
import ReadingCore

struct SourceSwitchView: View {
    let book: Book
    var currentChapters: [Chapter]? = nil
    var onSwitched: (Book) -> Void = { _ in }
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var candidates: [Book] = []
    @State private var loading = true
    @State private var working = false
    @State private var error: String?
    @State private var plan: SourceSwitchPlan?
    @State private var chapterQuery = ""
    @State private var selectedChapterIndex: Int?
    @State private var operation: Task<Void, Never>?
    @State private var isPresented = true
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                if loading || working { HStack { Spacer(); ProgressView(); Spacer() } }
                if let plan {
                    Section {
                        HStack {
                            Text(plan.candidate.sourceName)
                            Spacer()
                            Text("共 \(plan.chapters.count) 章").font(.caption).foregroundStyle(Palette.secondary)
                        }
                        Button("其他书源") { self.plan = nil; selectedChapterIndex = nil; error = nil }
                            .disabled(working)
                    }
                    if plan.matchedIndex == nil {
                        Section("选择接着读的章节") {
                            TextField("搜索章节", text: $chapterQuery)
                            ForEach(plan.chapters.filter { chapterQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(chapterQuery) || String($0.index + 1) == chapterQuery }) { chapter in
                                Button {
                                    selectedChapterIndex = plan.chapters.firstIndex(where: { $0.id == chapter.id })
                                } label: {
                                    HStack {
                                        Text(chapter.title)
                                        Spacer()
                                        if let selectedChapterIndex, plan.chapters[selectedChapterIndex].id == chapter.id { Image(systemName: "checkmark") }
                                    }
                                }.disabled(working)
                            }
                        }
                    } else if let selectedChapterIndex {
                        Section("接着读") { Text(plan.chapters[selectedChapterIndex].title) }
                    }
                } else {
                    ForEach(candidates) { candidate in
                        Button { prepare(candidate) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(candidate.sourceName).foregroundStyle(Palette.ink)
                                    if !candidate.author.isEmpty { Text(candidate.author).font(.caption).foregroundStyle(Palette.secondary) }
                                }
                                Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.secondary)
                            }.padding(.vertical, 5)
                        }.disabled(working)
                    }
                    if !loading && candidates.isEmpty { Text("暂无其他来源").foregroundStyle(Palette.secondary) }
                }
            }
            .tint(Palette.cinnabar)
            .navigationTitle("换源").navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                if let plan {
                    Button {
                        if let selectedChapterIndex { commit(plan, index: selectedChapterIndex) }
                    } label: { Text("确认换源") }
                        .buttonStyle(PrimaryButtonStyle()).disabled(working || selectedChapterIndex == nil)
                        .padding(.horizontal, 20).padding(.vertical, 12).background(Palette.paper)
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { cancelAndDismiss() } } }
            .onChange(of: store.profileRevision) { _ in cancelAndDismiss() }
            .onAppear { isPresented = true }
            .onDisappear { isPresented = false; operation?.cancel(); operation = nil }
            .task {
                let values = await store.sourceCandidates(for: book)
                guard !Task.isCancelled, isPresented else { return }
                candidates = values; loading = false
            }
        }
    }
    private func cancelAndDismiss() {
        isPresented = false; operation?.cancel(); operation = nil; dismiss()
    }
    private func prepare(_ candidate: Book) {
        operation?.cancel()
        working = true; error = nil
        operation = Task {
            defer { if !Task.isCancelled, isPresented { working = false } }
            do {
                let prepared = try await store.prepareSourceSwitch(from: book, to: candidate, currentChapters: currentChapters)
                try Task.checkCancellation()
                guard isPresented else { return }
                plan = prepared; selectedChapterIndex = prepared.matchedIndex; chapterQuery = ""
            } catch is CancellationError { }
            catch { if !Task.isCancelled, isPresented { self.error = error.localizedDescription } }
        }
    }
    private func commit(_ plan: SourceSwitchPlan, index: Int) {
        operation?.cancel()
        working = true; error = nil
        operation = Task {
            defer { if !Task.isCancelled, isPresented { working = false } }
            do {
                let updated = try await store.commitSourceSwitch(plan, chapterIndex: index)
                try Task.checkCancellation()
                guard isPresented else { return }
                onSwitched(updated); dismiss()
            } catch is CancellationError { }
            catch { if !Task.isCancelled, isPresented { self.error = error.localizedDescription } }
        }
    }

}

struct DownloadSelectionView: View {
    let book: Book
    let chapters: [Chapter]
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var start = "1"
    @State private var end = "1"
    private var nextIndex: Int { min(chapters.count, max(1, (store.position(for: book)?.chapterIndex ?? 0) + 1)) }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button("后续 50 章") { download(nextIndex...min(chapters.count, nextIndex + 49)) }
                    Button("后续 100 章") { download(nextIndex...min(chapters.count, nextIndex + 99)) }
                    Button("全书") { download(1...max(1, chapters.count)) }
                }
                Section("自选范围") {
                    HStack {
                        TextField("起始章", text: $start).keyboardType(.numberPad)
                        Text("—").foregroundStyle(Palette.secondary)
                        TextField("结束章", text: $end).keyboardType(.numberPad)
                    }
                    Button("加入下载") {
                        if let lower = Int(start), let upper = Int(end), lower > 0, upper >= lower, upper <= chapters.count { download(lower...upper) }
                    }.disabled(!validRange)
                }
                Section {
                    NavigationLink("下载管理") { DownloadManagerView() }
                    Text("已缓存 \(store.cachedCount(for: book)) / \(chapters.count) 章").font(.caption).foregroundStyle(Palette.secondary)
                }
            }
            .disabled(chapters.isEmpty).tint(Palette.cinnabar)
            .navigationTitle("下载").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .onChange(of: store.profileRevision) { _ in dismiss() }
            .onAppear { start = String(nextIndex); end = String(chapters.count) }
        }
    }
    private var validRange: Bool {
        guard let lower = Int(start), let upper = Int(end) else { return false }
        return lower >= 1 && upper >= lower && upper <= chapters.count
    }
    private func download(_ range: ClosedRange<Int>) { store.enqueueDownload(book: book, chapters: chapters, range: range); dismiss() }
}

struct DownloadManagerView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        List {
            if store.downloads.isEmpty { Text("暂无下载任务").foregroundStyle(Palette.secondary) }
            ForEach(store.downloads.reversed()) { task in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(task.book.title).font(.body).lineLimit(1)
                        Spacer()
                        Text(status(task.status)).font(.caption).foregroundStyle(Palette.secondary)
                    }
                    ProgressView(value: Double(task.completedCount), total: Double(max(1, task.chapters.count))).tint(Palette.cinnabar)
                    HStack {
                        Text("\(task.completedCount) / \(task.chapters.count) 章").font(.caption).foregroundStyle(Palette.secondary)
                        Spacer()
                        if [.queued, .running].contains(task.status) { Button("暂停") { store.pauseDownload(task.id) } }
                        if [.paused, .failed].contains(task.status) { Button(task.status == .failed ? "重试" : "继续") { store.resumeDownload(task.id) } }
                        if [.queued, .running, .paused, .failed].contains(task.status) { Button("取消", role: .destructive) { store.cancelDownload(task.id) } }
                        else { Button("移除") { store.dismissDownload(task.id) } }
                    }.buttonStyle(.borderless).font(.caption)
                    if task.status == .failed, let error = task.lastError { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2) }
                }.padding(.vertical, 6)
            }
        }.tint(Palette.cinnabar)
            .navigationTitle("下载管理").navigationBarTitleDisplayMode(.inline)
    }
    private func status(_ value: ChapterDownloadStatus) -> String {
        switch value { case .queued: return "等待中"; case .running: return "下载中"; case .paused: return "已暂停"; case .completed: return "已完成"; case .failed: return "部分失败"; case .cancelled: return "已取消" }
    }
}
