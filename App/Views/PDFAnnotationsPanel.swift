import SwiftUI
import PDFKit
import ReadingCore

struct PDFPageJump { let id = UUID(); let pageIndex: Int; let offset: Int; let length: Int }
struct PDFPageQuote: Identifiable {
    var id: String { "\(pageIndex):\(offset)" }
    let pageIndex: Int
    let offset: Int
    let length: Int
    let quote: String
    let excerpt: String
    static func selection(_ selection: PDFSelection, page: PDFPage, document: PDFDocument) -> PDFPageQuote? {
        let count = selection.numberOfTextRanges(on: page), raw = page.string ?? ""
        guard count > 0 else { return nil }
        let ranges = (0..<min(count, 100)).map { selection.range(at: $0, on: page) }.filter { $0.location != NSNotFound }
        guard let first = ranges.map(\.location).min(), let end = ranges.map({ NSMaxRange($0) }).max() else { return nil }
        let text = PDFTextAnchor.canonical(raw) as NSString
        let offset = PDFTextAnchor.canonicalOffset(first, in: raw), upper = min(text.length, PDFTextAnchor.canonicalOffset(end, in: raw))
        guard upper > offset else { return nil }
        let quote = ReadingMetadataText.clipped(text.substring(with: NSRange(location: offset, length: upper - offset)), utf16Limit: 500)
        let excerptStart = max(0, offset - 30), excerptEnd = min(text.length, upper + 60)
        return .init(pageIndex: document.index(for: page), offset: offset, length: upper - offset, quote: quote, excerpt: text.substring(with: NSRange(location: excerptStart, length: excerptEnd - excerptStart)))
    }
}

@MainActor private final class PDFLocalSearch: ObservableObject {
    @Published var results: [PDFPageQuote] = []
    @Published var searching = false
    private var document: PDFDocument?
    private var observers: [NSObjectProtocol] = []
    func search(_ query: String, in document: PDFDocument) {
        cancel(); results = []
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        self.document = document; searching = true
        observers.append(NotificationCenter.default.addObserver(forName: .PDFDocumentDidFindMatch, object: document, queue: .main) { [weak self, weak document] notification in
            guard let self, self.searching, let document, let selection = notification.userInfo?[PDFDocumentFoundSelectionKey] as? PDFSelection, let page = selection.pages.first,
                  let value = PDFPageQuote.selection(selection, page: page, document: document), !self.results.contains(where: { $0.id == value.id }) else { return }
            self.results.append(value)
            if self.results.count >= 100 { document.cancelFindString(); self.searching = false }
        })
        observers.append(NotificationCenter.default.addObserver(forName: .PDFDocumentDidEndFind, object: document, queue: .main) { [weak self] _ in self?.searching = false })
        document.beginFindString(query, withOptions: [.caseInsensitive])
    }
    func cancel() { document?.cancelFindString(); document = nil; observers.forEach { NotificationCenter.default.removeObserver($0) }; observers = []; searching = false }
}

struct PDFAnnotationsPanel: View {
    let book: Book
    let document: PDFDocument
    let pageIndex: Int
    let quote: PDFPageQuote?
    let onJump: (Int, Int, Int) -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var search = PDFLocalSearch()
    @State private var tab = 0
    @State private var note = ""
    @State private var query = ""
    @State private var selected: PDFPageQuote?
    @State private var error: String?
    @State private var openedProfile = -1
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("内容", selection: $tab) { Text("书签与笔记").tag(0); Text("正文搜索").tag(1) }.pickerStyle(.segmented).padding()
                if tab == 0 {
                    List {
                        Section {
                            if let selected { Text("第 \(selected.pageIndex + 1) 页 · \(selected.quote)").font(.footnote); Button("取消引用") { self.selected = nil } }
                            TextField("笔记（可选）", text: $note, axis: .vertical).lineLimit(2...5)
                            Button(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && selected == nil ? "添加当前页书签" : "保存笔记", action: save)
                        }
                        ForEach(store.annotations(for: book)) { item in
                            Button {
                                guard openedProfile == store.profileRevision, item.sourceID == book.sourceID, item.sourceURL == book.url.absoluteString else { return }
                                onJump(item.chapterIndex, item.characterOffset, item.characterLength); dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 6) { Text(item.chapterTitle).font(.subheadline); if !item.quote.isEmpty { Text(item.quote).font(.footnote).foregroundStyle(Palette.secondary) }; if !item.note.isEmpty { Text(item.note).font(.subheadline) } }
                            }.swipeActions { Button("删除", role: .destructive) { if openedProfile == store.profileRevision { store.deleteAnnotation(item, in: book) } } }
                        }
                    }.listStyle(.plain)
                } else {
                    HStack {
                        TextField("搜索 PDF 正文", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit(startSearch)
                        if search.searching { Button("停止") { search.cancel() } } else { Button("搜索", action: startSearch).disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                    }.padding()
                    List(search.results) { value in
                        VStack(alignment: .leading, spacing: 8) {
                            Button { onJump(value.pageIndex, value.offset, value.length); dismiss() } label: { VStack(alignment: .leading, spacing: 5) { Text("第 \(value.pageIndex + 1) 页"); Text(value.excerpt).font(.footnote).foregroundStyle(Palette.secondary) } }
                            Button("引用记笔记") { selected = value; tab = 0 }.font(.footnote)
                        }
                    }.listStyle(.plain)
                    if !search.searching && !query.isEmpty && search.results.isEmpty { Text("未找到可搜索文字；图片型 PDF 暂不支持 OCR。").font(.footnote).foregroundStyle(Palette.secondary).padding() }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
            }
            .tint(Palette.cinnabar).navigationTitle("书签与搜索").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .onAppear { openedProfile = store.profileRevision; selected = quote }
            .onDisappear { search.cancel() }
            .onChange(of: store.profileRevision) { _ in search.cancel(); dismiss() }
        }
    }
    private func startSearch() { guard openedProfile == store.profileRevision else { return }; search.search(query, in: document) }
    private func save() {
        guard openedProfile == store.profileRevision else { return }
        let index = selected?.pageIndex ?? pageIndex
        let chapter = Chapter(id: PDFTextAnchor.pageID(index), title: "第 \(index + 1) 页", url: book.url, index: index)
        do {
            try store.saveAnnotation(book: book, kind: selected == nil && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .bookmark : .note, chapter: chapter, offset: selected?.offset ?? 0, length: selected?.length ?? 0, quote: selected?.quote ?? "", note: ReadingMetadataText.clipped(note, utf16Limit: 1000))
            note = ""; selected = nil
        } catch { self.error = error.localizedDescription }
    }
}
