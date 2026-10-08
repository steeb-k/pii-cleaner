import AppKit
import UniformTypeIdentifiers

enum FilePanels {
    /// ~/Library/Application Support/Obfuscate/ (created on demand). Inside the sandbox this
    /// resolves to the app container's Application Support directory.
    static func legendDirectory() -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("Obfuscate", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @MainActor
    static func savePanel(suggestedName: String, type: UTType?, directory: URL? = nil) -> URL? {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSSavePanel()
        p.nameFieldStringValue = suggestedName
        if let t = type { p.allowedContentTypes = [t] }
        if let d = directory { p.directoryURL = d }
        p.canCreateDirectories = true
        return p.runModal() == .OK ? p.url : nil
    }

    @MainActor
    static func openFile(type: UTType?, directory: URL? = nil) -> URL? {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        if let t = type { p.allowedContentTypes = [t] }
        if let d = directory { p.directoryURL = d }
        p.canChooseFiles = true
        p.canChooseDirectories = false
        p.allowsMultipleSelection = false
        return p.runModal() == .OK ? p.url : nil
    }

    @MainActor
    static func chooseDirectory() -> URL? {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        p.allowsMultipleSelection = false
        p.prompt = "Choose"
        return p.runModal() == .OK ? p.url : nil
    }
}
