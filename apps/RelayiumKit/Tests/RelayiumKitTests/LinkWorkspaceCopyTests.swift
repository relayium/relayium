import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **The words a link's terminal reason and a batch's state turn into.**
///
/// `LinkEndingCopy` and `LinkBatchCopy` are the one thing this batch shares
/// between the two workspaces, and they are pure functions of two exhaustive
/// enums — so they are the one thing `swift test` can drive completely, without
/// a window on either platform.
///
/// The switches themselves cannot silently lose a case: Swift refuses an
/// incomplete `switch` and neither function has a `default`. What a compiler
/// cannot catch is the failure these tests own — two cases answering the SAME
/// sentence, so a user reading "the connection ended" cannot tell which of two
/// different things happened, and a platform split that exists in the key list
/// but resolves to identical text, which is a split that is not really there.
final class LinkWorkspaceCopyTests: XCTestCase {

    /// Every ending, listed rather than derived: `LinkWorkspaceEnding` is not
    /// `CaseIterable`, and the count assertion below is what makes a tenth case
    /// arrive here instead of being quietly untested.
    private let endings: [LinkWorkspaceEnding] = [
        .refused, .timedOut, .unavailable, .failed, .closed,
        .verificationRejected, .roomLost, .relayExpired, .roomUnavailable,
    ]

    /// `received` carries the committed manifest, so it is constructed rather
    /// than named — with a real path, because the word must not depend on one.
    private let states: [LinkFileBatchState] = [
        .offered, .queued, .transferring, .finished,
        .received(files: [URL(fileURLWithPath: "/tmp/a.bin")], container: nil),
        .failed,
    ]

    func testEveryEndingHasItsOwnSentence() {
        XCTAssertEqual(endings.count, 9, "an ending was added without a test for its words")
        var seen: [String: LinkWorkspaceEnding] = [:]
        for ending in endings {
            let text = LinkEndingCopy.text(for: ending)
            XCTAssertFalse(text.isEmpty, "\(ending) has no sentence")
            XCTAssertFalse(text.contains("link.ended"),
                           "\(ending) rendered its key instead of its sentence")
            if let clash = seen[text] {
                XCTFail("\(ending) and \(clash) say the same thing: \(text)")
            }
            seen[text] = ending
        }
    }

    /// `closed` is the only ending the user chose or the peer chose. Everything
    /// else is something that went wrong, including `verificationRejected` —
    /// which the user DID choose, and which exists to say something may be wrong.
    func testOnlyAClosedLinkIsNotAFailure() {
        for ending in endings {
            XCTAssertEqual(LinkEndingCopy.isFailure(ending), ending != .closed,
                           "\(ending) is on the wrong side of the failure boundary")
        }
    }

    /// **The two per-platform sentences are genuinely two.**
    ///
    /// `unavailable` and the room-loss note both name the device they are about,
    /// so they split. A split whose branches resolved to the same string would
    /// be a key nobody needs and a rule the next reader would delete; a branch
    /// that named the wrong machine is the defect the split exists to prevent.
    func testTheDeviceNamingSentencesAreThisPlatformsOwn() {
        #if os(macOS)
        XCTAssertEqual(LinkEndingCopy.text(for: .unavailable), L10n.t(.linkEndedUnavailable))
        XCTAssertEqual(LinkEndingCopy.signalingLost, L10n.t(.linkSignalingLost))
        #else
        XCTAssertEqual(LinkEndingCopy.text(for: .unavailable), L10n.t(.linkEndedUnavailableIOS))
        XCTAssertEqual(LinkEndingCopy.signalingLost, L10n.t(.linkSignalingLostIOS))
        #endif
        XCTAssertNotEqual(L10n.t(.linkEndedUnavailable), L10n.t(.linkEndedUnavailableIOS),
                          "the platform split resolves to one sentence, so it is not a split")
        XCTAssertNotEqual(L10n.t(.linkSignalingLost), L10n.t(.linkSignalingLostIOS),
                          "the platform split resolves to one sentence, so it is not a split")
    }

    func testEveryBatchStateHasItsOwnWord() {
        XCTAssertEqual(states.count, 6, "a batch state was added without a test for its word")
        var seen: [String: LinkFileBatchState] = [:]
        for state in states {
            let text = LinkBatchCopy.text(for: state)
            XCTAssertFalse(text.isEmpty, "\(state) has no word")
            XCTAssertFalse(text.contains("link.batch"),
                           "\(state) rendered its key instead of its word")
            if let clash = seen[text] {
                XCTFail("\(state) and \(clash) say the same thing: \(text)")
            }
            seen[text] = state
        }
    }

    /// A manifest is DESCRIBED, and the size is omitted rather than shown as
    /// zero: a batch whose total is unknown must not claim to be empty.
    func testASummaryNamesTheCountAndAddsTheSizeOnlyWhenThereIsOne() {
        XCTAssertEqual(LinkBatchCopy.summary(files: 3, totalBytes: 0),
                       L10n.plural(.selectionFiles, 3))
        XCTAssertEqual(LinkBatchCopy.summary(files: 1, totalBytes: 2048),
                       L10n.detail([L10n.plural(.selectionFiles, 1), L10n.bytes(2048)]))
        XCTAssertTrue(LinkBatchCopy.summary(files: 2, totalBytes: 1024)
            .contains(L10n.bytes(1024)),
                      "the size a user is about to receive is not on the row")
    }
}
