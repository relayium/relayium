import SwiftUI
import RelayiumAppKit

/// The frame every destination is built in: a header, a gutter, one centred
/// column, and the window's title.
///
/// ## One column, 660pt, centred
///
/// A wider window does not set the content wider. That is the first thing that
/// makes a Mac app feel like one rather than like a page in a window, and it is
/// the reference's own rule: the column is capped at `Metrics.readingMeasure`
/// and centred in whatever width the detail pane has. A destination whose
/// content does its own insetting — a grouped `Form` — asks for `fillsWidth`
/// and centres itself.
///
/// ## The name is chrome, and it is said exactly once on screen
///
/// `navigationTitle` names the window for Mission Control, window menus,
/// VoiceOver's window chrome — and, because a `navigationTitle` on the detail
/// column of a `NavigationSplitView` IS the window's title, in the title bar
/// directly above this content. That, plus the highlighted sidebar row, is two
/// statements of the destination's name before any content is drawn, so the
/// header names the destination only where the sidebar does not and
/// `MacSurface.browseable` is the one list that decides which those are.
struct DestinationScaffold<Content: View>: View {
    /// The window's title. `navigationTitle` is what makes it the window's.
    let title: String
    /// Which screen this is. It supplies the SF Symbol, so a row and the screen
    /// it opens cannot be marked differently, and it answers whether the
    /// sidebar already names this destination.
    let surface: MacSurface
    /// The destination's own one sentence, or nil for the deep-link-only screen
    /// that has no sidebar row and therefore no sentence of its own.
    let purpose: String?
    /// Whether the content lays out its own column rather than sitting in this
    /// one. True for the grouped `Form`, which insets and centres itself.
    let fillsWidth: Bool
    /// Whether the scaffold supplies the scroll view.
    ///
    /// True for every destination whose content is a stack of groups, which is
    /// all of them but one. The Device Inbox renders a grouped `Form`, and a
    /// `Form` is already a scroll view: nesting it inside another one gives the
    /// destination two scrollers over one list of sections, where the outer one
    /// has nothing to scroll and swallows the gesture at the edges.
    let scrolls: Bool
    @ViewBuilder let content: () -> Content

    /// How tall the header actually came out, for the non-scrolling arm only.
    ///
    /// Measured rather than assumed: the header is one or two lines depending
    /// on the destination, the rendered language and the user's text size, and
    /// a constant that was right in English would clip the bottom of the page
    /// in a longer locale by exactly the difference.
    @State private var headerHeight: CGFloat = 0

    init(title: String,
         surface: MacSurface,
         purpose: String? = nil,
         fillsWidth: Bool = false,
         scrolls: Bool = true,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.surface = surface
        self.purpose = purpose
        self.fillsWidth = fillsWidth
        self.scrolls = scrolls
        self.content = content
    }

    private var columnWidth: CGFloat { fillsWidth ? .infinity : Metrics.readingMeasure }

    /// The symbol, and the purpose or the name — never both the name and a
    /// sidebar row that already carries it.
    private var detailHeader: some View {
        DetailHeader(symbol: surface.symbol,
                     title: title,
                     purpose: purpose,
                     namesDestination: !surface.isBrowseable)
            .frame(maxWidth: columnWidth, alignment: .leading)
    }

    /// The destination's own content at the column measure.
    private var measuredContent: some View {
        content()
            .frame(maxWidth: columnWidth, alignment: .leading)
    }

    var body: some View {
        Group {
            if scrolls {
                ScrollView {
                    // The `VStack` is load-bearing: a destination's body is a
                    // `ViewBuilder`, and most of them hand over several views,
                    // which arrive as a `TupleView` with no layout of its own.
                    VStack(alignment: .leading, spacing: Metrics.section) {
                        detailHeader
                        measuredContent
                    }
                    .padding(.horizontal, Metrics.page)
                    .padding(.top, Metrics.pageTop)
                    .padding(.bottom, Metrics.pageBottom)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            } else {
                // **An exact height, and the destination is unusable without
                // it.** A grouped `Form` with no height constraint was measured
                // laying the detail column out 1326pt tall inside 560pt of
                // window at the shipped minimum size. SwiftUI centres an
                // overflowing child, so the top of it — the first section header
                // and the sign-in buttons under it — sat ABOVE the top of the
                // window: not visible, and not clickable. `maxHeight: .infinity`
                // fixes nothing: that modifier OFFERS a height and then reports
                // whatever the child insisted on. An exact frame is a size the
                // child is GIVEN, and the same `Form` then scrolled its own
                // overflow like any other scroll view.
                //
                // Wrapping the reader in a `VStack` is the other repair that
                // does not work: macOS 26 then re-measures the grouped Form at
                // its intrinsic height and its first sections — and even the
                // sidebar — can disappear. A safe-area inset reserves the header
                // space inside the same exact frame instead.
                //
                // **The header's height is subtracted from that exact frame.**
                // `safeAreaInset` reports a size that INCLUDES the inset
                // content, so a Form framed at the full height with a header on
                // top composed to `height + header` — which the `GeometryReader`
                // pinned to the top, leaving the bottom of the Form's viewport
                // that many points below the window. The Form scrolled fine; its
                // last lines were drawn underneath the window's edge. Moving the
                // frame outside the inset instead returns the original defect:
                // the Form takes its intrinsic height and does not scroll at
                // all. So the height stays exact and the header is measured.
                //
                // A preference rather than a constant, because the header is one
                // or two lines depending on the language and the user's text
                // size. First layout pass reports zero, which is safe: the page
                // is momentarily the height it had before this fix and is
                // corrected on the pass the measurement triggers.
                //
                // `DeviceInboxUITests.testTheFullHelpSectionIsReadableUnderTheLongestContent`
                // is the runtime guard for all of it.
                GeometryReader { proxy in
                    measuredContent
                        .frame(width: proxy.size.width,
                               height: max(proxy.size.height - headerHeight, 0),
                               alignment: .topLeading)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            detailHeader
                                .padding(.horizontal, Metrics.page)
                                .padding(.vertical, Metrics.inner)
                                // A grouped Form centres its own column in a
                                // wide detail pane. Match that measure so the
                                // header does not cling to the split divider
                                // while every section begins farther in.
                                .frame(maxWidth: Metrics.readingMeasure + Metrics.page * 2,
                                       alignment: .leading)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .background(Palette.pageBackground)
                                // Reported straight out of the inset rather than
                                // through a `PreferenceKey`: a preference set
                                // inside `safeAreaInset`'s content does NOT
                                // reach an `onPreferenceChange` attached outside
                                // it, so the reader fired never and the scroll
                                // view stayed exactly one header too tall.
                                // `onAppear`/`onChange` run after layout, so
                                // this writes state between passes.
                                .background(
                                    GeometryReader { header in
                                        Color.clear
                                            .onAppear { headerHeight = header.size.height }
                                            .onChange(of: header.size.height) { measured in
                                                headerHeight = measured
                                            }
                                    })
                        }
                }
            }
        }
        .navigationTitle(title)
    }
}
