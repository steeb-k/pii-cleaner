import SwiftUI

@main
struct ObfuscateApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            ContentView(state: state)
        } label: {
            // MenuBarIcon.image is a template image, so it follows the menu bar's
            // light/dark appearance. A small warning badge is added when the last
            // sanitize reported possible leaks.
            if state.lastLeaks.isEmpty {
                Image(nsImage: MenuBarIcon.image)
            } else {
                HStack(spacing: 2) {
                    Image(nsImage: MenuBarIcon.image)
                    Image(systemName: "exclamationmark.triangle.fill")
                }
            }
        }
        .menuBarExtraStyle(.window)
    }
}
