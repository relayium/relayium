import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **Six digits, and nothing else.**
///
/// The point of this object is what it does NOT do, so most of what is worth
/// asserting is a boundary rather than a behaviour: it holds no socket, decides
/// no lane, and its whole lifecycle is independent of any connection's. What is
/// left to test is the part that has actually gone wrong before — a slow mint
/// writing into a surface the user has moved on from, and the state a pairing
/// surface must not be allowed to fall out of while somebody is reading a code
/// out loud.
@MainActor
final class PairingCodeModelTests: XCTestCase {

    /// A mint the test drives: it answers when told to, so the window between
    /// "the user pressed Create" and "the server replied" is a real, inspectable
    /// state rather than something to sleep through.
    private final class ScriptedPairClient: PairCodeClient, @unchecked Sendable {
        /// Answers handed out in order. `nil` throws instead.
        var answers: [MintedCode?] = []
        var error: Error = AccountError.network
        private(set) var tokens: [String] = []
        /// Held open until `release()`, for the generation tests.
        var gate: CheckedContinuation<Void, Never>?
        var waitsForGate = false

        func mint(token: String) async throws -> MintedCode {
            tokens.append(token)
            if waitsForGate {
                await withCheckedContinuation { self.gate = $0 }
            }
            guard !answers.isEmpty else { throw error }
            guard let answer = answers.removeFirst() else { throw error }
            return answer
        }

        func release() {
            let waiting = gate
            gate = nil
            waiting?.resume()
        }
    }

    private func model(_ client: ScriptedPairClient) -> PairingCodeModel {
        PairingCodeModel(client: client)
    }

    // MARK: - minting

    func testAFreshModelHoldsNothing() {
        let m = model(ScriptedPairClient())
        XCTAssertEqual(m.state, .idle)
        XCTAssertNil(m.state.code)
        XCTAssertFalse(m.state.isActive, "an idle code must not hold a surface")
    }

    func testMintingPublishesTheCodeAndItsDeadline() async {
        let client = ScriptedPairClient()
        client.answers = [MintedCode(code: "481203", expiresAt: 1_700_000_000)]
        let m = model(client)

        await m.mint(token: "bearer")

        XCTAssertEqual(m.state, .showing("481203", expiresAt: 1_700_000_000))
        XCTAssertEqual(m.state.code, "481203")
        XCTAssertEqual(client.tokens, ["bearer"], "the bearer is spent exactly once")
    }

    func testAFailedMintKeepsTheSurfaceRatherThanSilentlyIdling() async {
        let client = ScriptedPairClient()
        client.error = AccountError.notSignedIn
        let m = model(client)

        await m.mint(token: "")

        guard case let .failed(message) = m.state else {
            return XCTFail("a failed mint must say so, not disappear: \(m.state)")
        }
        XCTAssertFalse(message.isEmpty)
        // The load-bearing half: `TransferModule.retainsWork` reads this, and a
        // failure that reported idle would take its own message off screen
        // before the user could read it.
        XCTAssertTrue(m.state.isActive)
    }

    /// **A mint that never passes through `.idle`.**
    ///
    /// The expired-code path mints a replacement while a code is still on
    /// screen. If that transition dipped through `.idle`, the app-scoped
    /// liveness observer would release the surface mid-action and drop the user
    /// back to the connect screen.
    func testMintingOverAShownCodeNeverReportsIdle() async {
        let client = ScriptedPairClient()
        client.answers = [MintedCode(code: "481203", expiresAt: 10),
                          MintedCode(code: "557914", expiresAt: 20)]
        let m = model(client)
        await m.mint(token: "t")
        XCTAssertEqual(m.state.code, "481203")

        var sawIdle = false
        let watch = m.$state.sink { if $0 == .idle { sawIdle = true } }
        defer { watch.cancel() }

        await m.mint(token: "t")

        XCTAssertEqual(m.state, .showing("557914", expiresAt: 20))
        XCTAssertFalse(sawIdle, "a replacement mint released the surface on its way")
    }

    // MARK: - the generation guard

    /// A slow mint whose answer arrives after the user cancelled must not write
    /// a code onto a surface they have already left.
    func testACancelledMintsAnswerIsDiscarded() async {
        let client = ScriptedPairClient()
        client.waitsForGate = true
        client.answers = [MintedCode(code: "481203", expiresAt: 10)]
        let m = model(client)

        let minting = Task { await m.mint(token: "t") }
        // Let the mint reach the gate before cancelling.
        while client.gate == nil { await Task.yield() }
        XCTAssertEqual(m.state, .minting)

        m.cancel()
        XCTAssertEqual(m.state, .idle)

        client.release()
        await minting.value

        XCTAssertEqual(m.state, .idle,
                       "a cancelled mint's answer was written onto an idle surface")
    }

    /// The same guard for a FAILURE arriving late: an error from a mint nobody
    /// is waiting on is not a message this surface owes anyone.
    func testACancelledMintsFailureIsAlsoDiscarded() async {
        let client = ScriptedPairClient()
        client.waitsForGate = true
        client.answers = []
        let m = model(client)

        let minting = Task { await m.mint(token: "t") }
        while client.gate == nil { await Task.yield() }
        m.cancel()
        client.release()
        await minting.value

        XCTAssertEqual(m.state, .idle)
    }

