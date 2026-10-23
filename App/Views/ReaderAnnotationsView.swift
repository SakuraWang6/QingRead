import SwiftUI
import ReadingCore

struct ReaderAnnotationsView: View {
    let book: Book
    let chapters: [Chapter]
    let currentChapter: Chapter?
    let bodyOffset: Int
    let onSelect: (String, Int) -> Void
    let onAnnotateParagraph: () -> Void
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
                            Button("当前段落笔记") { dismiss(); onAnnotateParagraph() }.disabled(currentChapter == nil)
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

struct ReaderParagraphNotesView: View {
    let book: Book
    let chapter: Chapter
    let paragraph: ReadingParagraphAnchor
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var editingID: String?
    @State private var note = ""
    @State private var error: String?
    @State private var openedProfile = -1
    @FocusState private var editorFocused: Bool

    private var notes: [ReadingAnnotation] {
        store.annotations(for: book).filter {
            $0.chapterID == chapter.id && $0.sourceID == book.sourceID
                && $0.sourceURL == book.url.absoluteString && paragraph.overlaps($0)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("第 \(paragraph.index + 1) 段") {
                    Text(paragraph.text).font(.body).lineSpacing(5).textSelection(.enabled)
                        .accessibilityIdentifier("reader.paragraph.quote")
                }
                Section(editingID == nil ? "写笔记" : "编辑笔记") {
                    TextField("写下想法", text: $note, axis: .vertical).lineLimit(3...8)
                        .focused($editorFocused).accessibilityIdentifier("reader.paragraph.note")
                    if editingID != nil {
                        Button("取消编辑") { editingID = nil; note = ""; editorFocused = false }
                    }
                }
                if !notes.isEmpty {
                    Section("我的笔记") {
                        ForEach(notes) { item in
                            VStack(alignment: .leading, spacing: 8) {
                                if !item.quote.isEmpty, item.quote != paragraph.text {
                                    Text(item.quote).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(3)
                                }
                                if !item.note.isEmpty { Text(item.note).font(.body) }
                                HStack {
                                    Button("编辑") { editingID = item.id; note = item.note; error = nil; editorFocused = true }
                                        .buttonStyle(.borderless)
                                    Spacer()
                                    Button("删除", role: .destructive) {
                                        guard openedProfile == store.profileRevision else { return }
                                        store.deleteAnnotation(item, in: book)
                                        if editingID == item.id { editingID = nil; note = "" }
                                    }.buttonStyle(.borderless)
                                }.font(.subheadline)
                            }.padding(.vertical, 4)
                        }
                    }
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("段落笔记").navigationBarTitleDisplayMode(.inline).tint(Palette.cinnabar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存", action: save).disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("reader.paragraph.save")
                }
            }
            .onAppear { openedProfile = store.profileRevision }
            .onChange(of: store.profileRevision) { _ in dismiss() }
            .onChange(of: note) { value in
                let clipped = ReadingMetadataText.clipped(value, utf16Limit: 1000)
                if value != clipped { note = clipped }
            }
        }
    }

    private func save() {
        guard openedProfile == store.profileRevision else { return }
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if let editingID {
            // Keep the exact quote/range of existing text selections, including older clients' notes.
            guard notes.contains(where: { $0.id == editingID }) else { error = "这条笔记已删除。"; return }
            store.editAnnotation(editingID, in: book, note: text)
            dismiss()
            return
        }
        do {
            try store.saveAnnotation(book: book, kind: .note, chapter: chapter,
                                     offset: paragraph.characterOffset, length: paragraph.characterLength,
                                     quote: paragraph.text, note: text)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
