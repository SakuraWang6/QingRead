import UIKit
import ImageIO
import CryptoKit
import ReadingCore

/// Artwork is kept independently of the chapter cache. Navigation and a fresh
/// launch reuse a small local thumbnail instead of re-fetching a full-size image.
@MainActor
final class BookCoverCache {
    static let shared = BookCoverCache()
    private let images = NSCache<NSString, UIImage>()
    private let loader: CoverDataLoader
    private var pending: [String: Task<UIImage?, Never>] = [:]
    private var failedUntil: [String: Date] = [:]

    init(root: URL? = nil, session: URLSession? = nil) {
        loader = CoverDataLoader(root: root, session: session)
        images.totalCostLimit = 24 * 1_024 * 1_024
    }

    func cachedImage(for book: Book) -> UIImage? { images.object(forKey: key(book) as NSString) }

    func image(for book: Book, sources: [SourceDefinition]) async -> UIImage? {
        let key = key(book)
        if let image = images.object(forKey: key as NSString) { return image }
        if let pending = pending[key] { return await pending.value }
        if let expiry = failedUntil[key], expiry > Date() { return nil }
        let task = Task { [loader] in
            guard let data = await loader.data(for: book, key: key, sources: sources), let image = UIImage(data: data) else { return nil as UIImage? }
            return image
        }
        pending[key] = task
        let image = await task.value
        pending.removeValue(forKey: key)
        if let image {
            images.setObject(image, forKey: key as NSString, cost: Int(image.size.width * image.size.height * 4))
            failedUntil.removeValue(forKey: key)
        } else { failedUntil[key] = Date().addingTimeInterval(60) }
        return image
    }

    private func key(_ book: Book) -> String {
        SHA256.hash(data: Data((book.id + "|" + (book.coverURL?.absoluteString ?? "detail")).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}

private actor CoverDataLoader {
    private let root: URL
    private let session: URLSession
    private let slots = CoverDownloadSlots(limit: 3)
    private var writes = 0

    init(root: URL? = nil, session: URLSession? = nil) {
        self.root = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("QingReadCovers", isDirectory: true)
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 15
        configuration.httpMaximumConnectionsPerHost = 3
        configuration.urlCache = URLCache(memoryCapacity: 8 * 1_024 * 1_024, diskCapacity: 32 * 1_024 * 1_024)
        self.session = session ?? URLSession(configuration: configuration)
    }

    func data(for book: Book, key: String, sources: [SourceDefinition]) async -> Data? {
        let destination = root.appendingPathComponent(key + ".jpg")
        if let data = try? Data(contentsOf: destination), Self.thumbnail(data) != nil {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: destination.path)
            return data
        }
        await slots.enter()
        let result = await fetch(book, sources: sources)
        await slots.leave()
        guard let result else { return nil }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try result.write(to: destination, options: .atomic)
            writes += 1
            if writes == 1 || writes % 12 == 0 { pruneDiskCache() }
        } catch { /* An unwritable cache must not hide successfully loaded artwork. */ }
        return result
    }

    private func fetch(_ book: Book, sources: [SourceDefinition]) async -> Data? {
        if let url = book.coverURL, let data = await download(url, referer: book.url) { return data }
        guard let detailCover = try? await ReadingService(sources: sources).coverURL(for: book),
              detailCover != book.coverURL else { return nil }
        return await download(detailCover, referer: book.url)
    }

    private func download(_ url: URL, referer: URL) async -> Data? {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        var request = URLRequest(url: url)
        request.setValue(referer.absoluteString, forHTTPHeaderField: "Referer")
        request.setValue("image/avif,image/webp,image/*;q=0.9,*/*;q=0.5", forHTTPHeaderField: "Accept")
        request.setValue("QingRead/0.3", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  data.count <= 8 * 1_024 * 1_024 else { return nil }
            return Self.thumbnail(data)
        } catch { return nil }
    }

    /// ImageIO decodes at display resolution, keeping giant source images out of
    /// the scrolling grid's main-thread decode path and memory cache.
    static func thumbnail(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 480,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary), image.width > 1, image.height > 1 else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.84)
    }

    private func pruneDiskCache() {
        let urls = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? []
        let files = urls.compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var size = files.reduce(0) { $0 + $1.1 }
        for file in files where size > 64 * 1_024 * 1_024 {
            if (try? FileManager.default.removeItem(at: file.0)) != nil { size -= file.1 }
        }
    }
}

private actor CoverDownloadSlots {
    let limit: Int
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(limit: Int) { self.limit = limit }
    func enter() async {
        if active < limit { active += 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func leave() {
        if waiters.isEmpty { active -= 1 } else { waiters.removeFirst().resume() }
    }
}
