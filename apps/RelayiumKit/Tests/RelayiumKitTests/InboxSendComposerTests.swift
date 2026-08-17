import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// The pure decisions macOS's per-device send screen rests on.
///
/// They are in the package rather than in the view for the reason every other
/// decision on that screen is: a rule inside a SwiftUI `switch` is a rule no
/// `swift test` can drive, and three of the rules here are the difference
/// between a message the user wrote arriving and a refusal after they wrote it.
///
/// `InboxSurfaceGuardTests` checks that the screen actually calls these rather
/// than re-deriving them; this file checks that the answers are right.
final class InboxSendComposerTests: XCTestCase {

    // MARK: - a message, measured the way the protocol measures it

    /// **Bytes, not characters**, which is the whole reason `InboxTextDraft`
    /// exists rather than a `count` at the call site.
    ///
    /// One emoji is four UTF-8 bytes and one Chinese character is three, so a
    /// composer bounded on `String.count` would report a quarter of the limit
    /// spent at the exact moment the seal refuses the message. The bound here is
    /// the same constant `InboxSendModel.sendText` applies and the same one the
    /// receiver re-measures.
    func testADraftIsMeasuredInUTF8BytesAndNotInCharacters() {
        XCTAssertEqual(InboxTextDraft("abc").byteCount, 3)
        // Four bytes, one Character.
        let emoji = "🙂"
        XCTAssertEqual(emoji.count, 1)
        XCTAssertEqual(InboxTextDraft(emoji).byteCount, 4)
        // Three bytes each.
        XCTAssertEqual(InboxTextDraft("你好").byteCount, 6)
    }

    /// The three verdicts, at the exact boundaries `sendText` uses.
    func testADraftIsSendableExactlyWithinTheProtocolsBounds() {
        let empty = InboxTextDraft("")
        XCTAssertTrue(empty.isEmpty)
        XCTAssertFalse(empty.isSendable, "an empty message is not a message")

        // One byte is a message. A receiver can present it.
        XCTAssertTrue(InboxTextDraft("x").isSendable)

        let atLimit = InboxTextDraft(String(repeating: "a", count: InboxManifest.maxTextBytes))
        XCTAssertEqual(atLimit.byteCount, InboxManifest.maxTextBytes)
        XCTAssertFalse(atLimit.isTooLong, "the limit itself is sendable")
        XCTAssertTrue(atLimit.isSendable)
        XCTAssertEqual(atLimit.overflowBytes, 0)

        let over = InboxTextDraft(String(repeating: "a", count: InboxManifest.maxTextBytes + 1))
        XCTAssertTrue(over.isTooLong)
        XCTAssertFalse(over.isSendable)
        XCTAssertEqual(over.overflowBytes, 1)
    }

    /// A draft the composer would enable Send for is a draft the model accepts,
    /// and one it would refuse is one the model refuses — asserted as the
    /// property rather than by reading both implementations.
    ///
    /// This is the assertion that matters: a button enabled on a condition the
    /// model then rejects is a control whose only outcome is an error message,
    /// and a button disabled on a condition the model would have accepted is a
    /// message the user cannot send for no reason they can see.
    func testTheComposersOwnVerdictAgreesWithTheModelsPrecondition() {
        let cases = ["", "x", String(repeating: "a", count: InboxManifest.maxTextBytes),
                     String(repeating: "a", count: InboxManifest.maxTextBytes + 1),
                     String(repeating: "🙂", count: InboxManifest.maxTextBytes / 4),
                     String(repeating: "🙂", count: InboxManifest.maxTextBytes / 4 + 1)]
        for text in cases {
            let bytes = Array(text.utf8).count
            let modelWouldAccept = bytes >= InboxManifest.minTextBytes
                && bytes <= InboxManifest.maxTextBytes
            XCTAssertEqual(InboxTextDraft(text).isSendable, modelWouldAccept,
                           "the composer and sendText disagree at \(bytes) bytes")
        }
    }

    // MARK: - how the screen is laid out

