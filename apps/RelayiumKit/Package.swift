// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RelayiumKit",
    // Required the moment a target ships `.lproj` resources: it is the language
    // SwiftPM treats as the base, and it is what makes `en` the deterministic
    // fallback for every key that a translation is missing for. It must stay
    // `en` — `LocalizationCatalog` falls back to `AppLanguage.en` in code, and
    // the two would disagree otherwise.
    defaultLocalization: "en",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "RelayiumKit", targets: ["RelayiumKit", "RelayiumAppKit"]),
        // The share extension's whole world, and deliberately a SEPARATE product
        // from the one the apps link. An `.appex` is a second process the system
        // launches inside somebody else's share sheet, under a tighter memory
        // budget and with the user watching; linking `RelayiumKit` there would
        // map WebRTC and libsodium into it for a job that copies files and writes
        // one JSON document. It would also put a full account client, a token
        // store and an uploader one `import` away from a process whose entire
        // safety argument is that it cannot reach them.
        //
        // Nothing in this target may gain a dependency. That is the constraint
        // that keeps the boundary real rather than documented.
        .library(name: "RelayiumShareKit", targets: ["RelayiumShareKit"]),
        // The ONLY module in this repository that imports StoreKit, and a
        // separate product for the same kind of reason `RelayiumShareKit` is:
        // the boundary has to be structural rather than remembered.
        //
        // Linking StoreKit into an app is a claim — it is what the purchase
        // machinery and App Store review look for, and an app that links it is
        // an app that sells something. Only the Mac App Store target and the
        // iOS app link this product; the direct Mac build and both Share
        // extensions do not. There is no `.storekit` configuration file and no
        // production product identifier in the tree; the server owns catalog
        // mappings for each bundle identity.
        //
        // It depends on `RelayiumAppKit` and must never gain a dependency the
        // other way round: the seam it implements (`SubscriptionStore`) is
        // declared above it and names no StoreKit type, which is what lets the
        // whole purchase policy run under `swift test` with no store at all.
        .library(name: "RelayiumStoreKit", targets: ["RelayiumStoreKit"]),
    ],
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
        // Foundation and nothing else. Two things live here, and they are here
        // for the same reason: the iOS share extension needs both, and needs
        // them without the transport stack.
        //
        //  - **The nine `.lproj` catalogs and `L10n`.** They used to sit in
        //    `RelayiumAppKit`. Nothing about turning a key into words depends on
        //    WebRTC, an uploader or an account, and the extension has to render
        //    the same nine languages as the app — so the layer moved down rather
        //    than the extension linking up. `Bundle.module` still resolves them
        //    with no main-bundle lookup, which is the property that made them
        //    package resources in the first place; it now resolves in the appex
        //    bundle too. `RelayiumAppKit` re-exports this module, so every
        //    existing `import RelayiumAppKit` still sees `L10n` unchanged.
        //  - **The shared draft store.** The App Group hand-off between the
        //    extension and the app. Both sides link it, so there is exactly one
        //    implementation of the on-disk format, and `swift test` drives it
        //    against an injected root with no container, no entitlement and no
        //    provider.
        .target(name: "RelayiumShareKit",
                resources: [.process("Resources")]),
        // @MainActor view-model layer for the native apps. Imports RelayiumKit and
        // Foundation, never SwiftUI — that is what keeps it unit-testable under
        // `swift test` and reusable by the iOS app in R3.
        .target(name: "RelayiumAppKit",
                dependencies: ["RelayiumKit", "RelayiumShareKit"]),
        // The StoreKit adapter, alone. One file, one import, no resources and no
        // product identifiers — everything it needs is passed in.
        //
        // It deliberately depends on nothing but `RelayiumAppKit`, whose
        // `SubscriptionStore` protocol it implements. In particular it does NOT
        // depend on `RelayiumKit`: an adapter with the account client one import
        // away could submit a transaction itself, and the whole point of the
        // seam is that the only thing it can do with a purchase is hand it up.
        .target(name: "RelayiumStoreKit",
                dependencies: ["RelayiumAppKit"]),
        .testTarget(
            name: "RelayiumKitTests",
            // Tests also link `RelayiumStoreKit`, so `swift test` type-checks
            // the real adapter on every run. The tests drive the purchase policy
            // through a fake store; what linking the real one buys is that the
            // StoreKit 2 API surface it names cannot rot unnoticed.
            dependencies: ["RelayiumKit", "RelayiumAppKit", "RelayiumShareKit",
                           "RelayiumStoreKit"],
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
