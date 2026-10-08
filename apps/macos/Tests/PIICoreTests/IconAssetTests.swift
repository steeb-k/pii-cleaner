import XCTest
import AppKit

/// Guards the icon assets the app and build-app.sh rely on. The executable target
/// cannot be imported from tests, so this checks the files on disk instead.
final class IconAssetTests: XCTestCase {
    private func pixelSize(_ url: URL) throws -> (Int, Int) {
        let rep = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: url)), url.lastPathComponent)
        return (rep.pixelsWide, rep.pixelsHigh)
    }

    func testMenuBarTemplatePNGsExistAtEachScale() throws {
        let dir = TestPaths.macosDir.appendingPathComponent("Sources/Obfuscate/Resources")
        let expected: [(String, Int, Int)] = [
            ("ObfuscateTemplate.png", 19, 18),
            ("ObfuscateTemplate@2x.png", 38, 36),
            ("ObfuscateTemplate@3x.png", 57, 54),
        ]
        for (name, w, h) in expected {
            let size = try pixelSize(dir.appendingPathComponent(name))
            XCTAssertEqual(size.0, w, name)
            XCTAssertEqual(size.1, h, name)
        }
    }

    func testPackageDeclaresResourcesForTheMenuBarIcon() throws {
        let text = try String(contentsOf: TestPaths.macosDir.appendingPathComponent("Package.swift"), encoding: .utf8)
        XCTAssertTrue(text.contains("resources: [.process(\"Resources\")]"), "Obfuscate target must ship its Resources")
    }

    func testAppIconIconsetHasEveryMacSize() throws {
        let dir = TestPaths.macosDir.appendingPathComponent("Icons/AppIcon.iconset")
        for base in [16, 32, 128, 256, 512] {
            let s1 = try pixelSize(dir.appendingPathComponent("icon_\(base)x\(base).png"))
            XCTAssertEqual(s1.0, base); XCTAssertEqual(s1.1, base)
            let s2 = try pixelSize(dir.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
            XCTAssertEqual(s2.0, base * 2); XCTAssertEqual(s2.1, base * 2)
        }
    }

    func testInfoPlistNamesTheAppIcon() throws {
        let data = try Data(contentsOf: TestPaths.macosDir.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(plist["CFBundleIconFile"] as? String, "AppIcon")
        XCTAssertEqual(plist["CFBundleName"] as? String, "Obfuscate")
    }
}
