import SwiftUI
import WebKit
import ReadingCore

private struct EPUBLocalPosition: Codable {
    let path: String
    let fragment: String
    let fraction: Double
}
private struct EPUBNavigationRequest: Identifiable {
    let id = UUID()
    var position: EPUBLocalPosition?
    var back = false
}

/// Original layout is an independent view of the same immutable EPUB. Its
/// physical scroll location is local; it never replaces plain-text UTF-16 data.
struct EPUBBookReader: View {
    let book: Book
    let url: URL
    var initialChapterID: String? = nil
    var onText: (() -> Void)? = nil
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var publication: EPUBOriginalPublication?
    @State private var contentRoot: URL?
    @State private var request: EPUBNavigationRequest?
    @State private var chapterIndex = 0
    @State private var canGoBack = false
    @State private var error: String?
    @State private var showCatalog = false
    @State private var showText = false
    @State private var zoom = 1.0
    @State private var openedProfile = 0
    @State private var originallySaved = false
    private var cacheRoot: URL { url.deletingLastPathComponent().appendingPathComponent("OriginalLayout-v1", isDirectory: true) }
    private var positionURL: URL { cacheRoot.appendingPathComponent("position.json") }

    var body: some View {
        NavigationStack {
            Group {
                if let publication, let contentRoot {
                    EPUBCanvas(root: contentRoot, request: request, zoom: zoom, onBackState: { canGoBack = $0 }, onPosition: { position in
                        guard store.profileRevision == openedProfile else { return }
                        if let index = publication.chapters.firstIndex(where: { $0.path == position.path }) { chapterIndex = index }
                        if let data = try? JSONEncoder().encode(position) {
                            try? data.write(to: positionURL, options: .atomic)
                            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: positionURL.path)
                        }
                    }, onError: { error = $0 })
                } else if let error {
                    VStack(spacing: 18) { Text(error).foregroundStyle(.secondary); Button("使用文字模式", action: openText) }.padding(24)
                } else { ProgressView("正在打开原版…") }
            }
            .background(Palette.paper)
            .navigationTitle(book.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("文字", action: openText)
                    Menu { Stepper("缩放 \(Int(zoom * 100))%", value: $zoom, in: 0.8...1.8, step: 0.1) } label: { Image(systemName: "textformat.size") }.accessibilityLabel("原版缩放")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button { request = .init(back: true) } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!canGoBack).accessibilityLabel("返回脚注前位置")
                    Spacer()
                    Button("目录") { showCatalog = true }.disabled(publication == nil)
                    Spacer()
                    Button { move(-1) } label: { Image(systemName: "chevron.left") }.disabled(chapterIndex <= 0)
                    if let publication { Text("\(chapterIndex + 1) / \(publication.chapters.count)").font(.caption).monospacedDigit() }
                    Button { move(1) } label: { Image(systemName: "chevron.right") }.disabled(chapterIndex + 1 >= (publication?.chapters.count ?? 0))
                }
            }
            .task(id: url) { await load() }
            .sheet(isPresented: $showCatalog) {
                NavigationStack {
                    if let publication {
                        List(publication.outline) { item in
                            Button(item.title) { request = .init(position: .init(path: item.path, fragment: item.fragment, fraction: 0)); showCatalog = false }
                                .padding(.leading, CGFloat(min(5, item.depth) * 12))
                        }
                    }
                    Text("目录").hidden().frame(height: 0)
                        .navigationTitle("目录").toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showCatalog = false } } }
                }
            }
            .fullScreenCover(isPresented: $showText) { ReaderView(book: book, initialChapterID: initialChapterID) }
            .alert("原版阅读", isPresented: Binding(get: { error != nil && publication != nil }, set: { if !$0 { error = nil } })) {
                Button("文字模式") { error = nil; openText() }; Button("好", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
            .onChange(of: store.profileRevision) { _ in publication = nil; contentRoot = nil; dismiss() }
            .onChange(of: store.isSaved(book)) { saved in if originallySaved && !saved { publication = nil; contentRoot = nil; dismiss() } }
        }
    }

    private func openText() {
        if let onText { onText() }
        else { showText = true }
    }

    private func move(_ delta: Int) {
        guard let publication else { return }
        let index = chapterIndex + delta
        guard publication.chapters.indices.contains(index) else { return }
        chapterIndex = index
        request = .init(position: .init(path: publication.chapters[index].path, fragment: "", fraction: 0))
    }
    @MainActor private func load() async {
        openedProfile = store.profileRevision; originallySaved = store.isSaved(book)
        let profile = openedProfile, cache = cacheRoot, source = url
        do {
            let prepared = try await Task.detached(priority: .userInitiated) { () throws -> EPUBOriginalPublication in
                let manifest = cache.appendingPathComponent("manifest.json"), content = cache.appendingPathComponent("content", isDirectory: true)
                if let data = try? Data(contentsOf: manifest), let saved = try? JSONDecoder().decode(EPUBOriginalPublication.self, from: data), !saved.chapters.isEmpty,
                   saved.chapters.allSatisfy({ EPUBOriginalImporter.resourcePath($0.path, relativeTo: "index.xhtml") == $0.path && FileManager.default.fileExists(atPath: content.appendingPathComponent($0.path).path) }) { return saved }
                let stage = cache.deletingLastPathComponent().appendingPathComponent(".original-" + UUID().uuidString, isDirectory: true)
                defer { try? FileManager.default.removeItem(at: stage) }
                let result = try EPUBOriginalImporter.prepare(source, directory: stage.appendingPathComponent("content", isDirectory: true))
                try JSONEncoder().encode(result).write(to: stage.appendingPathComponent("manifest.json"), options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stage.appendingPathComponent("manifest.json").path)
                if FileManager.default.fileExists(atPath: cache.path) { try FileManager.default.removeItem(at: cache) }
                try FileManager.default.moveItem(at: stage, to: cache)
                return result
            }.value
            try Task.checkCancellation(); guard profile == store.profileRevision else { return }
            let saved = (try? Data(contentsOf: positionURL)).flatMap { try? JSONDecoder().decode(EPUBLocalPosition.self, from: $0) }
            let fallbackIndex = store.position(for: book)?.chapterIndex ?? 0
            let chapter = prepared.chapters.first(where: { $0.textChapterIndex == fallbackIndex }) ?? prepared.chapters[0]
            let validSaved = saved.flatMap { value -> EPUBLocalPosition? in
                guard EPUBOriginalImporter.resourcePath(value.path, relativeTo: "index.xhtml") == value.path,
                      FileManager.default.fileExists(atPath: cache.appendingPathComponent("content").appendingPathComponent(value.path).path) else { return nil }
                return value
            }
            publication = prepared; contentRoot = cache.appendingPathComponent("content", isDirectory: true)
            let position = validSaved ?? .init(path: chapter.path, fragment: "", fraction: store.position(for: book)?.chapterFraction ?? 0)
            chapterIndex = prepared.chapters.firstIndex(where: { $0.path == position.path }) ?? 0
            request = .init(position: position)
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct EPUBCanvas: UIViewRepresentable {
    let root: URL
    let request: EPUBNavigationRequest?
    let zoom: Double
    let onBackState: (Bool) -> Void
    let onPosition: (EPUBLocalPosition) -> Void
    let onError: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator; view.allowsBackForwardNavigationGestures = true
        context.coordinator.observe(view)
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "QingRead-Offline-EPUB-v1", encodedContentRuleList: rules) { [weak view, weak coordinator = context.coordinator] ruleList, error in
            guard let view, let coordinator else { return }
            guard let ruleList, error == nil else { coordinator.parent.onError("离线阅读保护未能启动，请使用文字模式。"); return }
            view.configuration.userContentController.add(ruleList)
            coordinator.ready = true; coordinator.apply(on: view)
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        view.pageZoom = zoom
        context.coordinator.apply(on: view)
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading(); view.navigationDelegate = nil; coordinator.invalidate() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: EPUBCanvas
        var ready = false
        private var lastRequest: UUID?
        private var restore: Double?
        private var observations: [NSKeyValueObservation] = []
        init(parent: EPUBCanvas) { self.parent = parent }
        func observe(_ view: WKWebView) {
            observations.append(view.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in DispatchQueue.main.async { self?.parent.onBackState(view.canGoBack) } })
            observations.append(view.scrollView.observe(\.contentSize, options: [.new]) { [weak self, weak view] _, _ in guard let view else { return }; self?.restoreOffset(view) })
            observations.append(view.scrollView.observe(\.contentOffset, options: [.new]) { [weak self, weak view] scroll, _ in
                guard let self, let view, scroll.isDragging || scroll.isDecelerating else { return }
                self.restore = nil; self.report(view)
            })
        }
        func invalidate() { observations.forEach { $0.invalidate() }; observations = [] }
        func apply(on view: WKWebView) {
            guard ready, let request = parent.request, request.id != lastRequest else { return }
            lastRequest = request.id
            if request.back { restore = nil; view.goBack(); return }
            guard let position = request.position, let path = EPUBOriginalImporter.resourcePath(position.path, relativeTo: "index.xhtml"), path == position.path else { return }
            let file = parent.root.appendingPathComponent(path)
            guard FileManager.default.fileExists(atPath: file.path) else { parent.onError("原版页面不存在。"); return }
            var parts = URLComponents(url: file, resolvingAgainstBaseURL: false)
            parts?.fragment = position.fragment.isEmpty ? nil : position.fragment
            restore = position.fragment.isEmpty ? min(1, max(0, position.fraction.isFinite ? position.fraction : 0)) : nil
            if let url = parts?.url { view.loadFileURL(url, allowingReadAccessTo: parent.root) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.isFileURL,
                  url.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(parent.root.resolvingSymlinksInPath().standardizedFileURL.path + "/") else { decisionHandler(.cancel); return }
            if action.navigationType == .linkActivated { restore = nil }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            restoreOffset(webView); parent.onBackState(webView.canGoBack)
            report(webView, requestedFraction: restore, includeFragment: true)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.onError("原版页面未能打开，可切换文字模式。"); }
        private func restoreOffset(_ view: WKWebView) {
            guard let restore else { return }
            let maximum = max(0, view.scrollView.contentSize.height - view.scrollView.bounds.height)
            view.scrollView.setContentOffset(CGPoint(x: 0, y: maximum * restore), animated: false)
        }
        private func report(_ view: WKWebView, requestedFraction: Double? = nil, includeFragment: Bool = false) {
            guard let url = view.url else { return }
            let root = parent.root.standardizedFileURL.path + "/", path = url.standardizedFileURL.path
            guard path.hasPrefix(root) else { return }
            let height = max(1, view.scrollView.contentSize.height - view.scrollView.bounds.height)
            let fraction = requestedFraction ?? Double(min(1, max(0, view.scrollView.contentOffset.y / height)))
            let value = EPUBLocalPosition(path: String(path.dropFirst(root.count)), fragment: includeFragment ? url.fragment ?? "" : "", fraction: fraction)
            DispatchQueue.main.async { [weak self] in self?.parent.onPosition(value) }
        }
    }
}
