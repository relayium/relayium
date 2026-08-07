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
/// The five destinations, the settings scene and all nine languages are the real
/// UI. Residency and notification registration are skipped because they reach
/// outward; the generated-text-code test additionally injects the deterministic
/// model below so it can hold a handoff screen without contacting production.
enum UITestMode {
    #if DEBUG
    /// The argument the UI test target passes. Read once: `ProcessInfo`'s
    /// arguments cannot change after launch, and a stored answer keeps every
    /// call site cheap and identical.
    // nonlocalized: a launch argument, never displayed
    static let argument = "--relayium-ui-testing"
    static let isActive = ProcessInfo.processInfo.arguments.contains(argument)
    /// Holds the text pairing model on a deterministic terminal failure so the
    /// UI suite can verify that cleanup, not a second start path, owns the page.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalTextArgument = "--relayium-ui-testing-terminal-text"
    static let showsTerminalText = ProcessInfo.processInfo.arguments.contains(terminalTextArgument)
    /// Builds a deterministic failed Nearby file task so the UI suite can prove
    /// its retained terminal surface still exposes the route back to the roster.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalNearbyArgument = "--relayium-ui-testing-terminal-nearby"
    static let showsTerminalNearby = ProcessInfo.processInfo.arguments.contains(terminalNearbyArgument)
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

    @MainActor
    static func makeTerminalNearbyFileModel(verification: VerificationPreference) -> RealtimeSessionModel {
        RealtimeSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestFailingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }
    #endif
}

#if DEBUG
private struct UITestPairClient: PairCodeClient {
    func mint(token: String) async throws -> MintedCode {
        if UITestMode.showsTerminalText { throw AccountError.network }
        return MintedCode(code: "483920", expiresAt: 4_102_444_800)
    }
}

private struct UITestWaitingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig {
        try await Task.sleep(nanoseconds: 300_000_000_000)
        throw AccountError.network
    }
}

private struct UITestFailingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig { throw AccountError.network }
}
#endif
