import XCTest
@testable import PIICore

final class NoNetworkTests: XCTestCase {
    func testEntitlementsHaveNoNetworkKeys() throws {
        // Keys only: the file's comments may legitimately say "no network".
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Obfuscate.entitlements"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        for key in plist.keys {
            XCTAssertFalse(key.lowercased().contains("network"), "network entitlement present: \(key)")
        }
        XCTAssertEqual(plist["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(plist["com.apple.security.files.user-selected.read-write"] as? Bool, true)
    }

    func testEntitlementsAreExactlySandboxUserSelectedFilesAndJIT() throws {
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Obfuscate.entitlements"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        // allow-jit is for JavaScriptCore under the hardened runtime; it is not a network grant.
        XCTAssertEqual(Set(plist.keys), ["com.apple.security.app-sandbox",
                                         "com.apple.security.files.user-selected.read-write",
                                         "com.apple.security.cs.allow-jit"])
        XCTAssertEqual(plist["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(plist["com.apple.security.files.user-selected.read-write"] as? Bool, true)
        XCTAssertEqual(plist["com.apple.security.cs.allow-jit"] as? Bool, true)
    }

    func testInfoPlistIsMenuBarOnly() throws {
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(plist["LSUIElement"] as? Bool, true)
        XCTAssertEqual(plist["CFBundleExecutable"] as? String, "Obfuscate")
    }

    func testSourcesDoNotUseNetworking() throws {
        let src = TestPaths.macosDir.appendingPathComponent("Sources")
        let en = try XCTUnwrap(FileManager.default.enumerator(at: src, includingPropertiesForKeys: nil))
        var checked = 0
        let banned = ["import Network", "URLSession", "NSURLConnection", "fetch(", "XMLHttpRequest", "WebSocket"]
        for case let url as URL in en where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            for b in banned { XCTAssertFalse(text.contains(b), "\(url.lastPathComponent) contains \(b)") }
            checked += 1
        }
        XCTAssertGreaterThan(checked, 5)
    }

    func testResolvedCoreIsUnmodifiedRepoCore() throws {
        let located = try XCTUnwrap(CoreScript.locate())
        let repoCore = TestPaths.repoRoot.appendingPathComponent("core/sanitizer.js")
        XCTAssertEqual(try Data(contentsOf: located), try Data(contentsOf: repoCore))
    }
}
