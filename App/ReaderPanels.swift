import SwiftUI
import ReadingCore

struct ReaderTopBar: View {
    let title: String
    let theme: ReadingTheme
    let onClose: () -> Void
    var body: some View {
        HStack(spacing: 14) {
            Button(action: onClose) {
                Image(systemName: "chevron.left").font(.system(size: 20, weight: .medium)).frame(width: 38, height: 44)
            }.accessibilityLabel("关闭阅读器").accessibilityIdentifier("reader.close")
            Text(title).font(.system(size: 16, weight: .medium)).lineLimit(1)
            Spacer(minLength: 0)
            Text("清读").font(.system(size: 12)).opacity(0.45)
        }
        .foregroundStyle(theme.foreground).padding(.horizontal, 12).padding(.vertical, 8)
        .background(theme.background.opacity(0.98))
        .overlay(alignment: .bottom) { Divider().opacity(0.25) }
    }
}

struct ReaderBottomBar: View {
    let chapterTitle: String
    let chapterIndex: Int
    let chapterCount: Int
    let fraction: Double
    let isLoading: Bool
    let isNight: Bool
    let theme: ReadingTheme
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onCatalog: () -> Void
    let onSettings: () -> Void
    let onAudio: () -> Void
    let onNight: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            HStack(spacing: 16) {
                Button("上一章", action: onPrevious).disabled(chapterIndex <= 0 || isLoading)
                    .accessibilityIdentifier("reader.previousChapter")
                VStack(spacing: 5) {
                    Text(chapterTitle).font(.system(size: 12)).lineLimit(1)
                    Text("第 \(chapterIndex + 1) / \(max(1, chapterCount)) 章 · \(Int(fraction * 100))%")
                        .font(.system(size: 10)).opacity(0.5).monospacedDigit()
                }.frame(maxWidth: .infinity)
                Button("下一章", action: onNext).disabled(chapterIndex >= chapterCount - 1 || isLoading)
                    .accessibilityIdentifier("reader.nextChapter")
            }.font(.system(size: 13))
            HStack {
                tool("目录", symbol: "list.bullet", id: "reader.catalog", action: onCatalog)
                    .disabled(chapterCount == 0)
                tool(isNight ? "日间" : "夜间", symbol: isNight ? "sun.max" : "moon", id: "reader.night", action: onNight)
                tool("听书", symbol: "headphones", id: "reader.audio", action: onAudio).disabled(isLoading)
                tool("设置", symbol: "textformat.size", id: "reader.settings", action: onSettings)
            }
        }
        .foregroundStyle(theme.foreground).padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 14)
        .background(theme.background.opacity(0.98))
        .overlay(alignment: .top) { Divider().opacity(0.25) }
    }

    private func tool(_ title: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 22, weight: .regular)).frame(height: 26)
                Text(title).font(.system(size: 12))
            }.frame(maxWidth: .infinity).padding(.vertical, 4)
        }.accessibilityIdentifier(id)
    }
}

