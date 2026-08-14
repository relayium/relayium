import SwiftUI
import RelayiumAppKit

/// Five rows, all visible at once, in three sections plus a standalone Account row.
///
/// **The sidebar names the destinations; the screen it opens explains the one
/// you are on.** For one round it did both: every row printed its full
/// explanatory sentence, up to three wrapped lines, five times over. Two of
/// those sentences run past a hundred characters in English and further in
/// German, so a 208pt column at the supported 560pt window height was spending
/// most of itself on prose about four screens the reader was not looking at —
/// and in the longest locales it did not fit at all.
///
/// So each row is now a title and its symbol, and the sentence moved to
/// `DetailHeader` on the destination itself, where the column is three times as
/// wide and only one of them is on screen. **Nothing was lost to anyone**: every
/// row still carries the complete sentence as its `accessibilityHint`, so
/// VoiceOver reads exactly what it read before, and as its `help` tooltip, so a
/// pointer user can still read it before choosing.
///
/// **The selected state is the system's.** `List` selection already draws the
/// row in the app's own `AccentColor` — the brand violet — with the correct
/// contrast, focus behaviour and Increase Contrast handling. There is no second
/// indicator painted over it: the saturated violet paragraph block this replaces
/// was the single loudest thing in the window, and a bar drawn inside a
/// highlight the system already drew is decoration.
///
/// **LAN Transfer and Cross-network Transfer are two rows.** They were briefly
/// one, called Workspace, on the argument that they are two ways to reach one
/// peer rather than two products. Underneath they still share every model and
/// one `TransferPresence`; on screen they do not, because their preconditions
/// are opposite — the same network and no account, versus an account to mint a
/// code without requiring a shared network — and that difference is the first thing a
/// person choosing between them needs.
///
/// **The residency footer belongs to LAN Transfer, not to the sidebar.** It
/// answers "can this Mac be reached on this network right now", which is a fact
/// about one of those two destinations and about none of the others. It sits in
/// the sidebar's safe area because that is where it fits, not because it
/// describes the sidebar — so it renders only while LAN Transfer is selected.
///
/// **Open a link is deliberately not a row.** It is where a link the OS handed
/// this app is opened, not somewhere to set out for; the destination is still
/// rendered whenever a supported deep link selects it, and `MacSurface.browseable`
/// is the one list that says which surfaces are offered here.
///
/// **Device Inbox is a row for the same reason the other four are.** It shipped
/// with a resident receiver, a menu-bar line and a complete settings pane, and
/// was still missing in practice: the only full surface was behind ⌘, and
/// nothing in the window named the feature at all. It is listed signed out like
/// everything else — the screen behind it explains what it needs and offers the
/// way to an account, which is a different thing from hiding the row until
/// somebody already has one.
struct SidebarView: View {
    @EnvironmentObject private var navigation: AppNavigationModel
    /// Which destination is presenting the live session — the same object the
    /// two direct destinations ask before deciding which of them draws it, so
    /// the sidebar marks the row the session is actually on rather than a row
    /// that merely might be.
    @EnvironmentObject private var presence: TransferPresence
    /// Residency, and only residency: whether this Mac can be reached right now.
    /// It has no opinion about which row owns a running session.
    @EnvironmentObject private var receive: NearbyReceiveModel
    /// The two app-scoped session models, read for one fact each: whether a
    /// transfer is actually running. `TransferPresence` answers which row is
    /// drawing the session, and deliberately does not cache this — see
    /// `announcesRunningTransfer`.
    @EnvironmentObject private var fileModel: RealtimeSessionModel
    @EnvironmentObject private var textModel: RealtimeTextSessionModel

    /// The marker is a symbol first. `nav.a11yLiveSession` gives it the words,
    /// and the tint is the third carrier rather than the only one — a row that
    /// says "something is happening here" purely by turning a different colour
    /// says nothing at all under a colour filter or in Increase Contrast.
    private let liveSessionSymbol = "arrow.left.arrow.right.circle.fill"

