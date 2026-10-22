import SwiftUI
import PDFKit
import ReadingCore
import UniformTypeIdentifiers

struct BookReadingView: View {
    let book: Book
    var initialChapterID: String? = nil
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var cloudLoading=false
    @State private var cloudError:String?
    var body: some View {
      Group {
        if book.publicationFormat != nil, store.publicationURL(for: book) == nil {
            NavigationStack {
                FileBookDetailView(book: book)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            }
        } else if store.importedBooks[book.id]?.format == .pdf, let url = store.publicationURL(for: book) {
            PDFBookReader(book: book, url: url)
        } else if store.importedBooks[book.id]?.format == .epub, let url = store.publicationURL(for: book) {
            EPUBBookReader(book: book, url: url, initialChapterID: initialChapterID)
        } else { ReaderView(book: book, initialChapterID: initialChapterID) }
      }
      .overlay { if cloudLoading { ProgressView("下载中…").padding(24).background(.regularMaterial,in:RoundedRectangle(cornerRadius:12)) } }
      .task(id:book.id) {
          guard book.publicationFormat != nil,book.fileHash != nil,store.publicationURL(for:book)==nil,store.cloud.user != nil else { return }
          cloudLoading=true;defer { cloudLoading=false }
          do { _ = try await store.cloud.downloadPublication(book) } catch { if !Task.isCancelled { cloudError=error.localizedDescription } }
      }
      .alert("下载未完成",isPresented:Binding(get:{cloudError != nil},set:{if !$0 { cloudError=nil }})) { Button("好") { cloudError=nil } } message:{Text(cloudError ?? "")}
    }
}

struct FileBookDetailView: View {
    let book: Book
    @EnvironmentObject private var store: AppStore
    @State private var isDownloading = false
    @State private var progress = 0.0
    @State private var error: String?
    @State private var task: Task<Void, Never>?
    @State private var showReader = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 18) {
                    BookSpine(book: book)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(book.title).font(.title2.bold())
                        Text(book.author).font(.subheadline).foregroundStyle(Palette.secondary)
                        Text("\(book.sourceName) · \(book.publicationFormat?.rawValue.uppercased() ?? "电子书")").font(.caption).foregroundStyle(Palette.secondary)
                    }
                }
                if store.publicationURL(for: book) != nil {
                    Button { showReader = true } label: { Label("打开本地整本", systemImage: "book") }.buttonStyle(PrimaryButtonStyle())
                    Text("已下载，可离线阅读").font(.caption).foregroundStyle(Palette.secondary)
                } else {
                    PublicationImportButton(expectedBook: book) { _ in showReader = true }
                    CloudFileDownloadButton(book:book,cloud:store.cloud) { showReader=true }
                    if book.sourceID != "local-file" {
                    Button {
                        if isDownloading { task?.cancel(); return }
                        error = nil; isDownloading = true; progress = 0
                        task = Task {
                            do {
                                _ = try await store.downloadPublication(book) { if isDownloading { progress = $0 } }
                                if !Task.isCancelled { showReader = true }
                            } catch {
                                if !Task.isCancelled { self.error = error.localizedDescription }
                            }
                            isDownloading = false
                        }
                    } label: { Label(isDownloading ? "停止下载" : "下载整本并阅读", systemImage: isDownloading ? "stop.circle" : "arrow.down.circle") }
                        .buttonStyle(PrimaryButtonStyle())
                    if isDownloading { ProgressView(value: progress).tint(Palette.cinnabar) }
                    }
                }
                if let error { InlineNotice(message: error, isError: true) }
                if !book.summary.isEmpty { Text(book.summary).font(.system(size: 15)).lineSpacing(5) }
                if ["http", "https"].contains(book.url.scheme ?? "") { Link("查看原始出处", destination: book.url).font(.footnote) }
            }.padding(22)
        }
        .background(Palette.paper).navigationTitle("书籍").navigationBarTitleDisplayMode(.inline)
        .onDisappear { task?.cancel();store.cloud.cancelDownload(book) }
        .fullScreenCover(isPresented: $showReader) { BookReadingView(book: book) }
    }
}

private struct CloudFileDownloadButton: View {
    let book:Book
    @ObservedObject var cloud:NativeCloudSync
    var onRead:()->Void
    @State private var loading=false
    @State private var error:String?
    var body: some View {
        if cloud.files.contains(where:{$0.bookID==book.id}) {
            Button(loading ? "下载中…":"从云端下载") {
                loading=true;error=nil
                Task { do { _=try await cloud.downloadPublication(book);onRead() } catch { self.error=error.localizedDescription };loading=false }
            }.buttonStyle(PrimaryButtonStyle()).disabled(loading)
            if let error { InlineNotice(message:error,isError:true) }
        }
    }
}

struct PublicationImportButton: View {
    var expectedBook: Book? = nil
    var iconOnly = false
    var onImported: (Book) -> Void = { _ in }
    @EnvironmentObject private var store: AppStore
    @State private var showFiles = false
    @State private var isImporting = false
    @State private var error: String?
    var body: some View {
        Button { showFiles = true } label: {
            if iconOnly { Image(systemName: "doc.badge.plus") }
            else { Label(isImporting ? "正在导入…" : "导入 EPUB / PDF / TXT", systemImage: "doc.badge.plus") }
        }
            .accessibilityLabel(isImporting ? "正在导入" : "导入 EPUB、PDF 或 TXT")
            .disabled(isImporting)
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .plainText, UTType(filenameExtension: "epub")!]) { result in
                switch result {
                case .success(let url):
                    isImporting = true
                    Task {
                        let access = url.startAccessingSecurityScopedResource()
                        defer { if access { url.stopAccessingSecurityScopedResource() }; isImporting = false }
                        do { onImported(try await store.importPublication(at: url, metadata: expectedBook)) }
                        catch { self.error = error.localizedDescription }
                    }
                case .failure(let failure): error = failure.localizedDescription
                }
            }
            .alert("导入未完成", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("好") { error = nil } } message: { Text(error ?? "") }
    }
}

