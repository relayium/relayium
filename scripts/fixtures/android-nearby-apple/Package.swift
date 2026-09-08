// swift-tools-version:5.9
import Foundation
import PackageDescription

// The Apple half of the Android ↔ Apple BIDIRECTIONAL local-link acceptance.
//
// A fixture CALLER, and the manifest says so structurally: every module that
// touches the wire is either a product of `apps/RelayiumKit` or a VERBATIM copy
// of one of its targets, and the only source this package owns is
// `Sources/AppleNearbyBidirectionalPeer`, which sequences public API and reads
// the models back.
//
// ## Why `RelayiumPeerKit` is copied rather than imported
//
// `apps/RelayiumKit/Package.swift` exports `RelayiumKit` (which vends
// `RelayiumKit` and `RelayiumAppKit`) and `RelayiumLocalPeerKit` as products.
// `RelayiumPeerKit` — `LinkCounterpart`, `LoopbackControlServer`, `FileReceipt`
// and `sha256Hex` — is declared as a TARGET, deliberately, so nothing it
// contains can end up inside a signed build. A target is not importable from
// another package, so the acceptance mirrors its sources here and
// `prepare.sh` SHA-256 checks every mirrored file against the repository's own
// copy before this manifest is ever read. "Unchanged" is therefore verified,
// not asserted, and no upstream file is edited to make this build work.
//
// `Sources/RelayiumPeerKit` is consequently NOT in the repository: it is
// materialised into a disposable copy of this directory by `prepare.sh`, which
// is the only supported way to build this package. `swift build` run here in
// place fails on the missing sources, which is the honest answer.

// The checkout-relative default is what makes this package reproducible from a
// clone alone. `RELAYIUM_KIT_PACKAGE_PATH` exists because `prepare.sh` builds a
// disposable copy of this directory OUTSIDE the repository, from which the
// relative path no longer resolves; it is set from the launcher's own `$repo`
// and is never a path a person has to know.
let kitPath = ProcessInfo.processInfo.environment["RELAYIUM_KIT_PACKAGE_PATH"]
    ?? "../../../apps/RelayiumKit"

let package = Package(
    name: "AppleNearbyBidirectionalPeer",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: kitPath),
        // Named here only because the mirrored `RelayiumPeerKit` target links
        // it. Pinned to the same exact tag the shipped package pins, so this
        // build cannot resolve a transport the product would not.
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "150.0.0"),
    ],
    targets: [
        // The VERBATIM mirror. Every file is SHA-256 checked against
        // `apps/RelayiumKit/Sources/RelayiumPeerKit` by `prepare.sh` before this
        // builds; see the header above for why the copy exists at all.
        .target(
            name: "RelayiumPeerKit",
            dependencies: [
                .product(name: "RelayiumKit", package: "RelayiumKit"),
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources/RelayiumPeerKit"
        ),
        .executableTarget(
            name: "AppleNearbyBidirectionalPeer",
            dependencies: [
                "RelayiumPeerKit",
                .product(name: "RelayiumKit", package: "RelayiumKit"),
                // The local link's own discovery, advertisement, framing and
                // transport — the shipped iOS Nearby rendezvous.
                .product(name: "RelayiumLocalPeerKit", package: "RelayiumKit"),
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources/AppleNearbyBidirectionalPeer"
        ),
    ]
)
