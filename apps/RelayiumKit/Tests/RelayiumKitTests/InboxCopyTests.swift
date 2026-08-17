import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// One sentence per state, in nine languages, and never an optimistic one.
///
/// The state enum is closed and `CaseIterable` where it can be, so these tests
/// walk the real thing rather than a list somebody remembered to update. What
/// they are protecting is the claim `ready` makes: it is a promise to a STRANGER
/// that their file will land on this machine, so no other state may render its
/// sentence, and no state may render nothing at all.
final class InboxCopyTests: XCTestCase {

    /// Every state this product can be in.
    private var allStates: [InboxRuntimeState] {
        var states: [InboxRuntimeState] = [
            .signedOut, .loading, .disabled, .folderMissing, .paused, .working,
            .saved(files: 0), .saved(files: 1), .saved(files: 5), .savedMessage,
            .asking(count: 1), .asking(count: 4),
            .offline(retryInSeconds: nil), .offline(retryInSeconds: 30),
        ]
        for policy in InboxAutoAccept.allCases { states.append(.ready(policy)) }
        for problem in [InboxFolderProblem.accessDenied, .unresolvable, .notWritable,
                        .staleRefreshFailed] {
            states.append(.attention(.folder(problem)))
        }
        for code in InboxDeviceErrorCode.allCases { states.append(.attention(.delivery(code))) }
        for failure in InboxRuntimeFailure.allCases { states.append(.failed(failure)) }
        return states
    }

    func testEveryStateRendersInEveryShippedLanguage() {
        for language in AppLanguage.allCases {
            for state in allStates {
                let text = InboxStatusPresentation.text(for: state, language: language)
                XCTAssertFalse(text.isEmpty, "\(language) rendered nothing for \(state)")
                XCTAssertFalse(text.hasPrefix("inbox."),
                               "\(language) fell through to the key for \(state)")
            }
        }
    }

    /// The `ready` sentence belongs to `ready` alone. A `default:` in a renderer
    /// is what would break this, which is why the enum has no `other` case and
    /// this test exists.
    func testNoOtherStateBorrowsTheReadySentence() {
        for language in AppLanguage.allCases {
            let ready = Set([
                InboxStatusPresentation.text(for: .ready(.auto), language: language),
                InboxStatusPresentation.text(for: .ready(.ask), language: language),
            ])
            for state in allStates {
                if case .ready = state { continue }
                XCTAssertFalse(ready.contains(
                    InboxStatusPresentation.text(for: state, language: language)),
                    "\(language) rendered \(state) as ready")
            }
        }
    }

    /// `auto` and `ask` make different promises: one says a file will land
    /// without the user doing anything, the other says it will wait for them.
    func testAutoAndAskDoNotShareASentence() {
        for language in AppLanguage.allCases {
            XCTAssertNotEqual(InboxStatusPresentation.text(for: .ready(.auto), language: language),
                              InboxStatusPresentation.text(for: .ready(.ask), language: language),
                              "\(language) tells an ask device it receives automatically")
        }
    }

    /// Every folder problem and every delivery blocker has its own sentence.
    /// Collapsing two of them is how a stalled inbox looks fine for a week.
    func testEachBlockerHasItsOwnSentence() {
        for language in AppLanguage.allCases {
            var seen: [String: String] = [:]
            for problem in [InboxFolderProblem.accessDenied, .unresolvable, .notWritable,
                            .staleRefreshFailed] {
                let text = InboxStatusPresentation.text(for: .folder(problem), language: language)
                XCTAssertNil(seen[text], "\(language): \(problem) reads the same as \(seen[text]!)")
                seen[text] = "\(problem)"
            }
            var codes: [String: String] = [:]
            for code in InboxDeviceErrorCode.allCases {
                // `none` and `internal` deliberately share the fail-closed
                // sentence: an absent code on a failed delivery IS the internal
                // case, and inventing a second wording would imply a distinction
                // the product cannot make.
                guard code != .none else { continue }
                let text = InboxStatusPresentation.text(for: .delivery(code), language: language)
                XCTAssertNil(codes[text], "\(language): \(code) reads the same as \(codes[text]!)")
                codes[text] = "\(code)"
            }
        }
    }

