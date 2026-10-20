import SwiftUI
import ReadingCore

struct BookDetailView: View {
    let book: Book
    @EnvironmentObject private var store: AppStore
    @State private var chapters: [Chapter] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showReader = false
    @State private var selectedChapterID: String?
    @State private var showCatalog = false
    @State private var catalogSelection: String?
    @State private var showOtherSources = false
    @State private var cacheTask: Task<Void, Never>?
    @State private var isCaching = false
    @State private var cachedProgress = 0
    @State private var cacheMessage: String?
    @State private var showsFullSummary = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 18) {
                    BookSpine(book: book)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(book.title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.ink)
                        Text(book.author.isEmpty ? "作者未标注" : book.author).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                        Text(book.sourceName).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        if book.url.scheme == "https" || book.url.scheme == "http" {
                            Link(destination: book.url) {
                                Label("原网页", systemImage: "arrow.up.right").font(.system(size: 12))
                            }.tint(Palette.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }.padding(.top, 16)

                HStack(spacing: 12) {
                    Button {
                        selectedChapterID = nil
                        showReader = true
                    } label: {
                        Label(store.position(for: book) == nil ? "开始阅读" : "继续阅读", systemImage: "book")
                    }.buttonStyle(PrimaryButtonStyle()).disabled(chapters.isEmpty)
                    Button {
                        if store.isSaved(book) { store.remove(book) } else { store.add(book) }
                    } label: {
                        Image(systemName: store.isSaved(book) ? "bookmark.fill" : "bookmark")
                            .font(.system(size: 18)).foregroundStyle(Palette.cinnabar)
                            .frame(width: 52, height: 50)
                            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.rule, lineWidth: 0.5))
                    }.accessibilityLabel(store.isSaved(book) ? "从书架移除并删除该书缓存" : "加入书架")
                }
                HStack {
                    Text("当前书源：\(book.sourceName)").font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1)
                    Spacer(minLength: 8)
                    Button { showOtherSources = true } label: {
                        Label("换源", systemImage: "arrow.triangle.swap")
                            .font(.system(size: 13)).foregroundStyle(Palette.cinnabar)
                    }
                }

                if !book.summary.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("简介").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
                        Text(book.summary).font(.system(size: 14)).foregroundStyle(Palette.secondary).lineSpacing(5)
                            .lineLimit(showsFullSummary ? nil : 4).textSelection(.enabled)
                        if book.summary.count > 100 {
                            Button(showsFullSummary ? "收起" : "展开") { showsFullSummary.toggle() }
                                .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        }
                    }
                }
                Divider().overlay(Palette.rule)
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("目录").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
                        Spacer()
                        if !chapters.isEmpty { Text("\(chapters.count) 章").font(.caption).foregroundStyle(Palette.secondary) }
                    }
                    if isLoading {
                        HStack { ProgressView(); Text("正在获取目录…").font(.subheadline).foregroundStyle(Palette.secondary) }
                            .padding(.vertical, 12)
                    } else if let errorMessage {
                        InlineNotice(message: errorMessage, isError: true)
                        Button("重新获取目录") { Task { await loadChapters(refresh: true) } }
                    } else if chapters.isEmpty {
                        InlineNotice(message: "这个来源暂时没有返回可读章节。可以查看来源网页或更换书源。")
                    } else {
                        ForEach(chapters.prefix(5)) { chapter in
                            chapterButton(chapter)
                        }
                        if chapters.count > 5 {
                            Button { catalogSelection = nil; showCatalog = true } label: {
                                HStack { Text("查看全部目录"); Spacer(); Image(systemName: "arrow.right") }
                                    .font(.subheadline).foregroundStyle(Palette.cinnabar).padding(.vertical, 8)
                            }
                        }
                    }
                }

                if !chapters.isEmpty {
                    Divider().overlay(Palette.rule)
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text("离线缓存").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
                            Spacer()
                            Text("\(store.cachedCount(for: book)) / \(chapters.count) 章")
                                .font(.caption.monospacedDigit()).foregroundStyle(Palette.secondary)
                        }
                        if book.id == LocalSample.book.id {
                            Text("本地示例已随应用保存，离线也可以阅读。")
                                .font(.footnote).foregroundStyle(Palette.secondary)
                        } else {
                            Text("阅读时自动缓存。下载中离开此页会停止，已完成的章节会保留。")
                                .font(.system(size: 12)).foregroundStyle(Palette.secondary).lineSpacing(4)
                            Button {
                                if isCaching { cacheTask?.cancel() } else { cacheAllChapters() }
                            } label: {
                                Label(isCaching ? "停止缓存（\(cachedProgress) / \(chapters.count)）" : "缓存全书", systemImage: isCaching ? "stop.circle" : "arrow.down.circle")
                                    .font(.subheadline)
                            }
                            if isCaching { ProgressView(value: Double(cachedProgress), total: Double(chapters.count)).tint(Palette.cinnabar) }
                        }
                        if let cacheMessage { InlineNotice(message: cacheMessage) }
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 28)
        }
        .background(Palette.paper)
        .navigationTitle("书籍").navigationBarTitleDisplayMode(.inline)
        .task { await loadChapters() }
        .onDisappear { cacheTask?.cancel() }
        .refreshable { await loadChapters(refresh: true) }
        .fullScreenCover(isPresented: $showReader) { ReaderView(book: book, initialChapterID: selectedChapterID) }
        .sheet(isPresented: $showOtherSources) {
            NavigationStack {
                SearchView(initialQuery: book.title)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("关闭") { showOtherSources = false } }
                    }
            }
        }
        .sheet(isPresented: $showCatalog, onDismiss: {
            if let catalogSelection {
                selectedChapterID = catalogSelection
                showReader = true
            }
            catalogSelection = nil
        }) {
            NavigationStack {
                List(chapters) { chapter in
                    Button {
                        catalogSelection = chapter.id
                        showCatalog = false
                    } label: {
                        Text(chapter.title).font(.system(size: 14)).foregroundStyle(Palette.ink).padding(.vertical, 6)
                    }
                    .listRowBackground(Palette.paper)
                }
                .listStyle(.plain).scrollContentBackground(.hidden).background(Palette.paper)
                .navigationTitle("全部目录").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showCatalog = false } } }
            }
        }
    }

    private func chapterButton(_ chapter: Chapter) -> some View {
        Button {
            selectedChapterID = chapter.id
            showReader = true
        } label: {
            HStack {
                Text(chapter.title).lineLimit(2)
                Spacer()
                Image(systemName: "chevron.right").font(.caption)
            }.font(.system(size: 14)).foregroundStyle(Palette.ink).padding(.vertical, 7)
        }
    }

    private func loadChapters(refresh: Bool = false) async {
        isLoading = true
        errorMessage = nil
        do { chapters = try await store.chapters(for: book, refresh: refresh) }
        catch is CancellationError { }
        catch { errorMessage = "目录获取失败：\(error.localizedDescription)" }
        isLoading = false
    }

    private func cacheAllChapters() {
        isCaching = true
        cachedProgress = 0
        cacheMessage = nil
        cacheTask = Task {
            var failed = 0
            var lastFailure = ""
            for chapter in chapters {
                if Task.isCancelled { break }
                do {
                    _ = try await store.content(for: chapter, in: book)
                    guard store.hasCachedContent(for: chapter, in: book) else {
                        throw AppError.message("章节已获取，但未能保存到本机。请检查可用储存空间。")
                    }
                    cachedProgress += 1
                } catch is CancellationError { break }
                catch {
                    if Task.isCancelled { break }
                    failed += 1
                    lastFailure = error.localizedDescription
                }
            }
            if Task.isCancelled {
                cacheMessage = "已停止。当前有 \(store.cachedCount(for: book)) 章可离线阅读。"
            } else if failed > 0 {
                cacheMessage = "完成 \(cachedProgress) 章，\(failed) 章未能下载：\(lastFailure)"
            } else {
                cacheMessage = "全书 \(chapters.count) 章已缓存，可以离线阅读。"
            }
            isCaching = false
        }
    }
}
