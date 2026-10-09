// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Obfuscate",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "PIICore", targets: ["PIICore"]),
        .executable(name: "Obfuscate", targets: ["Obfuscate"]),
    ],
    targets: [
        .target(name: "PIICore"),
        // The install half of the updater (bundle and signature checks, quarantine, the swap):
        // Foundation + Security, no networking, unit-tested on throwaway bundles.
        .target(name: "UpdateInstall"),
        .executableTarget(name: "Obfuscate", dependencies: ["PIICore", "UpdateInstall"], resources: [.process("Resources")]),
        .testTarget(name: "PIICoreTests", dependencies: ["PIICore", "UpdateInstall"]),
    ],
    swiftLanguageVersions: [.v5]
)
