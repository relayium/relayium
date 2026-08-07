import SwiftUI
import RelayiumAppKit

/// Five rows, all visible at once, in two sections plus a standalone Account row.
///
/// This is the round's central correction. Everything the app can do used to be
/// either behind a sign-in form the capability did not need or inside a
/// collapsed `DisclosureGroup` under it; naming all five destinations at all
/// times is what makes the three anonymous ones findable. Each row carries a
/// compact subtitle that may wrap, so a destination is understandable before it
/// is opened rather than after — and that same sentence is the row's
/// accessibility hint.
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
    private var selection: Binding<AppDestination?> {
        Binding(get: { navigation.selection },
                set: { if let destination = $0 { navigation.select(destination) } })
    }

    var body: some View {
        List(selection: selection) {
            Section {
                row(.nearby,
                    symbol: "dot.radiowaves.left.and.right",
                    title: L10n.t(.navNearby),
                    subtitle: L10n.t(.navNearbySubtitle))
                row(.pairingCode,
                    symbol: "number",
                    title: L10n.t(.navPairingCode),
                    subtitle: L10n.t(.navPairingCodeSubtitle))
            } header: {
                sectionHeader(.navSectionDirect)
            }
            Section {
                row(.storedSend,
                    symbol: "link.badge.plus",
                    title: L10n.t(.navStoredSend),
                    subtitle: L10n.t(.navStoredSendSubtitle))
                row(.storedReceive,
                    symbol: "arrow.down.doc",
                    title: L10n.t(.navStoredReceive),
                    subtitle: L10n.t(.navStoredReceiveSubtitle))
            } header: {
                sectionHeader(.navSectionLinks)
            }
            // Standalone rather than in a section of its own: the account is not
            // a transport, and grouping it under a heading would imply it is one
            // more way to move a file.
            row(.account,
                symbol: "person.crop.circle",
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

    private func row(_ destination: AppDestination,
                     symbol: String,
                     title: String,
                     subtitle: String) -> some View {
        let live = hasLiveSession(destination)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Label(title, systemImage: symbol)
                if live {
                    Image(systemName: liveSessionSymbol)
                        .foregroundStyle(.tint)
                        // The words are already on the row's own accessibility
                        // label, and a badge that announced itself separately
                        // would read the state twice.
                        .accessibilityHidden(true)
                }
            }
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                // Sidebar lists inherit a single-line limit on macOS. Without
                // an explicit override the full string remains in AXHelp while
                // the visible row ends in an ellipsis at every window size.
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        // The AX container for a SwiftUI List changed between macOS 15 and 26
        // (table vs outline). The task identity must not depend on that private
        // hierarchy, and it also gives UI automation the same stable row on
        // every supported system.
        .accessibilityIdentifier("sidebar-\(destination.rawValue)")
        .accessibilityLabel(live
                            ? L10n.detail([title, L10n.t(.navA11yLiveSession)])
                            : title)
        .accessibilityHint(subtitle)
        .tag(destination)
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
    private func hasLiveSession(_ destination: AppDestination) -> Bool {
        presence.announcesRunningTransfer(destination,
                                          sessionIsBusy: fileModel.isBusy || textModel.isBusy)
    }

    /// Read-only on purpose: pause and resume live in Nearby and in the menu
    /// bar, and a third control site for one toggle is worse than a slightly
    /// longer path to it. What the footer owes the user is the answer to "can
    /// this Mac be reached right now", which is exactly what it reports.
    private var residency: some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            Text(L10n.t(.navResidency))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            StatusBadge(symbol: residencySymbol,
                        tint: residencyTint,
                        label: NearbyStatusPresentation.text(for: receive.state))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .accessibilityElement(children: .combine)
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
