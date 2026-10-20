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
    @State private var scope: SearchScope = .all
    @State private var showFailures = false
    @FocusState private var searchFocused: Bool

    private enum SearchScope: String, CaseIterable, Identifiable {
        case all = "全部", title = "书名", author = "作者"
        var id: String { rawValue }
    }

    private var visibleBooks: [Book] {
        guard scope != .all else { return books }
        let term = lastQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return books.filter {
            let field = scope == .title ? $0.title : $0.author
            return field.localizedStandardContains(term)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if store.enabledSourceIDs.isEmpty {
                        InlineNotice(message: "请先到「书源」启用至少一个来源。", isError: true)
                    }
                    if hasSearched {
                        Picker("搜索范围", selection: $scope) {
                            ForEach(SearchScope.allCases) { item in Text(item.rawValue).tag(item) }
                        }.pickerStyle(.segmented).padding(.top, 4)

                        HStack(spacing: 8) {
                            Text("搜索结果").font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.ink)
                            Text("\(visibleBooks.count)").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                            Spacer()
                            if isSearching {
                                ProgressView().scaleEffect(0.7).tint(Palette.cinnabar)
                                Text("搜索中").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                            }
                        }.padding(.top, 6)

                        if visibleBooks.isEmpty && !isSearching {
                            QuietEmptyState(symbol: "magnifyingglass",
                                            title: wasCancelled ? "搜索已取消" : "未找到相关书籍",
                                            message: wasCancelled ? "输入书名或作者重新搜索。" : (scope == .all ? "试试其他书名或作者，也可以更换书源。" : "当前筛选没有结果，可切换「全部」查看。"))
                        }
                        LazyVStack(spacing: 0) {
                            ForEach(visibleBooks) { book in
                                NavigationLink { BookDetailView(book: book) } label: { BookRow(book: book) }
                                    .buttonStyle(.plain)
                                Divider().overlay(Palette.rule)
                            }
                        }
                        if !failures.isEmpty {
                            DisclosureGroup(isExpanded: $showFailures) {
                                VStack(alignment: .leading, spacing: 10) {
                                    ForEach(failures) { failure in
                                        Text("\(failure.sourceName)：\(failure.message)")
                                            .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .textSelection(.enabled)
                                    }
                                    if !isSearching { Button("重新搜索", action: startSearch).font(.system(size: 13)) }
                                }.padding(.top, 10)
                            } label: {
                                Label("\(failures.count) 个书源暂不可用", systemImage: "exclamationmark.circle")
                                    .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                            }.tint(Palette.secondary).padding(.top, 8)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("快捷搜索").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.ink)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: 10) {
                                ForEach(["超神机械师", "这游戏也太真实了", "西游记"], id: \.self) { title in
                                    Button { query = title; startSearch() } label: {
                                        Text(title).font(.system(size: 13)).foregroundStyle(Palette.ink)
                                            .lineLimit(1)
                                            .padding(.horizontal, 12).padding(.vertical, 9)
                                            .background(Palette.rule.opacity(0.45), in: Capsule())
                                    }.buttonStyle(.plain).disabled(store.enabledSourceIDs.isEmpty)
                                }
                            }
                        }.padding(.top, 18)
                    }
                }.padding(.horizontal, 18).padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Palette.paper)
        .navigationTitle("搜书").navigationBarTitleDisplayMode(.inline)
        .task {
            if let initialQuery, !hasSearched { query = initialQuery; startSearch() }
        }
        .onDisappear { searchTask?.cancel(); isSearching = false }
    }

    private var searchBar: some View {
        HStack(spacing: 13) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(Palette.secondary)
                TextField("书名 / 作者", text: $query)
                    .font(.system(size: 15)).submitLabel(.search).focused($searchFocused)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .onSubmit(startSearch)
                    .accessibilityLabel("书名或作者")
                if !query.isEmpty {
                    Button { query = ""; searchFocused = true } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Palette.secondary.opacity(0.7))
                    }.accessibilityLabel("清空搜索文字")
                }
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(Palette.rule.opacity(0.45), in: Capsule())
            Button {
                if isSearching { cancelSearch() } else { startSearch() }
            } label: {
                Text(isSearching ? "取消" : "搜索").font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.cinnabar).frame(minWidth: 34)
            }
            .disabled(!isSearching && (query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.enabledSourceIDs.isEmpty))
        }.padding(.horizontal, 18).padding(.vertical, 10)
    }

    private func cancelSearch() {
        searchTask?.cancel()
        isSearching = false
        wasCancelled = true
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
        showFailures = false
        scope = .all
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
            showFailures = books.isEmpty && !failures.isEmpty
        }
    }
}
