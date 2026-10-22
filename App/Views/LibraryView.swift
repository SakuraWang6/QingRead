import SwiftUI
import ReadingCore

struct LibraryView: View {
    @EnvironmentObject private var store: AppStore
    @State private var readingBook: Book?
    @State private var detailBook: Book?
    @State private var removingBook: Book?
    @State private var isManaging = false
    @State private var selectedIDs: Set<String> = []
    @State private var statusFilter = "all"
    @State private var groupFilter = "all"
    @State private var groupName = ""
    @State private var groupingIDs: Set<String> = []
    @State private var showGroupName = false
    @State private var confirmBatchRemoval = false
    private var filteredShelf: [ShelfEntry] {
        store.sortedShelf.filter { entry in
            (statusFilter == "all" || (entry.organization?.status.rawValue ?? "reading") == statusFilter)
                && (groupFilter == "all" || (entry.organization?.group ?? "") == groupFilter)
        }
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: 3)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Menu {
                        Button("全部") { statusFilter = "all" }
                        ForEach(ShelfReadingStatus.allCases, id: \.self) { status in Button(statusName(status)) { statusFilter = status.rawValue } }
                    } label: { HStack(spacing: 4) { Text(statusFilter == "all" ? "全部 \(store.shelf.count)" : statusName(ShelfReadingStatus(rawValue: statusFilter) ?? .reading)); Image(systemName: "chevron.down").font(.caption2) }.font(.system(size: 14)).foregroundStyle(Palette.ink) }
                    Menu {
                        Button("全部分组") { groupFilter = "all" }
                        Button("未分组") { groupFilter = "" }
                        ForEach(store.shelfGroups, id: \.self) { group in Button(group) { groupFilter = group } }
                    } label: { Text(groupFilter == "all" ? "分组" : groupFilter.isEmpty ? "未分组" : groupFilter).font(.system(size: 13)).foregroundStyle(Palette.secondary) }
                    Spacer()
                    Button(isManaging ? "完成" : "管理") { isManaging.toggle(); selectedIDs = [] }
                        .font(.system(size: 14)).foregroundStyle(isManaging ? Palette.cinnabar : Palette.secondary)
                        .disabled(store.shelf.isEmpty)
                }.padding(.top, 10)

                if let message = store.storageMessage { InlineNotice(message: message, isError: true) }

                if let recent = store.recentEntry, !isManaging {
                    Button { readingBook = recent.book } label: {
                        HStack(spacing: 8) {
                            Text("继续阅读").font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.cinnabar)
                            Text(recent.book.title).font(.system(size: 13)).foregroundStyle(Palette.ink).lineLimit(1)
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.secondary)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .background(Palette.cinnabar.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))
                    }.buttonStyle(.plain)
                }

                if store.shelf.isEmpty {
                    VStack(spacing: 0) {
                        QuietEmptyState(symbol: "books.vertical", title: "书架暂无书籍", message: "搜索小说后，可以加入书架。")
                        NavigationLink { SearchView() } label: {
                            Text("去搜书").font(.system(size: 14, weight: .medium))
                                .padding(.horizontal, 28).padding(.vertical, 11)
                                .foregroundStyle(.white).background(Palette.cinnabar, in: Capsule())
                        }.buttonStyle(.plain)
                    }.frame(maxWidth: .infinity).padding(.top, 45)
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 22) {
                        ForEach(filteredShelf) { entry in shelfCell(entry) }
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 28)
        }
        .background(Palette.paper)
        .refreshable { await store.checkShelfUpdates(force: true) }
        .task { await store.checkShelfUpdates() }
        .safeAreaInset(edge: .bottom) { if isManaging { batchControls } }
        .onChange(of: store.profileRevision) { _ in selectedIDs = []; isManaging = false; readingBook = nil; detailBook = nil; showGroupName = false; confirmBatchRemoval = false }
        .alert("新建分组", isPresented: $showGroupName) {
            TextField("分组名称", text: $groupName)
            Button("保存") { store.organizeBooks(groupingIDs, group: groupName); groupName = "" }
            Button("取消", role: .cancel) { groupName = "" }
        }
        .confirmationDialog("移除所选 \(selectedIDs.count) 本书？", isPresented: $confirmBatchRemoval, titleVisibility: .visible) {
            Button("移除", role: .destructive) {
                for entry in store.shelf where selectedIDs.contains(entry.id) { store.remove(entry.book) }
                selectedIDs = []
            }
        }
        .navigationTitle("书架").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                NavigationLink { SearchView() } label: { Image(systemName: "magnifyingglass").foregroundStyle(Palette.ink) }
                    .accessibilityLabel("搜索小说")
                PublicationImportButton(iconOnly: true) { readingBook = $0 }
                Menu {
                    Button { Task { await store.checkShelfUpdates(force: true) } } label: { Label(store.checkingUpdates ? "检查中…" : "检查更新", systemImage: "arrow.clockwise") }
                        .disabled(store.checkingUpdates)
                    NavigationLink { DownloadManagerView() } label: { Label("下载管理", systemImage: "arrow.down.circle") }
                    Button { readingBook = LocalSample.book } label: { Label("本地阅读示例", systemImage: "doc.text") }
                    if !store.shelf.isEmpty {
                        Button { isManaging.toggle() } label: { Label(isManaging ? "完成管理" : "管理书架", systemImage: "square.grid.3x3") }
                    }
                } label: {
                    Image(systemName: "ellipsis").foregroundStyle(Palette.ink)
                }.accessibilityLabel("书架选项")
            }
        }
        .navigationDestination(isPresented: Binding(get: { detailBook != nil }, set: { if !$0 { detailBook = nil } })) {
            if let detailBook { BookDetailView(book: detailBook) }
        }
        .fullScreenCover(item: $readingBook) { book in BookReadingView(book: book) }
        .confirmationDialog("从书架移除这本书？", isPresented: Binding(get: { removingBook != nil }, set: { if !$0 { removingBook = nil } }), titleVisibility: .visible) {
            Button("移除书籍", role: .destructive) {
                if let removingBook { store.remove(removingBook) }
                removingBook = nil
                if store.shelf.isEmpty { isManaging = false }
            }
            Button("取消", role: .cancel) { removingBook = nil }
        } message: { Text("阅读进度、离线缓存和云端文件也会删除。") }
    }

    private func shelfCell(_ entry: ShelfEntry) -> some View {
        ZStack(alignment: .topTrailing) {
            Button {
                if isManaging {
                    if selectedIDs.contains(entry.id) { selectedIDs.remove(entry.id) } else { selectedIDs.insert(entry.id) }
                } else { readingBook = entry.book }
            } label: {
                VStack(alignment: .leading, spacing: 7) {
                    BookCoverView(book: entry.book)
                        .overlay(alignment: .topTrailing) {
                            if store.newChapterCount(for: entry.book) > 0 && !isManaging {
                                Text("更新 \(store.newChapterCount(for: entry.book)) 章")
                                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.white)
                                    .padding(.horizontal, 6).padding(.vertical, 4)
                                    .background(Palette.cinnabar, in: RoundedRectangle(cornerRadius: 4)).padding(4)
                            }
                        }
                    Text(entry.book.title).font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Palette.ink).lineLimit(2, reservesSpace: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(progressLabel(entry)).font(.system(size: 11)).foregroundStyle(Palette.secondary).lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(isManaging ? "查看详情" : "阅读") \(entry.book.title)，\(progressLabel(entry))")
            if isManaging {
                Image(systemName: selectedIDs.contains(entry.id) ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 24)).foregroundStyle(selectedIDs.contains(entry.id) ? Palette.cinnabar : Palette.secondary)
                    .background(.white, in: Circle()).padding(6).allowsHitTesting(false)
            } else if entry.organization?.pinned == true {
                Image(systemName: "pin.fill").font(.caption).foregroundStyle(Palette.cinnabar).padding(6).background(.white.opacity(0.9), in: Circle()).padding(3).allowsHitTesting(false)
            }
        }
        .contextMenu {
            Button { readingBook = entry.book } label: { Label("继续阅读", systemImage: "book") }
            Button(entry.organization?.pinned == true ? "取消置顶" : "置顶") { store.organizeBooks([entry.id], pinned: entry.organization?.pinned != true) }
            Menu("阅读状态") { ForEach(ShelfReadingStatus.allCases, id: \.self) { status in Button(statusName(status)) { store.organizeBooks([entry.id], status: status) } } }
            Menu("移到分组") {
                Button("未分组") { store.organizeBooks([entry.id], group: "") }
                ForEach(store.shelfGroups, id: \.self) { group in Button(group) { store.organizeBooks([entry.id], group: group) } }
                Button("新建分组") { groupingIDs = [entry.id]; showGroupName = true }
            }
            Button { detailBook = entry.book } label: { Label("书籍详情", systemImage: "info.circle") }
            Button(role: .destructive) { removingBook = entry.book } label: { Label("移出书架", systemImage: "trash") }
        }
    }

    private func progressLabel(_ entry: ShelfEntry) -> String {
        if entry.organization?.status == .finished { return "已读完" }
        if entry.organization?.status == .later { return "待读" }
        guard let position = entry.position else { return "未读" }
        return "读至\(position.chapterIndex + 1)章 · \(Int(position.chapterFraction * 100))%"
    }
    private func statusName(_ value: ShelfReadingStatus) -> String {
        switch value { case .reading: return "在读"; case .later: return "待读"; case .finished: return "读完" }
    }
    private var batchControls: some View {
        HStack(spacing: 18) {
            Button(selectedIDs.count == filteredShelf.count && !filteredShelf.isEmpty ? "取消全选" : "全选") { selectedIDs = selectedIDs.count == filteredShelf.count ? [] : Set(filteredShelf.map(\.id)) }
            Text("\(selectedIDs.count)").monospacedDigit().foregroundStyle(Palette.secondary)
            Spacer()
            Menu("状态") { ForEach(ShelfReadingStatus.allCases, id: \.self) { status in Button(statusName(status)) { store.organizeBooks(selectedIDs, status: status) } } }.disabled(selectedIDs.isEmpty)
            Menu("分组") {
                Button("未分组") { store.organizeBooks(selectedIDs, group: "") }
                ForEach(store.shelfGroups, id: \.self) { group in Button(group) { store.organizeBooks(selectedIDs, group: group) } }
                Button("新建分组") { groupingIDs = selectedIDs; showGroupName = true }
            }.disabled(selectedIDs.isEmpty)
            Button("移除", role: .destructive) { confirmBatchRemoval = true }.disabled(selectedIDs.isEmpty)
        }.font(.system(size: 13)).padding(.horizontal, 20).padding(.vertical, 16).background(Palette.paper)
    }

}
