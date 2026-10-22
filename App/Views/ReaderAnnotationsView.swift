import SwiftUI
import UIKit
import ReadingCore

struct ReaderAnnotationsView: View {
    let book: Book
    let chapters: [Chapter]
    let currentChapter: Chapter?
    let bodyOffset: Int
    let onSelect: (String, Int) -> Void
    let onSelectText: () -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var tab = 0
    @State private var query = ""
    @State private var results: [CachedBookMatch] = []
    @State private var searching = false
    @State private var error: String?
    @State private var editing: ReadingAnnotation?
    @State private var note = ""
    @State private var openedProfile = -1
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("内容", selection: $tab) { Text("书签与笔记").tag(0); Text("正文搜索").tag(1) }.pickerStyle(.segmented).padding()
                if tab == 0 {
                    List {
                        Section {
                            Button("添加当前书签") {
                                guard openedProfile == store.profileRevision, let currentChapter else { return }
                                do { try store.saveAnnotation(book: book, kind: .bookmark, chapter: currentChapter, offset: bodyOffset) }
                                catch { self.error = error.localizedDescription }
                            }.disabled(currentChapter == nil)
                            Button("选中文本记笔记") { dismiss(); onSelectText() }
                        }
                        ForEach(store.annotations(for: book)) { item in
                            Button {
                                guard openedProfile == store.profileRevision else { return }
                                guard item.sourceID == book.sourceID, item.sourceURL == book.url.absoluteString else { error = "这条标注来自换源前的书源。"; return }
                                onSelect(item.chapterID, item.characterOffset); dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Label(item.chapterTitle, systemImage: item.kind == .bookmark ? "bookmark" : "note.text").font(.subheadline).foregroundStyle(Palette.ink)
                                    if !item.quote.isEmpty { Text(item.quote).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(3) }
                                    if !item.note.isEmpty { Text(item.note).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(4) }
                                }.padding(.vertical, 5)
                            }
                            .contextMenu { Button("编辑笔记") { editing = item; note = item.note } }
                            .swipeActions { Button("删除", role: .destructive) { if openedProfile == store.profileRevision { store.deleteAnnotation(item, in: book) } } }
                        }
                    }.listStyle(.plain)
                } else {
                    HStack {
                        TextField("搜索已缓存正文", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit(search)
                        Button(action: search) { if searching { ProgressView() } else { Image(systemName: "magnifyingglass") } }.disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || searching)
                    }.padding(.horizontal).padding(.bottom, 12)
                    List(results) { item in
                        Button { guard openedProfile == store.profileRevision else { return }; onSelect(item.chapter.id, item.characterOffset); dismiss() } label: {
                            VStack(alignment: .leading, spacing: 6) { Text(item.chapter.title).font(.subheadline); Text(item.excerpt).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(3) }
                        }
                    }.listStyle(.plain)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red).padding() }
            }
            .tint(Palette.cinnabar).navigationTitle("书签与搜索").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .sheet(item: $editing) { item in
                NavigationStack {
                    TextEditor(text: $note).padding().navigationTitle("笔记")
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("取消") { editing = nil } }
                            ToolbarItem(placement: .confirmationAction) { Button("保存") { if openedProfile == store.profileRevision { store.editAnnotation(item.id, in: book, note: note) }; editing = nil } }
                        }
                }.presentationDetents([.medium, .large])
            }
            .onAppear { openedProfile = store.profileRevision }
            .onChange(of: store.profileRevision) { _ in dismiss() }
        }
    }
    private func search() {
        guard openedProfile == store.profileRevision else { return }
        let profile = openedProfile
        searching = true; error = nil
        Task {
            let values = await store.searchCachedText(query, book: book, chapters: chapters)
            guard profile == store.profileRevision else { return }
            results = values; searching = false
        }
    }
}

struct ReaderTextSelectionView: View {
    let book: Book
    let content: ChapterContent
    let initialBodyOffset: Int
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var range = NSRange(location: 0, length: 0)
    @State private var note = ""
    @State private var error: String?
    @State private var openedProfile = -1
    private var text: String { content.paragraphs.joined(separator: "\n") }
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                SelectableChapterText(text: text, initialOffset: initialBodyOffset) { range = $0 }
                TextField("笔记（可选）", text: $note, axis: .vertical).lineLimit(2...4).textFieldStyle(.roundedBorder).padding(.horizontal)
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Button("保存标注") {
                    let body = text as NSString
                    guard openedProfile == store.profileRevision, range.length > 0, NSMaxRange(range) <= body.length else { return }
                    do {
                        try store.saveAnnotation(book: book, kind: .note, chapter: content.chapter, offset: range.location, length: range.length, quote: body.substring(with: range), note: note)
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }.buttonStyle(PrimaryButtonStyle()).disabled(range.length == 0).padding(.horizontal).padding(.bottom, 12)
            }
            .navigationTitle("选择正文").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .onAppear { openedProfile = store.profileRevision }
            .onChange(of: store.profileRevision) { _ in dismiss() }
        }
    }
}

private struct SelectableChapterText: UIViewRepresentable {
    let text: String
    let initialOffset: Int
    let onSelection: (NSRange) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onSelection: onSelection) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(); view.isEditable = false; view.isSelectable = true; view.delegate = context.coordinator
        view.font = .systemFont(ofSize: 19); view.textContainerInset = UIEdgeInsets(top: 18, left: 16, bottom: 18, right: 16)
        view.text = text; view.selectedRange = NSRange(location: min(max(0, initialOffset), (text as NSString).length), length: 0)
        DispatchQueue.main.async { view.scrollRangeToVisible(view.selectedRange) }
        return view
    }
    func updateUIView(_ uiView: UITextView, context: Context) { context.coordinator.onSelection = onSelection }
    final class Coordinator: NSObject, UITextViewDelegate {
        var onSelection: (NSRange) -> Void
        init(onSelection: @escaping (NSRange) -> Void) { self.onSelection = onSelection }
        func textViewDidChangeSelection(_ textView: UITextView) { let range = textView.selectedRange; DispatchQueue.main.async { self.onSelection(range) } }
    }
}
