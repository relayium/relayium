import CoreGraphics
import ImageIO
import XCTest

/// The iOS icon catalog, checked for the two things Apple rejects at upload and
/// nothing that a re-render can legitimately change.
///
/// It is a separate file from `AppIconAssetTests` because iOS's rules are the
/// opposite of macOS's on both counts, and asserting them together would need
/// every assertion to carry a platform branch:
///
///  - **One image, not ten.** iOS derives every size from a single 1024×1024;
///    macOS wants an asset per size.
///  - **No alpha channel, and no self-drawn corners.** App Store Connect
///    refuses a transparent icon outright, and the system applies the mask — an
///    icon that rounds its own corners is rounded twice. macOS is the reverse:
///    its icon is an inset body on a transparent canvas.
///
/// Both are upload-time rejections. Every build, every test and every simulator
/// run passes with a transparent icon; the first thing that notices is App
/// Store Connect, after the archive has been made and uploaded.
final class IOSAppIconAssetTests: XCTestCase {
    /// The icon set, which must exist: a slot table compared against a missing
    /// directory is a comparison against nothing.
    private var iconSet: URL {
        get throws { try RepoRoot.directory("apps/ios/Relayium/Assets.xcassets/AppIcon.appiconset") }
    }
    private struct Entry: Decodable {
        let size, idiom: String
        let platform: String?
        let scale: String?
        let filename: String?
    }
    private struct Manifest: Decodable { let images: [Entry] }
    private func manifest() throws -> Manifest {
        try JSONDecoder().decode(Manifest.self,
            from: Data(contentsOf: try iconSet.appendingPathComponent("Contents.json")))
    }

    /// One entry, in the modern single-size form. A `scale` here makes Xcode
    /// read the catalog as the legacy per-size layout and then complain about
    /// every size it cannot find.
    func testExactlyOneUniversalEntry() throws {
        let images = try manifest().images
        XCTAssertEqual(images.count, 1)
        let entry = try XCTUnwrap(images.first)
        XCTAssertEqual(entry.idiom, "universal")
        XCTAssertEqual(entry.platform, "ios")
        XCTAssertEqual(entry.size, "1024x1024")
        XCTAssertNil(entry.scale, "the single-size form carries no scale")
        XCTAssertEqual(entry.filename, "icon_1024.png")
    }

    /// **The rejection this file exists for.** PNG colour type 2 is RGB; 6 is
    /// RGBA. An opaque RGBA icon still has the channel, and still gets refused.
    func testThePNGIs1024SquareWithNoAlphaChannel() throws {
        let entry = try XCTUnwrap(try manifest().images.first)
        let data = try Data(contentsOf: try iconSet.appendingPathComponent(entry.filename!))
        func be32(_ o: Int) -> Int { data[o...o + 3].reduce(0) { $0 << 8 | Int($1) } }
        XCTAssertEqual(Array(data[1...3]), Array("PNG".utf8))
        XCTAssertEqual(be32(16), 1024)
        XCTAssertEqual(be32(20), 1024)
        XCTAssertEqual(data[24], 8, "8-bit depth")
        XCTAssertEqual(data[25], 2, "colour type 2 is RGB; 6 would mean an alpha channel")
    }

    /// Full-bleed: the corners are painted, because the system masks them.
    ///
    /// Sampled as colour *family* rather than exact bytes — CoreGraphics
    /// rasterization is a system service that may change across releases, and a
    /// re-render that differs byte for byte is a toolchain change rather than a
    /// regression. What must not change is that no corner is background-free.
    func testEveryCornerIsPaintedRatherThanMasked() throws {
        let entry = try XCTUnwrap(try manifest().images.first)
        let url = try iconSet.appendingPathComponent(entry.filename!) as CFURL
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))

        // Redrawn into a known RGBA context so the samples are readable
        // regardless of how the PNG itself is laid out.
        let width = 64
        var pixels = [UInt8](repeating: 0, count: width * width * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels, width: width, height: width, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: width))

        func sample(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
            let i = (y * width + x) * 4
            return (Int(pixels[i]), Int(pixels[i + 1]), Int(pixels[i + 2]), Int(pixels[i + 3]))
        }
        for (x, y) in [(1, 1), (width - 2, 1), (1, width - 2), (width - 2, width - 2)] {
            let corner = sample(x, y)
            XCTAssertEqual(corner.a, 255, "corner (\(x),\(y)) is not opaque")
            // The brand family: more blue and red than green, never black.
            XCTAssertGreaterThan(corner.b, corner.g, "corner (\(x),\(y)) left the brand gradient")
            XCTAssertGreaterThan(corner.r, 60, "corner (\(x),\(y)) is too dark to be the gradient")
        }
        // And the glyph is still white in the middle of the canvas.
        let centre = sample(width / 2, width / 2)
        XCTAssertGreaterThan(min(centre.r, centre.g, centre.b), 180,
                             "the centre of the icon should be the white glyph")
    }

    /// The catalog is wired to the target, and the artwork is generated by the
    /// same script macOS uses — not a second copy of the drawing.
    func testTheCatalogIsDeclaredAndSharesOneRenderer() throws {
        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")
        XCTAssertEqual(
            project.components(separatedBy: "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;").count - 1,
            2, "both iOS app configurations must name the icon set")

        let renderer = try RepoRoot.text("apps/mac/tools/render-app-icon.swift")
        XCTAssertTrue(renderer.contains("case \"--ios\": self = .ios"),
                      "one renderer, two platforms — never a second drawing")
        XCTAssertTrue(renderer.contains("platform == .ios ? .noneSkipLast : .premultipliedLast"),
                      "the alpha decision must stay in the renderer, not in a later step")
    }
}