    /// **A dead end never leads, and neither kind is ever dropped.**
    ///
    /// A device that does not announce `inbox.text.v1` still shows its message
    /// group — removing it would teach the reader that this build cannot send
    /// messages at all — but below the files, so the first thing on the screen
    /// is the thing that works. A device that does leads with the message.
    func testBothKindsAreAlwaysOfferedAndTheWorkingOneLeads() {
        XCTAssertEqual(InboxSendComposer.order(canReceiveText: true), [.message, .files])
        XCTAssertEqual(InboxSendComposer.order(canReceiveText: false), [.files, .message])
        for canReceiveText in [true, false] {
            XCTAssertEqual(Set(InboxSendComposer.order(canReceiveText: canReceiveText)),
                           Set(InboxSendContentKind.allCases),
                           "a kind was dropped from the screen rather than ordered")
        }
        // And only the message kind is capability-gated: a receiver without the
        // token is a perfectly good file target — the CLI and the headless
        // receiver among them.
        XCTAssertEqual(InboxSendContentKind.allCases.filter(\.needsTextCapability), [.message])
    }

    // MARK: - stopping what is running

    /// The cancel a per-device screen makes prominent is the model's answer to
    /// which one applies, and the two are not interchangeable.
    ///
    /// `stopAttempt` ends work on THIS device and touches nothing durable;
    /// `cancelDelivery` asks central to drop a delivery that may be one moment
    /// from landing. A screen that offered the wrong one would either fail to
    /// stop an upload or ask the server to cancel something it never received.
    func testTheProminentCancelIsWhicheverOneIsActuallyOffered() {
        for activity in [InboxSendActivity.preparing, .uploading(sent: 1, total: 2), .creating] {
            XCTAssertEqual(InboxSendActions.cancel(for: item(activity)), .stopAttempt,
                           "a running attempt must offer the local stop")
        }
        for state in [InboxTaskState.queued, .notified, .attentionRequired, .failedRetryable] {
            XCTAssertEqual(InboxSendActions.cancel(for: item(.tracking(state))),
                           .cancelDelivery,
                           "a live delivery must offer the server-side cancel")
        }
        // Nothing to stop, so nothing is offered. A prominent Cancel over a
        // staged plan would be a control that either does nothing or discards
        // the user's only local copy under the wrong name.
        XCTAssertNil(InboxSendActions.cancel(for: item(.staged)))
        XCTAssertNil(InboxSendActions.cancel(for: item(.tracking(.saved))))
        XCTAssertNil(InboxSendActions.cancel(for: item(.tracking(.downloading))),
                     "central refuses a cancel while the target holds the claim")
        XCTAssertNil(InboxSendActions.cancel(for: item(.stopped(.uploadFailed))))
    }

    /// Whatever `cancel` returns is something `offered` actually offers, over
    /// every activity — so the screen can never draw a control the model would
    /// not have given it.
    func testEveryCancelOfferedIsOneTheActionListContains() {
        var activities: [InboxSendActivity] = [.staged, .preparing, .creating, .unknown,
                                               .uploading(sent: 0, total: 1),
                                               .stopped(.uploadFailed),
                                               .stopped(.contentKeyMissing)]
        activities.append(contentsOf: InboxTaskState.allCases.map { .tracking($0) })
        for activity in activities {
            for recoverable in [true, false] {
                let one = item(activity, isRecoverable: recoverable)
                guard let cancel = InboxSendActions.cancel(for: one) else { continue }
                XCTAssertTrue(InboxSendActions.offered(for: one).contains(cancel),
                              "cancel(\(activity)) is not in offered(\(activity))")
            }
        }
    }

    /// A per-device screen shows THIS device's send, newest first, and never
    /// another machine's — which would put a stranger's Discard button under a
    /// heading carrying this device's name.
    func testTheCurrentSendIsTheNewestOneAimedAtThatDeviceAndNoOther() {
        let mine = item(.creating, id: "job-new", device: "DEVICE-A")
        let older = item(.staged, id: "job-old", device: "DEVICE-A")
        let theirs = item(.creating, id: "job-other", device: "DEVICE-B")
        // Newest first, exactly as `InboxSendModel.publish()` orders them.
        let items = [mine, theirs, older]

        XCTAssertEqual(InboxSendActions.current(in: items, for: "DEVICE-A")?.id, "job-new")
        XCTAssertEqual(InboxSendActions.current(in: items, for: "DEVICE-B")?.id, "job-other")
        XCTAssertNil(InboxSendActions.current(in: items, for: "DEVICE-C"))
        XCTAssertNil(InboxSendActions.current(in: [], for: "DEVICE-A"))
    }

