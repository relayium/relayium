import SwiftUI
import RelayiumAppKit

/// The frame every destination is built in: a header, padding, a reading
/// measure, and the window's title.
///
/// ## One explanation, and it is here rather than in the sidebar
///
/// Each screen used to open with its own `largeTitle` and a caption copied
/// verbatim from the sidebar row that had just been clicked, which told a reader
/// looking at the highlighted row nothing. Removing both was right and left the
/// opposite defect behind: five long explanatory sentences stacked in a 208pt
/// column, up to three lines each, and in the longest locales the sidebar itself
/// stopped fitting the supported 560pt window height.
///
/// So the sentence moved instead of coming back. The sidebar names the five
/// browseable destinations compactly and keeps each complete sentence as the
/// row's `accessibilityHint` and pointer tooltip; `DetailHeader` renders it
/// once, for the destination that is actually open, in a column with the width
/// to set it.
///
/// ## The name is chrome, and it is said exactly once on screen
///
/// `navigationTitle` names the window for Mission Control, window menus,
/// VoiceOver's window chrome — and, because a `navigationTitle` on the detail
/// column of a `NavigationSplitView` IS the window's title, in the title bar
/// directly above this content. That, plus the highlighted sidebar row, is two
/// statements of the destination's name before any content is drawn; a heading
/// repeating it was a third, and it cost a line of a 560pt window.
///
/// So the header names the destination only where the sidebar does not, and
/// `MacSurface.browseable` is the one list that decides which those are — which
/// is why this takes the surface rather than a loose symbol. The labels inside a
/// destination — `SectionCard` titles, `OpenSection` titles, form section
/// headers — say what a *part* of a screen is, which is a different claim from
/// either.
///
/// The 720pt cap is a reading measure, not a compatibility floor: the gate
/// explanations and the verification copy run to several lines, and prose set at
/// a thousand points is unreadable. A destination with structured data that
/// genuinely wants the rest of the width — a device roster, a file list — opts
/// out and constrains only its prose locally.
struct DestinationScaffold<Content: View>: View {
    /// The window's title. `navigationTitle` is what makes it the window's, and
    /// on a browseable destination that — with the sidebar row — is the whole of
    /// where the name appears.
    let title: String
    /// Which screen this is.
    ///
    /// It supplies the SF Symbol, so a row and the screen it opens cannot be
    /// marked differently, and it answers whether the sidebar already names this
    /// destination — the one question that decides whether `DetailHeader` prints
    /// the title or only the purpose.
    let surface: MacSurface
    /// The destination's own one sentence, or nil for the deep-link-only screen
    /// that has no sidebar row and therefore no sentence of its own.
    let purpose: String?
    /// Most destinations are prose/forms and stay at the reading measure. A
    /// roster or account list benefits from the remaining window width, so its
    /// destination opts out and constrains only its prose locally.
    let contentMaxWidth: CGFloat?
    /// Whether the scaffold supplies the scroll view.
    ///
    /// True for every destination whose content is a stack of cards and prose,
    /// which is all of them but one. The Device Inbox renders a grouped `Form`,
    /// and a `Form` is already a scroll view: nesting it inside another one gives
    /// the destination two scrollers over one list of sections, where the outer
    /// one has nothing to scroll and swallows the gesture at the edges.
    let scrolls: Bool
    @ViewBuilder let content: () -> Content

    init(title: String,
         surface: MacSurface,
         purpose: String? = nil,
         contentMaxWidth: CGFloat? = Metrics.readingMeasure,
         scrolls: Bool = true,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.surface = surface
        self.purpose = purpose
        self.contentMaxWidth = contentMaxWidth
        self.scrolls = scrolls
        self.content = content
    }

    /// The symbol, and the purpose or the name — never both the name and a
    /// sidebar row that already carries it. `isBrowseable` is the single list
    /// that decides, so this cannot drift from what the sidebar actually offers.
    private var detailHeader: some View {
        DetailHeader(symbol: surface.symbol,
                     title: title,
                     purpose: purpose,
                     namesDestination: !surface.isBrowseable)
            .frame(maxWidth: contentMaxWidth ?? .infinity, alignment: .leading)
    }

    /// The destination's own content at whichever measure it asked for.
    private var measuredContent: some View {
        content()
            .frame(maxWidth: contentMaxWidth ?? .infinity, alignment: .leading)
    }

    var body: some View {
        Group {
            if scrolls {
                ScrollView {
                    // The `VStack` is load-bearing even with the heading gone:
                    // a destination's body is a `ViewBuilder`, and most of them
                    // hand over several views (a card and a note, a pane and the
                    // verification setting). Those arrive as a `TupleView`,
                    // which has no layout of its own — the stack is what puts
                    // them in a column with one spacing rule instead of leaving
                    // the arrangement to whatever encloses them.
                    VStack(alignment: .leading, spacing: Metrics.section) {
                        detailHeader
                        measuredContent
                    }
                    .padding(Metrics.page)
                    // Leading rather than centred: the sidebar is on the
                    // leading edge, and a measure that drifts to the middle
                    // of a wide window reads as a web page rather than as a
                    // Mac app.
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                // **An exact height, and the destination is unusable without
                // it.** A grouped `Form` with no height constraint was measured
                // on macOS 26.6 to lay the detail column out 1326pt tall inside
                // 560pt of window at the shipped minimum size. SwiftUI centres
                // an overflowing child, so the top of it — the first section
                // header and the sign-in, create-account and Open Account
                // buttons under it — sat ABOVE the top of the window: not
                // visible, and not clickable.
                //
                // `maxHeight: .infinity` fixes nothing here: that modifier
                // OFFERS a height and then reports whatever the child insisted
                // on, and the reported height changed by zero. An exact frame is
                // a size the child is given rather than offered, and the same
                // `Form` then reported 455pt and scrolled its own overflow like
                // any other scroll view.
                // Preserve the exact-height Form fix. Wrapping the reader in a
                // VStack makes macOS 26 re-measure the grouped Form at its
                // intrinsic height: its first sections and even the sidebar can
                // disappear. A safe-area inset reserves header space inside the
                // same exact frame without changing the child's proposed size.
                GeometryReader { proxy in
                    measuredContent
                        .frame(width: proxy.size.width, height: proxy.size.height,
                               alignment: .topLeading)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            detailHeader
                                .padding(.horizontal, Metrics.page)
                                .padding(.vertical, Metrics.inner)
                                // A grouped Form centres its own roughly 720pt
                                // column in a wide detail pane. Match that
                                // measure here so the header does not cling to
                                // the split divider while every section begins a
                                // hundred points farther in.
                                .frame(maxWidth: Metrics.readingMeasure + Metrics.page * 2,
                                       alignment: .leading)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .background(Color(nsColor: .windowBackgroundColor))
                        }
                }
            }
        }
        .navigationTitle(title)
    }
}