    /// A recovery is offered for exactly the states a person can act on, and for
    /// none of the healthy ones — a button on a working inbox invites the user to
    /// fix something that is not broken.
    func testRecoveryIsOfferedOnlyWhereThereIsSomethingToDo() {
        XCTAssertNil(InboxStatusPresentation.recovery(for: .ready(.auto)))
        XCTAssertNil(InboxStatusPresentation.recovery(for: .working))
        XCTAssertNil(InboxStatusPresentation.recovery(for: .saved(files: 1)))
        XCTAssertNil(InboxStatusPresentation.recovery(for: .loading))
        XCTAssertNil(InboxStatusPresentation.recovery(for: .disabled))
        XCTAssertNil(InboxStatusPresentation.recovery(for: .signedOut))

        XCTAssertEqual(InboxStatusPresentation.recovery(for: .folderMissing), .chooseFolder)
        XCTAssertEqual(InboxStatusPresentation.recovery(for: .paused), .resume)
        XCTAssertEqual(InboxStatusPresentation.recovery(for: .asking(count: 2)), .answer)
        XCTAssertEqual(InboxStatusPresentation.recovery(for: .offline(retryInSeconds: 5)), .retry)
        XCTAssertEqual(InboxStatusPresentation.recovery(for: .failed(.identity)), .retry)
    }

    /// Every folder problem is repaired by granting the folder again. Retrying
    /// the same stored bookmark is the one thing that cannot help.
    func testEveryFolderProblemAsksForTheFolderRatherThanARetry() {
        for problem in [InboxFolderProblem.accessDenied, .unresolvable, .notWritable,
                        .staleRefreshFailed] {
            XCTAssertEqual(InboxStatusPresentation.recovery(for: .attention(.folder(problem))),
                           .chooseFolder, "\(problem) offers a retry that cannot work")
        }
        // A permission or directory blocker on a DELIVERY has the same cause and
        // the same repair.
        for code in [InboxDeviceErrorCode.permissionDenied, .directoryUnavailable] {
            XCTAssertEqual(InboxStatusPresentation.recovery(for: .attention(.delivery(code))),
                           .chooseFolder)
        }
        XCTAssertEqual(InboxStatusPresentation.recovery(for: .attention(.delivery(.diskFull))),
                       .retry)
    }

    /// The offline sentence says WHEN, so the UI does not have to spin.
    func testTheOfflineSentenceCarriesTheScheduledRetry() {
        let bare = InboxStatusPresentation.text(for: .offline(retryInSeconds: nil), language: .en)
        let timed = InboxStatusPresentation.text(for: .offline(retryInSeconds: 20), language: .en)
        XCTAssertNotEqual(bare, timed)
        XCTAssertTrue(timed.contains("20"))
        // Zero is not a schedule: it renders the bare sentence rather than
        // promising a retry in no time at all.
        XCTAssertEqual(InboxStatusPresentation.text(for: .offline(retryInSeconds: 0),
                                                    language: .en), bare)
    }

    /// The three policy labels are distinct in every language, or the picker
    /// offers the same answer twice.
    func testThePolicyLabelsAreDistinctEverywhere() {
        for language in AppLanguage.allCases {
            let labels = InboxAutoAccept.allCases.map {
                InboxPolicyPresentation.label(for: $0, language: language)
            }
            XCTAssertEqual(Set(labels).count, labels.count, "\(language) repeats a policy label")
            for label in labels { XCTAssertFalse(label.isEmpty) }
        }
    }

    /// Every refusal of a user action has a sentence, in every language.
    func testEverySettingsRefusalRenders() {
        for language in AppLanguage.allCases {
            for error in InboxSettingsError.allCases {
                let text = InboxSettingsErrorCopy.message(error, language: language)
                XCTAssertFalse(text.isEmpty)
                XCTAssertFalse(text.hasPrefix("inbox."))
            }
        }
    }

    /// The folder line renders the folder's NAME, not its path — the path
    /// contains the user's short name, and often other people's.
    func testTheFolderLineNamesTheFolderRatherThanThePath() {
        let summary = InboxFolderSummary(url: URL(fileURLWithPath: "/Users/lily/Work/Inbox"),
                                         isChosen: true, problem: nil)
        let text = InboxFolderPresentation.description(summary, language: .en)
        XCTAssertEqual(text, "Inbox")
        XCTAssertFalse(text.contains("/Users"))
    }

