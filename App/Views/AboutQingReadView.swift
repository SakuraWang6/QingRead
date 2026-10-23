import SwiftUI
import UIKit
import ReadingCore

struct AboutQingReadView: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var checker = AboutUpdateChecker()
    @State private var information: AboutAppInformation?
    @State private var resourceError: String?
    private let installedVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知"
    private let installedBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未知"

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Text("清").font(.bookTitle(44)).foregroundStyle(Palette.cinnabar)
                        .frame(width: 76, height: 76).background(Palette.cinnabar.opacity(0.07), in: RoundedRectangle(cornerRadius: 18))
                    Text(information?.name ?? "清读").font(.bookTitle(26))
                    Text("版本 \(installedVersion)（\(installedBuild)）").font(.subheadline).foregroundStyle(Palette.secondary)
                        .accessibilityIdentifier("about.installed-version")
                }.frame(maxWidth: .infinity).padding(.vertical, 22)
                    .listRowBackground(Color.clear)
            }
            Section {
                Button {
                    checker.check(serverAddress: store.cloud.address, manifestPath: information?.update.manifestPath ?? "/qingread/releases.json",
                                  installedVersion: installedVersion, installedBuild: installedBuild)
                } label: {
                    HStack {
                        Label("检查更新", systemImage: "arrow.triangle.2.circlepath")
                        Spacer()
                        if checker.state == .checking { ProgressView() }
                    }
                }.disabled(checker.state == .checking).accessibilityIdentifier("about.check-update")
                if checker.state == .checking { Button("取消检查") { checker.cancel() } }
                if let information {
                    NavigationLink { AboutReleaseNotesView(releases: information.releases) } label: { Label("更新日志", systemImage: "list.bullet.rectangle") }
                    NavigationLink { AboutHelpView(items: information.help) } label: { Label("使用说明", systemImage: "questionmark.circle") }
                    NavigationLink {
                        AboutFeedbackView(url: information.feedbackURL, information: feedbackInformation)
                    } label: { Label("问题反馈", systemImage: "bubble.left") }
                    NavigationLink { AboutLicensesView(name: information.license.name) } label: { Label("许可说明", systemImage: "doc.text") }
                }
            } footer: { updateStatus }
            if let resourceError { Section { Text(resourceError).font(.footnote).foregroundStyle(.red) } }
        }
        .scrollContentBackground(.hidden).background(Palette.paper).foregroundStyle(Palette.ink).tint(Palette.cinnabar)
        .navigationTitle("关于清读").navigationBarTitleDisplayMode(.inline)
        .task {
            do { information = try AboutAppInformation.load() }
            catch { resourceError = "本地说明暂时无法读取。" }
        }
        .onDisappear { checker.cancel() }
    }

    @ViewBuilder private var updateStatus: some View {
        switch checker.state {
        case .idle: EmptyView()
        case .checking: Text("正在检查…")
        case .current: Text("已是最新版本")
        case .installedNewer: Text("当前安装版本高于已发布版本")
        case .failed(let message): Text(message).foregroundStyle(.red)
        case .available(let release):
            VStack(alignment: .leading, spacing: 7) {
                Text("发现新版本 \(release.version)（\(release.build)）").fontWeight(.medium)
                Text("请在 Mac 上通过现有签名流程更新到 iPhone。")
                ForEach(Array(release.notes.enumerated()), id: \.offset) { _, note in Text("· \(note)") }
            }
        }
    }

    private var feedbackInformation: AppFeedbackInformation {
        let category: String
        switch UIDevice.current.userInterfaceIdiom {
        case .phone: category = "iPhone"
        case .pad: category = "iPad"
        default: category = "其他"
        }
        return AppFeedbackInformation(version: installedVersion, build: installedBuild,
                                      systemVersion: UIDevice.current.systemVersion, deviceCategory: category)
    }
}

private struct AboutAppInformation: Decodable {
    let schemaVersion: Int
    let name: String
    let feedbackURL: URL
    let license: License
    let update: Update
    let releases: [Release]
    let help: [Help]
    struct License: Decodable { let name: String }
    struct Update: Decodable { let manifestPath: String }
    struct Release: Decodable { let version: String; let date: String; let changes: [String] }
    struct Help: Decodable, Identifiable { let id: String; let title: String; let body: String }

    static func load() throws -> Self {
        guard let url = Bundle.main.url(forResource: "AppInfo", withExtension: "json") else { throw AppUpdateError.invalidManifest }
        let information = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard information.schemaVersion == 1, information.feedbackURL.scheme == "https",
              information.feedbackURL.host == "github.com", information.feedbackURL.path == "/SakuraWang6/QingRead/issues/new" else { throw AppUpdateError.invalidManifest }
        return information
    }
}

private struct AboutReleaseNotesView: View {
    let releases: [AboutAppInformation.Release]
    var body: some View {
        List {
            ForEach(Array(releases.enumerated()), id: \.offset) { _, release in
                Section {
                    ForEach(Array(release.changes.enumerated()), id: \.offset) { _, change in Text(change).font(.body).padding(.vertical, 3) }
                } header: { HStack { Text(release.version); Spacer(); Text(release.date) } }
            }
        }
        .scrollContentBackground(.hidden).background(Palette.paper).foregroundStyle(Palette.ink)
        .navigationTitle("更新日志").navigationBarTitleDisplayMode(.inline)
    }
}

