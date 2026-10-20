import SwiftUI
import UniformTypeIdentifiers
import ReadingCore

struct SourcesView: View {
    @EnvironmentObject private var store: AppStore
    @State private var showFilePicker = false
    @State private var showTextImport = false
    @State private var showFormat = false
    @State private var showClearConfirmation = false
    @State private var removingSource: SourceDefinition?
    @State private var importMessage: String?
    @State private var importFailed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("已启用 \(store.enabledSourceIDs.count) / \(store.sources.count)")
                        .font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.secondary)
                    Spacer()
                    Menu {
                        Button { showFilePicker = true } label: { Label("从 JSON 文件导入", systemImage: "doc") }
                        Button { showTextImport = true } label: { Label("粘贴 JSON 规则", systemImage: "doc.on.clipboard") }
                    } label: {
                        Label("导入", systemImage: "plus").font(.system(size: 14)).foregroundStyle(Palette.cinnabar)
                    }
                }

                VStack(spacing: 0) {
                    ForEach(store.sources) { source in
                        VStack(alignment: .leading, spacing: 9) {
                            Toggle(isOn: Binding(get: { !store.disabledSourceIDs.contains(source.id) }, set: { store.setEnabled($0, source: source) })) {
                                Text(source.name).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.ink)
                            }.tint(Palette.cinnabar)
                            HStack {
                                Link(destination: source.homeURL) {
                                    Label(source.homeURL.host ?? source.homeURL.absoluteString, systemImage: "arrow.up.right")
                                        .font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
                                }
                                Spacer()
                                if !store.isBuiltIn(source) {
                                    Button(role: .destructive) { removingSource = source } label: {
                                        Image(systemName: "trash").font(.subheadline)
                                    }.accessibilityLabel("删除书源 \(source.name)")
                                }
                            }
                        }.padding(16)
                        if source.id != store.sources.last?.id { Divider().padding(.horizontal, 18) }
                    }
                }
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Palette.rule, lineWidth: 0.5))

                if let importMessage { InlineNotice(message: importMessage, isError: importFailed) }
                if let storageMessage = store.storageMessage { InlineNotice(message: storageMessage, isError: true) }

                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        Text("书源规则").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.ink)
                        Spacer()
                        Button("查看格式") { showFormat = true }.font(.system(size: 13))
                    }
                }
                Divider().overlay(Palette.rule)
                VStack(alignment: .leading, spacing: 14) {
                    Text("本地储存").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.ink)
                    HStack {
                        Text("章节缓存").font(.system(size: 14)).foregroundStyle(Palette.secondary)
                        Spacer()
                        Text(store.cacheSizeDescription).font(.system(size: 13).monospacedDigit()).foregroundStyle(Palette.secondary)
                        Button("清理") { showClearConfirmation = true }.font(.system(size: 13)).foregroundStyle(Palette.cinnabar).padding(.leading, 8)
                    }
                }
            }.padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 24)
        }
        .background(Palette.paper)
        .navigationTitle("书源").navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.json, .plainText]) { result in
            switch result {
            case .success(let url):
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do { try importData(Data(contentsOf: url)) }
                catch { importFailed = true; importMessage = error.localizedDescription }
            case .failure(let error):
                importFailed = true
                importMessage = "文件读取失败：\(error.localizedDescription)"
            }
        }
        .sheet(isPresented: $showTextImport) {
            SourceTextImportView { data in try importData(data) }
        }
        .sheet(isPresented: $showFormat) { SourceFormatView() }
        .confirmationDialog("清理所有已缓存的网络章节？", isPresented: $showClearConfirmation, titleVisibility: .visible) {
            Button("清理缓存", role: .destructive) { store.clearCache() }
            Button("取消", role: .cancel) { }
        } message: { Text("书架和阅读进度会保留，本地示例仍可阅读。") }
        .confirmationDialog("删除这个书源？", isPresented: Binding(get: { removingSource != nil }, set: { if !$0 { removingSource = nil } }), titleVisibility: .visible) {
            Button("删除书源", role: .destructive) {
                if let source = removingSource { store.removeSource(source) }
                removingSource = nil
            }
            Button("取消", role: .cancel) { removingSource = nil }
        } message: { Text("已缓存的书仍然保留；未缓存章节需要重新导入书源才能获取。") }
    }

    private func importData(_ data: Data) throws {
        let count = try store.importSources(data: data)
        importFailed = false
        importMessage = "已导入 \(count) 个书源并启用。同 ID 的导入书源已更新。"
    }
}

private struct SourceTextImportView: View {
    let onImport: (Data) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("粘贴一个书源对象或书源数组。规则只在本机保存。")
                    .font(.footnote).foregroundStyle(Palette.secondary)
                TextEditor(text: $text)
                    .font(.system(size: 13, design: .monospaced))
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .padding(8).background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.rule))
                    .accessibilityLabel("书源 JSON 规则")
                if let errorMessage { InlineNotice(message: errorMessage, isError: true) }
            }.padding(22).background(Palette.paper)
                .navigationTitle("粘贴书源").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("导入") {
                            do { try onImport(Data(text.utf8)); dismiss() }
                            catch { errorMessage = error.localizedDescription }
                        }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
        }
    }
}

private struct SourceFormatView: View {
    @Environment(\.dismiss) private var dismiss
    private let example = """
    {
      "id": "my-wikisource",
      "name": "我的维基文库",
      "summary": "公版文学作品",
      "homeURL": "https://zh.wikisource.org",
      "kind": "mediaWiki",
      "apiURL": "https://zh.wikisource.org/w/api.php"
    }
    """

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("每个书源需要唯一 ID、名称、网址和类型。以下是可导入的 MediaWiki 示例；它与内置书源访问同一个网站。")
                        .font(.subheadline).foregroundStyle(Palette.secondary).lineSpacing(5)
                    Text(example).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
                    Text("网页书源使用 kind: html，并在 html 中配置 searchURL、resultSelector、titleSelector、linkSelector、chapterSelector、contentSelector。搜索地址用 {query} 代表搜索词。规则只支持声明式解析，不执行脚本。完整示例见仓库 Sources 配置说明。")
                        .font(.footnote).foregroundStyle(Palette.secondary).lineSpacing(5)
                }.padding(22)
            }.background(Palette.paper)
                .navigationTitle("书源规则").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
