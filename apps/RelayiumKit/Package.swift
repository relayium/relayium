// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RelayiumKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "RelayiumKit", targets: ["RelayiumKit"])],
    dependencies: [
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
    ],
    targets: [
        .target(name: "RelayiumKit", dependencies: [.product(name: "Sodium", package: "swift-sodium")]),
        .testTarget(
            name: "RelayiumKitTests",
            dependencies: ["RelayiumKit"],
            path: "Tests",
            resources: [.process("Fixtures")]
        ),
    ]
)
