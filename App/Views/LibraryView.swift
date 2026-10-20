import SwiftUI
import ReadingCore

struct LibraryView: View {
    @EnvironmentObject private var store: AppStore
    @State private var readingBook: Book?
    @State private var detailBook: Book?
    @State private var removingBook: Book?
    @State private var isManaging = false

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: 3)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("全部 \(store.shelf.count)").font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.ink)
                    Spacer()
                    Button(isManaging ? "完成" : "管理") { isManaging.toggle() }
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
                        ForEach(store.sortedShelf) { entry in shelfCell(entry) }
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 28)
        }
        .background(Palette.paper)
        .navigationTitle("书架").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                NavigationLink { SearchView() } label: { Image(systemName: "magnifyingglass").foregroundStyle(Palette.ink) }
                    .accessibilityLabel("搜索小说")
                PublicationImportButton(iconOnly: true) { readingBook = $0 }
                Menu {
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
        } message: { Text("该书的阅读进度与离线缓存也会移除。") }
    }

    private func shelfCell(_ entry: ShelfEntry) -> some View {
        ZStack(alignment: .topTrailing) {
            Button {
                if isManaging { detailBook = entry.book } else { readingBook = entry.book }
            } label: {
                VStack(alignment: .leading, spacing: 7) {
                    BookCoverView(book: entry.book)
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
                Button { removingBook = entry.book } label: {
                    Image(systemName: "minus.circle.fill").font(.system(size: 23))
                        .symbolRenderingMode(.palette).foregroundStyle(.white, Palette.cinnabar)
                        .padding(6)
                }.accessibilityLabel("移除 \(entry.book.title)")
            }
        }
        .contextMenu {
            Button { readingBook = entry.book } label: { Label("继续阅读", systemImage: "book") }
            Button { detailBook = entry.book } label: { Label("书籍详情", systemImage: "info.circle") }
            Button(role: .destructive) { removingBook = entry.book } label: { Label("移出书架", systemImage: "trash") }
        }
    }

    private func progressLabel(_ entry: ShelfEntry) -> String {
        guard let position = entry.position else { return "未读" }
        return "读至\(position.chapterIndex + 1)章 · \(Int(position.chapterFraction * 100))%"
    }
}