    /// No folder and a broken folder are different sentences: one is nothing
    /// wrong, the other is something to fix.
    func testAbsentAndBrokenFoldersReadDifferently() {
        let absent = InboxFolderPresentation.description(.none, language: .en)
        let broken = InboxFolderPresentation.description(
            InboxFolderSummary(url: nil, isChosen: true, problem: .unresolvable), language: .en)
        XCTAssertNotEqual(absent, broken)
        XCTAssertFalse(broken.isEmpty)
    }

    // MARK: - the received-messages section

    private func message(_ id: String, _ text: String, at seconds: TimeInterval)
        -> InboxMessage {
        InboxMessage(id: id, receivedAt: Date(timeIntervalSince1970: seconds), text: text)
    }

    /// **The section's copy describes a message; it never contains one.**
    ///
    /// Everything this presentation returns is a heading, a footer, a timestamp
    /// or a control name. The body reaches the screen straight off
    /// `InboxMessage.text` at the view, because a presentation helper that took
    /// the body is where a preview or a truncation would eventually be added —
    /// and a preview is the one thing a received message must never have.
    func testTheMessageSectionCopyNeverContainsAMessage() {
        let secret = "the door code is 4321"
        let one = message("task1", secret, at: 1_700_000_000)
        for language in AppLanguage.allCases {
            for text in [InboxMessagePresentation.heading(language: language),
                         InboxMessagePresentation.explanation(language: language),
                         InboxMessagePresentation.receivedAt(one, language: language),
                         InboxMessagePresentation.copyActionLabel(copied: false,
                                                                  language: language),
                         InboxMessagePresentation.copyActionLabel(copied: true,
                                                                  language: language)] {
                XCTAssertFalse(text.isEmpty, "empty message-section copy in \(language)")
                XCTAssertFalse(text.contains(secret),
                               "the message section's copy carries the message in \(language)")
                XCTAssertFalse(text.contains("task1"),
                               "the message section's copy carries a delivery id in \(language)")
            }
        }
    }

    /// The section shows the newest messages and COUNTS the rest.
    ///
    /// Nothing here deletes a message, so silence at the display bound is the
    /// one thing that could make one look deleted. Under the bound there is
    /// nothing to say and the count is absent entirely.
    func testTheDisplayBoundCountsWhatItDoesNotDrawAndIsSilentUnderIt() {
        let limit = InboxMessagePresentation.displayLimit
        let few = (0..<limit).map { message("task\($0)", "m\($0)", at: 1_700_000_000) }
        XCTAssertEqual(InboxMessagePresentation.shown(few).count, limit)
        XCTAssertNil(InboxMessagePresentation.more(few),
                     "a full-but-not-over section claims there is more")

        let many = (0..<(limit + 7)).map { message("task\($0)", "m\($0)", at: 1_700_000_000) }
        XCTAssertEqual(InboxMessagePresentation.shown(many).count, limit,
                       "the section draws more rows than its bound")
        XCTAssertEqual(InboxMessagePresentation.more(many, language: .en), "+7 more")
        // The order the store handed over is preserved exactly: `shown` takes a
        // prefix and never re-sorts, so newest-first stays newest-first.
        XCTAssertEqual(InboxMessagePresentation.shown(many).map(\.id),
                       many.prefix(limit).map(\.id))
    }

    /// Copy and Copied are different sentences, and neither is bare "Copy".
    ///
    /// This pane renders a COLUMN of these controls, one per message. Visible,
    /// the compact label is right; spoken, "Copy" twenty times names nothing, so
    /// the accessible name says which kind of thing is being copied.
    func testTheCopyActionIsNamedForAColumnOfIdenticalButtons() {
        for language in AppLanguage.allCases {
            let idle = InboxMessagePresentation.copyActionLabel(copied: false,
                                                               language: language)
            let done = InboxMessagePresentation.copyActionLabel(copied: true, language: language)
            XCTAssertNotEqual(idle, done,
                              "Copy and Copied read identically in \(language)")
            XCTAssertNotEqual(idle, L10n.t(.commonCopy, language: language),
                              "the accessible name is the bare visible label in \(language)")
        }
    }
}
