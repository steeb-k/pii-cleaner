import AppKit

enum Pasteboard {
    static func readString() -> String? {
        NSPasteboard.general.string(forType: .string)
    }

    static func write(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }
}
