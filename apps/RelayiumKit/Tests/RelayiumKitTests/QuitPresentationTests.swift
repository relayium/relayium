import XCTest
@testable import RelayiumAppKit

final class QuitPresentationTests: XCTestCase {
    func testEveryRiskCombinationIsDistinct() {
        XCTAssertEqual(QuitPresentation.risk(transferRunning: false, hasLocalText: false), .none)
        XCTAssertEqual(QuitPresentation.risk(transferRunning: true, hasLocalText: false), .transfer)
        XCTAssertEqual(QuitPresentation.risk(transferRunning: false, hasLocalText: true), .localText)
        XCTAssertEqual(QuitPresentation.risk(transferRunning: true, hasLocalText: true),
                       .transferAndLocalText)
    }

    func testNoRiskNeedsNoPrompt() {
        XCTAssertNil(QuitPresentation.prompt(for: .none, language: .en))
    }

    func testTransferAndLocalTextPromptNamesEveryCost() throws {
        let transfer = try XCTUnwrap(QuitPresentation.prompt(for: .transfer, language: .en))
        let localText = try XCTUnwrap(QuitPresentation.prompt(for: .localText, language: .en))
        let both = try XCTUnwrap(QuitPresentation.prompt(for: .transferAndLocalText, language: .en))
        XCTAssertTrue(transfer.body.contains("cancels"))
        XCTAssertFalse(transfer.body.contains("history"))
        XCTAssertTrue(localText.body.contains("history"))
        XCTAssertTrue(localText.body.contains("unsent draft"))
        XCTAssertTrue(localText.body.contains("permanently"))
        XCTAssertFalse(localText.body.contains("transfer"))
        XCTAssertTrue(both.body.contains("transfer"))
        XCTAssertTrue(both.body.contains("history"))
        XCTAssertTrue(both.body.contains("permanently"))
    }

    func testEveryLanguageOffersGenericQuitAndStayActions() throws {
        for language in AppLanguage.allCases {
            let prompt = try XCTUnwrap(QuitPresentation.prompt(for: .localText,
                                                               language: language))
            XCTAssertFalse(prompt.title.isEmpty, language.rawValue)
            XCTAssertFalse(prompt.body.isEmpty, language.rawValue)
            XCTAssertFalse(prompt.quitAction.isEmpty, language.rawValue)
            XCTAssertFalse(prompt.stayAction.isEmpty, language.rawValue)
            XCTAssertTrue(prompt.stayAction.contains("Relayium"), language.rawValue)
        }
    }
}
