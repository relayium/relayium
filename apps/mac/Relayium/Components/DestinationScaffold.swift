import SwiftUI
import RelayiumAppKit

/// The frame every destination is built in: a unified toolbar, a gutter, one
/// centred column, and the window's title.
///
/// ## One column, 660pt, centred
///
/// A wider window does not set the content wider: the column is capped at
/// `Metrics.readingMeasure` and centred in whatever width the detail pane has.
/// A destination whose content does its own insetting — a grouped `Form` — asks
/// for `fillsWidth` and centres itself.
///
/// ## The toolbar says the name, what it is, and what is happening
///
/// The reference's 44pt toolbar carries the destination's title, a short
/// subtitle and, where the destination has live state, a status chip. That
/// replaces the separate purpose line the page used to open with: the name is
/// said once, in the toolbar, and the page begins with its first group.
/// `navigationTitle` still names the window for Mission Control, the Window
/// menu and VoiceOver; the window just does not draw it a second time.
struct DestinationScaffold<Content: View>: View {
    /// The window's title, and the toolbar's.
    let title: String
    /// Which screen this is.
    let surface: MacSurface
    /// The toolbar's short subtitle.
    let subtitle: String?
    /// The destination's live state at a moment, or nil where it has none worth
    /// a chip. A function of time so a deadline can change it without the page
    /// having to re-render.
    let status: ((Date) -> ToolbarStatus?)?
    /// Whether `status` depends on the clock and is re-read every second.
    let statusFollowsClock: Bool
    /// Whether the content lays out its own column rather than sitting in this
    /// one. True for the grouped `Form`, which insets and centres itself.
    let fillsWidth: Bool
    /// Whether the scaffold supplies the scroll view.
    ///
    /// True for every destination whose content is a stack of groups. The
    /// Device Inbox renders a grouped `Form`, which is already a scroll view:
    /// nesting it inside another gives two scrollers over one list of sections.
    let scrolls: Bool
    @ViewBuilder let content: () -> Content

    @Environment(\.shellChrome) private var chrome

    init(title: String,
         surface: MacSurface,
         subtitle: String? = nil,
         status: ((Date) -> ToolbarStatus?)? = nil,
         statusFollowsClock: Bool = false,
         fillsWidth: Bool = false,
         scrolls: Bool = true,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.surface = surface
        self.subtitle = subtitle
        self.status = status
        self.statusFollowsClock = statusFollowsClock
        self.fillsWidth = fillsWidth
        self.scrolls = scrolls
        self.content = content
    }

    private var columnWidth: CGFloat { fillsWidth ? .infinity : Metrics.readingMeasure }

    /// The destination's own content at the column measure.
    private var measuredContent: some View {
        content()
            .frame(maxWidth: columnWidth, alignment: .leading)
    }

    /// Tall enough for the reference, and never shorter than the title bar the
    /// traffic lights sit in.
    private var toolbarHeight: CGFloat {
        max(Metrics.toolbarHeight, chrome.controls.controlsMidY * 2)
    }

    private var toolbar: some View {
        HStack(alignment: .center, spacing: 10) {
            if !chrome.sidebarVisible {
                // The traffic lights are over this corner now, and the way back
                // to the sidebar has to be where the sidebar went.
                Color.clear
                    .frame(width: max(Metrics.trafficLightsWidth - Metrics.page,
                                      chrome.controls.controlsMaxX + 8 - Metrics.page),
                           height: 1)
                    .accessibilityHidden(true)
                SidebarToggleButton(sidebarVisible: false, action: chrome.toggleSidebar)
            }
            // The title and its subtitle stay on one baseline and give way
            // before the status chip does: the chip is live state, the
            // subtitle is a description.
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                    .layoutPriority(1)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("destination-title")
                if let subtitle {
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(Palette.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(subtitle)
                        .accessibilityIdentifier("destination-subtitle")
                }
            }
            Spacer(minLength: Metrics.tight)
            if let status {
                if statusFollowsClock {
                    TimelineView(.periodic(from: .now, by: 1)) { tick in
                        chip(status(tick.date))
                    }
                } else {
                    chip(status(Date()))
                }
            }
        }
        .padding(.leading, Metrics.page)
        .padding(.trailing, 18)
        .frame(height: toolbarHeight)
        .frame(maxWidth: .infinity)
        .background(WindowDragArea())
        .background(Palette.toolbar)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Palette.hairline)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func chip(_ status: ToolbarStatus?) -> some View {
        if let status {
            StatusChip(label: status.label, tone: status.tone)
        }
    }

    var body: some View {
        Group {
            if scrolls {
                VStack(spacing: 0) {
                    toolbar
                    ScrollView {
                        // The `VStack` is load-bearing: a destination's body is
                        // a `ViewBuilder`, and most of them hand over several
                        // views, which arrive as a `TupleView` with no layout
                        // of its own.
                        VStack(alignment: .leading, spacing: Metrics.section) {
                            measuredContent
                        }
                        .padding(.horizontal, Metrics.page)
                        .padding(.top, Metrics.pageTop)
                        .padding(.bottom, Metrics.pageBottom)
                        .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
            } else {
                // **An exact height, and the destination is unusable without
                // it.** A grouped `Form` with no height constraint was measured
                // laying the detail column out 1326pt tall inside 560pt of
                // window, and SwiftUI centres an overflowing child, so its top
                // sat above the window. `maxHeight: .infinity` fixes nothing:
                // it OFFERS a height and reports whatever the child insisted on.
                // An exact frame is a size the child is GIVEN.
                //
                // Wrapping the reader in a `VStack` is the repair that does not
                // work: macOS 26 re-measures the grouped Form at its intrinsic
                // height and its first sections can disappear. So the toolbar
                // is a safe-area inset inside the same exact frame, and its
                // height — which the scaffold chose, so nothing has to measure
                // it — is subtracted from that frame. `safeAreaInset` reports a
                // size that INCLUDES the inset, and a Form framed at the full
                // height would draw its last lines under the window's edge.
                //
                // `DeviceInboxUITests.testTheFullHelpSectionIsReadableUnderTheLongestContent`
                // is the runtime guard for all of it.
                GeometryReader { proxy in
                    measuredContent
                        .frame(width: proxy.size.width,
                               height: max(proxy.size.height - toolbarHeight, 0),
                               alignment: .topLeading)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            toolbar
                        }
                }
            }
        }
        .navigationTitle(title)
    }
}
