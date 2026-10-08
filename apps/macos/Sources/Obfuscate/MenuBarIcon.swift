import AppKit

/// The menu-bar status icon, assembled from the bundled ObfuscateTemplate PNGs.
///
/// SwiftPM's `swift build` does not compile asset catalogs, so the 1x/2x/3x PNGs
/// are shipped as plain files and combined into one template `NSImage` here.
/// A template image lets the menu bar tint it for light/dark appearance.
///
/// Lookup order: `Contents/Resources/` of the .app (build-app.sh copies the PNGs
/// there, next to sanitizer.js), then SwiftPM's resource bundle beside the binary
/// (dev `swift run`), then an SF Symbol so the item is never invisible. The
/// generated `Bundle.module` accessor is deliberately not used: it fatal-errors
/// when the bundle is not at the path it expects.
enum MenuBarIcon {
    static let pointSize = NSSize(width: 19, height: 18)
    private static let names = ["ObfuscateTemplate", "ObfuscateTemplate@2x", "ObfuscateTemplate@3x"]

    private static func url(for name: String) -> URL? {
        if let u = Bundle.main.url(forResource: name, withExtension: "png") { return u }
        let devBundle = Bundle.main.bundleURL.appendingPathComponent("Obfuscate_Obfuscate.bundle")
        let u = devBundle.appendingPathComponent(name + ".png")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    static let image: NSImage = {
        let img = NSImage(size: pointSize)
        for name in names {
            guard let url = url(for: name),
                  let data = try? Data(contentsOf: url),
                  let rep = NSBitmapImageRep(data: data) else { continue }
            rep.size = pointSize   // same point size for every scale; pixel size differs
            img.addRepresentation(rep)
        }
        if img.representations.isEmpty,
           let fallback = NSImage(systemSymbolName: "eye.slash", accessibilityDescription: "Obfuscate") {
            return fallback
        }
        img.isTemplate = true
        return img
    }()
}
