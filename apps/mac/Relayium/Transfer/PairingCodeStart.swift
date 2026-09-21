import Foundation
import RelayiumAppKit
import RelayiumKit

/// **Starting a pairing code, in one place, for the two actions that start
/// one.**
///
/// `CrossNetworkConnectPane` mints the first code of a session and joins
/// somebody else's; the same pane mints a REPLACEMENT when the one on screen has
/// expired. Those are the same two steps — mint the digits, watch the room they
/// name — and before this type existed only the connect path knew them. The
/// alternative to sharing them was a second copy in the expired-code branch,
/// which is how the two would come to disagree about whether the room is watched
/// at all.
///
/// It owns no state and holds nothing beyond the module. Ownership of the
/// surface, the account gate and the error the user sees all stay with the
/// caller, because those differ between the two: a first code CLAIMS the surface,
/// and a replacement loses it for an instant — retiring the dead room passes the
/// module through idle — and takes it back before it mints (see `regenerate`).
///
/// ## What it no longer does
///
/// **There is no legacy start behind it.** `watch` used to fall back to a legacy
/// file or text join when `LinkWorkspaceModel` refused the room, which kept
/// "pairing code works" true on a build whose link could not open one. This
/// build's link always can, and a room the model refuses is a room already held
/// — a second code minted over a live one — which a fallback would have turned
/// into two rendezvous at once rather than the refusal it is.
@MainActor
struct PairingCodeStart {
    let module: TransferModule

    private var code: PairingCodeModel { module.code }
    private var link: LinkWorkspaceModel { module.link }

    /// Mint a code and watch its room for a peer that speaks `link/1`.
    ///
    /// Reports whether the room is being watched, so a caller that must not
    /// leave the user holding unusable digits can tell. A mint that failed
    /// leaves its own message in `PairingCodeModel.state`; a mint that succeeded
    /// but could not be watched is the refusal above.
    @discardableResult
    func createAndWatch(token: String) async -> Bool {
        await code.mint(token: token)
        guard let minted = code.state.code else { return false }
        return watch(code: minted)
    }

    /// Join somebody else's code. The digits are adopted first so the surface
    /// shows the same wait a minted code shows.
    @discardableResult
    func joinAndWatch(code joined: String) -> Bool {
        code.adopt(joined: joined)
        return watch(code: joined)
    }

    /// **Replace an expired code with a fresh one. The shared action, not a copy
    /// of it.**
    ///
    /// This was three lines here — leave, dismiss, mint — under a comment that
    /// said the code model never passes through `.idle` and ownership is never
    /// touched. Neither was true, and macOS 1.4.1 shipped it. `RelayiumApp`
    /// answers a retired room by cancelling the digits that named it, so
    /// `leave()` takes the code to `.idle`, `dismiss()` leaves this module
    /// holding nothing, and the app-scoped liveness observer releases the
    /// surface. Nothing claimed it again: the replacement code was minted and
    /// its room was watched, and the peer that linked on it was never drawn.
    ///
    /// The action DOES pass through idle and cannot avoid it — the dead room has
    /// to go before `watchPairingCode` will take a new one. What keeps the
    /// surface is that `CrossNetworkPairingStart.regenerate` retakes the claim
    /// synchronously, before the mint suspends, and refuses an activation that
    /// is stale. The reasoning is recorded there, once; iOS had this same defect
    /// and a second copy is how the two platforms came to disagree.
    ///
    /// It still cannot disturb the OTHER module: nothing it reaches is outside
    /// `self.module`, and the two modules share no presence, room or socket.
    ///
    /// `MacSurfaceGuardTests` pins this body as a delegation and nothing else;
    /// `MacPairingCodeRegenerateTests` drives the action it names on a module
    /// wired the way `RelayiumApp` wires this one.
    func regenerate(token: String) async {
        await CrossNetworkPairingStart(module: module).regenerate(token: token)
    }

    /// Watch a code's room.
    ///
    /// **Nothing is armed and nothing is staged.** Neither surface has a picker,
    /// so the room is handed an empty batch; what the connection carries is
    /// chosen inside it, once the user can see who they reached.
    @discardableResult
    private func watch(code watched: String) -> Bool {
        // `legacyRole` is still supplied because the shared signature still
        // takes it — the paused iOS implementation and the headless acceptance
        // hosts reach the fallback it names. This composition cannot: its model
        // is built with `legacyFallback: .terminateUnsupported`, so the value is
        // never read. `.initiator` rather than a coin toss because a creator
        // offers, which is what the argument means where it is still used.
        let watching = link.watchPairingCode(watched, legacyRole: .initiator,
                                             files: [], sources: [])
        guard !watching else { return true }
        // **A refused room must not leave digits on screen.** `watchPairingCode`
        // refuses only when this model already holds a room, and a code nothing
        // is watching is six numbers no peer can ever reach — the exact state a
        // user would read out loud and then be unable to explain. Give the whole
        // thing back rather than half of it.
        //
        // A failed MINT never reaches here, so its own message survives: this
        // path is only ever the room refusal.
        module.cancelPairingCode()
        return false
    }
}
