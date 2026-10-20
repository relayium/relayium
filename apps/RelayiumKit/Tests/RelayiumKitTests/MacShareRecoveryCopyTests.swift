import XCTest
@testable import RelayiumAppKit

final class MacShareRecoveryCopyTests: XCTestCase {
    func testEveryMaintainedLanguageExplainsManualResumeAndNoClosedAppUploading() {
        let expected: [AppLanguage: [String]] = [.en: ["reopen", "Resume", "does not continue"],
                                                .zh: ["重新打开", "继续上传", "关闭期间不会继续上传"]]
        for language in AppLanguage.allCases {
            let copy = L10n.t(.uploadMacKeepOpen, language: language)
            for token in expected[language] ?? [] { XCTAssertTrue(copy.contains(token), copy) }
            XCTAssertFalse(copy.contains("start the upload again"))
            XCTAssertFalse(copy.contains("需要再次开始上传"))
        }
    }
    func testAmbiguousAndUnavailableUploadsHaveDifferentConsequencesInEveryLanguage() {
        for language in AppLanguage.allCases {
            let ambiguous = L10n.t(.uploadRecoveryUnconfirmed, language: language)
            let unavailable = L10n.t(.uploadRecoveryUnavailable, language: language)
            let disk = L10n.t(.uploadRecoveryStateWriteFailed, language: language)
            switch language {
            case .en:
                for word in ["same upload", "won't start another", "only removes", "this Mac"] {
                    XCTAssertTrue(ambiguous.contains(word), ambiguous)
                }
                XCTAssertTrue(unavailable.contains("counts as a new upload"))
                XCTAssertTrue(disk.contains("completion was not requested"))
            case .zh:
                for word in ["同一次上传", "不会另开一次", "只会移除", "这台 Mac"] {
                    XCTAssertTrue(ambiguous.contains(word), ambiguous)
                }
                XCTAssertTrue(unavailable.contains("重新计量"))
                XCTAssertTrue(disk.contains("尚未请求完成上传"))
            }
        }
    }
}
