import SwiftUI
import PIICore

struct ContentView: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Obfuscate").font(.headline)
                Text("Local only. Nothing leaves this Mac.").font(.caption).foregroundStyle(.secondary)
            }

            if let e = state.initError {
                Text(e).foregroundStyle(.red).font(.caption)
            }

            HStack {
                Button("Sanitize clipboard") { state.sanitizeClipboard() }
                    .disabled(state.initError != nil || state.isBusy)
                if state.isBusy { ProgressView().controlSize(.small) }
            }

            DropZoneView { state.handleDrop(urls: $0) }
                .disabled(state.isBusy)

            if !state.fileResults.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(state.fileResults) { f in
                        if let r = f.result {
                            Text("\(f.name): \(r.stats.total) replacements").font(.caption)
                        } else {
                            Text("\(f.name): failed (\(f.failure ?? "unknown"))").font(.caption).foregroundStyle(.red)
                        }
                    }
                    HStack {
                        Button("Copy all to clipboard") { state.copyAllFiles() }
                        Button("Save…") { state.saveFiles() }
                    }
                }
            }

            if !state.status.isEmpty { Text(state.status).font(.caption) }
            if let e = state.errorText { Text(e).font(.caption).foregroundStyle(.red) }

            if !state.lastLeaks.isEmpty {
                DisclosureGroup("Leaks (\(state.lastLeaks.count))") {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(state.lastLeaks.enumerated()), id: \.offset) { _, l in
                                Text("[\(l.type)] \(l.value)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.red)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(2)
                                    .background(Color.red.opacity(0.1))
                            }
                        }
                    }.frame(maxHeight: 100)
                }
            }

            DisclosureGroup("Types") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(PIIType.allCases, id: \.self) { t in
                        Toggle(t.rawValue, isOn: Binding(
                            get: { state.enabled[t] ?? true },
                            set: { state.enabled[t] = $0 }))
                            .toggleStyle(.checkbox)
                    }
                }
            }

            DisclosureGroup("Custom values") {
                VStack(alignment: .leading) {
                    Picker("Type", selection: $state.customType) {
                        ForEach([PIIType.HOST, .USER, .DOMAIN, .CUSTOM], id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    TextEditor(text: $state.customText)
                        .font(.body.monospaced())
                        .frame(height: 60)
                        .border(Color.secondary.opacity(0.4))
                    Button("Add") { state.addCustomValues() }
                }
            }

            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Text("Legend entries: \(state.legendCount)").font(.caption)
                HStack {
                    Button("Import…") { state.importLegend() }
                    Button("Export JSON…") { state.exportLegend(csv: false) }
                    Button("Export CSV…") { state.exportLegend(csv: true) }
                }
                Button("Clear session") { state.clearSession() }
                    .disabled(state.isBusy)
            }
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .padding(12)
        .frame(width: 340)
        .onAppear { state.refreshLegendCount() }
    }
}