    // MARK: - what the screen says

    /// The counter names both numbers in both maintained languages, and the
    /// limit it names is the protocol's.
    func testTheSizeLineNamesTheDraftAndTheProtocolsLimit() {
        for language in [AppLanguage.en, .zh] {
            let limit = L10n.bytes(Int64(InboxManifest.maxTextBytes), language: language)
            let line = InboxSendPresentation.size(of: InboxTextDraft("hello"),
                                                 language: language)
            XCTAssertTrue(line.contains(limit),
                          "\(language.rawValue) size line omits the limit: \(line)")
            XCTAssertTrue(line.contains(L10n.bytes(5, language: language)),
                          "\(language.rawValue) size line omits the draft: \(line)")
            XCTAssertFalse(line.contains("%"), "\(language.rawValue) left a placeholder unfilled")
        }
    }

    /// A device that cannot present a message says so; one that can says
    /// nothing, because a warning over a working composer is noise.
    func testOnlyADeviceWithoutTheTextCapabilityCarriesARefusal() {
        for language in [AppLanguage.en, .zh] {
            XCTAssertNil(InboxSendPresentation.textRefusal(for: candidate(canReceiveText: true),
                                                           language: language))
            let refusal = InboxSendPresentation.textRefusal(for: candidate(canReceiveText: false),
                                                            language: language)
            // The SAME sentence the unsupported-capability block carries, so one
            // condition does not acquire two explanations depending on which
            // action discovered it.
            XCTAssertEqual(refusal, L10n.t(.sendBlockUnsupportedCapability, language: language))
            XCTAssertEqual(refusal, InboxSendPresentation.text(for: InboxSendRefusal
                .textUnsupported, language: language))
        }
    }

    /// Every content group is named in both maintained languages, and no two of
    /// them share a name — two groups reading the same word would be two groups
    /// nobody can tell apart.
    func testEveryContentKindIsNamedDistinctlyInBothMaintainedLanguages() {
        for language in [AppLanguage.en, .zh] {
            let labels = InboxSendContentKind.allCases.map {
                InboxSendPresentation.label(for: $0, language: language)
            }
            XCTAssertEqual(Set(labels).count, labels.count,
                           "\(language.rawValue) names two kinds the same: \(labels)")
            for label in labels {
                XCTAssertFalse(label.isEmpty)
                XCTAssertFalse(label.contains("send."), "\(language.rawValue) rendered a raw key")
            }
        }
    }

    /// The row's action names the DEVICE as well as the verb.
    ///
    /// A list of devices offers a column of identical *Send Content* buttons,
    /// and to a VoiceOver user the name is the only thing separating the Mac in
    /// the study from the one in the office.
    func testTheRowActionIsSpokenWithItsDevice() {
        let spoken = InboxSendPresentation.openLabel(for: candidate(name: "Studio"),
                                                     language: .en)
        XCTAssertTrue(spoken.contains("Studio"), spoken)
        XCTAssertTrue(spoken.contains(L10n.t(.sendContentAction, language: .en)), spoken)
        // An unnamed device falls back to the account tab's own stand-in rather
        // than to a blank row that sends somewhere the user cannot identify.
        let blank = InboxSendPresentation.openLabel(for: candidate(name: "   "), language: .en)
        XCTAssertTrue(blank.contains(L10n.t(.accountUnnamedDevice, language: .en)), blank)
    }

    // MARK: - fixtures

    private func item(_ activity: InboxSendActivity, id: String = "job",
                      device: String = "DEVICE-A",
                      isRecoverable: Bool = true) -> InboxSendItem {
        InboxSendItem(id: id, files: [], fileCount: 1, byteCount: 10,
                      targetDeviceID: device, targetName: "Studio", activity: activity,
                      taskID: nil, savedAt: 0, expiresAt: 0, isRecoverable: isRecoverable)
    }

    private func candidate(name: String = "Studio",
                           canReceiveText: Bool = true) -> InboxSendCandidate {
        InboxSendCandidate(id: "DEVICE-A", name: name, kind: "mac",
                           availability: InboxTargetAvailability(
                               sendable: true, block: nil, caveats: [], online: true,
                               policy: .auto, isCurrentDevice: false),
                           canReceiveText: canReceiveText)
    }
}
