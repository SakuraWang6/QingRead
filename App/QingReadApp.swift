import SwiftUI

@main
struct QingReadApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .tint(Palette.cinnabar)
        }
    }
}

private struct RootView: View {
    @State private var selectedTab = 0
    #if DEBUG
    @State private var previewConfigured = false
    @State private var showPreviewReader = false
    #endif

    @ViewBuilder
    var body: some View {
        #if DEBUG
        tabContent
            .task {
                guard !previewConfigured else { return }
                previewConfigured = true
                let arguments = ProcessInfo.processInfo.arguments
                guard let flag = arguments.firstIndex(of: "--qingread-preview"),
                      arguments.indices.contains(flag + 1) else { return }
                switch arguments[flag + 1] {
                case "search": selectedTab = 1
                case "sources": selectedTab = 2
                case "reader": showPreviewReader = true
                default: break
                }
            }
            .fullScreenCover(isPresented: $showPreviewReader) { ReaderView(book: LocalSample.book) }
        #else
        tabContent
        #endif
    }

    private var tabContent: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { LibraryView() }
                .tabItem { Label("书架", systemImage: "books.vertical") }
                .tag(0)
            NavigationStack { SearchView() }
                .tabItem { Label("搜书", systemImage: "magnifyingglass") }
                .tag(1)
            NavigationStack { SourcesView() }
                .tabItem { Label("书源", systemImage: "square.stack.3d.up") }
                .tag(2)
        }
        .toolbarBackground(Palette.paper, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .preferredColorScheme(.light)
    }
}
