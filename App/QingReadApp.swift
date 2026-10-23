import SwiftUI
import Darwin
import ReadingCore

@main
struct QingReadApp: App {
    @UIApplicationDelegateAdaptor(QingReadApplicationDelegate.self) private var applicationDelegate
    @StateObject private var store: AppStore
    init() {
        let instance = AppStore()
        _store = StateObject(wrappedValue: instance)
        QingReadApplicationDelegate.store = instance
    }
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task { await store.cloud.start() }
                .onChange(of: scenePhase) { phase in
                    if phase == .background {
                        store.pauseDownloadsForBackground()
                        QingReadApplicationDelegate.scheduleRefresh(enabled: store.notificationPreferences.updates)
                    }
                    if phase == .active {
                        Task {
                            await store.cloud.sync()
                            guard UIApplication.shared.applicationState == .active else { return }
                            await store.checkShelfUpdates()
                        }
                    }
                }
                .tint(Palette.cinnabar)
        }
    }
}

private struct RootView: View {
    @State private var selectedTab = 0
    @EnvironmentObject private var store: AppStore
    @State private var importedBook: ReadingCore.Book?
    @State private var importError: String?
    #if DEBUG
    @State private var previewConfigured = false
    @State private var showPreviewReader = false
    @State private var showPreviewAbout = false
    #endif

    @ViewBuilder
    var body: some View {
        #if DEBUG
        tabContent
            .task {
                guard !previewConfigured else { return }
                previewConfigured = true
                let arguments = ProcessInfo.processInfo.arguments
                if arguments.contains(where: { $0.hasSuffix("self-test") }) { setbuf(stdout, nil) }
                if arguments.contains("--reader-self-test") {
                    FileHandle.standardOutput.write(Data("QINGREAD_READER_STARTUP stage=root-task uptime=\(ProcessInfo.processInfo.systemUptime)\n".utf8))
                }
                if arguments.contains("--storage-self-test") { await StoreDiagnostics.run() }
                if arguments.contains("--cover-self-test") { await CoverDiagnostics.run() }
                if arguments.contains("--ai-self-test") { await AIVoiceDiagnostics.run(downloadModel: arguments.contains("--download-ai-model")) }
                if arguments.contains("--kokoro-self-test") { await AIVoiceDiagnostics.run(downloadModel: arguments.contains("--download-ai-model"), kind: .kokoro) }
                guard let flag = arguments.firstIndex(of: "--qingread-preview"),
                      arguments.indices.contains(flag + 1) else { return }
                switch arguments[flag + 1] {
                case "search": selectedTab = 1
                case "sources": selectedTab = 2
                case "recommendations": selectedTab = 3
                case "categories": selectedTab = 4
                case "reader": showPreviewReader = true
                case "about": selectedTab = 2; showPreviewAbout = true
                default: break
                }
            }
            .fullScreenCover(isPresented: $showPreviewReader) { ReaderView(book: LocalSample.book) }
            .fullScreenCover(isPresented: $showPreviewAbout) { NavigationStack { AboutQingReadView() } }
        #else
        tabContent
        #endif
    }

    private var tabContent: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { LibraryView() }
                .tabItem { Label("书架", systemImage: "books.vertical") }
                .tag(0)
            NavigationStack { RecommendationsView() }
                .tabItem { Label("推荐", systemImage: "sparkles") }
                .tag(3)
            NavigationStack { CategoriesView() }
                .tabItem { Label("分类", systemImage: "square.grid.2x2") }
                .tag(4)
            NavigationStack { SearchView() }
                .tabItem { Label("搜书", systemImage: "magnifyingglass") }
                .tag(1)
            NavigationStack { SettingsView() }
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(2)
        }
        .onChange(of: store.notificationBook?.id) { _ in
            if let book = store.notificationBook { selectedTab = 0; importedBook = book; store.notificationBook = nil }
        }
        .toolbarBackground(Palette.paper, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .preferredColorScheme(.light)
        .onOpenURL { url in
            Task {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                do { importedBook = try await store.importPublication(at: url) }
                catch { importError = error.localizedDescription }
            }
        }
        .fullScreenCover(item: $importedBook) { BookReadingView(book: $0) }
        .alert("导入未完成", isPresented: Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })) {
            Button("好") { importError = nil }
        } message: { Text(importError ?? "") }
    }
}