struct ReaderSettingsPanel: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    private var theme: ReadingTheme { store.settings.activeTheme }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 25) {
                HStack {
                    Text("阅读设置").font(.system(size: 21, weight: .semibold))
                    Spacer()
                    Button("完成") { dismiss() }.accessibilityIdentifier("reader.settings.done")
                }
                settingTitle("翻页方式")
                Picker("翻页方式", selection: binding(\.turnMode)) {
                    ForEach(ReaderTurnMode.allCases) { mode in Text(mode.name).tag(mode) }
                }.pickerStyle(.segmented).accessibilityIdentifier("reader.settings.turnMode")
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        settingTitle("阅读背景")
                        Spacer()
                        Toggle("夜间", isOn: binding(\.isNightMode)).labelsHidden()
                            .accessibilityLabel("夜间模式").accessibilityIdentifier("reader.settings.night")
                        Text("夜间").font(.system(size: 13))
                    }
                    HStack(spacing: 10) {
                        ForEach(ReadingTheme.daytimeCases) { choice in
                            Button {
                                var updated = store.settings
                                updated.theme = choice
                                updated.isNightMode = false
                                store.updateSettings(updated)
                            } label: {
                                Text(choice.name).font(.system(size: 12)).foregroundStyle(choice.foreground)
                                    .frame(maxWidth: .infinity).frame(height: 43)
                                    .background(choice.background, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(store.settings.theme == choice && !store.settings.isNightMode ? Palette.cinnabar : theme.foreground.opacity(0.15), lineWidth: store.settings.theme == choice && !store.settings.isNightMode ? 2 : 0.5))
                            }
                            .accessibilityLabel("\(choice.name)背景")
                            .accessibilityIdentifier("reader.settings.theme.\(choice.rawValue)")
                            .accessibilityAddTraits(store.settings.theme == choice ? .isSelected : [])
                        }
                    }
                }
                VStack(spacing: 20) {
                    valueSlider("字号", value: binding(\.fontSize), in: 16...34, id: "reader.settings.fontSize")
                    valueSlider("行距", value: binding(\.lineSpacing), in: 4...22, id: "reader.settings.lineSpacing")
                    valueSlider("页边距", value: binding(\.horizontalMargin), in: 16...40, id: "reader.settings.margin")
                }
                HStack {
                    settingTitle("字体")
                    Picker("字体", selection: binding(\.font)) {
                        ForEach(ReaderFont.allCases) { font in Text(font.name).tag(font) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("reader.settings.font")
                }
                Toggle("加粗文字", isOn: binding(\.isBold)).font(.system(size: 14))
                    .accessibilityIdentifier("reader.settings.bold")
                VStack(spacing: 15) {
                    Toggle("亮度跟随系统", isOn: binding(\.followsSystemBrightness)).font(.system(size: 14))
                        .accessibilityIdentifier("reader.settings.systemBrightness")
                    HStack(spacing: 14) {
                        Image(systemName: "sun.min")
                        Slider(value: binding(\.brightness), in: 0.05...1)
                            .disabled(store.settings.followsSystemBrightness)
                            .accessibilityLabel("阅读亮度").accessibilityIdentifier("reader.settings.brightness")
                        Image(systemName: "sun.max")
                    }.font(.system(size: 15))
                    Text("自定亮度只在阅读期间生效，退出后恢复。")
                        .font(.system(size: 11)).opacity(0.55).frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("调整排版后，仍从当前文字附近继续。左右滑动和覆盖翻页为按屏分页，上下滚动为连续阅读。")
                    .font(.system(size: 12)).lineSpacing(5).opacity(0.55)
            }.padding(24)
        }
        .foregroundStyle(theme.foreground).background(theme.background)
        .tint(store.settings.isNightMode ? Color.orange.opacity(0.8) : Palette.cinnabar)
        .preferredColorScheme(store.settings.isNightMode ? .dark : .light)
    }

    private func settingTitle(_ title: String) -> some View { Text(title).font(.system(size: 14, weight: .medium)) }
    private func binding<Value>(_ keyPath: WritableKeyPath<ReaderSettings, Value>) -> Binding<Value> {
        Binding(get: { store.settings[keyPath: keyPath] }, set: { value in
            var updated = store.settings
            updated[keyPath: keyPath] = value
            store.updateSettings(updated)
        })
    }
    private func valueSlider(_ label: String, value: Binding<Double>, in range: ClosedRange<Double>, id: String) -> some View {
        HStack(spacing: 14) {
            Text(label).font(.system(size: 14)).frame(width: 44, alignment: .leading)
            Button { value.wrappedValue = max(range.lowerBound, value.wrappedValue - 1) } label: {
                Image(systemName: "minus").frame(width: 28, height: 32)
            }.accessibilityLabel("减小\(label)")
            Slider(value: value, in: range, step: 1).accessibilityLabel(label).accessibilityIdentifier(id)
            Button { value.wrappedValue = min(range.upperBound, value.wrappedValue + 1) } label: {
                Image(systemName: "plus").frame(width: 28, height: 32)
            }.accessibilityLabel("增大\(label)")
            Text("\(Int(value.wrappedValue))").font(.system(size: 12)).monospacedDigit().frame(width: 23)
        }
    }
}

