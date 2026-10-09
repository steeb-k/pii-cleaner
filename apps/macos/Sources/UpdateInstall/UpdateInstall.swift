import Foundation
import Security

/// The install half of the updater, shared by the app (which downloads, unpacks and checks
/// a release inside its sandbox) and by the ObfuscateUpdater helper (which runs outside the
/// sandbox to strip the quarantine, swap the bundle in and relaunch). Foundation + Security,
/// no networking, no UI.
///
/// Why a helper: the App Sandbox stamps every file a sandboxed process writes with a
/// quarantine attribute carrying the sandbox flag, and macOS refuses to execute a binary that
/// carries it. The app cannot remove that attribute from inside the sandbox, so the bundle it
/// unpacks can never launch until an unsandboxed process clears it. Launching the helper
/// through LaunchServices gives it its own, unsandboxed, process.
public enum UpdateInstall {
    /// Where build-app.sh nests the helper, relative to the app bundle.
    public static let helperRelativePath = "Contents/Helpers/ObfuscateUpdater.app"
    public static let helperBundleIdentifier = "com.obfuscate.app.updater"
    public static let quarantineAttribute = "com.apple.quarantine"

    public static func bundleIdentifier(of app: URL) -> String? {
        infoPlist(of: app)?["CFBundleIdentifier"] as? String
    }

    static func infoPlist(of app: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")) else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }

    public static func checkBundle(_ app: URL, version: String, bundleID: String) throws {
        guard let plist = infoPlist(of: app) else {
            throw UpdateInstallError.badArchive("the downloaded app has no readable Info.plist")
        }
        let id = plist["CFBundleIdentifier"] as? String ?? ""
        guard id == bundleID else { throw UpdateInstallError.badArchive("bundle identifier is \(id), expected \(bundleID)") }
        let v = plist["CFBundleShortVersionString"] as? String ?? ""
        guard v == version else { throw UpdateInstallError.badArchive("the downloaded app is version \(v), expected \(version)") }
    }

    /// The bundle must carry a valid signature; with a Developer ID build running, one from the
    /// same team (an ad-hoc dev build only checks integrity).
    public static func verifySignature(of app: URL, teamID: String?) throws {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &staticCode) == errSecSuccess, let code = staticCode else {
            throw UpdateInstallError.signature("could not read the code signature")
        }
        var requirement: SecRequirement?
        if let team = teamID {
            let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
            guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
                throw UpdateInstallError.signature("could not build the signing requirement")
            }
        }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures))
        let status = SecStaticCodeCheckValidity(code, flags, requirement)
        guard status == errSecSuccess else {
            var why = "OSStatus \(status)"
            if let msg = SecCopyErrorMessageString(status, nil) { why = msg as String }
            throw UpdateInstallError.signature(teamID == nil ? "the download is not validly signed (\(why))"
                                                             : "the download is not signed by the same team as this app (\(why))")
        }
    }

    /// The team the running process is signed by; nil for an ad-hoc (dev) signature.
    public static func ownTeamIdentifier() -> String? {
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

    /// Removes the quarantine attribute from `root` and everything under it. Only an
    /// unsandboxed process can do this to files the sandbox marked.
    public static func stripQuarantine(_ root: URL) throws {
        var paths = [root.path]
        if let en = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: []) {
            for case let url as URL in en { paths.append(url.path) }
        }
        for path in paths {
            if removexattr(path, quarantineAttribute, XATTR_NOFOLLOW) != 0 && errno != ENOATTR {
                throw UpdateInstallError.failed("could not clear the quarantine on \(URL(fileURLWithPath: path).lastPathComponent): \(String(cString: strerror(errno)))")
            }
        }
    }

    public static func hasQuarantine(_ url: URL) -> Bool {
        getxattr(url.path, quarantineAttribute, nil, 0, 0, XATTR_NOFOLLOW) >= 0
    }

    public static func sameFolder(_ a: URL, _ b: URL) -> Bool {
        a.standardizedFileURL.resolvingSymlinksInPath().path == b.standardizedFileURL.resolvingSymlinksInPath().path
    }

    /// Puts the staged bundle where the current one is. A running copy keeps working from
    /// its open files; the retired copy is removed, or left hidden if that fails.
    public static func swap(staged: URL, into appURL: URL) throws {
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

    /// Blocks until the process is gone, or the timeout passes.
    public static func waitForExit(of pid: pid_t, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while kill(pid, 0) == 0 && Date() < deadline { usleep(100_000) }
    }
}

public enum UpdateInstallError: LocalizedError, Equatable {
    case badArchive(String)
    case signature(String)
    case badArguments(String)
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .badArchive(let m), .signature(let m), .badArguments(let m), .failed(let m): return m
        }
    }
}

/// What the app hands the helper on its command line, and how the helper reads it back.
public struct HelperArguments: Equatable {
    /// The verified, unpacked .app inside the staging directory.
    public let staged: URL
    /// The .app to replace: where the running app lives.
    public let target: URL
    /// The app's whole staging directory, removed once the install is done.
    public let stagingRoot: URL
    /// The app that launched the helper; it quits right away, and the helper waits for that.
    public let parentPID: pid_t
    /// The version the staged bundle must declare.
    public let version: String

    public init(staged: URL, target: URL, stagingRoot: URL, parentPID: pid_t, version: String) {
        self.staged = staged; self.target = target; self.stagingRoot = stagingRoot
        self.parentPID = parentPID; self.version = version
    }

    public var commandLine: [String] {
        ["--staged", staged.path, "--target", target.path, "--staging-root", stagingRoot.path,
         "--parent-pid", String(parentPID), "--version", version]
    }

    /// Parses the arguments after the executable name. Every flag is required, the paths
    /// must be absolute, the bundles must be `.app`s and the staged one must sit under the
    /// staging root: the helper runs unsandboxed and takes no liberties with its input.
    public static func parse(_ args: [String]) throws -> HelperArguments {
        var values: [String: String] = [:]
        var i = 0
        while i < args.count {
            let flag = args[i]
            guard flag.hasPrefix("--"), i + 1 < args.count else { throw UpdateInstallError.badArguments("unexpected argument \(flag)") }
            values[String(flag.dropFirst(2))] = args[i + 1]
            i += 2
        }
        func path(_ key: String, app: Bool) throws -> URL {
            guard let v = values[key] else { throw UpdateInstallError.badArguments("missing --\(key)") }
            guard v.hasPrefix("/") else { throw UpdateInstallError.badArguments("--\(key) must be an absolute path") }
            let url = URL(fileURLWithPath: v).standardizedFileURL
            if app, url.pathExtension != "app" { throw UpdateInstallError.badArguments("--\(key) must be an .app bundle") }
            return url
        }
        let staged = try path("staged", app: true)
        let target = try path("target", app: true)
        let root = try path("staging-root", app: false)
        guard staged.path.hasPrefix(root.path + "/") else { throw UpdateInstallError.badArguments("--staged must be inside --staging-root") }
        guard let pidText = values["parent-pid"], let pid = pid_t(pidText), pid > 0 else { throw UpdateInstallError.badArguments("missing or bad --parent-pid") }
        guard let version = values["version"], !version.isEmpty else { throw UpdateInstallError.badArguments("missing --version") }
        return HelperArguments(staged: staged, target: target, stagingRoot: root, parentPID: pid, version: version)
    }
}
