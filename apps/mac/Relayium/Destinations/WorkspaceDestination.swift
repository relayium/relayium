import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **One destination for one peer.**
///
/// This replaces the two rows the sidebar used to carry. Nearby and Pairing code
/// were never two products: they always drove the same `RealtimeSessionModel`
/// and `RealtimeTextSessionModel`, took turns owning the same
/// `TransferPresence`, and each of them spent half its screen telling the user
/// that the session they were looking for was on the *other* row. Two ways of
/// reaching one device is a property of the connection, not a place in the app,
/// so it is a choice made inside this surface rather than a fork in front of it.
///
/// ## What is unified here, and what deliberately is not
///
/// Unified: navigation, the connection methods, the staged selection, the
/// verification setting, the live session and its exit.
///
/// **The wire is unified for a peer that can speak it, and only for that peer.**
/// A device that announced exact `link/1` gets `WorkspaceLinkPane`: ONE
/// authenticated connection, verified once, carrying an always-visible composer
/// and as many file or folder batches as the user wants. Everything else —
/// every older Web build, every native client on the shipped wire, the CLI, and
/// every pairing-code session on this platform — keeps `WorkspaceSessionPane`
/// and its one honest sentence about carrying messages *or* files.
///
/// The two are never on screen together and neither is a fallback for the
/// other: `LinkWorkspaceModel.canLink` is `PeerCapabilityRegistry.supports`
/// with exact matching, and a peer that does not answer it is not part of this
/// feature at all. Pairing-code rooms are deliberately outside it — see
/// `linkRoomActive(isCodelessRoom:)` for the reason and the revisit trigger.
///
/// ## Routing
///
/// `AppDestination` is untouched: `.nearby` and `.pairingCode` remain the shared
/// routing vocabulary, iOS still renders them as two tabs, and both of them draw
/// THIS screen on macOS (`AppDestination.macSurface`). That is what lets a
/// pairing-code deep link, an unsolicited nearby session and a Dock drop keep
/// their existing, tested routes while the user sees one place.
struct WorkspaceDestination: View {
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var verification: VerificationPreference
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @EnvironmentObject private var receive: NearbyReceiveModel
    @EnvironmentObject private var fileModel: RealtimeSessionModel
    @EnvironmentObject private var textModel: RealtimeTextSessionModel
    /// The unified `link/1`, for peers that announced it. Asked FIRST below:
    /// a link session and a legacy session cannot coexist, and the link is the
    /// one that can be running while both legacy models read idle.
    @EnvironmentObject private var link: LinkWorkspaceModel
    /// Held for ONE half of this surface: minting a pairing code reserves relay
    /// capacity billed to whoever created it. Same-network transfer in both
    /// directions, and joining somebody else's code, stay account-free and are
    /// rendered and enabled identically signed out — `MacSurfaceGuardTests`
    /// checks that the gate wraps only the create controls.
    @EnvironmentObject private var session: AccountSession

    /// **One staged selection for the whole surface**, and the reason it lives
    /// here rather than in either pane: the two panes are two phases of one
    /// task, so a batch chosen before connecting has to be the batch that is
    /// sent afterwards. Two `SelectionStore`s — which is what the two old panes
    /// had — is how a user stages files on one screen and finds the other one
    /// empty.
    @StateObject private var selection = SelectionStore()

    private var modelBusy: Bool { fileModel.isBusy || textModel.isBusy }

    /// A claim alone is not yet something to render a session for, and a
    /// terminal state is: `.completed` keeps its result, `.failed` keeps its
    /// manifest, and an ended conversation keeps its transcript. Either fact is
    /// enough to hand the screen to the session pane.
    private var hasRetainedSession: Bool {
        fileModel.state != .idle || textModel.state != .idle
    }

    /// True while any of this surface's routes owns a session. `presence` is
    /// still arbitrated per route — iOS depends on that — so this asks about
    /// both rather than assuming which one won.
    private var ownsSession: Bool {
        guard let owner = presence.owner else { return false }
        return AppDestination.macWorkspaceRoutes.contains(owner)
    }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navWorkspace),
                            subtitle: L10n.t(.navWorkspaceSubtitle),
                            contentMaxWidth: nil) {
            if link.hasSession {
                WorkspaceLinkPane(link: link)
            } else if ownsSession || hasRetainedSession {
                WorkspaceSessionPane(fileModel: fileModel,
                                     textModel: textModel,
                                     selection: selection)
            } else {
                WorkspaceConnectPane(discovery: discovery,
                                     receive: receive,
                                     fileModel: fileModel,
                                     textModel: textModel,
                                     link: link,
                                     selection: selection,
                                     gate: gate,
                                     accessNow: { accessNow })
                verificationSetting
            }
        }
        // A session nobody asked for decides its own kind, so the mode follows
        // it. `task(id:)` rather than `onChange`, because this window may have
        // been closed when the session started and rebuilt — with the mode back
        // at its default — while it is still running.
        .task(id: receive.activeKind) { followIncoming() }
    }

    /// The gate controls what is rendered.
    private var gate: AccountGate {
        #if DEBUG
        if UITestMode.isActive {
            return .allowed(AccountAccess(token: "ui-test", retentionSecs: 86_400))
        }
        #endif
        return AccountGate.from(session.state, bearer: session.bearerToken)
    }

    /// What an activation may spend. SwiftUI can deliver a click from the
    /// previous render after the account has changed, so child actions ask the
    /// live session again instead of spending the access a Button captured.
    private var accessNow: AccountAccess? {
        #if DEBUG
        if UITestMode.isActive {
            return AccountAccess(token: "ui-test", retentionSecs: 86_400) // nonlocalized: fixture
        }
        #endif
        guard case let .allowed(access) = AccountGate.from(session.state,
                                                           bearer: session.bearerToken)
        else { return nil }
        return access
    }

    /// Moved here from the destination this replaces: it applies to both kinds
    /// of session, so it belongs to the surface rather than to either lane.
    /// Locked while a session is live, because the models read it when the SAS
    /// arrives — flipping it mid-handshake would make the gate depend on timing.
    private var verificationSetting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(L10n.t(.verifyToggle), isOn: Binding(
                get: { verification.requiresSASConfirmation },
                set: { if !sessionLocked { verification.requiresSASConfirmation = $0 } }
            ))
                .disabled(sessionLocked)
            Text(L10n.t(.verifyExplainWhat))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.verifyExplainEncryption))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxWidth: 720, alignment: .leading)
    }

    private var sessionLocked: Bool {
        presence.owner != nil || hasRetainedSession || link.hasSession
    }

    /// Puts an incoming session on screen in the mode that can render it.
    /// Without this, a file transfer arriving while the mode sat on text shows
    /// the text lane's idle state and the transfer is invisible.
    private func followIncoming() {
        guard let kind = receive.activeKind else { return }
        presence.claim(AppRouting.destination(forIncoming: kind),
                       mode: kind == .file ? .files : .text)
    }
}