struct ReaderCatalogPanel: View {
    let chapters: [Chapter]
    let currentID: String?
    let onSelect: (Int) -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    private var filtered: [Chapter] { query.isEmpty ? chapters : chapters.filter { $0.title.localizedCaseInsensitiveContains(query) } }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List(filtered) { chapter in
                    Button {
                        if let index = chapters.firstIndex(where: { $0.id == chapter.id }) { onSelect(index) }
                    } label: {
                        HStack(spacing: 12) {
                            Text(chapter.title).font(.system(size: 15)).lineSpacing(5)
                            Spacer(minLength: 8)
                            if chapter.id == currentID { Image(systemName: "speaker.wave.1.fill").font(.system(size: 12)).foregroundStyle(Palette.cinnabar) }
                        }.foregroundStyle(chapter.id == currentID ? Palette.cinnabar : store.settings.activeTheme.foreground)
                            .padding(.vertical, 8)
                    }
                    .id(chapter.id).listRowBackground(store.settings.activeTheme.background)
                    .accessibilityIdentifier(chapter.id == currentID ? "reader.catalog.current" : "reader.catalog.chapter.\(chapter.index)")
                }
                .listStyle(.plain).scrollContentBackground(.hidden)
                .onAppear {
                    if let currentID { DispatchQueue.main.async { proxy.scrollTo(currentID, anchor: .center) } }
                }
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("当前章") { query = ""; if let currentID { withAnimation { proxy.scrollTo(currentID, anchor: .center) } } }
                            .accessibilityIdentifier("reader.catalog.locateCurrent")
                    }
                    ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                }
            }
            .searchable(text: $query, prompt: "查找章节")
            .background(store.settings.activeTheme.background)
            .navigationTitle("目录 · \(chapters.count)章").navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(store.settings.isNightMode ? .dark : .light)
    }
}

struct ReaderAudioPanel: View {
    @ObservedObject var speech: ReaderSpeechController
    let chapterTitle: String
    let chapterIndex: Int
    let chapterCount: Int
    @EnvironmentObject private var store: AppStore
    private var isPlaying: Bool { speech.state == .playing }
    var body: some View {
        VStack(spacing: 23) {
            HStack {
                Image(systemName: "headphones").font(.system(size: 21))
                Text("听书").font(.system(size: 21, weight: .semibold))
                Spacer()
                Button("停止") { speech.stop() }.font(.system(size: 13)).accessibilityIdentifier("reader.audio.stop")
            }
            VStack(spacing: 7) {
                Text(chapterTitle).font(.system(size: 16, weight: .medium)).lineLimit(1)
                Text(speech.state == .waiting ? "正在打开下一章…" : "第 \(speech.paragraphIndex + 1) / \(max(1, speech.paragraphCount)) 段 · 系统中文语音")
                    .font(.system(size: 12)).opacity(0.55)
            }
            HStack(spacing: 0) {
                audioButton("上一章", symbol: "backward.end", id: "reader.audio.previousChapter") { speech.requestChapter(-1) }.disabled(chapterIndex <= 0)
                audioButton("上一段", symbol: "gobackward", id: "reader.audio.previousParagraph") { speech.moveParagraph(-1) }
                Button { speech.toggle() } label: {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill").font(.system(size: 25))
                        .frame(width: 62, height: 62).foregroundStyle(store.settings.activeTheme.background)
                        .background(store.settings.activeTheme.foreground, in: Circle())
                }.accessibilityLabel(isPlaying ? "暂停听书" : "开始或继续听书").accessibilityIdentifier("reader.audio.playPause")
                    .disabled(speech.state == .waiting)
                audioButton("下一段", symbol: "goforward", id: "reader.audio.nextParagraph") { speech.moveParagraph(1) }
                audioButton("下一章", symbol: "forward.end", id: "reader.audio.nextChapter") { speech.requestChapter(1) }.disabled(chapterIndex >= chapterCount - 1)
            }
            HStack(spacing: 15) {
                Text("语速").font(.system(size: 13))
                Slider(value: Binding(get: { store.settings.speechRate }, set: { value in
                    var updated = store.settings; updated.speechRate = value; store.updateSettings(updated)
                }), in: 0.6...1.8, step: 0.1).accessibilityIdentifier("reader.audio.rate")
                Text(String(format: "%.1f×", store.settings.speechRate)).font(.system(size: 12)).monospacedDigit().frame(width: 36)
            }
            Text(speech.message ?? "锁屏后可继续收听，播完本章自动续章。退出阅读器后停止。")
                .font(.system(size: 11)).lineSpacing(4).opacity(0.55).multilineTextAlignment(.center)
        }
        .foregroundStyle(store.settings.activeTheme.foreground).padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(store.settings.activeTheme.background)
        .tint(Palette.cinnabar)
    }
    private func audioButton(_ label: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: symbol).font(.system(size: 18))
                Text(label).font(.system(size: 10))
            }.frame(maxWidth: .infinity).frame(height: 54)
        }.accessibilityIdentifier(id)
    }
}
