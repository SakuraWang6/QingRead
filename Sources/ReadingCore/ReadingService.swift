import Foundation

public actor ReadingService {
    private let sources: [SourceDefinition]
    private let fetcher: PageFetcher

    public init(sources: [SourceDefinition] = SourceDefinition.builtIn, client: any HTTPClient = URLSessionHTTPClient()) {
        self.sources = sources
        self.fetcher = PageFetcher(client: client)
    }

    /// A bad or unreachable source never discards successful results from other sources.
    /// Search cancellation returns no results; thrown catalog/content operations propagate cancellation.
    public func search(query: String, enabledSourceIDs: Set<String>? = nil, onUpdate: @Sendable (SearchResponse) async -> Void = { _ in }) async -> SearchResponse {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, !Task.isCancelled else { return SearchResponse(books: [], failures: []) }
        let enabled = sources.filter { enabledSourceIDs?.contains($0.id) ?? true }
        let fetcher = self.fetcher
        return await withTaskGroup(of: (Int, [Book], SourceFailure?).self) { group in
            for (index, source) in enabled.enumerated() {
                group.addTask {
                    do {
                        try SourceImporter.validate(source)
                        let books: [Book]
                        switch source.kind {
                        case .staticCatalog:
                            books = StaticCatalogSource(source: source, fetcher: fetcher).search(query: query)
                        case .mediaWiki:
                            books = try await MediaWikiSource(source: source, fetcher: fetcher).search(query: query)
                        case .html:
                            guard let config = source.html else { throw ReadingError.invalidSource("缺少 html 配置。") }
                            let url = try SourceURL.search(query: query, source: source, config: config)
                            let (data, response) = try await fetcher.data(at: url)
                            books = try HTMLParsing.search(HTMLParsing.decode(data, encoding: config.encoding), baseURL: response.url ?? url, source: source, config: config)
                        }
                        return (index, books, nil)
                    } catch {
                        if error is CancellationError || Task.isCancelled { return (index, [], nil) }
                        return (index, [], SourceFailure(sourceID: source.id, sourceName: source.name, message: error.localizedDescription))
                    }
                }
            }
            var results: [(Int, [Book], SourceFailure?)] = []
            func snapshot() -> SearchResponse {
                let ordered = results.sorted { $0.0 < $1.0 }
                var seen = Set<String>()
                let books = ordered.flatMap { $0.1 }.filter { seen.insert($0.id).inserted }
                return SearchResponse(books: books, failures: ordered.compactMap { $0.2 })
            }
            for await result in group {
                guard !Task.isCancelled else { group.cancelAll(); break }
                results.append(result)
                await onUpdate(snapshot())
            }
            guard !Task.isCancelled else { return SearchResponse(books: [], failures: []) }
            return snapshot()
        }
    }

    public func chapters(for book: Book) async throws -> [Chapter] {
        let source = try source(for: book)
        switch source.kind {
        case .staticCatalog: return try await StaticCatalogSource(source: source, fetcher: fetcher).chapters(for: book)
        case .mediaWiki: return try await MediaWikiSource(source: source, fetcher: fetcher).chapters(for: book)
        case .html:
            guard let config = source.html else { throw ReadingError.invalidSource("缺少 html 配置。") }
            let (data, response) = try await fetcher.data(at: book.url)
            let html = try HTMLParsing.decode(data, encoding: config.encoding)
            let baseURL = response.url ?? book.url
            if let catalogURL = try HTMLParsing.catalogURL(html, baseURL: baseURL, selector: config.catalogLinkSelector), catalogURL != baseURL {
                let (catalogData, catalogResponse) = try await fetcher.data(at: catalogURL)
                return try HTMLParsing.chapters(HTMLParsing.decode(catalogData, encoding: config.encoding), baseURL: catalogResponse.url ?? catalogURL, config: config)
            }
            return try HTMLParsing.chapters(html, baseURL: baseURL, config: config)
        }
    }

    public func content(for chapter: Chapter, in book: Book) async throws -> ChapterContent {
        let source = try source(for: book)
        switch source.kind {
        case .staticCatalog: return try await StaticCatalogSource(source: source, fetcher: fetcher).content(for: chapter)
        case .mediaWiki: return try await MediaWikiSource(source: source, fetcher: fetcher).content(for: chapter)
        case .html:
            guard let config = source.html else { throw ReadingError.invalidSource("缺少 html 配置。") }
            let (data, _) = try await fetcher.data(at: chapter.url)
            let html = try HTMLParsing.decode(data, encoding: config.encoding)
            return try ChapterContent(chapter: chapter, paragraphs: HTMLParsing.content(html, selector: config.contentSelector, removing: config.removeSelectors))
        }
    }

    private func source(for book: Book) throws -> SourceDefinition {
        guard let source = sources.first(where: { $0.id == book.sourceID }) else {
            throw ReadingError.sourceUnavailable(book.sourceID)
        }
        try SourceImporter.validate(source)
        return source
    }
}
