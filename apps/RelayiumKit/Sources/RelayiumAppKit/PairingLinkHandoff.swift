import Foundation
import RelayiumKit

// **The Cross-network module, assembled and started in ONE shared place.**
//
// iOS shipped `0.3.2` with a Cross-network screen that could not reach a current
// Mac or browser at all, and nothing failed to compile. The reason is recorded
// in WORKFLOW-LEARNINGS (2026-08-21): a protocol or model suite proves what the
// objects can do, never that the shipped graph connected them. The callbacks
// below are optionals, so a composition that forgets one builds, runs and
// leaves six digits on screen over a closed socket.
//
// So the assembly is a function in this package rather than a paragraph in an
// `App` initializer. `swift test` runs on macOS and cannot compile the iOS
// target, but it CAN call this — which is what lets
// `PairingLinkHandoffTests` build the module the way the iOS app builds it and
// fail when a wiring is removed. The macOS app keeps its own, older spelling of
// the same two callbacks; it predates this file and is pinned by
// `MacSurfaceGuardTests`.

extension TransferModule {
    /// The Cross-network module: a pairing code, the `link/1` that watches its
    /// room, and the two edges that keep the digits truthful.
    ///
    /// - `onPairingLinkActivated`: the room resolved to `link/1`. The link has
    ///   already published `.requesting`, so retiring the code cannot pass the
    ///   module through all-idle — and without it the spent code reappears under
    ///   the connect controls when the link ends.
    /// - `onPairingRoomRetired`: the room ended WITHOUT a link — a peer that
    ///   could not speak `link/1`, a code the hub would not resolve, a socket
    ///   that closed first. The rendezvous is gone, so the digits that named it
    ///   go too. Whatever the surface should now say (`unsupportedPairingPeer`,
    ///   an ending) is published separately and is not cleared by this.
    ///
    /// `adoptLegacyRoom` and `onLegacyFallbackBatch` are deliberately NOT set:
    /// this module's link is built `legacyFallback: .terminateUnsupported`, and a
    /// callback installed "just in case" is a route back to a lane the screen
    /// cannot draw.
    @MainActor
    public static func crossNetwork(link: LinkWorkspaceModel,
                                    code: PairingCodeModel,
                                    presence: TransferPresence? = nil) -> TransferModule {
        let module = TransferModule(route: .pairingCode, link: link, code: code,
                                    presence: presence)
        link.onPairingLinkActivated = { [weak code] in code?.cancel() }
        link.onPairingRoomRetired = { [weak code] in code?.cancel() }
        return module
    }
}

/// **Starting a pairing code on a connect-first surface: mint or adopt the
/// digits, then watch the room they name.**
///
/// The shared twin of the macOS target's `PairingCodeStart`, and the same two
/// steps for the same reason: a first code and a replacement for an expired one
/// must not be able to disagree about whether the room is watched at all.
///
/// **Nothing is armed and nothing is staged.** The surface has no pre-connect
/// picker and no Files/Text choice — a code carries no type, the link carries
/// both lanes, and what the connection carries is chosen inside it once the user
/// can see who they reached. Asking first was asking the user to guess what a
/// stranger's client speaks.
///
/// It owns no state. Claiming the surface, the account gate and the error copy
/// stay with the caller, because they differ between create and join.
@MainActor
public struct CrossNetworkPairingStart {
    public let module: TransferModule

    public init(module: TransferModule) {
        self.module = module
    }

    /// Mint a code and watch its room. False when the mint failed (its own
    /// message is left in `PairingCodeModel.state`) or the room was refused.
    @discardableResult
    public func createAndWatch(token: String) async -> Bool {
        await module.code.mint(token: token)
        guard let minted = module.code.state.code else { return false }
        // A newer action may have resumed while this mint was in flight, and its
        // room is the one this module now holds. `watchPairingCode` refuses a
        // second room, and the refusal below retires the digits and the socket —
        // which here would be somebody else's.
        guard module.link.connection == .idle else { return false }
        return watch(code: minted)
    }

    /// Join somebody else's code. The digits are adopted first so the surface
    /// shows the same wait a minted code shows.
    @discardableResult
    public func joinAndWatch(code joined: String) -> Bool {
        module.code.adopt(joined: joined)
        return watch(code: joined)
    }

    /// Replace an expired code: retire the dead room, take the surface back, and
    /// only then mint.
    ///
    /// **This action DOES pass the module through idle, and it cannot avoid it.**
    /// `watchPairingCode` refuses a second room while one is held, so the dead
    /// one must go first; `leave()` retires it, and `TransferModule.crossNetwork`
    /// answers a retired room by cancelling the digits that named it. By the time
    /// `dismiss()` returns the link to `.idle` this module holds nothing, and the
    /// app-scoped liveness observer has already released the surface. Nothing
    /// afterwards claimed it again: the replacement code was minted and its room
    /// was watched, but `pane` stayed `.connect` for the rest of the process, so
    /// the peer that linked on those digits was invisible.
    ///
    /// So the claim is retaken here, synchronously, BEFORE the asynchronous mint
    /// — which is also what makes the wait for the replacement a surface this
    /// module owns rather than one a second start could take.
    public func regenerate(token: String) async {
        // Only a code this module is still showing may be replaced. A surface
        // somebody else owns, a peer already claimed on this link, or a
        // replacement still minting are each a reason this activation is stale —
        // and acting on one would retire a room that is no longer this action's.
        // Nothing between here and `.minting` suspends, so a second activation
        // cannot slip past these three.
        guard module.presence.owner == module.route,
              !module.link.connection.hasPeer,
              module.code.state != .minting else { return }
        module.link.leave()
        module.link.dismiss()
        guard module.presence.claim(module.route) else { return }
        await createAndWatch(token: token)
    }

    @discardableResult
    private func watch(code watched: String) -> Bool {
        // `legacyRole` is supplied because the shared signature takes it; this
        // module's link is `terminateUnsupported`, so it is never read.
        let watching = module.link.watchPairingCode(watched, legacyRole: .initiator,
                                                    files: [], sources: [])
        guard !watching else { return true }
        // A refused room must not leave digits on screen: a code nothing is
        // watching is six numbers no peer can ever reach.
        module.cancelPairingCode()
        return false
    }
}
