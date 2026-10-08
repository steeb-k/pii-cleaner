import XCTest
@testable import PIICore

final class ParityTests: XCTestCase {
    private func nodeAvailable() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", "--version"]
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
    }

    private func runCLI(_ file: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", TestPaths.repoRoot.appendingPathComponent("apps/cli/pii-clean.js").path, "--quiet", file.path]
        let out = Pipe()
        p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        var s = String(decoding: data, as: UTF8.self)
        if s.hasSuffix("\n") { s.removeLast() }
        return s
    }

    func testJSCMatchesNodeCLIOnEverySample() throws {
        try XCTSkipUnless(nodeAvailable(), "node not on PATH")
        let dir = TestPaths.repoRoot.appendingPathComponent("samples")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { !$0.lastPathComponent.hasPrefix(".") }.sorted { $0.path < $1.path }
        XCTAssertGreaterThanOrEqual(files.count, 4)
        for f in files {
            let text = try String(contentsOf: f, encoding: .utf8)
            let core = try PIICore()
            let r = core.sanitize(text, filename: f.lastPathComponent)
            XCTAssertNil(r.error, f.lastPathComponent)
            XCTAssertFalse(r.output.isEmpty, f.lastPathComponent)
            XCTAssertEqual(r.output, try runCLI(f), "parity mismatch for \(f.lastPathComponent)")
        }
    }
}
