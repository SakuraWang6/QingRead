import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol HTTPClient: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public final class URLSessionHTTPClient: HTTPClient, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session { self.session = session }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 15
            configuration.timeoutIntervalForResource = 25
            configuration.httpMaximumConnectionsPerHost = 4
            self.session = URLSession(configuration: configuration)
        }
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ReadingError.invalidResponse }
        return (data, http)
    }
}

struct PageFetcher: Sendable {
    let client: any HTTPClient

    func data(at url: URL) async throws -> (Data, HTTPURLResponse) {
        try Task.checkCancellation()
        guard url.isHTTP else { throw ReadingError.invalidURL(url.absoluteString) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("QingRead/0.1 (personal open-source reader)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json,text/html;q=0.9,*/*;q=0.5", forHTTPHeaderField: "Accept")
        let result = try await client.data(for: request)
        try Task.checkCancellation()
        guard (200...299).contains(result.1.statusCode) else { throw ReadingError.httpStatus(result.1.statusCode) }
        guard result.0.count <= 12 * 1_024 * 1_024 else {
            throw ReadingError.parsingFailed("网页超过 12 MB，已停止加载。")
        }
        return result
    }
}
