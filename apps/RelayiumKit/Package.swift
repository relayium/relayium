// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RelayiumKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "RelayiumKit", targets: ["RelayiumKit", "RelayiumAppKit"])],
    dependencies: [
        // Exact, not `from:` — this is the crypto the whole E2E guarantee rests
        // on, so a resolve must never be able to move it on its own. 0.11.0 is
        // what every build so far has actually used; bumping it is a deliberate
        // edit that re-runs the vector tests, not a side effect of resolving.
        .package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.11.0"),
        // Pinned to a tag, not the "latest" branch: this is the transport for an
        // E2E-encrypted product, so what goes into a signed build has to be a
        // named, immutable point — a branch silently moves under any resolve.
        // The tag's Package.swift is a .binaryTarget with a release URL and a
        // SHA256, so the XCFramework itself is checksum-verified on fetch.
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "150.0.0"),
    ],
    targets: [
        .target(
            name: "RelayiumKit",
            dependencies: [
                .product(name: "Sodium", package: "swift-sodium"),
                .product(name: "WebRTC", package: "WebRTC"),
            ]
        ),
        // @MainActor view-model layer for the native apps. Imports RelayiumKit and
        // Foundation, never SwiftUI — that is what keeps it unit-testable under
        // `swift test` and reusable by the iOS app in R3.
        .target(name: "RelayiumAppKit", dependencies: ["RelayiumKit"]),
        .testTarget(
            name: "RelayiumKitTests",
            dependencies: ["RelayiumKit", "RelayiumAppKit"],
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
        // Live PASSIVE-RECEIVE E2E: an unsolicited offer answered by the app's
        // own residency + listener + session model, rather than by two peers a
        // harness built. Depends on RelayiumAppKit for exactly that reason.
        // Run manually: `swift run NearbyReceiveE2E`. Needs the network.
        .executableTarget(
            name: "NearbyReceiveE2E",
            dependencies: [
                "RelayiumKit",
                "RelayiumAppKit",
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources/NearbyReceiveE2E"
        ),
    ]
)
