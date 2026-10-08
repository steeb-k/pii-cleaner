import SwiftUI
import UniformTypeIdentifiers

struct DropZoneView: View {
    let onDrop: ([URL]) -> Void
    @State private var targeted = false

    var body: some View {
        RoundedRectangle(cornerRadius: 8)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [5]))
            .foregroundStyle(targeted ? Color.accentColor : Color.secondary)
            .background(targeted ? Color.accentColor.opacity(0.1) : Color.clear)
            .frame(height: 60)
            .overlay(Text("Drop log files here").foregroundStyle(.secondary))
            .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
                let group = DispatchGroup()
                var urls: [(Int, URL)] = []
                let lock = NSLock()
                for (i, p) in providers.enumerated() {
                    group.enter()
                    p.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                        defer { group.leave() }
                        var url: URL?
                        if let d = item as? Data { url = URL(dataRepresentation: d, relativeTo: nil) }
                        else if let u = item as? URL { url = u }
                        if let u = url { lock.lock(); urls.append((i, u)); lock.unlock() }
                    }
                }
                group.notify(queue: .main) {
                    let ordered = urls.sorted { $0.0 < $1.0 }.map { $0.1 }
                    if !ordered.isEmpty { onDrop(ordered) }
                }
                return true
            }
    }
}
