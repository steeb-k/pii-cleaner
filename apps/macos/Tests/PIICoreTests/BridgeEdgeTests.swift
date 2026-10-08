import XCTest
@testable import PIICore

/// Edge cases of the JavaScriptCore bridge, checked against core/README.md.
final class BridgeEdgeTests: XCTestCase {
    func testDisabledIPIsUntouchedAndNotFlaggedAsLeak() throws {
        let core = try PIICore()
        let r = core.sanitize("connect from 10.9.8.7 now", enabled: [.IP: false])
        XCTAssertNil(r.error)
        XCTAssertTrue(r.output.contains("10.9.8.7"))
        XCTAssertFalse(r.leaks.contains { $0.type == "IP" }, "\(r.leaks)")
        XCTAssertNil(r.stats.byType["IP"])
        // Explicit true and omitted both mean enabled.
        let on = try PIICore().sanitize("connect from 10.9.8.7 now", enabled: [.IP: true, .HOST: true])
        XCTAssertFalse(on.output.contains("10.9.8.7"))
    }

    func testFilenamePassesThroughWithoutChangingOutput() throws {
        let a = try PIICore().sanitize(#"{"UserName":"jdoe"}"#, filename: "x.json")
        let b = try PIICore().sanitize(#"{"UserName":"jdoe"}"#)
        XCTAssertNil(a.error)
        XCTAssertEqual(a.output, b.output)
    }

    func testImportLegendMalformedThrowsAndContextSurvives() throws {
        let core = try PIICore()
        for bad in ["{not json", "", "null", "[]", #"{"entries":5}"#] {
            XCTAssertThrowsError(try core.importLegend(json: bad), "input: \(bad)") { e in
                guard case PIICoreError.jsException = e else { return XCTFail("wrong error \(e)") }
            }
        }
        // Context still usable after the exceptions.
        let r = core.sanitize(#"{"ComputerName":"WKS-1"}"#)
        XCTAssertNil(r.error)
        XCTAssertTrue(r.output.contains("{{HOST_1}}"))
        XCTAssertNoThrow(try core.importLegend(json: #"{"entries":[]}"#))
    }

    func testImportLegendCounts() throws {
        let core = try PIICore()
        let json = """
        {"entries":[
          {"token":"{{HOST_3}}","type":"HOST","original":"wks-a","count":1},
          {"token":"{{USER_1}}","type":"USER","original":"jdoe","count":2},
          {"token":"{{HOST_1}}","type":"USER","original":"bad","count":1},
          {"token":"{{NOPE_1}}","type":"NOPE","original":"x","count":1},
          {"type":"HOST","original":"missing-token"}
        ]}
        """
        let r = try core.importLegend(json: json)
        XCTAssertEqual(r, LegendImportResult(imported: 2, skipped: 3))
        // Counter advanced past the highest imported N.
        let out = core.sanitize(#"{"ComputerName":"wks-new","Other":"wks-a"}"#).output
        XCTAssertTrue(out.contains("{{HOST_4}}"), out)
        XCTAssertTrue(out.contains("{{HOST_3}}"), out)
    }

    func testExportImportRoundTripKeepsTokensStable() throws {
        let a = try PIICore()
        let first = a.sanitize(#"{"ComputerName":"WKS-A","UserName":"alice","LocalAddressIP4":"10.0.0.5"}"#).output
        let json = a.exportLegendJSON()
        let b = try PIICore()
        let r = try b.importLegend(json: json)
        XCTAssertEqual(r.skipped, 0)
        XCTAssertEqual(r.imported, 3)
        let second = b.sanitize(#"{"ComputerName":"WKS-A","UserName":"alice","LocalAddressIP4":"10.0.0.5"}"#).output
        XCTAssertEqual(first, second)
        // Re-export equals modulo the timestamp.
        func strip(_ s: String) -> String { s.replacingOccurrences(of: #""created": "[^"]*""#, with: "", options: .regularExpression) }
        XCTAssertEqual(strip(b.exportLegendJSON()).components(separatedBy: "\"count\"").count,
                       strip(json).components(separatedBy: "\"count\"").count)
    }

    func testExportCSVHeader() throws {
        let core = try PIICore()
        XCTAssertEqual(core.exportLegendCSV().components(separatedBy: "\n").first, "token,type,original,count")
        _ = core.sanitize(#"{"UserName":"jdoe"}"#)
        let lines = core.exportLegendCSV().split(separator: "\n")
        XCTAssertEqual(lines.first, "token,type,original,count")
        XCTAssertTrue(lines.contains { $0.hasPrefix("{{USER_1}},USER,jdoe,") })
    }

    func testAddCustomRejectsNonCustomTypes() throws {
        let core = try PIICore()
        for t in PIIType.allCases {
            if [.HOST, .USER, .DOMAIN, .CUSTOM].contains(t) {
                XCTAssertNoThrow(try core.addCustom(type: t, values: ["v-\(t.rawValue)"]))
            } else {
                XCTAssertThrowsError(try core.addCustom(type: t, values: ["x"]), t.rawValue)
            }
        }
    }

    func testClearResetsCounters() throws {
        let core = try PIICore()
        _ = core.sanitize(#"{"ComputerName":"A1"}"#)
        _ = core.sanitize(#"{"ComputerName":"A2"}"#)
        core.clear()
        let r = core.sanitize(#"{"ComputerName":"A3"}"#)
        XCTAssertTrue(r.output.contains("{{HOST_1}}"), r.output)
        XCTAssertFalse(r.output.contains("{{HOST_3}}"))
    }

    func testBrokenJSONWarnsAndSanitizesAsText() throws {
        let core = try PIICore()
        let r = core.sanitize(#"{"UserName":"jdoe", "ip": "10.1.2.3",}"#)
        XCTAssertNil(r.error)
        XCTAssertEqual(r.format, "text")
        XCTAssertNotNil(r.warning)
        XCTAssertFalse(r.output.contains("10.1.2.3"), r.output)
    }

    func testEmptyInput() throws {
        let core = try PIICore()
        for s in ["", "   \n  "] {
            let r = core.sanitize(s)
            XCTAssertNil(r.error)
            XCTAssertEqual(r.records, 0)
            XCTAssertEqual(r.stats.total, 0)
        }
    }

    func testNonASCIIAndEmoji() throws {
        let core = try PIICore()
        let input = #"{"ComputerName":"WKS-Ünïcødé-🔥","UserName":"jöhn.dœ","note":"日本語 テキスト 👍 10.1.2.3"}"#
        let r = core.sanitize(input)
        XCTAssertNil(r.error)
        XCTAssertTrue(r.output.contains("{{HOST_1}}"))
        XCTAssertTrue(r.output.contains("日本語 テキスト 👍"))
        XCTAssertFalse(r.output.contains("🔥"))
        XCTAssertFalse(r.output.contains("10.1.2.3"))
        // Legend round-trips the non-ASCII original.
        XCTAssertTrue(core.exportLegendJSON().contains("WKS-Ünïcødé-🔥"))
    }

    func testLargeNDJSON() throws {
        let core = try PIICore()
        var lines: [String] = []
        var size = 0
        var i = 0
        while size < 5_000_000 {
            let l = #"{"ComputerName":"WKS-\#(i % 500)","UserName":"user\#(i % 300)","LocalAddressIP4":"10.0.\#(i % 250).\#(i % 200)","CommandLine":"cmd.exe /c echo hello world padding padding padding"}"#
            lines.append(l); size += l.utf8.count + 1; i += 1
        }
        let r = core.sanitize(lines.joined(separator: "\n"))
        XCTAssertNil(r.error)
        XCTAssertEqual(r.format, "ndjson")
        XCTAssertEqual(r.records, lines.count)
        XCTAssertFalse(r.output.contains("WKS-1\""))
        // Session is still usable afterwards.
        XCTAssertNil(core.sanitize("hello").error)
    }

    func testJSExceptionSurfacedAndContextRecovers() throws {
        let core = try PIICore()
        // A thrown JS error from the core (invalid legend) must surface and be cleared.
        XCTAssertThrowsError(try core.importLegend(json: "{}"))
        XCTAssertNoThrow(try core.addCustom(type: .HOST, values: ["after-error-host"]))
        let r = core.sanitize("ping after-error-host")
        XCTAssertNil(r.error)
        XCTAssertEqual(r.output, "ping {{HOST_1}}")
    }

    func testConcurrentCallersAreSerialized() throws {
        let core = try PIICore()
        DispatchQueue.concurrentPerform(iterations: 50) { i in
            let r = core.sanitize(#"{"ComputerName":"H\#(i % 5)"}"#)
            XCTAssertNil(r.error)
            _ = core.exportLegendJSON()
        }
        let entries = core.exportLegendCSV().split(separator: "\n").count - 1
        XCTAssertEqual(entries, 5)
    }
}

final class LoneSurrogateTests: XCTestCase {
    /// core slices leak `context` by UTF-16 index, which can cut an emoji in half and leave a
    /// lone surrogate. JSON.stringify emits it as `\udd25`, which JSONDecoder rejects. The bridge
    /// must not turn that into a failed sanitize (output "" + error).
    func testLeakContextSplittingEmojiDoesNotFailSanitize() throws {
        let core = try PIICore()
        let input = "🔥" + String(repeating: "a", count: 16) + #" \\FILESRV-09\finance"#
        let r = core.sanitize(input)
        XCTAssertNil(r.error, r.error ?? "")
        XCTAssertEqual(r.output, input)
        XCTAssertEqual(r.leaks.first?.value, "FILESRV-09")
        XCTAssertTrue(r.leaks.first?.context.contains("FILESRV-09") ?? false)
    }
}
