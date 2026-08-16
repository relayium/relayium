import Foundation
import RelayiumAppKit
import RelayiumKit

/// **Starting a pairing code, in one place, for the two surfaces that start
/// one.**
///
/// `CrossNetworkConnectPane` mints the first code of a session and joins
/// somebody else's; `TransferSessionPane` mints a REPLACEMENT when the one on
/// screen has expired. Those are the same three steps — mint, watch the room the
/// code names, fall back to the legacy start if this build cannot watch — and
/// before this type existed only the connect pane knew them. The alternative to
/// sharing them was a second copy in the pane that renders the expired code,
/// which is how the two would come to disagree about the legacy role or about
/// whether the room is watched at all.
///
/// It owns no state and holds nothing beyond the module. Ownership of the
/// surface, the account gate and the error the user sees all stay with the
/// surface that started the action, because those differ between the two: a
/// first code CLAIMS the surface and a replacement is minted on a surface this
/// module already owns.
@MainActor
struct PairingCodeStart {
    let module: TransferModule

    private var fileModel: RealtimeSessionModel { module.files }
    private var link: LinkWorkspaceModel { module.link }

    /// Mint a code and watch its room for a peer that speaks `link/1`.
    ///
    /// The creator is the offerer on the legacy wire, so `.initiator` is what the
    /// fallback must use. A LINK computes its own role from the two room ids and
    /// ignores this one.
    func createAndWatch(token: String) async {
        await fileModel.mintCode(token: token)
        guard case let .showingCode(code, _) = fileModel.state else { return }
        watch(code: code, legacyRole: .initiator) {
            await fileModel.join(code: code, role: .initiator)
        }
    }

    /// Join somebody else's code. A joiner ANSWERS on the legacy wire, so
    /// `.responder` is what the fallback must use.
    func joinAndWatch(code: String) {
        watch(code: code, legacyRole: .responder) {
            await fileModel.join(code: code)
        }
    }

    /// **Replace an expired code with a fresh one, without letting go of the
    /// surface in between.**
    ///
    /// The ORDER is the whole of it, and each step is load-bearing:
    ///
    ///  1. The dead room is left and dismissed FIRST. `watchPairingCode` refuses
    ///     while a room is held, so a mint that ran before this would produce a
    ///     code nothing is watching — six digits on screen that no peer could
    ///     ever reach.
    ///  2. `mintCode` is called while the file model is still `.showingCode`, and
    ///     it takes that: it bumps its generation and moves to `.minting` from
    ///     any state. That matters because the model must never pass through
    ///     `.idle` — `TransferSessionPane` releases this module's surface the
    ///     moment it does, which would drop the user back to the connect screen
    ///     half way through the action they just asked for.
    ///  3. Ownership is never touched. This module already owns its surface and
    ///     goes on owning it, which is also why regenerating cannot disturb a
    ///     session on the OTHER module: nothing here reaches outside
    ///     `self.module`, and the two modules share no presence, no room and no
    ///     socket.
    func regenerate(token: String) async {
        link.leave()
        link.dismiss()
        await createAndWatch(token: token)
    }

    /// Watch a code, or fall straight back when this build cannot.
    ///
    /// **Nothing is armed and nothing is staged, on either branch.** Neither
    /// surface has a picker, so `watchPairingCode` is handed an empty batch and
    /// the legacy start has nothing to queue. What the connection carries is
    /// chosen inside it.
    ///
    /// `legacyStart` is the path that shipped before the unified link, and it
    /// runs unchanged when the link model refuses the room — a client with no
    /// pairing socket factory, or one already holding a session. That is what
    /// keeps "pairing code works" true regardless of which half answers.
    private func watch(code: String,
                       legacyRole: Role,
                       legacyStart: @escaping () async -> Void) {
        let watched = link.watchPairingCode(code,
                                            legacyRole: legacyRole,
                                            files: [],
                                            sources: [])
        guard !watched else { return }
        Task { await legacyStart() }
    }
}
