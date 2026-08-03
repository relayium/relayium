import CoreGraphics
import ImageIO
import XCTest

/// The generated icon catalog, checked for *structure* rather than for bytes.
///
/// Regeneration is a human command (`apps/mac/tools/README.md`), never a test
/// or a build side effect, and CoreGraphics rasterization is a system service
/// that may legitimately change across macOS releases. So a re-render that
/// differs byte for byte with no structural difference is a toolchain change,
/// not a regression — and these assertions are written to say exactly that:
/// slot completeness, PNG header geometry, alpha topology, and colour *family*
/// at named sample points.
final class AppIconAssetTests: XCTestCase {
    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }
    private var catalog: URL { repoRoot.appendingPathComponent("apps/mac/Relayium/Assets.xcassets") }
    private var iconSet: URL { catalog.appendingPathComponent("AppIcon.appiconset") }
    /// macOS needs an asset per size — Apple, "Configuring your app icon".
    /// 10 slots over 7 distinct pixel sizes; 32/256/512 are referenced twice.
    private let slots = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1),
                         (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
    private let pixelSizes = [16, 32, 64, 128, 256, 512, 1024]
    private struct Entry: Decodable { let size, scale, idiom: String; let filename: String? }
    private struct Manifest: Decodable { let images: [Entry] }
    private func manifest() throws -> Manifest {
        try JSONDecoder().decode(Manifest.self,
            from: Data(contentsOf: iconSet.appendingPathComponent("Contents.json")))
    }

    func testTenMacSlotsMatchingTheSlotTable() throws {
        let images = try manifest().images
        XCTAssertEqual(images.count, 10)
        XCTAssertTrue(images.allSatisfy { $0.idiom == "mac" })
        XCTAssertEqual(images.map { "\($0.size)@\($0.scale)" }.sorted(),
                       slots.map { "\($0.0)x\($0.0)@\($0.1)x" }.sorted())
        XCTAssertEqual(Set(slots.map { $0.0 * $0.1 }).sorted(), pixelSizes)
    }
    func testEveryFilenameExistsAndSevenAreDistinct() throws {
        let names = try manifest().images.compactMap(\.filename)
        XCTAssertEqual(names.count, 10)
        XCTAssertEqual(Set(names).count, 7)
        for n in Set(names) {
            XCTAssertTrue(FileManager.default.fileExists(atPath: iconSet.appendingPathComponent(n).path), n)
        }
    }
    /// IHDR read directly — width, height, bit depth, colour type. No decoder.
    func testEachPNGHeaderMatchesItsSlot() throws {
        for e in try manifest().images {
            let want = Int(e.size.split(separator: "x")[0])! * Int(e.scale.dropLast())!
            let d = try Data(contentsOf: iconSet.appendingPathComponent(e.filename!))
            func be32(_ o: Int) -> Int { d[o...o+3].reduce(0) { $0 << 8 | Int($1) } }
            XCTAssertEqual(Array(d[1...3]), Array("PNG".utf8))
            XCTAssertEqual(be32(16), want, e.filename!)
            XCTAssertEqual(be32(20), want, e.filename!)
            XCTAssertEqual(d[24], 8, "8-bit depth")
            XCTAssertEqual(d[25], 6, "RGBA colour type")
        }
    }
    /// Alpha topology and colour family at named sample points — never bytes,
    /// because a pixel-exact comparison across macOS rasterizers is fragile.
    func testSquircleTopologyAndColourFamily() throws {
        let at = try rgba(of: "icon_1024.png")
        XCTAssertEqual(at(4, 4).a, 0, "corner outside the squircle is transparent")
        XCTAssertEqual(at(512, 512).a, 255, "body centre opaque")
        XCTAssertEqual(at(512, 104).a, 255, "straight top edge of the body opaque")
        let c = at(512, 512)
        XCTAssertGreaterThan(c.r, c.g); XCTAssertGreaterThan(c.b, c.g)   // purple family
        let g = at(512, 400)                                             // upper arrow shaft
        XCTAssertTrue(g.r > 200 && g.g > 200 && g.b > 200, "glyph is white")
    }
    func testAccentColorSetAndIconNameAreDeclared() throws {
        let accent = try String(contentsOf:
            catalog.appendingPathComponent("AccentColor.colorset/Contents.json"), encoding: .utf8)
        XCTAssertTrue(accent.contains("0x6D"), "light accent #6d28d9")
        XCTAssertTrue(accent.contains("0x7C"), "dark accent #7c3aed")
        XCTAssertTrue(accent.contains("luminosity"), "a dark appearance variant must be declared")
        let plist = try String(contentsOf:
            repoRoot.appendingPathComponent("apps/mac/Relayium/Info.plist"), encoding: .utf8)
        XCTAssertTrue(plist.contains("<key>CFBundleIconName</key>"))
        XCTAssertTrue(plist.contains("<string>AppIcon</string>"))
    }
    /// The catalog must ship; the artwork source and the renderer must not.
    func testOnlyTheCatalogSitsInsideTheSynchronizedRoot() {
        let fm = FileManager.default
        XCTAssertTrue(catalog.path.hasSuffix("/apps/mac/Relayium/Assets.xcassets"))
        XCTAssertTrue(fm.fileExists(atPath: repoRoot.appendingPathComponent("apps/mac/Brand/AppIcon.svg").path))
        for shipped in ["apps/mac/Relayium/AppIcon.svg", "apps/mac/Relayium/Brand",
                        "apps/mac/Relayium/tools"] {
            XCTAssertFalse(fm.fileExists(atPath: repoRoot.appendingPathComponent(shipped).path),
                           "\(shipped) would be copied into the bundle")
        }
    }

    // MARK: - Sampling

    private struct Pixel { let r, g, b, a: Int }

    /// A `(x, y) -> Pixel` sampler over a decoded PNG.
    ///
    /// `y` counts **down from the top**, so a sample point reads the same way
    /// the SVG does. That is not an extra flip: a `CGBitmapContext`'s first
    /// memory row *is* the image's top row, so the plain index math below is
    /// already top-down once the image has been drawn upright.
    ///
    /// Colour components are un-premultiplied, so a comparison is about hue
    /// rather than about coverage.
    private func rgba(of filename: String) throws -> (Int, Int) -> Pixel {
        let url = iconSet.appendingPathComponent(filename)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil), filename)
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil), filename)
        let w = image.width, h = image.height
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4)
        buffer.initialize(repeating: 0, count: w * h * 4)
        defer { buffer.deallocate() }
        let context = try XCTUnwrap(CGContext(
            data: buffer, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        let bytes = Array(UnsafeBufferPointer(start: buffer, count: w * h * 4))
        return { x, y in
            let i = (y * w + x) * 4
            let a = Int(bytes[i + 3])
            func straight(_ c: UInt8) -> Int { a == 0 ? 0 : min(255, Int(c) * 255 / a) }
            return Pixel(r: straight(bytes[i]), g: straight(bytes[i + 1]),
                         b: straight(bytes[i + 2]), a: a)
        }
    }
}
