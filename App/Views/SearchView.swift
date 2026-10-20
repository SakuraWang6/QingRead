import SwiftUI
import ReadingCore

struct SearchView: View {
    var initialQuery: String? = nil
    @EnvironmentObject private var store: AppStore
    @State private var query = ""
    @State private var lastQuery = ""
    @State private var books: [Book] = []
    @State private var failures: [SourceFailure] = []
    @State private var isSearching = false
    @State private var hasSearched = false
    @State private var searchTask: Task<Void, Never>?
    @State private var requestID = UUID()
    @State private var wasCancelled = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeading(eyebrow: "FIND A STORY", title: "想读什么？", subtitle: "书名、作者，一次搜索已启用的书源。")
                HStack(spacing: 12) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Palette.secondary)
                    TextField("输入书名或作者", text: $query)
                        .submitLabel(.search).focused($searchFocused)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .onSubmit(startSearch)
                        .accessibilityLabel("书名或作者")
                    if !query.isEmpty {
                        Button { query = ""; searchFocused = true } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.secondary) }
                            .accessibilityLabel("清空搜索文字")
                    }
                    Button(action: startSearch) {
                        Image(systemName: "arrow.right").font(.system(size: 15, weight: .medium))
                            .frame(width: 33, height: 33).foregroundStyle(Palette.surface)
                            .background(Palette.ink, in: Circle())
                    }
                    .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.enabledSourceIDs.isEmpty)
                    .accessibilityLabel("开始搜索")
                }
                .padding(13).background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.rule, lineWidth: 0.5))

                if store.enabledSourceIDs.isEmpty {
                    InlineNotice(message: "尚未启用书源。请到「书源」开启至少一个来源后搜索。", isError: true)
                }
                if isSearching {
                    HStack(spacing: 12) {
                        ProgressView().tint(Palette.cinnabar)
                        Text("正在搜索「\(lastQuery)」…").font(.subheadline).foregroundStyle(Palette.secondary)
                        Spacer()
                        Button("取消") { searchTask?.cancel(); isSearching = false; wasCancelled = true }
                            .font(.subheadline)
                    }.padding(.vertical, 20)
                }
                if hasSearched && (!isSearching || !books.isEmpty || !failures.isEmpty) {
                    HStack {
                        Text("「\(lastQuery)」的搜索结果").font(.bookTitle(20)).foregroundStyle(Palette.ink)
                        Spacer()
                        Text("\(books.count) 本").font(.caption).foregroundStyle(Palette.secondary)
                    }.padding(.top, 8)
                    if books.isEmpty && !isSearching {
                        QuietEmptyState(symbol: "text.magnifyingglass", title: wasCancelled ? "搜索已取消" : (failures.isEmpty ? "暂时没有找到" : "这次没有搜到可读内容"), message: wasCancelled ? "可以换个关键词再试一次。" : (failures.isEmpty ? "试试更短的书名、作者名，\n或在「书源」导入其他来源。" : "下方列出了书源的实际错误。\n可以稍后重试，或更换书源。"))
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(books) { book in
                                NavigationLink { BookDetailView(book: book) } label: { BookRow(book: book) }
                                    .buttonStyle(.plain)
                                Divider().overlay(Palette.rule)
                            }
                        }
                    }
                    ForEach(failures) { failure in
                        InlineNotice(message: "\(failure.sourceName)：\(failure.message)", isError: true)
                    }
                    if !failures.isEmpty && !isSearching {
                        Button("重试搜索", action: startSearch).font(.subheadline)
                    }
                } else if !hasSearched {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("从一部经典开始").font(.bookTitle(21)).foregroundStyle(Palette.ink)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 94), alignment: .leading)], alignment: .leading, spacing: 10) {
                            ForEach(["西游记", "聊斋志异", "红楼梦"], id: \.self) { title in
                                Button { query = title; startSearch() } label: {
                                    Text(title).font(.subheadline).foregroundStyle(Palette.ink)
                                        .padding(.horizontal, 13).padding(.vertical, 10)
                                        .overlay(Capsule().stroke(Palette.rule, lineWidth: 1))
                                }.disabled(store.enabledSourceIDs.isEmpty)
                            }
                        }
                        Text("内置古典小说精选与中文维基文库，适合阅读经典作品。也可以到「书源」导入其他来源。")
                            .font(.footnote).foregroundStyle(Palette.secondary).lineSpacing(5)
                    }.padding(.top, 12)
                }
            }.padding(.horizontal, 22).padding(.bottom, 30)
        }
        .background(Palette.paper)
        .navigationTitle("搜书").navigationBarTitleDisplayMode(.inline)
        .task {
            if let initialQuery, !hasSearched { query = initialQuery; startSearch() }
        }
        .onDisappear { searchTask?.cancel(); isSearching = false }
    }

    private func startSearch() {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty, !store.enabledSourceIDs.isEmpty else { return }
        searchFocused = false
        searchTask?.cancel()
        let currentID = UUID()
        requestID = currentID
        lastQuery = term
        books = []
        failures = []
        isSearching = true
        hasSearched = true
        wasCancelled = false
        searchTask = Task {
            let response = await store.search(term) { response in
                guard requestID == currentID, isSearching else { return }
                books = response.books
                failures = response.failures
            }
            guard !Task.isCancelled, requestID == currentID else { return }
            books = response.books
            failures = response.failures
            isSearching = false
        }
    }
}
