import AppKit
import SwiftUI
import PIICore
import UpdateInstall

/// Checks GitHub for a newer release and installs it in place.
///
/// This is the ONLY file in the app that touches the network, and it talks only to the
/// hosts in `UpdateCheck.allowedHosts` (GitHub's API, release page and asset CDN).
/// `NoNetworkTests` pins both facts. Logs never go anywhere: the check is a GET of the
/// latest-release JSON, the install is a GET of the release zip, and nothing is posted.
///
/// Schedule: once at launch (a dialog offers the update) and whenever the popover is
/// opened (an "Install Update" button appears), at most once an hour across launches.
/// `--install-update` on the command line checks right away and installs without asking.
///
/// Install: download the zip, unpack it with `ditto`, check that it is an Obfuscate bundle
/// of the expected version signed by the same team as the running app, swap it into the
/// folder the app lives in (normally /Applications, writable by an admin user), relaunch
/// and quit. The checks and the swap are `UpdateInstall`.
@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()

    enum Phase: Equatable {
        case idle
        case checking
        case downloading
        case installing
        case failed(String)
    }

    /// A release newer than the running app, once a check has found one.
    @Published private(set) var available: UpdateRelease?
    @Published private(set) var phase: Phase = .idle

    private enum Keys {
        static let lastCheck = "updater.lastCheck"
        static let cachedRelease = "updater.cachedRelease"
    }

    private let defaults = UserDefaults.standard
    private var progressPanel: NSPanel?

    private init() {
        // An earlier 0.9.4 kept a security-scoped bookmark for the app's folder; nothing needs it now.
        defaults.removeObject(forKey: "updater.folderBookmark")
    }

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    /// Why the last install failed, until the next attempt.
    var failureMessage: String? {
        if case .failed(let message) = phase { return message }
        return nil
    }

    var isWorking: Bool {
        switch phase {
        case .checking, .downloading, .installing: return true
        case .idle, .failed: return false
        }
    }

    // MARK: Checking

    /// At launch: check (if due) and offer the update in a dialog.
    func checkAtLaunch() { check(offerInDialog: true) }

    /// When the popover opens: check (if due); the view shows the Install Update button.
    func checkOnPopoverOpen() { check(offerInDialog: false) }

    /// `--install-update`: check now, ignoring the hourly limit, and install without asking.
    /// A failure is reported in the usual dialog; "already up to date" only goes to the log.
    func installLatestNow() {
        guard isWorking == false else { return }
        phase = .checking
        let userAgent = self.userAgent
        Task { [weak self] in
            guard let self else { return }
            do {
                let rel = try await UpdateInstaller.fetchLatest(userAgent: userAgent)
                self.phase = .idle
                guard UpdateCheck.isNewer(rel.version, than: self.currentVersion) else {
                    NSLog("Obfuscate --install-update: \(rel.version) is not newer than \(self.currentVersion)")
                    return
                }
                self.available = rel
                self.install(rel)
            } catch {
                self.fail("Could not check for an update: \(error.localizedDescription)")
            }
        }
    }

    private func check(offerInDialog: Bool) {
        guard isWorking == false else { return }
        let last = defaults.object(forKey: Keys.lastCheck) as? Date
        guard UpdateCheck.isCheckDue(lastCheck: last) else {
            // Within the hour: reuse what the last check found, without touching the network.
            if available == nil, let data = defaults.data(forKey: Keys.cachedRelease),
               let rel = try? JSONDecoder().decode(UpdateRelease.self, from: data),
               UpdateCheck.isNewer(rel.version, than: currentVersion) {
                available = rel
            }
            return
        }
        defaults.set(Date(), forKey: Keys.lastCheck)
        phase = .checking
        let userAgent = self.userAgent
        Task { [weak self] in
            guard let self else { return }
            do {
                let rel = try await UpdateInstaller.fetchLatest(userAgent: userAgent)
                self.defaults.set(try? JSONEncoder().encode(rel), forKey: Keys.cachedRelease)
                self.phase = .idle
                if UpdateCheck.isNewer(rel.version, than: self.currentVersion) {
                    self.available = rel
                    if offerInDialog { self.offerInDialog(rel) }
                } else {
                    self.available = nil
                }
            } catch {
                // Nobody asked for this check, so a failure (offline, rate-limited) stays quiet.
                self.phase = .idle
                NSLog("Obfuscate update check failed: \(error)")
            }
        }
    }

    private var userAgent: String { "Obfuscate/\(currentVersion) (macOS; +\(UpdateCheck.projectPageURL.absoluteString))" }

    private func offerInDialog(_ rel: UpdateRelease) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Obfuscate \(rel.version) is available"
        a.informativeText = "You have \(currentVersion). Download and install the update now? Obfuscate restarts when it is done."
        a.addButton(withTitle: "Install Update")
        a.addButton(withTitle: "Later")
        if a.runModal() == .alertFirstButtonReturn { install(rel) }
    }

    // MARK: Installing

    func install(_ rel: UpdateRelease) {
        guard isWorking == false else { return }
        let appURL = Bundle.main.bundleURL
        if appURL.pathExtension != "app" {
            fail("Obfuscate is not running from an app bundle, so it cannot update itself."); return
        }
        if appURL.path.contains("/AppTranslocation/") {
            fail("Move Obfuscate to your Applications folder first, then update."); return
        }
        phase = .downloading
        showProgressPanel()
        let teamID = UpdateInstall.ownTeamIdentifier()
        let expectedBundleID = Bundle.main.bundleIdentifier ?? "com.obfuscate.app"
        let userAgent = self.userAgent
        Task { [weak self] in
            guard let self else { return }
            do {
                let staged = try await Task.detached(priority: .userInitiated) {
                    try await UpdateInstaller.downloadAndStage(rel, userAgent: userAgent, teamID: teamID, bundleID: expectedBundleID)
                }.value
                let stagingRoot = staged.deletingLastPathComponent().deletingLastPathComponent()
                self.phase = .installing
                try UpdateInstall.stripQuarantine(staged)
                try UpdateInstall.swap(staged: staged, into: appURL)
                try? FileManager.default.removeItem(at: stagingRoot)
                self.relaunch(appURL, version: rel.version)
            } catch {
                self.fail("Could not install \(rel.version): \(error.localizedDescription)")
            }
        }
    }

    /// Starts the freshly installed copy; this one quits once that has been attempted.
    private func relaunch(_ appURL: URL, version: String) {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        cfg.activates = false
        NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { _, error in
            Task { @MainActor in
                if let error = error {
                    self.fail("Obfuscate \(version) is installed, but it could not be relaunched: \(error.localizedDescription). Open it again from \(appURL.deletingLastPathComponent().lastPathComponent).")
                }
                NSApp.terminate(nil)
            }
        }
    }

    private func fail(_ message: String) {
        phase = .failed(message)
        hideProgressPanel()
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "Update failed"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        if let page = available?.pageURL {
            a.addButton(withTitle: "Open Release Page")
            if a.runModal() == .alertSecondButtonReturn { NSWorkspace.shared.open(page) }
        } else {
            a.runModal()
        }
    }

    // MARK: Progress panel (the popover closes when focus moves, so progress lives in its own window)

    private func showProgressPanel() {
        if progressPanel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 80),
                                styleMask: [.titled, .utilityWindow], backing: .buffered, defer: false)
            panel.title = "Obfuscate Update"
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            panel.contentView = NSHostingView(rootView: UpdateProgressView(updater: self))
            panel.center()
            progressPanel = panel
        }
        progressPanel?.orderFrontRegardless()
    }

    private func hideProgressPanel() {
        progressPanel?.orderOut(nil)
    }
}

