// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Obfuscate",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "PIICore", targets: ["PIICore"]),
        .executable(name: "Obfuscate", targets: ["Obfuscate"]),
        .executable(name: "ObfuscateUpdater", targets: ["ObfuscateUpdater"]),
    ],
    targets: [
        .target(name: "PIICore"),
        // The install half of the updater (signature checks, quarantine, the swap), shared by
        // the app and the unsandboxed helper that does the part the sandbox forbids.
        .target(name: "UpdateInstall"),
        .executableTarget(name: "Obfuscate", dependencies: ["PIICore", "UpdateInstall"], resources: [.process("Resources")]),
        .executableTarget(name: "ObfuscateUpdater", dependencies: ["UpdateInstall"]),
        .testTarget(name: "PIICoreTests", dependencies: ["PIICore", "UpdateInstall"]),
    ],
    swiftLanguageVersions: [.v5]
)
