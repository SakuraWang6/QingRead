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
    var body: some View {
        TabView {
            NavigationStack { LibraryView() }
                .tabItem { Label("书架", systemImage: "books.vertical") }
            NavigationStack { SearchView() }
                .tabItem { Label("搜书", systemImage: "magnifyingglass") }
            NavigationStack { SourcesView() }
                .tabItem { Label("书源", systemImage: "square.stack.3d.up") }
        }
        .toolbarBackground(Palette.paper, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .preferredColorScheme(.light)
    }
}