/// The non-UI half of the install, kept outside the main actor so it can run on a background task.
enum UpdateInstaller {
    /// Downloads, unpacks and checks the release. Returns the staged .app inside a fresh
    /// temporary directory (the caller removes that directory). Runs off the main thread.
    static func downloadAndStage(_ rel: UpdateRelease, userAgent: String, teamID: String?, bundleID: String) async throws -> URL {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("ObfuscateUpdate-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        do {
            let zip = try await download(rel, userAgent: userAgent, into: dir)
            let unpacked = dir.appendingPathComponent("unpacked", isDirectory: true)
            try fm.createDirectory(at: unpacked, withIntermediateDirectories: true)
            try run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path])
            try? fm.removeItem(at: zip)
            let apps = try fm.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "app" }
            guard apps.count == 1, let app = apps.first else {
                throw UpdaterError.badArchive("expected one .app in the zip, found \(apps.count)")
            }
            try UpdateInstall.checkBundle(app, version: rel.version, bundleID: bundleID)
            try UpdateInstall.verifySignature(of: app, teamID: teamID)
            return app
        } catch {
            try? fm.removeItem(at: dir)
            throw error
        }
    }

    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    static func request(_ url: URL, userAgent: String, timeout: TimeInterval) throws -> URLRequest {
        guard url.scheme == "https", let host = url.host, UpdateCheck.allowedHosts.contains(host) else {
            throw UpdaterError.refusedHost(url.host ?? url.absoluteString)
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        return req
    }

    static func fetchLatest(userAgent: String) async throws -> UpdateRelease {
        var req = try request(UpdateCheck.latestReleaseURL, userAgent: userAgent, timeout: 15)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: req, delegate: HostGuard.shared)
        guard let http = response as? HTTPURLResponse else { throw UpdaterError.badResponse("no HTTP response") }
        guard http.statusCode == 200 else { throw UpdaterError.badResponse("HTTP \(http.statusCode) from \(UpdateCheck.latestReleaseURL.host ?? "GitHub")") }
        return try UpdateCheck.parseLatest(data)
    }

    static func download(_ rel: UpdateRelease, userAgent: String, into dir: URL) async throws -> URL {
        let req = try request(rel.assetURL, userAgent: userAgent, timeout: 120)
        let (tmp, response) = try await session.download(for: req, delegate: HostGuard.shared)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            try? FileManager.default.removeItem(at: tmp)
            let http = response as? HTTPURLResponse
            if let http, (300..<400).contains(http.statusCode),
               let target = http.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)) {
                // HostGuard declined the hop: GitHub is sending downloads somewhere new.
                throw UpdaterError.refusedHost(target.host ?? target.absoluteString)
            }
            throw UpdaterError.badResponse("HTTP \(http?.statusCode ?? 0) downloading \(rel.assetURL.lastPathComponent)")
        }
        // The temporary file does not outlive this call; keep it under our own directory.
        let zip = dir.appendingPathComponent(UpdateCheck.assetName(for: rel.version))
        try FileManager.default.moveItem(at: tmp, to: zip)
        return zip
    }

    /// Redirects (github.com asset links go to a githubusercontent.com CDN host) may only land on
    /// allowed hosts. A refused redirect is not followed, so the caller sees the 3xx response itself.
    final class HostGuard: NSObject, URLSessionTaskDelegate {
        static let shared = HostGuard()
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            if let url = request.url, url.scheme == "https", let host = url.host, UpdateCheck.allowedHosts.contains(host) {
                completionHandler(request)
            } else {
                completionHandler(nil)
            }
        }
    }

    static func run(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw UpdaterError.toolFailed("\(URL(fileURLWithPath: tool).lastPathComponent) exited with \(p.terminationStatus)")
        }
    }
}

enum UpdaterError: LocalizedError {
    case refusedHost(String)
    case badResponse(String)
    case badArchive(String)
    case toolFailed(String)

    var errorDescription: String? {
        switch self {
        case .refusedHost(let h): return "refusing to talk to \(h)"
        case .badResponse(let m), .badArchive(let m), .toolFailed(let m): return m
        }
    }
}

struct UpdateProgressView: View {
    @ObservedObject var updater: Updater

    private var title: String {
        switch updater.phase {
        case .downloading: return "Downloading Obfuscate \(updater.available?.version ?? "")…"
        case .installing: return "Installing…"
        case .failed: return "Update failed"
        case .checking, .idle: return "Updating…"
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text("Obfuscate restarts when the update is installed.").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(width: 360)
    }
}
