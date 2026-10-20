import SwiftUI
import ReadingCore

struct RecommendationsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var page: DiscoveryPage?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var retryVersion = 0
    @State private var requestID = UUID()

    private var isSourceEnabled: Bool { store.enabledSourceIDs.contains("biequgei") }
    private var loadKey: DiscoveryLoadKey {
        DiscoveryLoadKey(enabled: isSourceEnabled, selection: "", retryVersion: retryVersion)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if !isSourceEnabled {
                    DiscoverySourceDisabledView()
                } else {
                    if isLoading {
                        DiscoveryLoadingView(hasContent: page != nil)
                    }
                    if let errorMessage {
                        DiscoveryFailureView(message: errorMessage) { retryVersion += 1 }
                    }
                    if let page {
                        let sections = page.sections.filter { !$0.books.isEmpty }
                        if sections.isEmpty && !isLoading {
                            QuietEmptyState(symbol: "books.vertical", title: "暂无推荐书籍", message: "可以下拉刷新，或稍后再试。")
                        }
                        VStack(alignment: .leading, spacing: 36) {
                            ForEach(sections) { section in
                                VStack(alignment: .leading, spacing: 16) {
                                    Text(section.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
                                    DiscoveryBookGrid(books: section.books)
                                }
                            }
                        }
                    }
                    if page != nil {
                        DiscoverySourceFooter()
                    }
                }
            }
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 26)
        }
        .background(Palette.paper)
        .navigationTitle("推荐").navigationBarTitleDisplayMode(.inline)
        .task(id: loadKey) {
            if isSourceEnabled { await loadRecommendations() }
            else { clearContent() }
        }
        .refreshable {
            if isSourceEnabled { await loadRecommendations() }
        }
    }

    private func clearContent() {
        requestID = UUID()
        page = nil
        errorMessage = nil
        isLoading = false
    }

    private func loadRecommendations() async {
        guard isSourceEnabled else { clearContent(); return }
        let currentID = UUID()
        requestID = currentID
        isLoading = true
        errorMessage = nil
        defer { if requestID == currentID { isLoading = false } }
        do {
            let loaded = try await DiscoveryService().recommendations()
            try Task.checkCancellation()
            guard requestID == currentID, isSourceEnabled else { return }
            page = loaded
        } catch {
            guard requestID == currentID, isSourceEnabled, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}

struct CategoriesView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selectedCategory = DiscoveryCategory.all[0]
    @State private var books: [Book] = []
    @State private var loadedCategoryID: String?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var retryVersion = 0
    @State private var requestID = UUID()

    private var isSourceEnabled: Bool { store.enabledSourceIDs.contains("biequgei") }
    private var loadKey: DiscoveryLoadKey {
        DiscoveryLoadKey(enabled: isSourceEnabled, selection: selectedCategory.id, retryVersion: retryVersion)
    }

    var body: some View {
        VStack(spacing: 0) {
            if isSourceEnabled {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(DiscoveryCategory.all) { category in
                            Button {
                                selectedCategory = category
                            } label: {
                                Text(category.title).font(.system(size: 14, weight: selectedCategory.id == category.id ? .semibold : .regular))
                                    .foregroundStyle(selectedCategory.id == category.id ? Palette.cinnabar : Palette.secondary)
                                    .padding(.horizontal, 15).padding(.vertical, 10)
                                    .background(selectedCategory.id == category.id ? Palette.cinnabar.opacity(0.08) : Palette.rule.opacity(0.28), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selectedCategory.id == category.id ? .isSelected : [])
                        }
                    }.padding(.horizontal, 20).padding(.vertical, 12)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !isSourceEnabled {
                        DiscoverySourceDisabledView()
                    } else {
                        if isLoading {
                            DiscoveryLoadingView(hasContent: loadedCategoryID == selectedCategory.id && !books.isEmpty)
                        }
                        if let errorMessage {
                            DiscoveryFailureView(message: errorMessage) { retryVersion += 1 }
                        }
                        if loadedCategoryID == selectedCategory.id {
                            if books.isEmpty && !isLoading && errorMessage == nil {
                                QuietEmptyState(symbol: "books.vertical", title: "该分类暂无书籍", message: "可以切换分类，或下拉刷新。")
                            } else {
                                DiscoveryBookGrid(books: books)
                            }
                            DiscoverySourceFooter()
                        }
                    }
                }
                .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 26)
            }
            .refreshable {
                if isSourceEnabled { await loadCategory(selectedCategory) }
            }
        }
        .background(Palette.paper)
        .navigationTitle("分类").navigationBarTitleDisplayMode(.inline)
        .task(id: loadKey) {
            if isSourceEnabled { await loadCategory(selectedCategory) }
            else { clearContent() }
        }
    }

    private func clearContent() {
        requestID = UUID()
        books = []
        loadedCategoryID = nil
        errorMessage = nil
        isLoading = false
    }

    private func loadCategory(_ category: DiscoveryCategory) async {
        guard isSourceEnabled else { clearContent(); return }
        let currentID = UUID()
        requestID = currentID
        isLoading = true
        errorMessage = nil
        if loadedCategoryID != category.id { books = []; loadedCategoryID = nil }
        defer { if requestID == currentID { isLoading = false } }
        do {
            let loaded = try await DiscoveryService().category(category)
            try Task.checkCancellation()
            guard requestID == currentID, isSourceEnabled, selectedCategory.id == category.id else { return }
            books = loaded
            loadedCategoryID = category.id
        } catch {
            guard requestID == currentID, isSourceEnabled, selectedCategory.id == category.id, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct DiscoveryLoadKey: Hashable {
    let enabled: Bool
    let selection: String
    let retryVersion: Int
}

private struct DiscoveryBookGrid: View {
    let books: [Book]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 22) {
            ForEach(books) { book in
                NavigationLink { BookDetailView(book: book) } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        BookCoverView(book: book)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(book.title).font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Palette.ink).lineLimit(2, reservesSpace: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(book.author.isEmpty ? "作者未标注" : book.author)
                                .font(.system(size: 11)).foregroundStyle(Palette.secondary).lineLimit(1)
                        }.fixedSize(horizontal: false, vertical: true)
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(book.title)，\(book.author.isEmpty ? "作者未标注" : book.author)")
            }
        }
    }
}

