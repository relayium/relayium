// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RelayiumKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "RelayiumKit", targets: ["RelayiumKit"])],
    dependencies: [
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
        .package(url: "https://github.com/stasel/WebRTC.git", branch: "latest"),
    ],
    targets: [
        .target(
            name: "RelayiumKit",
            dependencies: [
                .product(name: "Sodium", package: "swift-sodium"),
                .product(name: "WebRTC", package: "WebRTC"),
            ]
        ),
        .testTarget(
            name: "RelayiumKitTests",
            dependencies: ["RelayiumKit"],
            path: "Tests",
            resources: [.process("Fixtures")]
        ),
        // Live realtime E2E harness (native<->native over prod /ws). Not a unit
        // test — run manually: `swift run RealtimeE2E`. Needs the network.
        .executableTarget(
            name: "RealtimeE2E",
            dependencies: [
                "RelayiumKit",
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources/RealtimeE2E"
        ),
    ]
)
