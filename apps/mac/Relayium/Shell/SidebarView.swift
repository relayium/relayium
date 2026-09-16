import SwiftUI
import RelayiumAppKit

/// Five rows, all visible at once, in three sections, under a destination search.
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
/// **The selected state is the reference's**: a 28pt violet row with white
/// semibold text, drawn by this view because the owner rejected the system
/// sidebar's styling. It is still a real selection — the row carries the
/// selected trait — and its High Contrast colour keeps white text legible.
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
    /// Both transfer modules, each asked about its OWN row.
    ///
    /// It used to be one `TransferPresence` plus one pair of session models,
    /// which could only ever mark one row: with the modules independent, a
    /// same-network transfer and a pairing transfer can be running at the same
    /// time, and the sidebar has to be able to say so about both rows rather
    /// than picking whichever the shared presence happened to own.
    @EnvironmentObject private var modules: TransferModules

    /// The marker is a symbol first. `nav.a11yLiveSession` gives it the words,
    /// and the tint is the third carrier rather than the only one — a row that
    /// says "something is happening here" purely by turning a different colour
    /// says nothing at all under a colour filter or in Increase Contrast.
    private let liveSessionSymbol = "arrow.left.arrow.right.circle.fill"

    /// The destination filter. View state only: what somebody typed to find a
    /// row is not remembered, stored or sent anywhere.
    @State private var query = ""
    @State private var hovered: MacSurface?
    @Environment(\.shellChrome) private var chrome

    /// One row of the sidebar: which surface, and the words it is found by.
    private struct Entry: Identifiable {
        let surface: MacSurface
        let title: String
        let subtitle: String
        var id: MacSurface { surface }
    }

    private struct SidebarSection: Identifiable {
        let header: L10nKey
        let entries: [Entry]
        var id: String { header.rawValue }
    }

    /// The sections in the reference's order. Account sits under This Mac with
    /// the Device Inbox, as it does in the reference.
    private var groups: [SidebarSection] {
        [
            SidebarSection(header: .navSectionDirect, entries: [
                Entry(surface: .lanTransfer,
                      title: L10n.t(.navLanTransfer),
                      subtitle: L10n.t(.navLanTransferSubtitle)),
                Entry(surface: .crossNetworkTransfer,
                      title: L10n.t(.navCrossNetworkShort),
                      subtitle: L10n.t(.navCrossNetworkSubtitle)),
            ]),
            SidebarSection(header: .navSectionLinks, entries: [
                Entry(surface: .storedSend,
                      title: L10n.t(.navStoredSend),
                      subtitle: L10n.t(.navStoredSendSubtitle)),
            ]),
            // The title is `inbox.title`, the same key the menu bar, the
            // settings tab and the destination toolbar render.
            SidebarSection(header: .navSectionDevice, entries: [
                Entry(surface: .deviceInbox,
                      title: L10n.t(.inboxTitle),
                      subtitle: L10n.t(.navDeviceInboxSubtitle)),
                Entry(surface: .account,
                      title: L10n.t(.navAccount),
                      subtitle: L10n.t(.navAccountSubtitle)),
            ]),
        ]
    }

    /// **Search is real.** It matches the localized row title and the row's own
    /// purpose sentence, ignoring case and diacritics, and a section with no
    /// match disappears with its heading. An empty query shows everything.
    private var visibleGroups: [SidebarSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return groups }
        return groups.compactMap { group in
            let matches = group.entries.filter {
                $0.title.localizedStandardContains(needle)
                    || $0.subtitle.localizedStandardContains(needle)
            }
            return matches.isEmpty ? nil : SidebarSection(header: group.header, entries: matches)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            controlRow
            searchField
                .padding(.horizontal, 12)
                .padding(.bottom, Metrics.tight)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    let shown = visibleGroups
                    if shown.isEmpty {
                        Text(L10n.t(.navSearchNoResults))
                            .font(.callout)
                            .foregroundStyle(Palette.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 20)
                            .padding(.top, Metrics.tight)
                            .accessibilityIdentifier("sidebar-search-empty")
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, group in
                        sectionHeader(group.header)
                            .padding(.top, index == 0 ? 6 : 12)
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(group.entries) { entry in
                                row(entry)
                            }
                        }
                        .padding(.horizontal, Metrics.sidebarInset)
                    }
                }
                .padding(.bottom, Metrics.sidebarInset)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.navA11ySections))
    }

    /// The row the window's traffic lights sit in, with the sidebar toggle at
    /// its trailing end, centred on the lights AppKit actually placed.
    private var controlRow: some View {
        let height = max(Metrics.sidebarControlRow, chrome.controls.controlsMidY * 2)
        return HStack(spacing: 0) {
            Spacer(minLength: 0)
            SidebarToggleButton(sidebarVisible: true, action: chrome.toggleSidebar)
                .padding(.trailing, 10)
        }
        .frame(height: height)
        .background(WindowDragArea())
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(Palette.textTertiary)
                .accessibilityHidden(true)
            TextField(L10n.t(.navSearchPlaceholder), text: $query)
                .textFieldStyle(.plain)
                .font(.callout)
                // Return opens the first match, so search is a way to get
                // somewhere rather than only a way to hide rows.
                .onSubmit {
                    if let first = visibleGroups.first?.entries.first {
                        navigation.select(first.surface.route)
                    }
                }
                .accessibilityLabel(L10n.t(.navSearchLabel))
                .accessibilityIdentifier("sidebar-search")
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Palette.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.t(.navSearchClear))
                .accessibilityIdentifier("sidebar-search-clear")
            }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: Metrics.searchHeight)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.field))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.cardBorder, lineWidth: 1))
    }

    /// Each section heading is a real heading element with a stable identity,
    /// so the groups have names in the accessibility outline and a runtime check
    /// can find them. The label, trait and identity modify the `Text` in place.
    private func sectionHeader(_ key: L10nKey) -> some View {
        let title = L10n.t(key)
        // The trailing component of `nav.sectionDirect`, so the runtime identity
        // cannot drift from the key that supplies the words.
        let id = key.rawValue.split(separator: ".").last.map(String.init) ?? key.rawValue
        return Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 20)
            .padding(.bottom, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("sidebar-\(id)")
    }

    /// A 28pt row: glyph and title, violet with white text when selected.
    ///
    /// Clicks go through `navigation.select(_:)`, so every selection change —
    /// user, deep link or incoming session — takes the same one-assignment path
    /// the routing contract is stated in terms of. A destination with no row of
    /// its own (Open a link) highlights nothing, which is the truthful answer.
    private func row(_ entry: Entry) -> some View {
        let surface = entry.surface
        let title = entry.title
        let subtitle = entry.subtitle
        let selected = navigation.selection.macSurface == surface
        let live = hasLiveSession(surface)
        return Button {
            navigation.select(surface.route)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: SidebarGlyph.symbol(for: surface))
                    .font(.body)
                    .frame(width: 16)
                    .foregroundStyle(selected ? Color.white : Palette.text)
                Text(title)
                    .font(.body.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.white : Palette.text)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if live {
                    // The words are on the row's own accessibility label; the
                    // symbol is the visible carrier and the tint the third.
                    Image(systemName: liveSessionSymbol)
                        .foregroundStyle(selected ? Color.white : Palette.actionLabel)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, Metrics.sidebarInset)
            // A FLOOR rather than a fixed height: a longer locale or a larger
            // text size wraps to two lines instead of clipping.
            .frame(minHeight: Metrics.sidebarRowHeight)
            .background(
                RoundedRectangle(cornerRadius: Metrics.sidebarRowCorner)
                    .fill(selected ? Palette.action
                          : hovered == surface ? Palette.rowHover : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hovered = surface } else if hovered == surface { hovered = nil }
        }
        // The purpose sentence, kept where a pointer and VoiceOver can reach it.
        .help(subtitle)
        .accessibilityIdentifier("sidebar-\(surface.rawValue)")
        .accessibilityLabel(live
                            ? L10n.detail([title, L10n.t(.navA11yLiveSession)])
                            : title)
        .accessibilityHint(subtitle)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
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
    ///
    /// **Both facts come from the row's OWN module.** A row with no module —
    /// Send a link, Device Inbox, Account — is never marked, which is a `nil`
    /// rather than a `false` written here so a new transfer surface has to
    /// supply a module rather than silently inherit "not running".
    ///
    /// Two rows can be marked at once now, and that is the honest answer: the
    /// modules are independent, so a same-network transfer and a pairing
    /// transfer really can both be running.
    private func hasLiveSession(_ surface: MacSurface) -> Bool {
        guard let module = modules.module(for: surface.route) else { return false }
        return module.presence.announcesRunningTransfer(surface.route,
                                                        sessionIsBusy: module.isBusy)
    }
}

/// The reference's sidebar glyphs, as SF Symbols.
///
/// Presentation only: `MacSurface.symbol` stays the shared answer for every
/// other place a surface is drawn.
enum SidebarGlyph {
    // nonlocalized: SF Symbol names
    static func symbol(for surface: MacSurface) -> String {
        switch surface {
        case .lanTransfer:          return "smallcircle.filled.circle"
        case .crossNetworkTransfer: return "number"
        case .storedSend:           return "link"
        case .storedReceive:        return "arrow.down.circle"
        case .deviceInbox:          return "tray.and.arrow.down"
        case .account:              return "person.crop.circle"
        }
    }
}
