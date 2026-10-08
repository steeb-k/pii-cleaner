import Foundation

/// Locates the one shared `core/sanitizer.js`. Nothing is copied into the source tree.
public enum CoreScript {
    /// Bundled resource (built .app), else walk up from this source file to `<repo>/core/sanitizer.js`.
    public static func locate(filePath: String = #filePath) -> URL? {
        if let u = Bundle.main.url(forResource: "sanitizer", withExtension: "js") { return u }
        var dir = URL(fileURLWithPath: filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("core/sanitizer.js")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }
}
