import AppKit
import UpdateInstall

/// ObfuscateUpdater: the unsandboxed half of the in-app update. Obfuscate downloads, unpacks
/// and checks a release inside its sandbox, then launches this helper (nested in its own
/// bundle, started through LaunchServices so it does not inherit the sandbox) and quits.
/// The helper checks the staged bundle again, clears the sandbox's quarantine, swaps it into
/// place, relaunches Obfuscate and exits. No networking; see Sources/UpdateInstall.
///
/// It is an app bundle, not a bare tool, because that is what LaunchServices launches, and it
/// runs an NSApplication so the launch is acknowledged before the work starts.
final class HelperDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.global(qos: .userInitiated).async { Helper.run() }
    }
}

enum Helper {
    static func run() {
        let args: HelperArguments
        do { args = try HelperArguments.parse(Array(CommandLine.arguments.dropFirst())) }
        catch { finish(error: error, relaunch: nil); return }
        NSLog("ObfuscateUpdater: installing \(args.version) from \(args.staged.path) into \(args.target.path)")
        do {
            // The app quits as soon as it has launched us; give it a moment to go.
            UpdateInstall.waitForExit(of: args.parentPID, timeout: 20)
            guard let bundleID = UpdateInstall.bundleIdentifier(of: args.target) else {
                throw UpdateInstallError.failed("\(args.target.lastPathComponent) is not an app bundle any more")
            }
            // The same checks the app made, repeated here: this process is the one with the
            // power to put something in Applications, so it trusts nothing it did not verify.
            try UpdateInstall.checkBundle(args.staged, version: args.version, bundleID: bundleID)
            try UpdateInstall.verifySignature(of: args.staged, teamID: UpdateInstall.ownTeamIdentifier())
            try UpdateInstall.stripQuarantine(args.staged)
            try UpdateInstall.swap(staged: args.staged, into: args.target)
            try? FileManager.default.removeItem(at: args.stagingRoot)
            NSLog("ObfuscateUpdater: installed \(args.version)")
            finish(error: nil, relaunch: args.target)
        } catch {
            try? FileManager.default.removeItem(at: args.stagingRoot)
            finish(error: error, relaunch: args.target)
        }
    }

    /// Relaunches the app (the new one, or the old one if the swap was undone), reports a
    /// failure in a dialog, and exits.
    static func finish(error: Error?, relaunch: URL?) {
        DispatchQueue.main.async {
            if let error {
                NSLog("ObfuscateUpdater: failed: \(error)")
                NSApp.activate(ignoringOtherApps: true)
                let a = NSAlert()
                a.alertStyle = .warning
                a.messageText = "Update failed"
                a.informativeText = error.localizedDescription
                a.addButton(withTitle: "OK")
                a.runModal()
            }
            guard let app = relaunch, FileManager.default.fileExists(atPath: app.path) else { exit(error == nil ? 0 : 1) }
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.createsNewApplicationInstance = true
            cfg.activates = false
            NSWorkspace.shared.openApplication(at: app, configuration: cfg) { _, launchError in
                if let launchError { NSLog("ObfuscateUpdater: could not relaunch \(app.path): \(launchError)") }
                exit(error == nil && launchError == nil ? 0 : 1)
            }
        }
    }
}

let application = NSApplication.shared
let delegate = HelperDelegate()
application.delegate = delegate
application.run()
