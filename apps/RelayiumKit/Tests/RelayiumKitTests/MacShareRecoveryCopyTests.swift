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
                for word in ["this completion request", "earlier request", "same upload"] {
                    XCTAssertTrue(disk.contains(word), disk)
                }
            case .zh:
                for word in ["同一次上传", "不会另开一次", "只会移除", "这台 Mac"] {
                    XCTAssertTrue(ambiguous.contains(word), ambiguous)
                }
                XCTAssertTrue(unavailable.contains("重新计量"))
                for word in ["这次完成请求", "之前的完成请求", "同一次上传"] {
                    XCTAssertTrue(disk.contains(word), disk)
                }
            }
        }
    }
    func testDiscardConfirmationExplainsLostAccessAndNoRefundInBothMaintainedLanguages() {
        for language in AppLanguage.allCases {
            let title = L10n.t(.uploadDiscardConfirmTitle, language: language)
            let body = L10n.t(.uploadDiscardConfirmBody, language: language)
            XCTAssertFalse(title.isEmpty)
            switch language {
            case .en:
                for word in ["already be complete", "permanently", "recover its link", "refund usage", "same upload"] {
                    XCTAssertTrue(body.contains(word), body)
                }
            case .zh:
                for word in ["可能已完成", "永久", "分享链接", "退还已计用量", "同一次上传"] {
                    XCTAssertTrue(body.contains(word), body)
                }
            }
        }
    }

}
