#if DEBUG
import UIKit
import ReadingCore

@MainActor enum CoverDiagnostics {
    static func run() async {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("QingRead-cover-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoverDiagnosticProtocol.self]
        let session = URLSession(configuration: configuration)
        let book = Book(id: "cover-diagnostic", title: "封面缓存", coverURL: URL(string: "https://covers.example/cover.jpg"), sourceID: "diagnostic", sourceName: "诊断", url: URL(string: "https://covers.example/book/1")!)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 900))
        let image = renderer.image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 600, height: 900))
        }
        CoverDiagnosticProtocol.configure(data: image.jpegData(compressionQuality: 0.9)!)
        let first = BookCoverCache(root: root, session: session)
        let firstImage = await first.image(for: book, sources: [])
        let secondImage = await first.image(for: book, sources: [])
        assert(firstImage != nil && secondImage != nil)
        assert(max(firstImage!.size.width, firstImage!.size.height) <= 480)
        let reopened = BookCoverCache(root: root, session: session)
        let diskImage = await reopened.image(for: book, sources: [])
        assert(diskImage != nil)
        assert(CoverDiagnosticProtocol.snapshot() == (1, book.url.absoluteString), "Fresh cache instances must reuse disk without fetching artwork")
        print("QINGREAD_COVER_SELFTEST memory=passed disk=passed thumbnail480=passed referer=passed requests=1")
    }
}

private final class CoverDiagnosticProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var data = Data()
    private static var requests = 0
    private static var referer = ""
    static func configure(data: Data) {
        lock.lock(); defer { lock.unlock() }
        self.data = data
        requests = 0
        referer = ""
    }
    static func snapshot() -> (Int, String) {
        lock.lock(); defer { lock.unlock() }
        return (requests, referer)
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "covers.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.requests += 1
        Self.referer = request.value(forHTTPHeaderField: "Referer") ?? ""
        let data = Self.data
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
#endif
