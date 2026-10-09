import XCTest
import UpdateInstall

/// The install half of the updater: what the app hands the helper, and what the helper does
/// with it, exercised on throwaway bundles under a temporary directory.
final class UpdateInstallTests: XCTestCase {
    private var tmp: URL!

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("UpdateInstallTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    /// A minimal .app: Contents/Info.plist and a one-line "executable".
    private func makeApp(_ name: String, in dir: URL, bundleID: String = "com.obfuscate.app", version: String) throws -> URL {
        let app = dir.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        let plist: [String: Any] = ["CFBundleIdentifier": bundleID, "CFBundleShortVersionString": version, "CFBundleExecutable": "X"]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: app.appendingPathComponent("Contents/Info.plist"))
        try "#!/bin/sh\necho \(version)\n".write(to: app.appendingPathComponent("Contents/MacOS/X"), atomically: true, encoding: .utf8)
        return app
    }

    // MARK: Arguments

    func testArgumentsRoundTrip() throws {
        let args = HelperArguments(staged: URL(fileURLWithPath: "/tmp/stage/unpacked/Obfuscate.app"),
                                   target: URL(fileURLWithPath: "/Applications/Obfuscate.app"),
                                   stagingRoot: URL(fileURLWithPath: "/tmp/stage"), parentPID: 4242, version: "0.9.6")
        XCTAssertEqual(try HelperArguments.parse(args.commandLine), args)
    }

    func testArgumentsAreStrict() throws {
        let good = HelperArguments(staged: URL(fileURLWithPath: "/tmp/stage/unpacked/Obfuscate.app"),
                                   target: URL(fileURLWithPath: "/Applications/Obfuscate.app"),
                                   stagingRoot: URL(fileURLWithPath: "/tmp/stage"), parentPID: 1, version: "0.9.6").commandLine
        func dropping(_ flag: String) -> [String] {
            var out: [String] = []
            var i = 0
            while i < good.count { if good[i] == flag { i += 2 } else { out.append(good[i]); i += 1 } }
            return out
        }
        for flag in ["--staged", "--target", "--staging-root", "--parent-pid", "--version"] {
            XCTAssertThrowsError(try HelperArguments.parse(dropping(flag)), flag)
        }
        func replacing(_ flag: String, with value: String) -> [String] {
            var out = good
            out[out.firstIndex(of: flag)! + 1] = value
            return out
        }
        XCTAssertThrowsError(try HelperArguments.parse(replacing("--staged", with: "relative/Obfuscate.app")))
        XCTAssertThrowsError(try HelperArguments.parse(replacing("--target", with: "/Applications/Obfuscate")))
        XCTAssertThrowsError(try HelperArguments.parse(replacing("--staged", with: "/elsewhere/Obfuscate.app")), "staged must be under the staging root")
        XCTAssertThrowsError(try HelperArguments.parse(replacing("--parent-pid", with: "0")))
        XCTAssertThrowsError(try HelperArguments.parse(replacing("--parent-pid", with: "abc")))
        XCTAssertThrowsError(try HelperArguments.parse(good + ["--extra"]))
        XCTAssertThrowsError(try HelperArguments.parse(["Obfuscate.app"]))
    }

    // MARK: Bundle checks

    func testCheckBundleWantsTheRightIdentifierAndVersion() throws {
        let app = try makeApp("A.app", in: tmp, version: "0.9.6")
        XCTAssertNoThrow(try UpdateInstall.checkBundle(app, version: "0.9.6", bundleID: "com.obfuscate.app"))
        XCTAssertThrowsError(try UpdateInstall.checkBundle(app, version: "0.9.7", bundleID: "com.obfuscate.app"))
        XCTAssertThrowsError(try UpdateInstall.checkBundle(app, version: "0.9.6", bundleID: "com.other"))
        XCTAssertThrowsError(try UpdateInstall.checkBundle(tmp.appendingPathComponent("Missing.app"), version: "0.9.6", bundleID: "com.obfuscate.app"))
        XCTAssertEqual(UpdateInstall.bundleIdentifier(of: app), "com.obfuscate.app")
        XCTAssertNil(UpdateInstall.bundleIdentifier(of: tmp))
    }

