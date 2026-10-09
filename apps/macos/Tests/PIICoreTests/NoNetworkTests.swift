import XCTest
@testable import PIICore

/// The app's networking is confined to the updater, which talks only to GitHub.
/// Everything else (the core bridge, the UI, file handling) stays network-free. The app is
/// not sandboxed (the updater replaces the bundle in place, which the sandbox forbids), so
/// the guarantee is these tests: one networking file, GitHub hosts only, and an entitlement
/// set of exactly the JIT. Never a network entitlement, never network.server.
final class NoNetworkTests: XCTestCase {
    private func entitlements() throws -> [String: Any] {
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Obfuscate.entitlements"))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testEntitlementsAreExactlyTheJIT() throws {
        let plist = try entitlements()
        XCTAssertEqual(Set(plist.keys), ["com.apple.security.cs.allow-jit"])
        XCTAssertEqual(plist["com.apple.security.cs.allow-jit"] as? Bool, true)
    }

    func testNoNetworkEntitlementAtAll() throws {
        let plist = try entitlements()
        XCTAssertNil(plist["com.apple.security.network.server"])
        XCTAssertNil(plist["com.apple.security.network.client"])
        for key in plist.keys { XCTAssertFalse(key.lowercased().contains("network"), "unexpected network entitlement: \(key)") }
    }

    func testInfoPlistIsMenuBarOnly() throws {
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(plist["LSUIElement"] as? Bool, true)
        XCTAssertEqual(plist["CFBundleExecutable"] as? String, "Obfuscate")
        // Downloaded updates must not be quarantined by the app itself.
        XCTAssertNil(plist["LSFileQuarantineEnabled"])
    }

    /// The one file allowed to use networking, relative to apps/macos/Sources.
    private static let updaterFile = "Obfuscate/Updater.swift"
    private static let banned = ["import Network", "URLSession", "NSURLConnection", "fetch(", "XMLHttpRequest", "WebSocket", "CFSocket", "NWConnection"]

    private func swiftSources() throws -> [(relative: String, text: String)] {
        let src = TestPaths.macosDir.appendingPathComponent("Sources")
        let en = try XCTUnwrap(FileManager.default.enumerator(at: src, includingPropertiesForKeys: nil))
        var out: [(relative: String, text: String)] = []
        for case let url as URL in en where url.pathExtension == "swift" {
            let rel = url.path.replacingOccurrences(of: src.path + "/", with: "")
            out.append((relative: rel, text: try String(contentsOf: url, encoding: .utf8)))
        }
        return out
    }

    func testNetworkingIsConfinedToTheUpdater() throws {
        let sources = try swiftSources()
        XCTAssertGreaterThan(sources.count, 6)
        var sawUpdater = false, sawInstall = false
        for (rel, text) in sources {
            if rel == Self.updaterFile { sawUpdater = true; continue }
            if rel.hasPrefix("UpdateInstall/") { sawInstall = true }
            for b in Self.banned { XCTAssertFalse(text.contains(b), "\(rel) contains \(b)") }
        }
        XCTAssertTrue(sawUpdater, "\(Self.updaterFile) is missing")
        XCTAssertTrue(sawInstall, "the install library is missing")
    }

    /// Every URL literal in the sources is https and on an allowed GitHub host, and the
    /// updater only ever downloads from those hosts (its host check names the allow-list).
    func testURLLiteralsOnlyPointAtGitHub() throws {
        let re = try NSRegularExpression(pattern: #"[a-z][a-z0-9+.-]*://[^\s"'<>)]+"#, options: [.caseInsensitive])
        var found = 0
        for (rel, text) in try swiftSources() {
            for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                let literal = String(text[Range(m.range, in: text)!])
                found += 1
                let url = try XCTUnwrap(URL(string: literal), "\(rel): \(literal)")
                XCTAssertEqual(url.scheme, "https", "\(rel): \(literal)")
                let host = try XCTUnwrap(url.host, "\(rel): \(literal)")
                XCTAssertTrue(UpdateCheck.allowedHosts.contains(host), "\(rel): \(literal) is not on an allowed host")
            }
        }
        XCTAssertGreaterThan(found, 0)
        let updater = try XCTUnwrap(try swiftSources().first { $0.relative == Self.updaterFile }).text
        XCTAssertTrue(updater.contains("UpdateCheck.allowedHosts.contains(host)"), "the updater must check hosts against UpdateCheck.allowedHosts")
        XCTAssertTrue(updater.contains("willPerformHTTPRedirection"), "the updater must vet redirects")
    }

    func testAllowedHostsAreGitHubOnly() {
        for host in UpdateCheck.allowedHosts {
            XCTAssertTrue(host == "github.com" || host.hasSuffix(".github.com") || host.hasSuffix(".githubusercontent.com"), host)
        }
        XCTAssertEqual(UpdateCheck.latestReleaseURL.host, "api.github.com")
        XCTAssertEqual(UpdateCheck.projectPageURL.host, "github.com")
    }

    /// The core bridge library itself must stay Foundation + JavaScriptCore only.
    func testPIICoreLibraryDoesNotUseNetworking() throws {
        for (rel, text) in try swiftSources() where rel.hasPrefix("PIICore/") {
            for b in Self.banned { XCTAssertFalse(text.contains(b), "\(rel) contains \(b)") }
        }
    }

    func testResolvedCoreIsUnmodifiedRepoCore() throws {
        let located = try XCTUnwrap(CoreScript.locate())
        let repoCore = TestPaths.repoRoot.appendingPathComponent("core/sanitizer.js")
        XCTAssertEqual(try Data(contentsOf: located), try Data(contentsOf: repoCore))
    }
}
