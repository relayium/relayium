import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// What may be announced, and what may be announced twice.
///
/// The privacy half is a claim about the TYPE, not about the current call sites:
/// `InboxNotification` has three cases and none of them can carry a file name, a
/// path, an account email, a device id, a task id, a bearer or key material. The
/// assertions below drive the rendered strings for every case and check that
/// nothing the user or the protocol supplied appears in them, so a future case
/// that added such a field would have to change this file to ship.
final class InboxNotificationTests: XCTestCase {

    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - de-duplication

    /// A `saved` report that central never acknowledged is re-asserted on the
    /// next claim. The files did not arrive twice.
    func testTheSameTaskIsAnnouncedOnlyOnce() {
        let ledger = InboxNotificationLedger()
        let receipt = InboxReceipt(taskID: "t1", urls: [URL(fileURLWithPath: "/tmp/a")],
                                   byteCount: 1, savedAt: epoch, isReplay: false)
        XCTAssertTrue(ledger.shouldAnnounce(receipt))
        XCTAssertFalse(ledger.shouldAnnounce(receipt))
    }

    /// A replay is evidence, not an event: the files are genuinely on disk and
    /// the result row still appears, but nothing buzzes.
    func testAReplayedReceiptIsNeverAnnounced() {
        let ledger = InboxNotificationLedger()
        let replay = InboxReceipt(taskID: "t1", urls: [URL(fileURLWithPath: "/tmp/a")],
                                  byteCount: 1, savedAt: epoch, isReplay: true)
        XCTAssertFalse(ledger.shouldAnnounce(replay))
        // And it did not consume the identity: a genuine first delivery of the
        // same task would still be news.
        let fresh = InboxReceipt(taskID: "t1", urls: [URL(fileURLWithPath: "/tmp/a")],
                                 byteCount: 1, savedAt: epoch, isReplay: false)
        XCTAssertTrue(ledger.shouldAnnounce(fresh))
    }

    /// A blocker is re-measured on every pass. One problem is one banner.
    func testTheSameBlockerIsAnnouncedOnceAndReArmsWhenItClears() {
        let ledger = InboxNotificationLedger()
        let problem = InboxAttention.folder(.unresolvable)
        XCTAssertTrue(ledger.shouldAnnounce(problem))
        XCTAssertFalse(ledger.shouldAnnounce(problem))
        // A DIFFERENT blocker is news even while the first is unresolved: the
        // action it asks for has changed.
        XCTAssertTrue(ledger.shouldAnnounce(.delivery(.diskFull)))
        ledger.attentionCleared()
        XCTAssertTrue(ledger.shouldAnnounce(problem),
                      "a problem that came back was suppressed by a stale memory")
    }

    func testTheSameTerminalFailureIsAnnouncedOnce() {
        let ledger = InboxNotificationLedger()
        XCTAssertTrue(ledger.shouldAnnounce(InboxRuntimeFailure.keyUnavailable))
        XCTAssertFalse(ledger.shouldAnnounce(InboxRuntimeFailure.keyUnavailable))
        XCTAssertTrue(ledger.shouldAnnounce(InboxRuntimeFailure.identity))
    }

    /// Account B must not inherit account A's idea of what has already been
    /// announced, in either direction.
    func testResetForgetsBothDirections() {
        let ledger = InboxNotificationLedger()
        let receipt = InboxReceipt(taskID: "t1", urls: [URL(fileURLWithPath: "/tmp/a")],
                                   byteCount: 1, savedAt: epoch, isReplay: false)
        XCTAssertTrue(ledger.shouldAnnounce(receipt))
        XCTAssertTrue(ledger.shouldAnnounce(InboxAttention.delivery(.diskFull)))
        ledger.reset()
        XCTAssertTrue(ledger.shouldAnnounce(receipt))
        XCTAssertTrue(ledger.shouldAnnounce(InboxAttention.delivery(.diskFull)))
    }

    // MARK: - what a locked screen may show

    /// Every notification this product can raise, in every shipped language,
    /// rendered and checked for content it must never contain.
    ///
    /// The strings are exhaustive over the type: both attention arms across all
    /// their closed codes, every terminal failure, and a range of counts.
    func testNoNotificationCanRenderContentAFileNameOrAnIdentifier() {
        var notifications: [InboxNotification] = [.saved(files: 0), .saved(files: 1),
                                                  .saved(files: 3), .saved(files: 11),
                                                  .savedMessage]
        for problem in [InboxFolderProblem.accessDenied, .unresolvable, .notWritable,
                        .staleRefreshFailed] {
            notifications.append(.attention(.folder(problem)))
        }
        for code in InboxDeviceErrorCode.allCases {
            notifications.append(.attention(.delivery(code)))
        }
        for failure in InboxRuntimeFailure.allCases {
            notifications.append(.failed(failure))
        }

        // Things a real delivery carries, none of which may appear.
        let forbidden = ["brief.txt", "/Users/", "Downloads", "acct_", "dev_", "task_",
                         "bearer", "claim-token", "key1"]
        for language in AppLanguage.allCases {
            for notification in notifications {
                let title = InboxNotificationPresentation.title(notification, language: language)
                let body = InboxNotificationPresentation.body(notification, language: language)
                XCTAssertFalse(title.isEmpty)
                XCTAssertFalse(body.isEmpty)
                for needle in forbidden {
                    XCTAssertFalse(title.contains(needle), "\(language) title leaked \(needle)")
                    XCTAssertFalse(body.contains(needle), "\(language) body leaked \(needle)")
                }
                // A raw catalog key on a banner is a bug report; assert the
                // lookup resolved rather than fell through to the key.
                XCTAssertFalse(title.hasPrefix("inbox."), "\(language) title fell through")
                XCTAssertFalse(body.hasPrefix("inbox."), "\(language) body fell through")
            }
        }
    }

    /// The saved body is a COUNT, and it changes with the count — an assertion
    /// that would pass against a constant string is not evidence.
    func testTheSavedBodyIsTheCountAndOnlyTheCount() {
        let one = InboxNotificationPresentation.body(.saved(files: 1), language: .en)
        let many = InboxNotificationPresentation.body(.saved(files: 4), language: .en)
        XCTAssertNotEqual(one, many)
        XCTAssertTrue(one.contains("1"))
        XCTAssertTrue(many.contains("4"))
    }

    /// A message banner announces THAT a message arrived and nothing else.
    ///
    /// The type is what enforces it — `savedMessage` has no associated value, so
    /// there is nothing a call site could put on the banner — and this asserts
    /// the rendered halves in both maintained languages, including that a
    /// message does not render as a file count.
    func testAMessageBannerCarriesNoContentAndNoCount() {
        for language in [AppLanguage.en, .zh] {
            let title = InboxNotificationPresentation.title(.savedMessage, language: language)
            let body = InboxNotificationPresentation.body(.savedMessage, language: language)
            XCTAssertFalse(title.isEmpty)
            XCTAssertFalse(body.isEmpty)
            XCTAssertNotEqual(body,
                              InboxNotificationPresentation.body(.saved(files: 1),
                                                                 language: language),
                              "a message renders as a file delivery")
            XCTAssertNotEqual(body,
                              InboxNotificationPresentation.body(.saved(files: 0),
                                                                 language: language))
        }
    }
}
