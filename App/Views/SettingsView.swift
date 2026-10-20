import SwiftUI
import ReadingCore

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        List {
            Section {
                NavigationLink { SourcesView() } label: { Label("书源", systemImage: "books.vertical") }
                NavigationLink { VoiceSettingsView() } label: { Label("听书与离线音色", systemImage: "waveform") }
                NavigationLink { DownloadSitesView() } label: { Label("整本下载与网站", systemImage: "arrow.down.doc") }
            }
            Section("阅读") {
                NavigationLink { ReaderSettingsPanel() } label: { Label("排版与翻页", systemImage: "textformat.size") }
            }
        }
        .scrollContentBackground(.hidden).background(Palette.paper)
        .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
    }
}

struct DownloadSitesView: View {
    @State private var imported: Book?
    var body: some View {
        List {
            Section {
                Text("在「搜书」中可直接搜索以下书库。进入书籍详情后下载整本，保存到书架即可离线阅读。")
                    .font(.subheadline).foregroundStyle(Palette.secondary)
                Link("Project Gutenberg · 中外文学", destination: URL(string: "https://www.gutenberg.org")!)
                Link("Standard Ebooks · 英文文学", destination: URL(string: "https://standardebooks.org")!)
                Link("OpenStax · 英文大学教材", destination: URL(string: "https://openstax.org")!)
            } header: { Text("整本书库") }
            Section {
                PublicationImportButton { imported = $0 }
                Text("也可以将其他网站下载的 EPUB、PDF、TXT 从「文件」导入。EPUB 使用文字阅读器，PDF 保留图表和原始版面。")
                    .font(.footnote).foregroundStyle(Palette.secondary)
            } header: { Text("本地电子书") }
        }
        .navigationTitle("整本下载").navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $imported) { BookReadingView(book: $0) }
    }
}

struct KokoroVoice: Identifiable {
    let id: Int
    let name: String
    static let all = [KokoroVoice(id: 3, name: "女声 001"), .init(id: 16, name: "女声 023"), .init(id: 46, name: "女声 079"),
                      .init(id: 58, name: "男声 009"), .init(id: 76, name: "男声 045"), .init(id: 93, name: "男声 080")]
}

struct VoiceSettingsView: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var preview = ReaderSpeechController()
    var body: some View {
        ScrollView {
            VoicePreferencesView(activeSpeech: preview).padding(20)
        }
        .background(Palette.paper)
        .navigationTitle("听书与音色").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(preview.state == .playing ? "停止试听" : "试听") {
                    if preview.state == .playing { preview.stop() }
                    else {
                        let content = ChapterContent(chapter: LocalSample.chapters[0], paragraphs: ["晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近。"])
                        preview.prepare(content: content, settings: store.settings, anchor: 0, bookTitle: "音色试听", autoplay: true)
                    }
                }
            }
        }
        .onChange(of: store.settings) { preview.updateSettings($0) }
        .onDisappear { preview.stop() }
    }
}

struct VoicePreferencesView: View {
    var activeSpeech: ReaderSpeechController?
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var melo = AIModelManager.shared
    @ObservedObject private var kokoro = AIModelManager.kokoro

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Button { select(.system) } label: { row("系统语音", selected: store.settings.speechEngine == .system) }
                .accessibilityIdentifier("reader.audio.engine.system")
            if store.settings.speechEngine == .system, let speech = activeSpeech {
                Picker("系统中文音色", selection: Binding(get: { store.settings.speechVoiceIdentifier }, set: { value in
                    var settings = store.settings; settings.speechVoiceIdentifier = value; store.updateSettings(settings)
                })) {
                    Text("自动 · 优先增强音色").tag("")
                    ForEach(speech.availableVoices) { Text("\($0.name) · \($0.qualityLabel)").tag($0.id) }
                }.pickerStyle(.menu).font(.system(size: 13)).accessibilityIdentifier("reader.audio.voice")
            }
            modelSection(melo, title: "Melo", detail: "一种中文音色")
            modelSection(kokoro, title: "Kokoro", detail: "中文男声、女声 · 六种音色")
            if store.settings.speechEngine == .kokoro {
                Picker("中文音色", selection: Binding(get: { store.settings.kokoroVoiceID }, set: { value in
                    var settings = store.settings; settings.kokoroVoiceID = value; store.updateSettings(settings)
                })) { ForEach(KokoroVoice.all) { Text($0.name).tag($0.id) } }
                .pickerStyle(.menu).font(.system(size: 14)).accessibilityIdentifier("reader.audio.kokoroVoice")
            }
            Text("声库下载后在手机本地生成声音。开始播放前会准备缓冲；高倍速或设备较慢时仍可能等待。音频会在本地复用，下载只使用 Wi‑Fi。")
                .font(.system(size: 11)).foregroundStyle(Palette.secondary).lineSpacing(4)
            if let message = activeSpeech?.message { Text(message).font(.footnote).foregroundStyle(Palette.secondary) }
        }.foregroundStyle(Palette.ink).tint(Palette.cinnabar)
    }

    private func row(_ title: String, selected: Bool) -> some View {
        HStack { Text(title).font(.system(size: 15, weight: .medium)); Spacer(); Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? Palette.cinnabar : Palette.secondary) }
            .padding(14).background(Palette.surface, in: RoundedRectangle(cornerRadius: 10))
    }
    @ViewBuilder private func modelSection(_ manager: AIModelManager, title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { select(manager.engine) } label: { row(title, selected: store.settings.speechEngine == manager.engine) }
                .disabled(manager.readyDirectory == nil)
                .accessibilityIdentifier("reader.audio.engine.\(manager.engine.rawValue)")
            HStack {
                Text("\(detail) · \(manager.downloadSize)").font(.system(size: 11)).foregroundStyle(Palette.secondary)
                Spacer()
                switch manager.state {
                case .missing, .failed:
                    Button("下载") { manager.download() }.font(.system(size: 12)).accessibilityIdentifier("reader.audio.\(manager.engine.rawValue).download")
                case .downloading(let progress):
                    Text("\(Int(progress * 100))%").font(.caption).monospacedDigit()
                    Button("取消") { manager.cancelDownload() }.font(.system(size: 12))
                case .ready:
                    Button("删除声库") {
                        if store.settings.speechEngine == manager.engine { activeSpeech?.stop(); select(.system) }
                        manager.remove()
                    }.font(.system(size: 12))
                }
            }.padding(.horizontal, 4)
            if case .downloading(let progress) = manager.state { ProgressView(value: progress) }
            if case .failed(let message) = manager.state { Text(message).font(.system(size: 11)).foregroundStyle(Palette.secondary) }
        }
    }
    private func select(_ engine: SpeechEngine) {
        guard engine == .system || AIModelManager.manager(for: engine).readyDirectory != nil else { return }
        var settings = store.settings; settings.speechEngine = engine; store.updateSettings(settings)
    }
}
