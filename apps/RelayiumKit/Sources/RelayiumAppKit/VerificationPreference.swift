import Foundation

/// "Advanced verification" — whether this Mac blocks on the SAS comparison.
///
/// **Default OFF, and opt-in**, matching the web client. The reasoning is the
/// same and is worth restating here because this file is what a reviewer will
/// read when they ask whether the app got less safe:
///
///   - The SAS detects substitution of the SIGNALLING endpoints, and only if a
///     human really compares the two codes out of band. A blocking gate that
///     every user clicks through provides no protection and teaches them that
///     security prompts are noise.
///   - Nothing the SAS is not is affected. The commit-then-reveal handshake
///     still runs on every connection and still fails it on a mismatched
///     reveal; AEAD still authenticates every frame; the derived SAS is still
///     computed and kept, so turning the preference on mid-life needs no
///     renegotiation. Those are in `RealtimeConnection` and are not reachable
///     from this flag.
///   - What IS lost with the preference off is the only check on peer identity.
///     Commit-reveal proves the peer revealed the key it committed to; it does
///     not prove the peer is the person the sender meant. With no SAS
///     comparison, a connection reached with a guessed pairing code is treated
///     like any other, and incoming files are written to `saveDirectory` as
///     soon as the link is ready — this app has no per-batch Accept gesture for
///     files (the browser does, and that one stops an unsolicited write, not
///     disclosure to someone who chooses to accept). Where the files go is
///     bounded — `saveDirectory` is the configured destination, Downloads
///     unless the pane points it elsewhere — but WHO may send them, or receive
///     what this side sends, is not.
///
/// Backed by UserDefaults so it survives a relaunch, and injectable so the
/// model tests can drive both paths without touching the real domain.
@MainActor
public final class VerificationPreference: ObservableObject {
    /// Absent until the user turns it ON, so the default is what an untouched
    /// install does — and an unreadable/reset domain means the same thing.
    public static let defaultsKey = "com.relayium.verifyPeers"

    private let defaults: UserDefaults

    @Published public var requiresSASConfirmation: Bool {
        didSet {
            guard requiresSASConfirmation != oldValue else { return }
            if requiresSASConfirmation { defaults.set(true, forKey: Self.defaultsKey) }
            else { defaults.removeObject(forKey: Self.defaultsKey) }
        }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `bool(forKey:)` is false for a missing key, which is exactly the
        // default — no separate "has the user decided yet" state is needed.
        self.requiresSASConfirmation = defaults.bool(forKey: Self.defaultsKey)
    }
}
