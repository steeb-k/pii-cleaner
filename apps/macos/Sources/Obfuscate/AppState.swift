import SwiftUI
import PIICore
import UniformTypeIdentifiers

struct FileResult: Identifiable {
    let id = UUID()
    let name: String
    let result: SanitizeResult?   // nil = failed to read
    let failure: String?
}

@MainActor
final class AppState: ObservableObject {
    private var core: PIICore?
    @Published var initError: String?
    @Published var status: String = ""
    @Published var errorText: String?
    @Published var lastLeaks: [Leak] = []
    @Published var fileResults: [FileResult] = []
    @Published var enabled: [PIIType: Bool] = Dictionary(uniqueKeysWithValues: PIIType.allCases.map { ($0, true) })
    @Published var customType: PIIType = .HOST
    @Published var customText: String = ""
    @Published var legendCount: Int = 0
    /// True while a sanitize job runs off the main thread; the UI disables actions meanwhile.
    @Published var isBusy: Bool = false

    init() {
        do { core = try PIICore() }
        catch { initError = "Could not load the sanitizer core: \(error)" }
    }

    private var enabledOverrides: [PIIType: Bool] { enabled }

    private func summary(_ r: SanitizeResult) -> String {
        if let e = r.error { return "Error: \(e)" }
        let rec = r.records == 1 ? "1 record" : "\(r.records) records"
        let rep = r.stats.total == 1 ? "1 replacement" : "\(r.stats.total) replacements"
        return "Sanitized \(rec), \(rep) (format: \(r.format))"
    }

    func refreshLegendCount() {
        guard let core = core, let data = core.exportLegendJSON().data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = obj["entries"] as? [Any] else { legendCount = 0; return }
        legendCount = entries.count
    }

    func sanitizeClipboard() {
        errorText = nil
        guard let core = core, !isBusy else { return }
        guard let text = Pasteboard.readString(), !text.isEmpty else {
            status = "Clipboard has no text"
            return
        }
        let overrides = enabledOverrides
        isBusy = true
        status = "Sanitizing clipboard…"
        Task.detached(priority: .userInitiated) { [weak self] in
            // PIICore serializes JS access on its own queue, so calling it off-main is safe.
            let r = core.sanitize(text, enabled: overrides)
            await self?.finishClipboard(r)
        }
    }

    private func finishClipboard(_ r: SanitizeResult) {
        isBusy = false
        if r.error != nil { status = summary(r); lastLeaks = []; return }
        Pasteboard.write(r.output)
        lastLeaks = r.leaks
        status = summary(r) + (r.warning.map { " - \($0)" } ?? "")
        refreshLegendCount()
    }

    func handleDrop(urls: [URL]) {
        errorText = nil
        guard let core = core, !isBusy, !urls.isEmpty else { return }
        let overrides = enabledOverrides
        isBusy = true
        status = "Sanitizing \(urls.count) file\(urls.count == 1 ? "" : "s")…"
        Task.detached(priority: .userInitiated) { [weak self] in
            let results = Self.sanitizeFiles(urls, core: core, enabled: overrides)
            await self?.finishDrop(results)
        }
    }

    /// Reads and sanitizes each dropped file with the shared session. Runs off the main thread.
    nonisolated private static func sanitizeFiles(_ urls: [URL], core: PIICore, enabled: [PIIType: Bool]) -> [FileResult] {
        var results: [FileResult] = []
        for url in urls {
            let name = url.lastPathComponent
            let didAccess = url.startAccessingSecurityScopedResource()
            defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                results.append(FileResult(name: name, result: nil, failure: "could not read file"))
                continue
            }
            guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
                results.append(FileResult(name: name, result: nil, failure: "could not decode text"))
                continue
            }
            let r = core.sanitize(text, enabled: enabled, filename: name)
            if r.error != nil {
                results.append(FileResult(name: name, result: nil, failure: r.error))
            } else {
                results.append(FileResult(name: name, result: r, failure: nil))
            }
        }
        return results
    }

    private func finishDrop(_ results: [FileResult]) {
        isBusy = false
        fileResults = results
        lastLeaks = results.flatMap { $0.result?.leaks ?? [] }
        let ok = results.filter { $0.result != nil }.count
        let failed = results.count - ok
        status = "Sanitized \(ok) file\(ok == 1 ? "" : "s")" + (failed > 0 ? ", \(failed) failed" : "")
        refreshLegendCount()
    }

    private var successes: [(name: String, result: SanitizeResult)] {
        fileResults.compactMap { f in f.result.map { (f.name, $0) } }
    }

    func copyAllFiles() {
        let items = successes
        guard !items.isEmpty else { return }
        let text = FileOutput.joined(items.map { ($0.name, $0.result.output) })
        Pasteboard.write(text)
        status = "Copied \(items.count) file\(items.count == 1 ? "" : "s") to clipboard"
    }

    func saveFiles() {
        errorText = nil
        let items = successes
        guard !items.isEmpty else { return }
        if items.count == 1 {
            let item = items[0]
            guard let url = FilePanels.savePanel(suggestedName: FileOutput.sanitizedName(for: item.name), type: nil) else { return }
            do {
                try item.result.output.write(to: url, atomically: true, encoding: .utf8)
                status = "Saved \(url.lastPathComponent)"
            } catch { errorText = "Could not save: \(error.localizedDescription)" }
        } else {
            guard let dir = FilePanels.chooseDirectory() else { return }
            var saved = 0
            for item in items {
                let url = FileOutput.uniqueURL(in: dir, name: FileOutput.sanitizedName(for: item.name))
                do { try item.result.output.write(to: url, atomically: true, encoding: .utf8); saved += 1 }
                catch { errorText = "Could not save \(url.lastPathComponent): \(error.localizedDescription)" }
            }
            status = "Saved \(saved) of \(items.count) files to \(dir.lastPathComponent)"
        }
    }

    func addCustomValues() {
        errorText = nil
        guard let core = core else { return }
        let values = customText.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !values.isEmpty else { return }
        do {
            try core.addCustom(type: customType, values: values)
            status = "Added \(values.count) custom \(customType.rawValue) value\(values.count == 1 ? "" : "s")"
            customText = ""
            refreshLegendCount()
        } catch { errorText = "\(error)" }
    }

    func importLegend() {
        errorText = nil
        guard let core = core else { return }
        guard let url = FilePanels.openFile(type: .json, directory: FilePanels.legendDirectory()) else { return }
        do {
            let json = try String(contentsOf: url, encoding: .utf8)
            let r = try core.importLegend(json: json)
            status = "Legend imported: \(r.imported) imported, \(r.skipped) skipped"
            refreshLegendCount()
        } catch { errorText = "Could not import legend: \(error)" }
    }

    func exportLegend(csv: Bool) {
        errorText = nil
        guard let core = core else { return }
        guard let url = FilePanels.savePanel(suggestedName: csv ? "legend.csv" : "legend.json",
                                             type: csv ? .commaSeparatedText : .json,
                                             directory: FilePanels.legendDirectory()) else { return }
        do {
            try (csv ? core.exportLegendCSV() : core.exportLegendJSON()).write(to: url, atomically: true, encoding: .utf8)
            status = "Legend exported to \(url.lastPathComponent)"
        } catch { errorText = "Could not export legend: \(error.localizedDescription)" }
    }

    func clearSession() {
        core?.clear()
        lastLeaks = []
        fileResults = []
        refreshLegendCount()
        status = "Session cleared"
    }
}
