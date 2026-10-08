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
        .executableTarget(name: "Obfuscate", dependencies: ["PIICore"], resources: [.process("Resources")]),
        .testTarget(name: "PIICoreTests", dependencies: ["PIICore"]),
    ],
    swiftLanguageVersions: [.v5]
)
