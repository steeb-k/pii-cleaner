import XCTest
@testable import PIICore

final class PIICoreTests: XCTestCase {
    func testSanitizeJSONRecord() throws {
        let core = try PIICore()
        let r = core.sanitize(#"{"ComputerName":"WKS-1","UserName":"jdoe"}"#)
        XCTAssertNil(r.error)
        XCTAssertEqual(r.format, "json")
        XCTAssertEqual(r.records, 1)
        XCTAssertTrue(r.output.contains("{{HOST_1}}"))
        XCTAssertTrue(r.output.contains("{{USER_1}}"))
        XCTAssertFalse(r.output.contains("WKS-1"))
        XCTAssertEqual(r.stats.byType["HOST"], 1)
        XCTAssertGreaterThanOrEqual(r.stats.total, 2)
    }

    func testSessionKeepsTokensStable() throws {
        let core = try PIICore()
        _ = core.sanitize(#"{"ComputerName":"A"}"#)
        let r = core.sanitize(#"{"ComputerName":"B","Other":"A"}"#)
        XCTAssertTrue(r.output.contains("{{HOST_2}}"))
    }

    func testEnabledOverrides() throws {
        let core = try PIICore()
        let input = #"{"LocalAddressIP4":"10.1.2.3","ComputerName":"WKS-1"}"#
        let off = core.sanitize(input, enabled: [.IP: false])
        XCTAssertTrue(off.output.contains("10.1.2.3"))
        XCTAssertTrue(off.output.contains("{{HOST_1}}"))
        let on = PIICoreFresh.make().sanitize(input)
        XCTAssertFalse(on.output.contains("10.1.2.3"))
    }

    func testDetectFormat() throws {
        let core = try PIICore()
        XCTAssertEqual(core.detectFormat("{\"a\":1}"), "json")
        XCTAssertEqual(core.detectFormat("[{\"a\":1}]"), "array")
        XCTAssertEqual(core.detectFormat("{\"a\":1}\n{\"a\":2}"), "ndjson")
        XCTAssertEqual(core.detectFormat("hello world"), "text")
    }

    func testLegendRoundTrip() throws {
        let a = try PIICore()
        _ = a.sanitize(#"{"ComputerName":"WKS-STABLE"}"#)
        let json = a.exportLegendJSON()
        XCTAssertTrue(json.hasSuffix("}\n"))
        XCTAssertTrue(json.contains("\n  \"entries\""))
        XCTAssertTrue(a.exportLegendCSV().hasPrefix("token,type,original,count"))

        let b = try PIICore()
        let r = try b.importLegend(json: json)
        XCTAssertEqual(r.imported, 1)
        XCTAssertEqual(r.skipped, 0)
        let out = b.sanitize(#"{"ComputerName":"WKS-STABLE"}"#)
        XCTAssertTrue(out.output.contains("{{HOST_1}}"))
    }

    func testImportInvalidJSONThrows() throws {
        let core = try PIICore()
        XCTAssertThrowsError(try core.importLegend(json: "not json")) { e in
            guard case PIICoreError.jsException = e else { return XCTFail("wrong error \(e)") }
        }
        XCTAssertThrowsError(try core.importLegend(json: "{}"))
    }

    func testAddCustomAndClear() throws {
        let core = try PIICore()
        try core.addCustom(type: .CUSTOM, values: ["Project Falcon"])
        let r = core.sanitize("working on Project Falcon today")
        XCTAssertTrue(r.output.contains("{{CUSTOM_1}}"))
        XCTAssertThrowsError(try core.addCustom(type: .IP, values: ["1.2.3.4"]))
        core.clear()
        XCTAssertEqual(core.sanitize("Project Falcon").output, "Project Falcon")
    }

    func testMissingScriptThrows() {
        XCTAssertThrowsError(try PIICore(scriptURL: URL(fileURLWithPath: "/nonexistent/sanitizer.js")))
    }
}

enum PIICoreFresh { static func make() -> PIICore { try! PIICore() } }