    /// Clicks go through `select(_:)` rather than writing `selection` directly,
    /// so every selection change — user, deep link or incoming session — takes
    /// the same one-assignment path the routing contract is stated in terms of.
    /// `List` single-selection is an optional binding; a deselection (which the
    /// sidebar has no gesture for) is simply ignored rather than blanking the
    /// detail column.
    /// **Normalised to the surface, not to the destination.** Writing back goes
    /// through the surface's own `route`, so a click still produces exactly one
    /// ordinary `select(_:)`.
    ///
    /// A destination with no row of its own — Open a link, arrived at by deep
    /// link — maps to a `MacSurface` that no row is tagged with, so `List`
    /// highlights nothing. That is the correct answer rather than a gap: the
    /// user is somewhere the sidebar does not offer, and pretending a row is
    /// selected would name the wrong one.
    private var selection: Binding<MacSurface?> {
        Binding(get: { navigation.selection.macSurface },
                set: { if let surface = $0 { navigation.select(surface.route) } })
    }

    var body: some View {
        List(selection: selection) {
            Section {
                row(.lanTransfer,
                    title: L10n.t(.navLanTransfer),
                    subtitle: L10n.t(.navLanTransferSubtitle))
                row(.crossNetworkTransfer,
                    title: L10n.t(.navCrossNetwork),
                    subtitle: L10n.t(.navCrossNetworkSubtitle))
            } header: {
                sectionHeader(.navSectionDirect)
            }
            Section {
                row(.storedSend,
                    title: L10n.t(.navStoredSend),
                    subtitle: L10n.t(.navStoredSendSubtitle))
            } header: {
                sectionHeader(.navSectionLinks)
            }
            // A section of its own rather than a third row under Links, because
            // the Device Inbox is neither a link nor a conversation with somebody
            // present: it is this Mac as a destination, running with the window
            // closed. One row today; a section is what the next resident
            // capability joins without renaming the group around it.
            Section {
                // The title is `inbox.title`, the same key the menu bar, the
                // settings tab and the destination heading render — so the
                // feature has one name in the product rather than four.
                row(.deviceInbox,
                    title: L10n.t(.inboxTitle),
                    subtitle: L10n.t(.navDeviceInboxSubtitle))
            } header: {
                sectionHeader(.navSectionDevice)
            }
            // Standalone rather than in a section of its own: the account is not
            // a transport, and grouping it under a heading would imply it is one
            // more way to move a file.
            row(.account,
                title: L10n.t(.navAccount),
                subtitle: L10n.t(.navAccountSubtitle))
        }
        .accessibilityLabel(L10n.t(.navA11ySections))
        .safeAreaInset(edge: .bottom) { residency }
    }

