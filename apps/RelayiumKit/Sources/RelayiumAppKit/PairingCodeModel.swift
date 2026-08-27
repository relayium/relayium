import Combine
import Foundation
import RelayiumKit

/// What a pairing code is doing on screen. Four states, and none of them is a
/// connection: this type mints digits and holds them until somebody uses them.
public enum PairingCodeState: Equatable {
    /// No code. Nothing minted, nothing typed, nothing to show.
    case idle
    /// A mint is in flight. Cancellable, and it is the one state a user can be
    /// stuck in without a code to read out.
    case minting
    /// Six digits and the second they stop working.
    case showing(String, expiresAt: Int64)
    /// The mint failed, in the words `ErrorCopy` gave it.
    case failed(String)

    /// The live code, or nil in every other state.
    public var code: String? {
        guard case let .showing(code, _) = self else { return nil }
        return code
    }

    /// Whether this object is holding anything the surface must not discard
    /// behind the user's back — including a mint they are waiting on.
    public var isActive: Bool {
        switch self {
        case .idle: return false
        case .minting, .showing, .failed: return true
        }
    }
}

/// **A pairing code, and nothing else: mint it, show it, let it expire.**
///
/// ## Why this exists
///
/// macOS used to mint through `RealtimeSessionModel`. That was never a product
/// decision — it was where the code happened to live, because the legacy file
/// lane was the thing that consumed one. So the pairing surface reached into a
/// whole transport model to ask for six digits, and three consequences followed
/// from it, each of which cost a repair of its own:
///
///  1. **The lane had to be guessed before the peer existed.** A code was minted
///     into `.files` because one of the two legacy models had to hold it, and a
///     room that turned out to be a text peer then had to be MOVED — a surface
///     transition with an ordering rule (`adoptLegacyRoom`) whose only purpose
///     was to undo a choice nothing had asked for.
///  2. **Retiring the code was retiring a session.** When a `link/1` peer
///     arrived, the model rendering the digits had to be cancelled underneath
///     the new link, and cancelling it dropped the whole module through an
///     all-idle state that released the surface. The repair
///     (`TransferModule.retainsWork`) is correct and stays; the reason it was
///     needed was that six digits and a transport shared one lifecycle.
///  3. **A build with no legacy transport could not mint at all.** Which is
///     exactly the build macOS now ships.
///
/// So the code is its own object. It reserves relay capacity billed to an
/// account and it holds an expiry; it opens no socket, derives no key, speaks no
/// protocol and has no peer. What the code is FOR — one authenticated `link/1`
/// carrying files and messages together — belongs to `LinkWorkspaceModel`, which
/// watches the room these digits name.
///
/// ## What it deliberately does not do
///
/// It does not watch, join, connect or fall back. `PairingCodeStart` composes
/// this object's mint with `LinkWorkspaceModel.watchPairingCode`, and that
/// composition is the only place the two meet. A model that did both would be
/// the shared lifecycle above, rebuilt under a new name.
///
/// App-scoped like everything else a `TransferModule` owns: macOS keeps running
/// with its window closed, so a code minted before the user closed the window is
/// still the code the other person is typing.
@MainActor
public final class PairingCodeModel: ObservableObject {
    @Published public private(set) var state: PairingCodeState = .idle

    /// The code being TYPED, as opposed to the one being shown. Shared with the
    /// field so an OS handoff (`relayium://` with a code in it) can prefill it
    /// without joining anything or replacing a code already on screen.
    @Published public var joinCode: String = ""

    private let client: PairCodeClient

    /// Bumped by every mint and every cancel, so a slow response cannot write
    /// into a surface the user has already moved on from. The same guard
    /// `RealtimeSessionModel.mintCode` had, kept because the failure it prevents
    /// — an expired code appearing over a live connection — is unchanged.
    private var generation = 0

    public init(client: PairCodeClient) {
        self.client = client
    }

    public var canJoin: Bool { isCompletePairingCode(joinCode) }

    /// Normalize inside the one state transition rather than in an `onChange`
    /// behind it: a raw write followed by a correction can lose a paste or a
    /// fast keystroke that landed in between.
    public func updateJoinCode(_ raw: String) {
        joinCode = normalizedPairingCode(raw)
    }

    /// **Mint a code to show. Requires the bearer** — the code's owner pays for
    /// whatever is relayed through it, so the server will not mint anonymously.
    ///
    /// It moves to `.minting` from ANY state, including `.showing`, and that is
    /// load-bearing for the expired-code replacement path: passing through
    /// `.idle` would make this module momentarily hold nothing, and the
    /// app-scoped liveness observer would release the surface out from under the
    /// action the user just asked for.
    public func mint(token: String) async {
        generation += 1
        let mine = generation
        state = .minting
        do {
            let minted = try await client.mint(token: token)
            guard mine == generation else { return }
            state = .showing(minted.code, expiresAt: minted.expiresAt)
        } catch {
            guard mine == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Adopt a code somebody typed, so the surface renders the same wait a
    /// minted one does.
    ///
    /// **`expiresAt: 0` is a real answer, not a placeholder.** A joiner was
    /// given six digits and was never told when they stop working; the server
    /// knows and this side does not. `PairingCodeExpiry.presentation` already
    /// defines that input as "usable and uncounted" — a code with no local
    /// deadline is offered, without a countdown this side would have to invent,
    /// and the server still refuses it at the real moment. Treating it as
    /// expired instead would break a working transfer over a field this device
    /// was never sent.
    public func adopt(joined code: String) {
        generation += 1
        state = .showing(code, expiresAt: 0)
    }

    /// Discard whatever is held, and make any in-flight mint's answer arrive too
    /// late to be written.
    public func cancel() {
        generation += 1
        state = .idle
    }
}
