import XCTest
@testable import RelayiumAppKit

final class QuitPresentationTests: XCTestCase {
    func testEveryRiskCombinationIsDistinct() {
        XCTAssertEqual(QuitPresentation.risk(transferRunning: false, hasTextHistory: false), .none)
        XCTAssertEqual(QuitPresentation.risk(transferRunning: true, hasTextHistory: false), .transfer)
        XCTAssertEqual(QuitPresentation.risk(transferRunning: false, hasTextHistory: true), .textHistory)
        XCTAssertEqual(QuitPresentation.risk(transferRunning: true, hasTextHistory: true),
                       .transferAndTextHistory)
    }

    func testNoRiskNeedsNoPrompt() {
        XCTAssertNil(QuitPresentation.prompt(for: .none, language: .en))
    }

    func testTransferAndHistoryPromptNamesBothCosts() throws {
        let transfer = try XCTUnwrap(QuitPresentation.prompt(for: .transfer, language: .en))
        let history = try XCTUnwrap(QuitPresentation.prompt(for: .textHistory, language: .en))
        let both = try XCTUnwrap(QuitPresentation.prompt(for: .transferAndTextHistory, language: .en))
        XCTAssertTrue(transfer.body.contains("cancels"))
        XCTAssertFalse(transfer.body.contains("history"))
        XCTAssertTrue(history.body.contains("permanently"))
        XCTAssertFalse(history.body.contains("transfer"))
        XCTAssertTrue(both.body.contains("transfer"))
        XCTAssertTrue(both.body.contains("history"))
        XCTAssertTrue(both.body.contains("permanently"))
    }

    func testEveryLanguageOffersGenericQuitAndStayActions() throws {
        for language in AppLanguage.allCases {
            let prompt = try XCTUnwrap(QuitPresentation.prompt(for: .textHistory,
                                                               language: language))
            XCTAssertFalse(prompt.title.isEmpty, language.rawValue)
            XCTAssertFalse(prompt.body.isEmpty, language.rawValue)
            XCTAssertFalse(prompt.quitAction.isEmpty, language.rawValue)
            XCTAssertFalse(prompt.stayAction.isEmpty, language.rawValue)
            XCTAssertTrue(prompt.stayAction.contains("Relayium"), language.rawValue)
        }
    }
}
