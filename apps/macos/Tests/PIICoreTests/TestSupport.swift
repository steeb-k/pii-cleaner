import Foundation
import XCTest
@testable import PIICore

enum TestPaths {
    static var repoRoot: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("core/sanitizer.js").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        fatalError("repo root not found")
    }
    static var macosDir: URL { repoRoot.appendingPathComponent("apps/macos") }
}
