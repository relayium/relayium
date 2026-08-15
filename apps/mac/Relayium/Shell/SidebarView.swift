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
/// pointer user can still read it before choosing. A keyboard user sees the
/// complete purpose immediately after selecting a row in the detail column.
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
/// **The residency footer is gone, and the fact it carried is not.** It reported
/// `NearbyStatusPresentation.text(for: receive.state)` in the sidebar's safe
/// area. Rendered under every row it was worse than useless — it put same-network
/// reachability on Cross-network Transfer, whose whole premise is that no shared
/// network exists — so it was scoped to LAN Transfer, and that scoping is what
/// finished the argument: on the only screen it ever appeared on, the LAN pane's
/// own receive section states the identical string, with the Pause and Resume
/// controls beside it. Two renderings of one sentence, a column apart, and the
/// sidebar's copy was the one nobody could act on. So the pane keeps it and the
/// sidebar spends its bottom on nothing.
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
    }

    /// A `Section` promotes its visual header to `AXHeading`, but on macOS it
    /// can leave that element empty even though the glyphs are on screen. Give
    /// the header's own text an explicit label, heading trait and stable
    /// identity, so the transfer groups have names in the accessibility outline
    /// and a runtime check can tell the product's own element apart from
    /// whatever `List` wraps around it.
    ///
    /// **Annotate the element the text already is; do not synthesize one here.**
    /// `.accessibilityElement(children: .ignore)` sat on this header for two
    /// rounds — first on an `HStack(spacing: 0)` holding a single `Text`, then on
    /// the `Text` itself — and the owner's 2026-08-16 run of
    /// `testEveryDestinationPassesTheSystemAccessibilityAudit` measured what it
    /// cost: NO element carrying `sidebar-sectionDirect`, `…Links` or `…Device`
    /// existed anywhere in the running tree. That modifier discards the view's
    /// own accessibility element and puts a roleless synthesized one in its
    /// place, and everything written after it — the label, the heading trait, the
    /// identifier — lands on that replacement rather than on the text. Inside a
    /// `List` section header the replacement does not survive into the tree: the
    /// 2026-08-15 probe (`WORK-QUEUE.md` Q9), taken while the same modifier stack
    /// sat on the `HStack`, found only the raw `Text` — `(778,362,34,14)
    /// label=Direct`, no identity — which is the same result read twice.
    ///
    /// `PathRail` is the control case for the other half of that mechanism: its
    /// stops genuinely need one element built from several views, and the same
    /// audit reported them as `Unknown role` until a trait supplied the role the
    /// synthesized element does not have. A heading needs neither step. A `Text`
    /// is already one leaf element with a role, so the label, the trait and the
    /// identity below modify it in place.
    ///
    /// What the audit still rejects on these rows — an unlabelled 208×19 `Group`
    /// at `(778,360)`, `(778,456)` and `(778,520)`, byte-identical before and
    /// after everything this function has been rewritten to do — is therefore
    /// `List`'s own wrapper, which no product code can reach.
    /// `AppShellUITests` excludes it by name, and only for as long as it encloses
    /// one of these identified, labelled headings.
    private func sectionHeader(_ key: L10nKey) -> some View {
        let title = L10n.t(key)
        // The trailing component of `nav.sectionDirect`, so the runtime identity
        // cannot drift from the key that supplies the words.
        let id = key.rawValue.split(separator: ".").last.map(String.init) ?? key.rawValue
        return Text(title)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("sidebar-\(id)")
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
}
