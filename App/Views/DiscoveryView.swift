import SwiftUI
import ReadingCore

struct NativeDiscoveryCategory: Decodable, Identifiable { let id: String; let title: String }
struct NativeDiscoverySection: Decodable, Identifiable { let id: String; let title: String; let books: [Book] }
struct NativeDiscoveryPage: Decodable { let sections: [NativeDiscoverySection] }
struct NativeAuthorPage: Decodable { let author: String; let books: [Book] }

struct RecommendationsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var sections: [NativeDiscoverySection] = []
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if let error { InlineNotice(message: error, isError: true); Button("重试") { Task { await load() } } }
                ForEach(sections) { section in
                    let books = section.books.filter { store.enabledSourceIDs.contains($0.sourceID) }
                    if !books.isEmpty {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(section.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
                            DiscoveryBookGrid(books: books)
                        }
                    }
                }
            }.padding(20)
        }.background(Palette.paper).navigationTitle("推荐").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard !loading else { return }; loading = true; error = nil
        defer { loading = false }
        do { sections = try await store.cloud.discoveryRecommendations().sections }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

struct CategoriesView: View {
    @EnvironmentObject private var store: AppStore
    @State private var categories: [NativeDiscoveryCategory] = []
    @State private var selected = "literature"
    @State private var books: [Book] = []
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(categories) { category in
                        Button { selected = category.id } label: {
                            Text(category.title).font(.system(size: 14)).foregroundStyle(selected == category.id ? Palette.cinnabar : Palette.secondary)
                                .padding(.horizontal, 15).padding(.vertical, 10)
                                .background(selected == category.id ? Palette.cinnabar.opacity(0.08) : Palette.rule.opacity(0.28), in: Capsule())
                        }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 12)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if loading { ProgressView().frame(maxWidth: .infinity) }
                    if let error { InlineNotice(message: error, isError: true); Button("重试") { Task { await loadBooks() } } }
                    DiscoveryBookGrid(books: books.filter { store.enabledSourceIDs.contains($0.sourceID) })
                }.padding(20)
            }.refreshable { await loadBooks() }
        }.background(Palette.paper).navigationTitle("分类").navigationBarTitleDisplayMode(.inline)
            .task {
                do { categories = try await store.cloud.discoveryCategories() }
                catch { self.error = error.localizedDescription }
            }
            .task(id: selected) { await loadBooks() }
    }
    private func loadBooks() async {
        let target = selected; loading = true; error = nil
        do {
            let values = try await store.cloud.discoveryCategory(target)
            try Task.checkCancellation()
            guard selected == target else { return }; books = values
        } catch is CancellationError { }
        catch { if selected == target { self.error = error.localizedDescription } }
        if selected == target { loading = false }
    }
}

struct AuthorBooksView: View {
    let author: String
    @EnvironmentObject private var store: AppStore
    @State private var books: [Book] = []
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if let error { InlineNotice(message: error, isError: true) }
                DiscoveryBookGrid(books: books.filter { store.enabledSourceIDs.contains($0.sourceID) })
                if !loading && books.isEmpty && error == nil { Text("暂无其他作品").foregroundStyle(Palette.secondary) }
            }.padding(20)
        }.navigationTitle(author).navigationBarTitleDisplayMode(.inline).background(Palette.paper)
            .task {
                do { books = try await store.cloud.discoveryAuthor(author).books }
                catch { self.error = error.localizedDescription }
                loading = false
            }
    }
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
                        Text(book.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.ink).lineLimit(2, reservesSpace: true).frame(maxWidth: .infinity, alignment: .leading)
                        Text(book.author).font(.system(size: 11)).foregroundStyle(Palette.secondary).lineLimit(1)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }
    }
}