    /// A `Section` promotes its visual header to `AXHeading`, but on macOS it
    /// can leave that element empty even though the glyphs are on screen. Give
    /// the promoted element one explicit child policy, label and heading trait
    /// so the transfer groups have names in the accessibility outline.
    private func sectionHeader(_ key: L10nKey) -> some View {
        let title = L10n.t(key)
        return HStack(spacing: 0) {
            Text(title)
        }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isHeader)
    }

    private func row(_ surface: MacSurface,
                     title: String,
                     subtitle: String) -> some View {
        let live = hasLiveSession(surface)
        return HStack(spacing: Metrics.tight) {
            Label(title, systemImage: surface.symbol)
                .lineLimit(2)
            if live {
                Image(systemName: liveSessionSymbol)
                    .foregroundStyle(.tint)
                    // The words are already on the row's own accessibility
                    // label, and a badge that announced itself separately
                    // would read the state twice.
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 3)
        // The sentence that used to be printed under the title, kept where a
        // pointer can still reach it. This is the SAME string the row's
        // accessibility hint carries, so the tooltip and VoiceOver cannot drift
        // apart, and it is the reason dropping the visible caption costs a
        // browsing reader nothing rather than hiding the explanation.
        .help(subtitle)
        .accessibilityElement(children: .combine)
        // The AX container for a SwiftUI List changed between macOS 15 and 26
        // (table vs outline). The task identity must not depend on that private
        // hierarchy, and it also gives UI automation the same stable row on
        // every supported system.
        .accessibilityIdentifier("sidebar-\(surface.rawValue)")
        .accessibilityLabel(live
                            ? L10n.detail([title, L10n.t(.navA11yLiveSession)])
                            : title)
        .accessibilityHint(subtitle)
        .tag(surface)
    }

    /// Whichever destination is presenting a session that is actually running —
    /// true for at most one row, and for none once the transfer ends.
    ///
    /// It used to be `destination == .nearby && receive.activeKind != nil`, and
    /// that was wrong in three directions at once: a pairing-code session was
    /// never marked, an outbound *nearby send* was never marked because nothing
    /// had arrived, and residency was being read as ownership —
    /// `NearbyReceiveModel` only knows whether this Mac can be reached.
    ///
    /// Ownership alone was the next answer and was still wrong at the end: a
    /// `.completed` receive keeps its surface, so the row went on announcing
    /// `nav.a11yLiveSession` — "A transfer is running here" — while the user
    /// read "Transfer complete". Both facts are needed, and each is taken from
    /// the object that owns it rather than copied into a third.
    ///
    /// One route per row again, which is what makes the marker useful: with the
    /// two transfer destinations separated, the marked row is the one the
    /// session is actually on, so following it lands the user on the transfer
    /// rather than on a screen that has to explain where it went.
    private func hasLiveSession(_ surface: MacSurface) -> Bool {
        let busy = fileModel.isBusy || textModel.isBusy
        return presence.announcesRunningTransfer(surface.route, sessionIsBusy: busy)
    }

    /// Read-only on purpose: pause and resume live in Nearby and in the menu
    /// bar, and a third control site for one toggle is worse than a slightly
    /// longer path to it. What the footer owes the user is the answer to "can
    /// this Mac be reached right now", which is exactly what it reports.
    ///
    /// **On LAN Transfer, and nowhere else.** `NearbyReceiveModel` is
    /// same-network residency: whether this Mac is announcing itself on the
    /// local network and can be reached by a device that shares it. Rendered
    /// under every row, it put that answer on Cross-network Transfer — the one
    /// destination whose entire premise is that no shared network exists — and
    /// on Stored Send, Device Inbox and Account, none of which it describes
    /// either. `testCrossNetworkTransferOffersOnlyPairingCodeConnecting…`
    /// already forbade the residency *control* on the pairing screen; this
    /// footer was the same claim, one column to the left, in a container the
    /// destination does not own.
    ///
    /// This is presentation only. Residency itself is unchanged and app-scoped:
    /// this Mac keeps receiving from anywhere in the app, and the LAN row's own
    /// live-session marker still says when a transfer is running there.
    @ViewBuilder private var residency: some View {
        if navigation.selection.macSurface == .lanTransfer {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Divider()
                Text(L10n.t(.navResidency))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                StatusBadge(symbol: residencySymbol,
                            tint: residencyTint,
                            label: NearbyStatusPresentation.text(for: receive.state))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.inner)
            .padding(.bottom, Metrics.inner)
            .accessibilityElement(children: .combine)
            // The footer is an absence on four of five rows, and an absence
            // needs a name a runtime check can ask for. The AX container for a
            // safe-area inset is not stable across macOS versions, so the
            // identity is on the content rather than on the inset.
            .accessibilityIdentifier("sidebar-lan-residency")
        }
    }

    private var residencySymbol: String {
        switch receive.state {
        case .ready:                     return "checkmark.circle.fill"
        case .active:                    return "arrow.down.circle.fill"
        case .connecting, .reconnecting: return "arrow.triangle.2.circlepath"
        case .paused:                    return "pause.circle.fill"
        case .off:                       return "circle.slash"
        }
    }

    private var residencyTint: Color {
        switch receive.state {
        case .ready, .active:            return .green
        case .connecting, .reconnecting: return .orange
        case .paused, .off:              return .secondary
        }
    }
}
