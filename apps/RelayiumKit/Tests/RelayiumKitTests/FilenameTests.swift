import XCTest
@testable import RelayiumKit

final class FilenameTests: XCTestCase {
    func testSafeDisplayNameMatchesVector() throws {
        let v = try Vectors.load("store-wire-vectors")
        XCTAssertEqual(safeDisplayName(v.str("sanitize.in")), v.str("sanitize.out"))
    }
    func testStripsBidiAndControls() {
        // U+202E (RLO) and U+0007 (BEL) removed; ordinary chars kept.
        XCTAssertEqual(safeDisplayName("a\u{202E}b\u{0007}.txt"), "ab.txt")
        XCTAssertEqual(safeDisplayName("\u{200F}\u{2069}name\u{061C}"), "name")
        XCTAssertEqual(safeDisplayName("normal.png"), "normal.png")
    }
}
