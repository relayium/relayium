import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

final class FileIdentityPresentationTests: XCTestCase {
    func testSafeNamesAndPathsRemainExact() {
        XCTAssertEqual(FileIdentityPresentation.name(
            for: FileMeta(name: "report.pdf", size: 1), language: .en), "report.pdf")
        XCTAssertEqual(FileIdentityPresentation.name(
            for: FileMeta(name: "report.pdf", size: 1, path: "季度/报告.pdf"), language: .en),
            "季度/报告.pdf")
    }

    func testAnEntirelyUnsafeNameGetsTheLocalizedPlaceholder() {
        let file = FileMeta(name: "\u{202E}\u{0007}\u{2069}", size: 1)
        let english = FileIdentityPresentation.name(for: file, language: .en)
        XCTAssertEqual(english, "Unnamed file")
        for language in AppLanguage.allCases where language != .en {
            let rendered = FileIdentityPresentation.name(for: file, language: language)
            XCTAssertFalse(rendered.isEmpty, language.rawValue)
            XCTAssertNotEqual(rendered, english, "\(language.rawValue) leaked the English fallback")
            XCTAssertFalse(rendered.contains("\u{202E}"), language.rawValue)
            XCTAssertFalse(rendered.contains("\u{0007}"), language.rawValue)
        }
    }
}
