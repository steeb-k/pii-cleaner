import XCTest
@testable import PIICore

final class UpdateCheckTests: XCTestCase {
    private func releaseJSON(tag: String, assets: [String], draft: Bool = false, prerelease: Bool = false) -> Data {
        let list = assets.map {
            #"{"name":"\#($0)","browser_download_url":"https://github.com/steeb-k/pii-cleaner/releases/download/\#(tag)/\#($0)"}"#
        }.joined(separator: ",")
        return Data(#"""
        {"tag_name":"\#(tag)","html_url":"https://github.com/steeb-k/pii-cleaner/releases/tag/\#(tag)",
         "draft":\#(draft),"prerelease":\#(prerelease),"assets":[\#(list)]}
        """#.utf8)
    }

    func testVersionComparison() {
        XCTAssertTrue(UpdateCheck.isNewer("0.9.5", than: "0.9.4"))
        XCTAssertTrue(UpdateCheck.isNewer("0.10.0", than: "0.9.9"))
        XCTAssertTrue(UpdateCheck.isNewer("1.0", than: "0.9.4"))
        XCTAssertFalse(UpdateCheck.isNewer("0.9.4", than: "0.9.4"))
        XCTAssertFalse(UpdateCheck.isNewer("0.9.3", than: "0.9.4"))
        XCTAssertFalse(UpdateCheck.isNewer("1.0.0", than: "1.0"))
        XCTAssertEqual(UpdateCheck.compare("v0.9.5", "0.9.5"), 0)
        XCTAssertEqual(UpdateCheck.compare("0.9.5-test1", "0.9.5"), 0)
        XCTAssertEqual(UpdateCheck.components("0.9.4"), [0, 9, 4])
    }

    func testTagToVersion() {
        XCTAssertEqual(UpdateCheck.baseVersion(ofTag: "v0.9.5"), "0.9.5")
        XCTAssertEqual(UpdateCheck.baseVersion(ofTag: "v0.9.5-test2"), "0.9.5")
        XCTAssertEqual(UpdateCheck.baseVersion(ofTag: "0.9.5"), "0.9.5")
    }

    func testAssetNameMatchesTheReleasePipeline() throws {
        // Same shape as apps/macos/build-app.sh and release.yml produce.
        XCTAssertEqual(UpdateCheck.assetName(for: "0.9.5"), "Obfuscate-0.9.5-macos-universal.zip")
        let script = try String(contentsOf: TestPaths.macosDir.appendingPathComponent("build-app.sh"), encoding: .utf8)
        XCTAssertTrue(script.contains("Obfuscate-$VERSION-macos-$SLICE.zip"))
    }

    func testParsesTheLatestReleaseAndPicksTheUniversalZip() throws {
        let data = releaseJSON(tag: "v0.9.5", assets: ["Obfuscate-0.9.5-macos-arm64.zip", "Obfuscate-0.9.5-macos-universal.zip"])
        let r = try UpdateCheck.parseLatest(data)
        XCTAssertEqual(r.version, "0.9.5")
        XCTAssertEqual(r.tag, "v0.9.5")
        XCTAssertEqual(r.assetURL.lastPathComponent, "Obfuscate-0.9.5-macos-universal.zip")
        XCTAssertEqual(r.assetURL.host, "github.com")
        XCTAssertEqual(r.pageURL?.host, "github.com")
        XCTAssertTrue(UpdateCheck.allowedHosts.contains(try XCTUnwrap(r.assetURL.host)))
    }

    func testReleaseRoundTripsThroughCodable() throws {
        let r = try UpdateCheck.parseLatest(releaseJSON(tag: "v0.9.5", assets: ["Obfuscate-0.9.5-macos-universal.zip"]))
        let again = try JSONDecoder().decode(UpdateRelease.self, from: try JSONEncoder().encode(r))
        XCTAssertEqual(again, r)
    }

    func testRejectsReleasesWithoutTheMacAsset() {
        let data = releaseJSON(tag: "v0.9.5", assets: ["Obfuscate-0.9.5-macos-arm64.zip", "source.tar.gz"])
        XCTAssertThrowsError(try UpdateCheck.parseLatest(data)) { e in
            XCTAssertEqual(e as? UpdateCheckError, .noMacAsset("Obfuscate-0.9.5-macos-universal.zip"))
        }
    }

    func testRejectsDraftsAndPrereleasesAndGarbage() {
        XCTAssertThrowsError(try UpdateCheck.parseLatest(releaseJSON(tag: "v0.9.5", assets: ["Obfuscate-0.9.5-macos-universal.zip"], prerelease: true)))
        XCTAssertThrowsError(try UpdateCheck.parseLatest(releaseJSON(tag: "v0.9.5", assets: ["Obfuscate-0.9.5-macos-universal.zip"], draft: true)))
        XCTAssertThrowsError(try UpdateCheck.parseLatest(Data("not json".utf8)))
        XCTAssertThrowsError(try UpdateCheck.parseLatest(Data(#"{"tag_name":"v","assets":[]}"#.utf8)))
    }

    func testRejectsNonHTTPSAssets() {
        let data = Data(#"""
        {"tag_name":"v0.9.5","assets":[{"name":"Obfuscate-0.9.5-macos-universal.zip","browser_download_url":"http://github.com/x.zip"}]}
        """#.utf8)
        XCTAssertThrowsError(try UpdateCheck.parseLatest(data))
    }

    func testHourlyThrottle() {
        let now = Date()
        XCTAssertTrue(UpdateCheck.isCheckDue(lastCheck: nil, now: now))
        XCTAssertFalse(UpdateCheck.isCheckDue(lastCheck: now.addingTimeInterval(-10), now: now))
        XCTAssertFalse(UpdateCheck.isCheckDue(lastCheck: now.addingTimeInterval(-3599), now: now))
        XCTAssertTrue(UpdateCheck.isCheckDue(lastCheck: now.addingTimeInterval(-3600), now: now))
        XCTAssertTrue(UpdateCheck.isCheckDue(lastCheck: now.addingTimeInterval(600), now: now), "a clock set back must not silence checks")
    }

    func testCurrentInfoPlistVersionParses() throws {
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let v = try XCTUnwrap(plist["CFBundleShortVersionString"] as? String)
        XCTAssertEqual(UpdateCheck.components(v).count, 3, v)
        XCTAssertTrue(UpdateCheck.isNewer("99.0.0", than: v))
    }
}