    /// Two mints in flight: the SECOND owns the surface, and the first's answer
    /// — arriving later — must not replace it. A user who pressed Create twice
    /// must not end up showing the code the server issued first while the peer
    /// is being told about the second.
    func testASupersededMintCannotOverwriteTheCodeOnScreen() async {
        let client = ScriptedPairClient()
        client.waitsForGate = true
        client.answers = [MintedCode(code: "111111", expiresAt: 10)]
        let m = model(client)

        let first = Task { await m.mint(token: "t") }
        while client.gate == nil { await Task.yield() }

        // The second mint bumps the generation, then answers immediately.
        client.waitsForGate = false
        client.answers = [MintedCode(code: "222222", expiresAt: 20)]
        await m.mint(token: "t")
        XCTAssertEqual(m.state.code, "222222")

        client.release()
        await first.value

        XCTAssertEqual(m.state.code, "222222",
                       "the superseded mint wrote its code over the live one")
    }

    // MARK: - a joined code

    /// A code somebody typed is shown with no deadline, and `PairingCodeExpiry`
    /// already defines that input as usable-and-uncounted. The joiner was never
    /// told when the code dies; inventing a deadline would refuse a working
    /// code, and treating the missing field as expiry would refuse it instantly.
    func testAJoinedCodeIsShownAndIsNotTreatedAsExpired() {
        let m = model(ScriptedPairClient())
        m.adopt(joined: "481203")

        XCTAssertEqual(m.state, .showing("481203", expiresAt: 0))
        XCTAssertTrue(m.state.isActive)

        let deadline = PairingCodeExpiry.presentation(expiresAt: 0, now: Date())
        XCTAssertTrue(deadline.isUsable, "a joined code must not read as expired")
        XCTAssertNil(deadline.countdown, "and must not invent a countdown")
    }

    /// Adopting also bumps the generation, so a mint that was in flight when the
    /// user gave up and typed somebody else's code cannot replace it.
    func testAdoptingAJoinedCodeSupersedesAnInFlightMint() async {
        let client = ScriptedPairClient()
        client.waitsForGate = true
        client.answers = [MintedCode(code: "333333", expiresAt: 10)]
        let m = model(client)

        let minting = Task { await m.mint(token: "t") }
        while client.gate == nil { await Task.yield() }
        m.adopt(joined: "444444")

        client.release()
        await minting.value

        XCTAssertEqual(m.state.code, "444444",
                       "a mint the user abandoned replaced the code they typed")
    }

    // MARK: - the typed field

    func testTheTypedCodeIsNormalizedInsideTheOneTransition() {
        let m = model(ScriptedPairClient())
        // Codes are digits: `normalizedPairingCode` keeps those and discards
        // everything else, so the separators a person types when reading six
        // numbers off a screen are dropped rather than refused.
        m.updateJoinCode(" 48-12 03 ")
        XCTAssertEqual(m.joinCode, "481203")
        XCTAssertTrue(m.canJoin)
    }

    func testAnIncompleteTypedCodeCannotJoin() {
        let m = model(ScriptedPairClient())
        m.updateJoinCode("481")
        XCTAssertFalse(m.canJoin)
    }

    // MARK: - what this object deliberately is not

    /// **The separation, asserted.** Nothing here touches a link, so a code's
    /// whole lifecycle can run with no connection in existence — which is the
    /// property that let the code stop being a `RealtimeSessionModel` state.
    func testTheCodesLifecycleIsIndependentOfAnyConnection() async {
        let client = ScriptedPairClient()
        client.answers = [MintedCode(code: "481203", expiresAt: 10)]
        let m = model(client)

        await m.mint(token: "t")
        XCTAssertTrue(TransferModule.retainsWork(code: m.state, link: .idle),
                      "a code with no link is still work the module holds")

        m.cancel()
        XCTAssertFalse(TransferModule.retainsWork(code: m.state, link: .idle))
        // …and a watched room is work even once the code is gone, which is the
        // other half of the same rule.
        XCTAssertTrue(TransferModule.retainsWork(code: m.state,
                                                 link: .watching(code: "481203")))
    }

    /// A mint in flight holds the surface too. The window between pressing
    /// Create and the server answering is the one a link-only liveness rule
    /// would have reported idle through.
    func testAMintInFlightAlreadyHoldsTheSurface() async {
        let client = ScriptedPairClient()
        client.waitsForGate = true
        client.answers = [MintedCode(code: "481203", expiresAt: 10)]
        let m = model(client)

        let minting = Task { await m.mint(token: "t") }
        while client.gate == nil { await Task.yield() }

        XCTAssertEqual(m.state, .minting)
        XCTAssertTrue(TransferModule.retainsWork(code: m.state, link: .idle),
                      "the surface would be released while the mint is in flight")

        client.release()
        await minting.value
    }
}
