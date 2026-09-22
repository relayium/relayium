import XCTest
@testable import RelayiumKit

/// The discriminator that tells a relayium CLI peer apart from an app peer in a
/// pairing room. Its safety argument is that no app or web peer emits a
/// top-level `kind`, so every shape one of them DOES emit is pinned here: a
/// future signal that adds `kind` fails this test rather than silently refusing
/// real pairings in production.
final class CliPeerSignalTests: XCTestCase {
    /// Verbatim from `hsMsg` in `server/internal/rzvous/handshake.go`.
    /// `mode` is omitted for the file mode, which a plain `relayium send` emits.
    private let cliCommit = JSONValue.object([
        "kind": .string("commit"), "commit": .string("Y29tbWl0"), "mode": .string("text"),
    ])
    private let cliCommitFile = JSONValue.object([
        "kind": .string("commit"), "commit": .string("Y29tbWl0"),
    ])
    private let cliReveal = JSONValue.object([
        "kind": .string("reveal"),
        "fp": .string(String(repeating: "ab", count: 32)),
        "nonce": .string("bm9uY2U="),
        "candidates": .array([.string("192.0.2.1:5000")]),
    ])

    func testRecognisesTheCliHandshakeFrames() {
        XCTAssertTrue(CliPeerSignal.isHandshake(cliCommit))
        XCTAssertTrue(CliPeerSignal.isHandshake(cliCommitFile))
        XCTAssertTrue(CliPeerSignal.isHandshake(cliReveal))
    }

    func testDoesNotRecogniseAnyShapeAnAppPeerSends() {
        let appSignals: [(String, JSONValue)] = [
            ("capability hello", .object(["caps": .array([.string("link/1"), .string("preupload/1")])])),
            ("relay-RTT map", .object(["relayRtt": .object(["r1": .number(42)])])),
            ("rename", .object(["rename": .string("Lily's Mac")])),
            ("link request", .object(["linkRequest": .bool(true), "link": .bool(true)])),
            ("busy", .object(["busy": .bool(true), "link": .bool(true)])),
            ("link leave", .object(["link": .bool(true), "leave": .bool(true), "auth": .string("c2ln")])),
            ("renew", .object(["link": .bool(true), "renew": .object(["round": .number(1)]), "auth": .string("c2ln")])),
            ("reveal (app)", .object(["link": .bool(true), "reveal": .object(["key": .string("a2V5")])])),
            ("offer", .object([
                "sdp": .object(["type": .string("offer"), "sdp": .string("v=0…")]),
                "commit": .string("Y29tbWl0"),
                "caps": .array([.string("link/1")]),
            ])),
            ("answer", .object(["sdp": .object(["type": .string("answer"), "sdp": .string("v=0…")])])),
            ("ice", .object(["ice": .object(["candidate": .string("candidate:1 1 udp …")])])),
        ]
        for (name, signal) in appSignals {
            XCTAssertFalse(CliPeerSignal.isHandshake(signal), "\(name) must not read as a CLI peer")
        }
    }

    /// `commit` is a legitimate field on an app's offer/answer, which is how a
    /// shape-permissive decode came to accept a CLI frame as an app commit.
    func testDoesNotKeyOnCommit() {
        XCTAssertFalse(CliPeerSignal.isHandshake(.object(["commit": .string("Y29tbWl0")])))
    }

    func testRejectsNonObjectsAndANonStringKind() {
        let bad: [JSONValue] = [
            .null, .string("kind"), .number(7), .bool(true),
            .array([.object(["kind": .string("commit")])]),
            .object(["kind": .number(1)]),
            .object(["kind": .null]),
            .object([:]),
        ]
        for value in bad {
            XCTAssertFalse(CliPeerSignal.isHandshake(value), "\(value) must not read as a CLI peer")
        }
    }
}