private struct AboutHelpView: View {
    let items: [AboutAppInformation.Help]
    var body: some View {
        List(items) { item in
            DisclosureGroup(item.title) { Text(item.body).font(.subheadline).foregroundStyle(Palette.secondary).lineSpacing(5).padding(.vertical, 5) }
        }
        .scrollContentBackground(.hidden).background(Palette.paper).foregroundStyle(Palette.ink).tint(Palette.cinnabar)
        .navigationTitle("使用说明").navigationBarTitleDisplayMode(.inline)
    }
}

private struct AboutFeedbackView: View {
    let url: URL
    let information: AppFeedbackInformation
    @State private var copied = false
    var body: some View {
        List {
            Section {
                Link(destination: url) { Label("提交问题", systemImage: "square.and.pencil") }
            }
            Section("反馈信息") {
                Text(information.text).font(.subheadline).lineSpacing(5).textSelection(.enabled)
                Button(copied ? "已复制" : "复制反馈信息") { UIPasteboard.general.string = information.text; copied = true }
                    .accessibilityIdentifier("about.copy-feedback")
            }
        }
        .scrollContentBackground(.hidden).background(Palette.paper).foregroundStyle(Palette.ink).tint(Palette.cinnabar)
        .navigationTitle("问题反馈").navigationBarTitleDisplayMode(.inline)
    }
}

private struct AboutLicensesView: View {
    let name: String
    var body: some View {
        List {
            Section {
                NavigationLink { AboutLegalDocumentView(title: "项目许可", resource: "ProjectLicense") } label: {
                    VStack(alignment: .leading, spacing: 5) { Text("项目许可"); Text(name).font(.footnote).foregroundStyle(Palette.secondary) }
                }
                NavigationLink("第三方声明") { AboutLegalDocumentView(title: "第三方声明", resource: "ThirdPartyNotices") }
            }
        }
        .scrollContentBackground(.hidden).background(Palette.paper).foregroundStyle(Palette.ink)
        .navigationTitle("许可说明").navigationBarTitleDisplayMode(.inline)
    }
}

private struct AboutLegalDocumentView: View {
    let title: String
    let resource: String
    @State private var contents = ""
    var body: some View {
        AboutSelectableDocument(text: contents).background(Palette.paper)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .task {
                guard let url = Bundle.main.url(forResource: resource, withExtension: "txt"),
                      let data = try? Data(contentsOf: url), data.count <= 1024 * 1024,
                      let text = String(data: data, encoding: .utf8) else { contents = "本地文件暂时无法读取。"; return }
                contents = text
            }
    }
}

private struct AboutSelectableDocument: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false; view.isSelectable = true
        view.backgroundColor = UIColor(Palette.paper); view.textColor = UIColor(Palette.ink)
        view.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 20, left: 16, bottom: 24, right: 16)
        return view
    }
    func updateUIView(_ uiView: UITextView, context: Context) { if uiView.text != text { uiView.text = text } }
}

@MainActor private final class AboutUpdateChecker: ObservableObject {
    enum State: Equatable { case idle, checking, current, installedNewer, available(IOSAppRelease), failed(String) }
    @Published private(set) var state = State.idle
    private var operation: Task<Void, Never>?
    private var generation = UUID()

    func check(serverAddress: String, manifestPath: String, installedVersion: String, installedBuild: String) {
        cancel()
        let currentGeneration = UUID(); generation = currentGeneration
        state = .checking
        operation = Task { [weak self] in
            do {
                let url = try AppUpdateEndpoint.url(serverAddress: serverAddress, manifestPath: manifestPath)
                let release = try await AboutUpdateClient.fetch(url)
                try Task.checkCancellation()
                guard let self, self.generation == currentGeneration else { return }
                switch try release.compare(installedVersion: installedVersion, installedBuild: installedBuild) {
                case .available: self.state = .available(release)
                case .current: self.state = .current
                case .installedNewer: self.state = .installedNewer
                }
                self.operation = nil
            } catch {
                guard !Task.isCancelled, let self, self.generation == currentGeneration else { return }
                if let error = error as? AppUpdateError { self.state = .failed(error.localizedDescription) }
                else if (error as? URLError)?.code == .timedOut { self.state = .failed("检查超时，请稍后重试。") }
                else { self.state = .failed("检查失败，请检查网络后重试。") }
                self.operation = nil
            }
        }
    }

    func cancel() {
        generation = UUID(); operation?.cancel(); operation = nil
        if state == .checking { state = .idle }
    }
}

private final class AboutUpdateRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private enum AboutUpdateClient {
    static func fetch(_ url: URL) async throws -> IOSAppRelease {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12; configuration.timeoutIntervalForResource = 15
        configuration.httpShouldSetCookies = false; configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: AboutUpdateRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw AppUpdateError.unavailable }
        guard response.expectedContentLength <= 64 * 1024 else { throw AppUpdateError.responseTooLarge }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 64 * 1024 else { throw AppUpdateError.responseTooLarge }
            data.append(byte)
        }
        return try IOSAppRelease.parse(data)
    }
}
