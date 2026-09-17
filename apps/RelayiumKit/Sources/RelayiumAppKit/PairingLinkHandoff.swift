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
        return watch(code: minted)
    }

    /// Join somebody else's code. The digits are adopted first so the surface
    /// shows the same wait a minted code shows.
    @discardableResult
    public func joinAndWatch(code joined: String) -> Bool {
        module.code.adopt(joined: joined)
        return watch(code: joined)
    }

    /// Replace an expired code without letting go of the surface in between.
    ///
    /// The dead room is left and dismissed FIRST — `watchPairingCode` refuses
    /// while a room is held — and `mint` is called while the code model is still
    /// `.showing`, so the module never passes through `.idle` and the liveness
    /// observer never releases the surface half way through the action.
    public func regenerate(token: String) async {
        module.link.leave()
        module.link.dismiss()
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
