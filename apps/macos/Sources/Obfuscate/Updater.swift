import AppKit
import SwiftUI
import Security
import PIICore

/// Checks GitHub for a newer release and installs it in place.
///
/// This is the ONLY file in the app that touches the network, and it talks only to the
/// hosts in `UpdateCheck.allowedHosts` (GitHub's API, release page and asset CDN).
/// `NoNetworkTests` pins both facts. Logs never go anywhere: the check is a GET of the
/// latest-release JSON, the install is a GET of the release zip, and nothing is posted.
///
/// Schedule: once at launch (a dialog offers the update) and whenever the popover is
/// opened (an "Install Update" button appears), at most once an hour across launches.
///
/// Install: download the zip, unpack it with `ditto`, check that it is an Obfuscate bundle
/// of the expected version signed by the same team as the running app, swap it into the
/// folder the app lives in, relaunch and quit. The app is sandboxed, so writing to that
/// folder (normally /Applications) needs the user to allow it once in a folder panel; a
/// security-scoped bookmark remembers the grant for later updates.
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
        static let folderBookmark = "updater.folderBookmark"
    }

    private let defaults = UserDefaults.standard
    private var progressPanel: NSPanel?

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
        let teamID = UpdateInstaller.ownTeamIdentifier()
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
                guard let folder = try self.folderAccess(for: appURL) else {
                    // Declined in the folder panel: nothing was changed, and the button stays for later.
                    try? FileManager.default.removeItem(at: stagingRoot)
                    self.phase = .idle
                    self.hideProgressPanel()
                    return
                }
                defer { folder.stopAccessingSecurityScopedResource() }
                try UpdateInstaller.swap(staged: staged, into: appURL)
                try? FileManager.default.removeItem(at: stagingRoot)
                self.relaunch(appURL, version: rel.version)
            } catch {
                self.fail("Could not install \(rel.version): \(error.localizedDescription)")
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

    // MARK: The folder the app lives in

    /// Write access to the app's folder: the remembered grant if it still fits, otherwise a
    /// folder panel pointed at that folder (one click on Allow). nil = the user declined.
    /// The returned URL has security-scoped access started; the caller stops it.
    private func folderAccess(for appURL: URL) throws -> URL? {
        let parent = appURL.deletingLastPathComponent()
        if let data = defaults.data(forKey: Keys.folderBookmark) {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale),
               !stale, UpdateInstaller.sameFolder(url, parent), url.startAccessingSecurityScopedResource() {
                return url
            }
            defaults.removeObject(forKey: Keys.folderBookmark)
        }
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.message = "Obfuscate needs permission to replace itself in \"\(parent.lastPathComponent)\". Click Allow to continue the update."
        p.prompt = "Allow"
        p.directoryURL = parent
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = false
        p.allowsMultipleSelection = false
        guard p.runModal() == .OK, let picked = p.url else { return nil }
        guard UpdateInstaller.sameFolder(picked, parent) else {
            throw UpdaterError.wrongFolder("that is \"\(picked.lastPathComponent)\"; Obfuscate needs the folder it is in, \"\(parent.lastPathComponent)\"")
        }
        guard picked.startAccessingSecurityScopedResource() else { return nil }
        if let bm = try? picked.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) {
            defaults.set(bm, forKey: Keys.folderBookmark)
        }
        return picked
    }

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

    // MARK: Progress panel (the popover closes under the folder panel, so progress lives in its own window)

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
            try checkBundle(app, version: rel.version, bundleID: bundleID)
            try verifySignature(of: app, teamID: teamID)
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
            throw UpdaterError.badResponse("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0) downloading \(rel.assetURL.lastPathComponent)")
        }
        // The temporary file does not outlive this call; keep it under our own directory.
        let zip = dir.appendingPathComponent(UpdateCheck.assetName(for: rel.version))
        try FileManager.default.moveItem(at: tmp, to: zip)
        return zip
    }

    /// Redirects (github.com asset links go to objects.githubusercontent.com) may only land on allowed hosts.
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

    static func checkBundle(_ app: URL, version: String, bundleID: String) throws {
        let plistURL = app.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw UpdaterError.badArchive("the downloaded app has no readable Info.plist")
        }
        let id = plist["CFBundleIdentifier"] as? String ?? ""
        guard id == bundleID else { throw UpdaterError.badArchive("bundle identifier is \(id), expected \(bundleID)") }
        let v = plist["CFBundleShortVersionString"] as? String ?? ""
        guard v == version else { throw UpdaterError.badArchive("the downloaded app is version \(v), expected \(version)") }
    }

    /// The downloaded bundle must carry a valid signature; with a Developer ID build running,
    /// one from the same team (an ad-hoc dev build only checks integrity).
    static func verifySignature(of app: URL, teamID: String?) throws {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &staticCode) == errSecSuccess, let code = staticCode else {
            throw UpdaterError.signature("could not read the code signature")
        }
        var requirement: SecRequirement?
        if let team = teamID {
            let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
            guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
                throw UpdaterError.signature("could not build the signing requirement")
            }
        }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures))
        let status = SecStaticCodeCheckValidity(code, flags, requirement)
        guard status == errSecSuccess else {
            var why = "OSStatus \(status)"
            if let msg = SecCopyErrorMessageString(status, nil) { why = msg as String }
            throw UpdaterError.signature(teamID == nil ? "the download is not validly signed (\(why))"
                                                       : "the download is not signed by the same team as this app (\(why))")
        }
    }

    static func ownTeamIdentifier() -> String? {
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let c = selfCode else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(c, [], &staticCode) == errSecSuccess, let sc = staticCode else { return nil }
        var info: CFDictionary?
        let flags = SecCSFlags(rawValue: UInt32(kSecCSSigningInformation))
        guard SecCodeCopySigningInformation(sc, flags, &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return nil }
        let team = dict[kSecCodeInfoTeamIdentifier as String] as? String
        return (team?.isEmpty ?? true) ? nil : team
    }

    static func sameFolder(_ a: URL, _ b: URL) -> Bool {
        a.standardizedFileURL.resolvingSymlinksInPath().path == b.standardizedFileURL.resolvingSymlinksInPath().path
    }

    /// Puts the staged bundle where the running one is. The running app keeps working from
    /// its open files; the retired copy is removed, or left hidden if that fails.
    static func swap(staged: URL, into appURL: URL) throws {
        let fm = FileManager.default
        let parent = appURL.deletingLastPathComponent()
        let name = appURL.lastPathComponent
        let token = String(UUID().uuidString.prefix(8))
        let incoming = parent.appendingPathComponent(".\(name).update-\(token)")
        let retired = parent.appendingPathComponent(".\(name).old-\(token)")
        try fm.moveItem(at: staged, to: incoming)
        do { try fm.moveItem(at: appURL, to: retired) }
        catch { try? fm.removeItem(at: incoming); throw error }
        do { try fm.moveItem(at: incoming, to: appURL) }
        catch {
            try? fm.moveItem(at: retired, to: appURL)
            try? fm.removeItem(at: incoming)
            throw error
        }
        try? fm.removeItem(at: retired)
    }
}

enum UpdaterError: LocalizedError {
    case refusedHost(String)
    case badResponse(String)
    case badArchive(String)
    case toolFailed(String)
    case signature(String)
    case wrongFolder(String)

    var errorDescription: String? {
        switch self {
        case .refusedHost(let h): return "refusing to talk to \(h)"
        case .badResponse(let m), .badArchive(let m), .toolFailed(let m), .signature(let m), .wrongFolder(let m): return m
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