private struct PDFBookReader: View {
    let book: Book
    let url: URL
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var page = 0
    @State private var pages = 1
    @State private var seekPage: Int?
    @State private var showCatalog = false
    @State private var showNotes = false
    @State private var document: PDFDocument?
    @State private var selectedText: PDFPageQuote?
    @State private var requestedMatch: PDFPageJump?
    @State private var openedProfile = -1
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                PDFCanvas(url: url, initialPage: store.position(for: book)?.chapterIndex ?? 0, requestedPage: seekPage, requestedMatch: requestedMatch, onDocument: {
                    if openedProfile == store.profileRevision { document = $0 }
                }, onSelection: {
                    if openedProfile == store.profileRevision { selectedText = $0 }
                }) { index, count in
                    guard openedProfile == store.profileRevision else { return }
                    page = index; pages = count
                    let chapter = Chapter(id: book.id + "|\(index)", title: "第 \(index + 1) 页", url: book.url, index: index)
                    store.savePosition(book: book, chapter: chapter, index: index, characterOffset: 0, fraction: 0)
                }
                HStack {
                    Button("目录") { showCatalog = true }
                    Slider(value: Binding(get: { Double(page) }, set: { seekPage = Int($0) }), in: 0...Double(max(1, pages - 1)), step: 1).disabled(pages <= 1)

                }.padding(16).tint(Palette.cinnabar)
                HStack { Text("\(page + 1) / \(pages)").monospacedDigit(); Spacer(); ReaderDeviceStatus() }
                    .font(.system(size: 12)).foregroundStyle(Palette.secondary).padding(.horizontal, 24).padding(.bottom, 8)
            }
            .background(Palette.paper).navigationTitle(book.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button { showNotes = true } label: { Image(systemName: "bookmark") }.accessibilityLabel("PDF 书签与搜索").disabled(document == nil) }
            }
            .onAppear { openedProfile = store.profileRevision }
            .onChange(of: store.profileRevision) { _ in document?.cancelFindString(); document = nil; dismiss() }
            .sheet(isPresented: $showNotes) {
                if let document {
                    PDFAnnotationsPanel(book: book, document: document, pageIndex: page, quote: selectedText) { index, offset, length in
                        seekPage = index; requestedMatch = .init(pageIndex: index, offset: offset, length: length)
                    }
                }
            }
            .sheet(isPresented: $showCatalog) {
                NavigationStack {
                    List(0..<pages, id: \.self) { index in
                        Button("第 \(index + 1) 页") { seekPage = index; showCatalog = false }
                    }.navigationTitle("PDF 页面").toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showCatalog = false } } }
                }
            }
        }
    }
}

private struct PDFCanvas: UIViewRepresentable {
    let url: URL
    let initialPage: Int
    let requestedPage: Int?
    let requestedMatch: PDFPageJump?
    let onDocument: (PDFDocument) -> Void
    let onSelection: (PDFPageQuote?) -> Void
    let onPage: (Int, Int) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onPage: onPage) }
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true; view.displayMode = .singlePageContinuous; view.displayDirection = .vertical
        view.backgroundColor = UIColor(Palette.paper)
        if let document = PDFDocument(url: url) {
            view.document = document
            if let page = document.page(at: min(max(0, initialPage), max(0, document.pageCount - 1))) { view.go(to: page) }
            DispatchQueue.main.async { onDocument(document) }
        }
        context.coordinator.observer = NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak view] _ in
            guard let view, let page = view.currentPage, let doc = view.document else { return }
            onPage(doc.index(for: page), doc.pageCount)
        }
        context.coordinator.selectionObserver = NotificationCenter.default.addObserver(forName: .PDFViewSelectionChanged, object: view, queue: .main) { [weak view] _ in
            guard let view, let document = view.document, let selection = view.currentSelection, let page = selection.pages.first else { onSelection(nil); return }
            onSelection(PDFPageQuote.selection(selection, page: page, document: document))
        }
        DispatchQueue.main.async { if let doc = view.document { onPage(min(max(0, initialPage), max(0, doc.pageCount - 1)), doc.pageCount) } }
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {
        if let requestedMatch, requestedMatch.id != context.coordinator.lastMatch, let page = view.document?.page(at: requestedMatch.pageIndex) {
            context.coordinator.lastMatch = requestedMatch.id
            context.coordinator.lastRequested = requestedMatch.pageIndex
            let range = PDFTextAnchor.rawRange(offset: requestedMatch.offset, length: max(1, requestedMatch.length), in: page.string ?? "")
            if let selection = page.selection(for: range), range.length > 0 { view.setCurrentSelection(selection, animate: true); view.go(to: selection) }
            else { view.go(to: page) }
        }
        if let requestedPage, requestedPage != context.coordinator.lastRequested, let page = view.document?.page(at: requestedPage) {
            context.coordinator.lastRequested = requestedPage; view.go(to: page)
        }
    }
    class Coordinator {
        var lastRequested: Int?
        var observer: NSObjectProtocol?
        var selectionObserver: NSObjectProtocol?
        var lastMatch: UUID?
        init(onPage: @escaping (Int, Int) -> Void) { }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) }; if let selectionObserver { NotificationCenter.default.removeObserver(selectionObserver) } }
    }
}
