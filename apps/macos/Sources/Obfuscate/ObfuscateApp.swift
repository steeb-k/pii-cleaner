import SwiftUI

/// Launch hook: the update check runs once the app is up (see Updater). Launched with
/// `--install-update` (`open Obfuscate.app --args --install-update`), the app instead checks
/// right away and installs whatever newer release it finds, with no dialog: the way to
/// exercise the whole update path from a terminal.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--install-update") {
            Updater.shared.installLatestNow()
        } else {
            Updater.shared.checkAtLaunch()
        }
    }
}

@main
struct ObfuscateApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            ContentView(state: state, updater: Updater.shared)
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
