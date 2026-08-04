import XCTest
@testable import RelayiumAppKit

/// Files or text is ONE choice, and it stops being the user's the moment a
/// session exists.
///
/// The iOS Direct tab renders both modes over the same two models, exactly as
/// the macOS pairing-code destination does. macOS keeps the answer in
/// `TransferPresence`, which also arbitrates between two destinations; iOS has
/// one Direct surface and no roster, so what is left is the narrower question —
/// which mode is showing, and when may it change.
///
/// The lock is derived from the two model states on every read rather than
/// cached. A cached flag is a second answer to a question the models already
/// answer exactly, and the drift shows up as a segmented control that lets the
/// user switch away from a running transfer — which does not stop it, does not
/// show it, and leaves a Cancel button on a screen nobody is looking at.
@MainActor
final class DirectModeSelectionTests: XCTestCase {

    func testFilesIsTheDefaultMode() {
        XCTAssertEqual(DirectModeSelection().mode, .files)
    }

    /// Nothing anywhere: the picker is live.
    func testBothModelsIdleLeavesTheChoiceOpen() {
        XCTAssertFalse(DirectModeSelection.isLocked(file: .idle, text: .idle))
    }

    /// Every non-idle file state locks it, including the two TERMINAL ones.
    ///
    /// `.completed` and `.failed` are not "over" from this surface's point of
    /// view: a completed receive still owns its result and its share affordance,
    /// and a failure still owns the sentence explaining it. Switching mode would
    /// take both off screen with no way back to them.
    func testEveryLiveOrRetainedFileStateLocksTheChoice() {
        let states: [RealtimeState] = [
            .minting,
            .showingCode("483920", expiresAt: 1800000000),
            .joining("483920"),
            .connecting,
            .verifying(sas: "x"),
            .transferring(done: 0, total: 10),
            .completed([URL(fileURLWithPath: "/tmp/a.txt")]),
            .failed("nope"),
        ]
        for state in states {
            XCTAssertTrue(DirectModeSelection.isLocked(file: state, text: .idle),
                          "file state \(state) left the mode picker live")
        }
    }

    /// The same for text, whose terminal set is larger — and whose `.ended`
    /// arm is precisely the one that retains the local transcript.
    func testEveryLiveOrRetainedTextStateLocksTheChoice() {
        let states: [RealtimeTextState] = [
            .minting,
            .showingCode("483920", expiresAt: 1800000000),
            .joining("483920"),
            .connecting,
            .verifying(sas: "x"),
            .waitingAccept(sas: "x"),
            .incomingRequest(sas: "x"),
            .open(sas: "x"),
            .ended,
            .refused,
            .unsupported,
            .failed("nope"),
        ]
        for state in states {
            XCTAssertTrue(DirectModeSelection.isLocked(file: .idle, text: state),
                          "text state \(state) left the mode picker live")
        }
    }

    /// The refusal lives in the type, not in a `.disabled` modifier.
    ///
    /// A disabled control is a courtesy: SwiftUI still owns the binding, a
    /// rebuild can restore an older value, and a deep link or a restored scene
    /// can write one. So `select` is the only way in and it re-reads the two
    /// states every time rather than trusting a flag somebody set earlier.
    func testSelectRefusesWhileEitherModelOwnsASession() {
        let modes = DirectModeSelection()
        modes.select(.text, file: .idle, text: .idle)
        XCTAssertEqual(modes.mode, .text)

        modes.select(.files, file: .transferring(done: 1, total: 2), text: .idle)
        XCTAssertEqual(modes.mode, .text, "the mode moved out from under a running transfer")

        modes.select(.files, file: .idle, text: .open(sas: "x"))
        XCTAssertEqual(modes.mode, .text, "the mode moved out from under a live text session")

        modes.select(.files, file: .completed([]), text: .idle)
        XCTAssertEqual(modes.mode, .text, "the mode moved off a retained result")

        modes.select(.files, file: .idle, text: .idle)
        XCTAssertEqual(modes.mode, .files, "the choice never came back")
    }
}
