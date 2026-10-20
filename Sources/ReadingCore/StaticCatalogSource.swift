import Foundation

struct StaticCatalogSource: Sendable {
    let source: SourceDefinition
    let fetcher: PageFetcher

    func search(query: String) -> [Book] {
        let normalizedQuery = normalize(query)
        return source.catalogBooks.filter {
            normalize($0.title).contains(normalizedQuery) || normalize($0.author).contains(normalizedQuery)
        }.map {
            Book(title: $0.title, author: $0.author, summary: $0.summary,
                 sourceID: source.id, sourceName: source.name, url: $0.directoryURL)
        }
    }

    func chapters(for book: Book) async throws -> [Chapter] {
        // This source's public file format uses zero-based N.html files and info.json metadata.
        let url = try SourceURL.resolve("info.json", relativeTo: book.url)
        let (data, _) = try await fetcher.data(at: url)
        let catalog = try JSONDecoder().decode(Catalog.self, from: data)
        guard !catalog.catalogues.isEmpty else { throw ReadingError.parsingFailed("静态目录为空。") }
        return try catalog.catalogues.enumerated().map { index, title in
            Chapter(title: title, url: try SourceURL.resolve("\(index).html", relativeTo: book.url), index: index)
        }
    }

    func content(for chapter: Chapter) async throws -> ChapterContent {
        let (data, _) = try await fetcher.data(at: chapter.url)
        let html = try HTMLParsing.decode(data, encoding: .utf8)
        return try ChapterContent(chapter: chapter, paragraphs: HTMLParsing.content(html, selector: "body"))
    }

    private func normalize(_ value: String) -> String {
        (value.applyingTransform(StringTransform("Traditional-Simplified"), reverse: false) ?? value)
            .lowercased().filter { !$0.isWhitespace && !"《》〈〉".contains($0) }
    }

    private struct Catalog: Decodable { let catalogues: [String] }
}
