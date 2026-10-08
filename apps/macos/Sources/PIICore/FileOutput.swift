import Foundation

/// Pure helpers for the app's file output (naming, no-overwrite, multi-file join).
/// They live here, not in the UI target, so XCTest can cover them.
public enum FileOutput {
    /// `app.log` -> `app.sanitized.log`; `README` -> `README.sanitized`.
    public static func sanitizedName(for original: String) -> String {
        let ns = original as NSString
        let ext = ns.pathExtension
        let base = ns.deletingPathExtension
        return ext.isEmpty ? "\(base).sanitized" : "\(base).sanitized.\(ext)"
    }

    /// Returns `dir/name`, or `dir/base-2.ext`, `-3`, ... if it already exists. Never overwrites.
    public static func uniqueURL(in dir: URL, name: String, fileManager fm: FileManager = .default) -> URL {
        var url = dir.appendingPathComponent(name)
        guard fm.fileExists(atPath: url.path) else { return url }
        let ns = name as NSString
        let ext = ns.pathExtension
        let base = ns.deletingPathExtension
        var n = 2
        repeat {
            let candidate = ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)"
            url = dir.appendingPathComponent(candidate)
            n += 1
        } while fm.fileExists(atPath: url.path)
        return url
    }

    /// Same shape as the CLI's multi-file stdout: each part is `// ==== <name> ====\n<output>`,
    /// parts joined with "\n". A single file is just its output.
    public static func joined(_ items: [(name: String, output: String)]) -> String {
        if items.count == 1 { return items[0].output }
        return items.map { "// ==== \($0.name) ====\n" + $0.output }.joined(separator: "\n")
    }
}
