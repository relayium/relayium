import Foundation
import RelayiumAppKit
import RelayiumKit

/// Whether this process was launched by the UI test suite.
///
/// **It does not exist in a Release build.** The whole type is inside
/// `#if DEBUG`, so the shipped binary contains neither the flag nor the check —
/// this is not a runtime switch a user, a deep link or a relay could reach, it
/// is a compile-time absence. That is deliberate: the one thing it turns off is
/// residency, and an app that silently stops being reachable is the worst bug
/// this product can have.
///
/// **Why UI tests need it at all**, rather than simply running the app as
/// shipped: launching Relayium opens a persistent room socket, and every device
/// reaching the internet from the same public address sees the others on its
/// nearby list. CI runners share public addresses. A UI test with residency on
/// would put a GitHub runner into strangers' device lists for the length of the
/// run — a privacy consequence, not a tidiness one, and not something a
/// `--dry-run` flag on the test would fix.
///
/// Nothing else is faked. The five destinations, the settings scene, every
/// account-gated surface and all nine languages render exactly as they do
/// normally; the tests assert the real UI. Only the socket and the notification
/// registration are skipped, because those are what reach outward.
enum UITestMode {
    #if DEBUG
    /// The argument the UI test target passes. Read once: `ProcessInfo`'s
    /// arguments cannot change after launch, and a stored answer keeps every
    /// call site cheap and identical.
    // nonlocalized: a launch argument, never displayed
    static let argument = "--relayium-ui-testing"
    static let isActive = ProcessInfo.processInfo.arguments.contains(argument)
    #else
    /// In Release the answer is a constant the optimiser folds away, so the
    /// guarded work is unconditional and the argument means nothing.
    static let isActive = false
    #endif

    #if DEBUG
    /// A deterministic code-creation path for UI tests. It changes no Release
    /// behavior and never opens a network connection: mint succeeds locally,
    /// then ICE lookup waits until the test process ends so the screen remains
    /// on the handoff state a person needs time to read and share.
    @MainActor
    static func makeRealtimeTextModel(verification: VerificationPreference) -> RealtimeTextSessionModel {
        RealtimeTextSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestWaitingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }
    #endif
}

#if DEBUG
private struct UITestPairClient: PairCodeClient {
    func mint(token: String) async throws -> MintedCode {
        MintedCode(code: "483920", expiresAt: 4_102_444_800)
    }
}

private struct UITestWaitingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig {
        try await Task.sleep(nanoseconds: 300_000_000_000)
        throw AccountError.network
    }
}
#endif
