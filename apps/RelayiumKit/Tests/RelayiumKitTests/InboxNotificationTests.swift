import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// What may be announced, and what may be announced twice.
///
/// The privacy half is a claim about the TYPE, not about the current call sites:
/// `InboxNotification` has four cases and none of them can carry a file name, a
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
            // The two halves say different things. They were the same string for
            // one delivery, which read as the sentence twice and left a user who
            // had never opened the Device Inbox with no idea where the message
            // had gone. The body is the route; the title is the event.
            XCTAssertNotEqual(title, body,
                              "\(language) renders the message banner as one sentence twice")
            // No digit anywhere in either half. A message has no count, and a
            // number on this banner could only have come from a length, a
            // position in a batch or an identifier — none of which a locked
            // screen may show.
            for half in [title, body] {
                XCTAssertNil(half.rangeOfCharacter(from: .decimalDigits),
                             "\(language) put a number on a message banner: \(half)")
            }
        }
    }

    /// **Nothing can be substituted into the message banner, in either half.**
    ///
    /// The strongest version of the rule, and the one a future edit is most
    /// likely to break quietly: `L10n.t` renders its catalog entry verbatim, so
    /// the ONLY way user content could reach this banner is a template with a
    /// `%@` in it and a call site that fills it. Both maintained catalogs are
    /// checked for the slot rather than for the content — an assertion about the
    /// finished string would pass right up until somebody added the argument.
    ///
    /// `testPlaceholderSignaturesMatchEnglish` then carries this to the frozen
    /// seven: a locale may not introduce a specifier English does not have.
    func testTheMessageBannerStringsHaveNoSubstitutionSlotAtAll() throws {
        for language in [AppLanguage.en, .zh] {
            let catalog = try XCTUnwrap(StringsCatalog.load(language),
                                        "catalog for \(language.rawValue) is missing")
            for key in [L10nKey.inboxSavedMessage, .inboxNotifyBodyMessage] {
                let template = try XCTUnwrap(catalog[key.rawValue],
                                             "\(language.rawValue) is missing \(key.rawValue)")
                XCTAssertEqual(formatSpecifiers(template), [],
                               "\(language.rawValue) \(key.rawValue) has a substitution slot, "
                               + "which is where a message preview would go: \(template)")
            }
        }
    }

    /// **`savedMessage` has no associated value, measured rather than read.**
    ///
    /// The privacy claim for a received message is not a rule about call sites —
    /// it is that the case has no payload, so there is no expression anywhere
    /// that could put the text, its length, its sender or its delivery id on a
    /// banner. Reflection is what turns that from a statement in a doc comment
    /// into something that fails when the declaration changes: adding
    /// `case savedMessage(preview: String)` would give the mirror a child here
    /// long before any renderer decided what to do with it.
    ///
    /// The `saved` case is checked in the same breath so this cannot pass by the
    /// mirror simply seeing nothing at all.
    func testTheMessageCaseHasNoAssociatedValueToCarryContent() {
        XCTAssertEqual(Mirror(reflecting: InboxNotification.savedMessage).children.count, 0,
                       "InboxNotification.savedMessage gained a payload; a macOS banner is "
                       + "drawn on the lock screen and there is nothing about a message it "
                       + "may show")
        XCTAssertEqual(Mirror(reflecting: InboxNotification.saved(files: 3)).children.count, 1,
                       "the mirror sees no payload on a case that has one, so the assertion "
                       + "above proves nothing")
    }
}
