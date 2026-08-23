import XCTest

/// The app icon is *derived* artwork, not new artwork: `web/public/favicon.svg`
/// and `web/src/lib/Logo.svelte` already carry the same mark, and the macOS
/// canvas re-expresses it on Apple's icon grid. This test is what keeps the
/// three copies from drifting — a source-parity test, so it imports no module
/// and simply reads the files, the pattern `IOSSurfaceGuardTests` already uses.
final class AppIconArtworkTests: XCTestCase {
    private func text(_ p: String) throws -> String { try RepoRoot.text(p) }
    private let macSVG = "apps/mac/Brand/AppIcon.svg"
    private let webSources = ["web/public/favicon.svg", "web/src/lib/Logo.svelte"]
    private let glyph = "M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5"

    func testTheGlyphIsIdenticalInAllThreeArtworkSources() throws {
        XCTAssertEqual(glyph.filter { $0 == "M" }.count, 4, "four subpaths")
        for file in [macSVG] + webSources {
            XCTAssertTrue(try text(file).contains(glyph), "\(file) no longer carries the glyph")
        }
    }
    func testGradientStopsAndStrokeAreIdenticalInAllThreeSources() throws {
        for file in [macSVG] + webSources {
            let t = try text(file)
            for needle in ["#a94bff", "#635bff", "stop-opacity=\".22\"", "offset=\".55\"",
                           "stroke-width=\"5.5\"", "stroke-linecap=\"round\"",
                           "stroke-linejoin=\"round\""] {
                XCTAssertTrue(t.contains(needle), "\(file) missing \(needle)")
            }
        }
    }
    /// The two deviations the design records, and no others: Apple's canvas and
    /// corner radius, and no shadow anywhere in the file.
    func testTheMacCanvasFollowsApplesGridAndBakesNoShadow() throws {
        let t = try text(macSVG)
        for needle in ["viewBox=\"0 0 1024 1024\"", "x=\"100\"", "y=\"100\"",
                       "width=\"824\"", "height=\"824\"", "rx=\"185.4\"",
                       "scale(12.875)"] {                       // 824/64
            XCTAssertTrue(t.contains(needle), "the mac canvas lost \(needle)")
        }
        XCTAssertFalse(t.contains("rx=\"15\""), "the web corner radius must not survive")
        for banned in ["feDropShadow", "filter=", "feGaussianBlur"] {
            XCTAssertFalse(t.contains(banned), "no shadow may be baked into the alpha channel")
        }
    }
    /// Constraint 9: the shared package must not learn about icons. The ban is
    /// on the *icon* targets by name — not on `executableTarget` as such, which
    /// `Package.swift` already uses legitimately for the `RealtimeE2E`,
    /// `NearbyReceiveE2E` and `LocalTransferPeer` manual harnesses. Those three
    /// must survive untouched, so the second assertion pins the executable set
    /// to exactly them: an added icon executable fails whatever it is called,
    /// and a *removed* harness fails too.
    ///
    /// `LocalTransferPeer` was added by Q0-T2a as the second endpoint a real
    /// local transfer needs. Extending the pinned set is the only way to admit
    /// it — the list is deliberately exhaustive so that a new executable is a
    /// decision somebody records here, not something that appears silently.
    func testTheSharedPackageHasNoIconTargets() throws {
        let manifest = try text("apps/RelayiumKit/Package.swift")
        for banned in ["AppIconArtwork", "AppIconGen"] {
            XCTAssertFalse(manifest.contains(banned), "Package.swift gained \(banned)")
        }
        let executables = manifest.components(separatedBy: ".executableTarget")
            .dropFirst()                                   // text before the first one
            .compactMap { chunk -> String? in
                guard let open = chunk.range(of: "name: \"") else { return nil }
                return String(chunk[open.upperBound...].prefix { $0 != "\"" })
            }
        XCTAssertEqual(executables.sorted(),
                       ["LocalTransferPeer", "NearbyReceiveE2E", "RealtimeE2E"],
                       "the executable targets are exactly the three recorded harnesses")
    }
}
