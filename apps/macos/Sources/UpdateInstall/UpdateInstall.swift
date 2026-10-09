import Foundation
import Security

/// The install half of the updater: the checks a downloaded bundle must pass, clearing any
/// quarantine from it, and swapping it into place. Foundation + Security, no networking, no
/// UI, so every rule is unit-testable (`UpdateInstallTests`). `Updater` in the app target
/// does the downloading and drives this.
public enum UpdateInstall {
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

    /// Removes the quarantine attribute from `root` and everything under it. The app does not
    /// quarantine what it downloads (no LSFileQuarantineEnabled), so this is a belt-and-braces
    /// step: a bundle carrying the attribute would launch with a Gatekeeper prompt, or not at all.
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
}

public enum UpdateInstallError: LocalizedError, Equatable {
    case badArchive(String)
    case signature(String)
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .badArchive(let m), .signature(let m), .failed(let m): return m
        }
    }
}