private struct DiscoverySourceDisabledView: View {
    var body: some View {
        VStack(spacing: 0) {
            QuietEmptyState(symbol: "square.stack", title: "笔趣阁书源已停用", message: "开启该书源后，可以查看推荐和分类。")
            NavigationLink { SourcesView() } label: {
                Text("管理书源").font(.system(size: 14, weight: .medium))
                    .padding(.horizontal, 26).padding(.vertical, 11)
                    .foregroundStyle(.white).background(Palette.cinnabar, in: Capsule())
            }.buttonStyle(.plain)
        }.frame(maxWidth: .infinity).padding(.top, 28)
    }
}

private struct DiscoveryLoadingView: View {
    let hasContent: Bool

    var body: some View {
        HStack(spacing: 9) {
            ProgressView().tint(Palette.cinnabar)
            Text(hasContent ? "正在刷新…" : "正在加载…").font(.system(size: 13)).foregroundStyle(Palette.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, hasContent ? 6 : 54)
    }
}

private struct DiscoveryFailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            InlineNotice(message: "加载失败：\(message)", isError: true)
            Button("重新加载", action: retry).font(.system(size: 13)).foregroundStyle(Palette.cinnabar)
        }
    }
}

private struct DiscoverySourceFooter: View {
    var body: some View {
        Text("来源：笔趣阁").font(.system(size: 11)).foregroundStyle(Palette.secondary)
            .frame(maxWidth: .infinity).padding(.top, 6)
    }
}
