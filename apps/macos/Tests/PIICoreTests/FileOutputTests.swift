import XCTest
@testable import PIICore

final class FileOutputTests: XCTestCase {
    func testSanitizedName() {
        XCTAssertEqual(FileOutput.sanitizedName(for: "app.log"), "app.sanitized.log")
        XCTAssertEqual(FileOutput.sanitizedName(for: "events.ndjson"), "events.sanitized.ndjson")
        XCTAssertEqual(FileOutput.sanitizedName(for: "README"), "README.sanitized")
        XCTAssertEqual(FileOutput.sanitizedName(for: "a.tar.gz"), "a.tar.sanitized.gz")
        XCTAssertEqual(FileOutput.sanitizedName(for: "my log.json"), "my log.sanitized.json")
    }

    func testUniqueURLNeverOverwrites() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pii-fo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        XCTAssertEqual(FileOutput.uniqueURL(in: dir, name: "a.sanitized.log").lastPathComponent, "a.sanitized.log")
        try "x".write(to: dir.appendingPathComponent("a.sanitized.log"), atomically: true, encoding: .utf8)
        XCTAssertEqual(FileOutput.uniqueURL(in: dir, name: "a.sanitized.log").lastPathComponent, "a.sanitized-2.log")
        try "x".write(to: dir.appendingPathComponent("a.sanitized-2.log"), atomically: true, encoding: .utf8)
        XCTAssertEqual(FileOutput.uniqueURL(in: dir, name: "a.sanitized.log").lastPathComponent, "a.sanitized-3.log")

        try "x".write(to: dir.appendingPathComponent("NOEXT.sanitized"), atomically: true, encoding: .utf8)
        // "NOEXT.sanitized" has extension "sanitized" per NSString rules.
        XCTAssertEqual(FileOutput.uniqueURL(in: dir, name: "NOEXT.sanitized").lastPathComponent, "NOEXT-2.sanitized")

        // Simulates saving two dropped files that share a basename: sequential writes never collide.
        var written: [String] = []
        for _ in 0..<3 {
            let u = FileOutput.uniqueURL(in: dir, name: "dup.sanitized.json")
            XCTAssertFalse(FileManager.default.fileExists(atPath: u.path))
            try "y".write(to: u, atomically: true, encoding: .utf8)
            written.append(u.lastPathComponent)
        }
        XCTAssertEqual(written, ["dup.sanitized.json", "dup.sanitized-2.json", "dup.sanitized-3.json"])
    }

    func testJoinedSingleIsBareOutput() {
        XCTAssertEqual(FileOutput.joined([("a.log", "OUT")]), "OUT")
    }

    func testJoinedMatchesCLISeparatorFormat() {
        XCTAssertEqual(FileOutput.joined([("a.log", "A"), ("b.json", "{\n  \"x\": 1\n}")]),
                       "// ==== a.log ====\nA\n// ==== b.json ====\n{\n  \"x\": 1\n}")
    }

    /// Byte-for-byte parity with `node apps/cli/pii-clean.js f1 f2` (shared session, separators).
    func testJoinedMatchesNodeCLIMultiFile() throws {
        let samples = TestPaths.repoRoot.appendingPathComponent("samples")
        let names = try FileManager.default.contentsOfDirectory(atPath: samples.path)
            .filter { !$0.hasPrefix(".") }.sorted()
        XCTAssertGreaterThanOrEqual(names.count, 2)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.currentDirectoryURL = samples
        p.arguments = ["node", TestPaths.repoRoot.appendingPathComponent("apps/cli/pii-clean.js").path] + names
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { throw XCTSkip("node not runnable: \(error)") }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        try XCTSkipIf(p.terminationStatus == 127, "node not on PATH")
        var cli = String(decoding: data, as: UTF8.self)
        if cli.hasSuffix("\n") { cli.removeLast() }

        let core = try PIICore()
        let items: [(name: String, output: String)] = try names.map { n in
            let text = try String(contentsOf: samples.appendingPathComponent(n), encoding: .utf8)
            return (n, core.sanitize(text, filename: n).output)
        }
        XCTAssertEqual(FileOutput.joined(items), cli)
    }
}
