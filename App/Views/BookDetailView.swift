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
    @State private var showDownload = false
    private var currentBook: Book { store.currentBook(book) }
    @State private var showsFullSummary = false

    @ViewBuilder var body: some View {
        if book.publicationFormat != nil { FileBookDetailView(book: currentBook) }
        else { webBookBody }
    }
    private var webBookBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 18) {
                    BookSpine(book: currentBook)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(book.title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.ink)
                        Text(book.author.isEmpty ? "作者未标注" : book.author).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                        Text(currentBook.sourceName).font(.system(size: 12)).foregroundStyle(Palette.secondary)
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
                        Label(store.position(for: currentBook) == nil ? "开始阅读" : "继续阅读", systemImage: "book")
                    }.buttonStyle(PrimaryButtonStyle()).disabled(chapters.isEmpty)
                    Button {
                        if store.isSaved(currentBook) { store.remove(currentBook) } else { store.add(currentBook) }
                    } label: {
                        Image(systemName: store.isSaved(currentBook) ? "bookmark.fill" : "bookmark")
                            .font(.system(size: 18)).foregroundStyle(Palette.cinnabar)
                            .frame(width: 52, height: 50)
                            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.rule, lineWidth: 0.5))
                    }.accessibilityLabel(store.isSaved(currentBook) ? "从书架移除并删除该书缓存" : "加入书架")
                }
                HStack {
                    Text("当前书源：\(currentBook.sourceName)").font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1)
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
                            Text("\(store.cachedCount(for: currentBook)) / \(chapters.count) 章")
                                .font(.caption.monospacedDigit()).foregroundStyle(Palette.secondary)
                        }
                        Button { showDownload = true } label: { Label("下载章节", systemImage: "arrow.down.circle") }
                        NavigationLink("下载管理") { DownloadManagerView() }
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 28)
        }
        .background(Palette.paper)
        .navigationTitle("书籍").navigationBarTitleDisplayMode(.inline)
        .task { await loadChapters() }
        .onChange(of: store.sourceFingerprint(currentBook)) { _ in Task { await loadChapters() } }
        .sheet(isPresented: $showDownload) { DownloadSelectionView(book: currentBook, chapters: chapters) }
        .refreshable { await loadChapters(refresh: true) }
        .fullScreenCover(isPresented: $showReader) { ReaderView(book: currentBook, initialChapterID: selectedChapterID) }
        .sheet(isPresented: $showOtherSources) { SourceSwitchView(book: currentBook, currentChapters: chapters) }
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
        do { chapters = try await store.chapters(for: currentBook, refresh: refresh) }
        catch is CancellationError { }
        catch { errorMessage = "目录获取失败：\(error.localizedDescription)" }
        isLoading = false
    }

}