    func testUnsignedBundleFailsSignatureCheck() throws {
        let app = try makeApp("A.app", in: tmp, version: "0.9.6")
        XCTAssertThrowsError(try UpdateInstall.verifySignature(of: app, teamID: nil))
        XCTAssertThrowsError(try UpdateInstall.verifySignature(of: app, teamID: "TEAMID1234"))
    }

    // MARK: Quarantine

    func testStripQuarantineClearsEveryFileAndDirectory() throws {
        let app = try makeApp("A.app", in: tmp, version: "0.9.6")
        // What the sandbox stamps on files a sandboxed app writes (flags with the sandbox bit set).
        let mark = "0286;00000000;Obfuscate;"
        var marked: [URL] = [app]
        for case let url as URL in try XCTUnwrap(FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)) { marked.append(url) }
        for url in marked {
            XCTAssertEqual(setxattr(url.path, UpdateInstall.quarantineAttribute, mark, mark.utf8.count, 0, XATTR_NOFOLLOW), 0, url.path)
            XCTAssertTrue(UpdateInstall.hasQuarantine(url))
        }
        XCTAssertGreaterThanOrEqual(marked.count, 5)

        try UpdateInstall.stripQuarantine(app)
        for url in marked { XCTAssertFalse(UpdateInstall.hasQuarantine(url), url.path) }
        // Idempotent: nothing to strip is not an error.
        XCTAssertNoThrow(try UpdateInstall.stripQuarantine(app))
    }

    // MARK: Swap

    func testSwapReplacesTheTargetAndLeavesNothingBehind() throws {
        let apps = tmp.appendingPathComponent("Applications", isDirectory: true)
        let stage = tmp.appendingPathComponent("stage/unpacked", isDirectory: true)
        try FileManager.default.createDirectory(at: apps, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        let old = try makeApp("Obfuscate.app", in: apps, version: "0.9.5")
        let new = try makeApp("Obfuscate.app", in: stage, version: "0.9.6")

        try UpdateInstall.swap(staged: new, into: old)

        XCTAssertEqual(UpdateInstall.bundleIdentifier(of: old), "com.obfuscate.app")
        XCTAssertNoThrow(try UpdateInstall.checkBundle(old, version: "0.9.6", bundleID: "com.obfuscate.app"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.path))
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: apps.path)
        XCTAssertEqual(leftovers, ["Obfuscate.app"], "no hidden .old/.update bundles remain")
    }

    func testSwapRestoresTheTargetWhenItCannotFinish() throws {
        let apps = tmp.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: apps, withIntermediateDirectories: true)
        let old = try makeApp("Obfuscate.app", in: apps, version: "0.9.5")
        let missing = tmp.appendingPathComponent("nowhere/Obfuscate.app")
        XCTAssertThrowsError(try UpdateInstall.swap(staged: missing, into: old))
        XCTAssertNoThrow(try UpdateInstall.checkBundle(old, version: "0.9.5", bundleID: "com.obfuscate.app"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: apps.path), ["Obfuscate.app"])
    }

    func testSameFolderSeesThroughSymlinksAndTrailingSlashes() {
        XCTAssertTrue(UpdateInstall.sameFolder(URL(fileURLWithPath: "/tmp/"), URL(fileURLWithPath: "/private/tmp")))
        XCTAssertFalse(UpdateInstall.sameFolder(URL(fileURLWithPath: "/tmp"), URL(fileURLWithPath: "/var")))
    }

    func testWaitForExitReturnsOnceTheProcessIsGone() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 0.3"]
        XCTAssertNoThrow(try p.run())
        let started = Date()
        UpdateInstall.waitForExit(of: p.processIdentifier, timeout: 5)
        XCTAssertFalse(p.isRunning)
        XCTAssertLessThan(Date().timeIntervalSince(started), 4)
    }
}
