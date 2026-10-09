import Foundation

/// A published Obfuscate release on GitHub, as far as the updater needs to know it.
public struct UpdateRelease: Codable, Equatable {
    /// Bare version, e.g. "0.9.5" (the tag without its leading "v").
    public let version: String
    public let tag: String
    /// The universal macOS zip attached to the release.
    public let assetURL: URL
    /// The release page, for a human to read the notes.
    public let pageURL: URL?

    public init(version: String, tag: String, assetURL: URL, pageURL: URL?) {
        self.version = version; self.tag = tag; self.assetURL = assetURL; self.pageURL = pageURL
    }
}

public enum UpdateCheckError: Error, Equatable {
    case malformed(String)
    case draftOrPrerelease(String)
    case noMacAsset(String)
}

/// The pure half of the updater: where releases live, how the latest-release JSON is read
/// and how versions compare. No networking here (that is `Updater` in the app target), so
/// every rule is unit-testable and the library stays Foundation-only.
public enum UpdateCheck {
    public static let repository = "steeb-k/pii-cleaner"
    public static let projectPageURL = URL(string: "https://github.com/steeb-k/pii-cleaner")!
    /// GitHub's "latest release" endpoint: the newest non-draft, non-prerelease release.
    public static let latestReleaseURL = URL(string: "https://api.github.com/repos/steeb-k/pii-cleaner/releases/latest")!
    /// The hosts the updater is allowed to talk to. `NoNetworkTests` checks the sources against this.
    /// Asset downloads from github.com redirect to a CDN host: release-assets.githubusercontent.com
    /// today, objects.githubusercontent.com before that. A redirect to any other host is refused,
    /// which the download reports as a 3xx status.
    public static let allowedHosts: Set<String> = [
        "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
    ]
    /// Checks are rate-limited to one per this interval, across launches.
    public static let minimumInterval: TimeInterval = 60 * 60

    /// The asset `release.yml` publishes for a version (see `apps/macos/build-app.sh`).
    public static func assetName(for version: String) -> String {
        "Obfuscate-\(version)-macos-universal.zip"
    }

    private struct ReleaseJSON: Decodable {
        struct Asset: Decodable {
            let name: String
            let browser_download_url: String
        }
        let tag_name: String
        let html_url: String?
        let draft: Bool?
        let prerelease: Bool?
        let assets: [Asset]?
    }

    /// Reads the JSON of GitHub's `releases/latest` response.
    public static func parseLatest(_ data: Data) throws -> UpdateRelease {
        let r: ReleaseJSON
        do { r = try JSONDecoder().decode(ReleaseJSON.self, from: data) }
        catch { throw UpdateCheckError.malformed("\(error)") }
        if r.draft == true || r.prerelease == true { throw UpdateCheckError.draftOrPrerelease(r.tag_name) }
        let version = baseVersion(ofTag: r.tag_name)
        guard !version.isEmpty else { throw UpdateCheckError.malformed("tag \(r.tag_name) carries no version") }
        let wanted = assetName(for: version)
        guard let asset = (r.assets ?? []).first(where: { $0.name == wanted }),
              let url = URL(string: asset.browser_download_url), url.scheme == "https" else {
            throw UpdateCheckError.noMacAsset(wanted)
        }
        return UpdateRelease(version: version, tag: r.tag_name, assetURL: url, pageURL: r.html_url.flatMap { URL(string: $0) })
    }

    /// "v0.9.5" -> "0.9.5", "v0.9.5-test1" -> "0.9.5" (the same rule as release.yml's version gate).
    public static func baseVersion(ofTag tag: String) -> String {
        var s = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        if let dash = s.firstIndex(of: "-") { s = String(s[..<dash]) }
        return s
    }

    /// Dotted numeric components; anything non-numeric in a component is ignored,
    /// missing components count as 0, so "1.0" == "1.0.0" and "0.10" > "0.9.5".
    public static func components(_ version: String) -> [Int] {
        baseVersion(ofTag: version).split(separator: ".").map { part in
            Int(String(part).filter { $0.isNumber }) ?? 0
        }
    }

    public static func compare(_ a: String, _ b: String) -> Int {
        var x = components(a), y = components(b)
        let n = max(x.count, y.count)
        x += Array(repeating: 0, count: n - x.count)
        y += Array(repeating: 0, count: n - y.count)
        for i in 0..<n where x[i] != y[i] { return x[i] < y[i] ? -1 : 1 }
        return 0
    }

    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        compare(candidate, current) > 0
    }

    /// Whether a check is due, given when the last one ran (nil = never).
    public static func isCheckDue(lastCheck: Date?, now: Date = Date()) -> Bool {
        guard let last = lastCheck else { return true }
        // A clock set backwards would otherwise silence checks for a long time.
        return now.timeIntervalSince(last) >= minimumInterval || last > now
    }
}
