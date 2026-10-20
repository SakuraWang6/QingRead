import SwiftUI
import ReadingCore

struct LibraryView: View {
    @EnvironmentObject private var store: AppStore
    @State private var readingBook: Book?

    var body: some View {
        List {
            PageHeading(eyebrow: "QING READ · 私人书房", title: "把时间，留给好书。", subtitle: "没有广告，翻开就读。")
                .listRowSeparator(.hidden)
            if let message = store.storageMessage {
                InlineNotice(message: message, isError: true).listRowSeparator(.hidden)
            }
            if let recent = store.recentEntry {
                continueReading(recent).listRowSeparator(.hidden)
            }
            HStack {
                Text("我的书架").font(.bookTitle(22)).foregroundStyle(Palette.ink)
                Spacer()
                Text("\(store.shelf.count) 本").font(.caption.monospacedDigit()).foregroundStyle(Palette.secondary)
            }.padding(.top, 18).listRowSeparator(.hidden)

            if store.shelf.isEmpty {
                VStack(spacing: 0) {
                    QuietEmptyState(symbol: "book.closed", title: "书架还空着", message: "到「搜书」输入书名或作者，\n找到喜欢的书后加入书架。")
                    Button { readingBook = LocalSample.book } label: {
                        Label("先读一篇《桃花源记》", systemImage: "book")
                    }.buttonStyle(PrimaryButtonStyle())
                    Text("本地公版示例 · 无需联网").font(.caption).foregroundStyle(Palette.secondary).padding(.top, 10)
                }.padding(.bottom, 24).listRowSeparator(.hidden)
            } else {
                ForEach(store.sortedShelf) { entry in
                    NavigationLink {
                        BookDetailView(book: entry.book)
                    } label: {
                        BookRow(book: entry.book, annotation: progressLabel(entry))
                    }
                    .listRowSeparator(.visible)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { store.remove(entry.book) } label: { Label("移除", systemImage: "trash") }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Palette.paper)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Text("清 读").font(.bookTitle(18)).foregroundStyle(Palette.ink)
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button { readingBook = LocalSample.book } label: { Label("阅读本地公版示例", systemImage: "leaf") }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(Palette.ink)
                }.accessibilityLabel("书架选项")
            }
        }
        .fullScreenCover(item: $readingBook) { book in ReaderView(book: book) }
    }

    private func continueReading(_ entry: ShelfEntry) -> some View {
        Button { readingBook = entry.book } label: {
            HStack(alignment: .center, spacing: 20) {
                BookSpine(book: entry.book)
                VStack(alignment: .leading, spacing: 12) {
                    Text("继续阅读").font(.caption).tracking(3).foregroundStyle(Palette.cinnabar)
                    Text(entry.book.title).font(.bookTitle(25)).foregroundStyle(Palette.ink).lineLimit(3)
                    Text(progressLabel(entry)).font(.caption).foregroundStyle(Palette.secondary)
                    HStack(spacing: 6) {
                        Text("翻开下一页")
                        Image(systemName: "arrow.right")
                    }.font(.subheadline).foregroundStyle(Palette.ink).padding(.top, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.rule, lineWidth: 0.5))
        }.buttonStyle(.plain)
    }

    private func progressLabel(_ entry: ShelfEntry) -> String {
        guard let position = entry.position else { return "尚未开始 · \(entry.book.sourceName)" }
        return "第 \(position.chapterIndex + 1) 章 · 章内 \(Int(position.chapterFraction * 100))%"
    }
}
