import XCTest
@testable import RelayiumAppKit

@MainActor
final class AppDeepLinkTests: XCTestCase {
    func testParsesAValidatedDownloadLink() {
        let url = URL(string: "https://relayium.com/d/abc123#k=KEYPART")!
        XCTAssertEqual(parseAppDeepLink(url), .download(url))
    }

    func testParsesRealtimeWithOrWithoutACode() {
        XCTAssertEqual(
            parseAppDeepLink(URL(string: "https://relayium.com/cross-network#c=483920")!),
            .realtime(code: "483920")
        )
        XCTAssertEqual(
            parseAppDeepLink(URL(string: "https://relayium.com/cross-network")!),
            .realtime(code: nil)
        )
    }

    func testNormalizesPairingInputToDigitsOnly() {
        XCTAssertEqual(normalizedPairingCode("48 39-20"), "483920")
        // Letters are discarded, never mapped: someone who mistyped O meant
        // some digit other than 0, and a silent substitution hands them a code
        // that is wrong rather than obviously incomplete.
        XCTAssertEqual(normalizedPairingCode("4O8I3B9"), "4839")
        // Old-alphabet codes normalize to whatever digits they contained, which
        // is short — so they cannot be mistaken for a joinable code.
        XCTAssertEqual(normalizedPairingCode("ACDEFH"), "")
        // Leading zeros are ordinary. A code is a string, not an integer.
        XCTAssertEqual(normalizedPairingCode("004291"), "004291")
        XCTAssertEqual(normalizedPairingCode("000000"), "000000")
        // Truncated at the code length, so a paste of extra digits does not
        // push the real ones out.
        XCTAssertEqual(normalizedPairingCode("483920999"), "483920")

        XCTAssertTrue(isCompletePairingCode("483920"))
        XCTAssertTrue(isCompletePairingCode("000000"))
        XCTAssertTrue(isCompletePairingCode("012345"))
        XCTAssertFalse(isCompletePairingCode("K7M3X9"))
        XCTAssertFalse(isCompletePairingCode("48392"))
        XCTAssertFalse(isCompletePairingCode("4839201"))
        XCTAssertFalse(isCompletePairingCode("48392a"))
    }

    func testRejectsUntrustedOrMalformedHandoffs() {
        let rejected = [
            "http://relayium.com/d/a#k=K",
            "https://evil.example/d/a#k=K",
            "https://relayium.com@evil.example/d/a#k=K",
            "https://relayium.com:8443/d/a#k=K",
            "https://relayium.com/d/a",
            "https://relayium.com/cross-network#c=48392a",
            "https://relayium.com/cross-network#c=K7M3X9",
            "https://relayium.com/cross-network#c=483920&next=evil",
            "https://relayium.com/not-a-route",
        ]
        for value in rejected {
            XCTAssertNil(parseAppDeepLink(URL(string: value)!), value)
        }
    }

    func testRouterKeepsValidLinksUntilTheUIConsumesThem() {
        let router = AppDeepLinkRouter()
        let url = URL(string: "https://relayium.com/cross-network#c=483920")!
        XCTAssertTrue(router.open(url))
        XCTAssertEqual(router.pending, .realtime(code: "483920"))
        router.consume()
        XCTAssertNil(router.pending)
    }

    /// Why the shell defers its `consume()` by one turn instead of calling it
    /// inline, which is the obvious shape and the wrong one.
    ///
    /// `@Published` emits in `willSet`: a subscriber runs BEFORE the new value
    /// is stored, so a `consume()` made from inside the subscriber is
    /// immediately overwritten by the assignment that delivered the link. The
    /// router is then left holding a link the UI has already acted on — and
    /// `Published` replays its current value to every new subscriber, so the
    /// next time the unique window is closed and reopened the link is applied a
    /// second time: a stored download that was already saved would re-resolve,
    /// discarding the result on screen.
    ///
    /// This is a property of the mechanism, not of `AppDeepLinkRouter`, which is
    /// exactly why it is worth pinning: if `pending` ever stops being
    /// `@Published`, this fails and the deferral in `AppShellView` can go.
    @MainActor
    func testConsumingFromInsideTheSubscriberDoesNotClearPending() {
        let router = AppDeepLinkRouter()
        var seen: [AppDeepLink] = []
        let subscription = router.$pending.compactMap { $0 }.sink { link in
            seen.append(link)
            router.consume()          // inline — the shape this warns against
        }
        defer { subscription.cancel() }

        XCTAssertTrue(router.open(URL(string: "https://relayium.com/cross-network#c=483920")!))
        XCTAssertEqual(seen, [.realtime(code: "483920")], "the UI still saw it exactly once")
        XCTAssertEqual(router.pending, .realtime(code: "483920"),
                       "an inline consume is overwritten by the assignment that delivered the link")

        // A late subscriber — the window reopening — is handed it again.
        var replayed: [AppDeepLink] = []
        let second = router.$pending.compactMap { $0 }.sink { replayed.append($0) }
        defer { second.cancel() }
        XCTAssertEqual(replayed, [.realtime(code: "483920")],
                       "Published replays its current value, so an unconsumed link fires again")

        // Deferred out of the emission, it clears — what the shell does.
        router.consume()
        XCTAssertNil(router.pending)
    }

    func testRouterDoesNotReplacePendingWorkWithAnInvalidURL() {
        let router = AppDeepLinkRouter()
        XCTAssertTrue(router.open(URL(string: "https://relayium.com/cross-network")!))
        XCTAssertFalse(router.open(URL(string: "https://example.com/cross-network")!))
        XCTAssertEqual(router.pending, .realtime(code: nil))
    }
}
