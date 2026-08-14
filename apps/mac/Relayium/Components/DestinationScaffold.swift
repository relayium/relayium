import SwiftUI

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
/// destinations compactly and keeps each complete sentence as the row's
/// `accessibilityHint` and pointer tooltip; `DetailHeader` renders it once, for
/// the destination that is actually open, in a column with the width to set it.
/// `navigationTitle` still names the window for Mission Control, window menus
/// and VoiceOver's window chrome, and the labels inside a destination —
/// `SectionCard` titles, `OpenSection` titles, form section headers — say what a
/// *part* of a screen is, which neither the sidebar nor this header claims to.
///
/// The header is `title3`, never `largeTitle`: a label on a screen rather than a
/// banner above one, which is what keeps the 560pt floor usable.
///
/// The 720pt cap is a reading measure, not a compatibility floor: the gate
/// explanations and the verification copy run to several lines, and prose set at
/// a thousand points is unreadable. A destination with structured data that
/// genuinely wants the rest of the width — a device roster, a file list — opts
/// out and constrains only its prose locally.
struct DestinationScaffold<Content: View>: View {
    /// The window's title, and the header's. `navigationTitle` is what makes it
    /// the window's; `DetailHeader` is what puts it on the screen.
    let title: String
    /// The destination's SF Symbol — the same one its sidebar row carries, so
    /// the row and the screen it opens are visibly the same thing.
    let symbol: String?
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
         symbol: String? = nil,
         purpose: String? = nil,
         contentMaxWidth: CGFloat? = Metrics.readingMeasure,
         scrolls: Bool = true,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.symbol = symbol
        self.purpose = purpose
        self.contentMaxWidth = contentMaxWidth
        self.scrolls = scrolls
        self.content = content
    }

    /// Rendered only where a destination supplied a symbol. The one screen that
    /// does not is the deep-link-only surface, which has no sidebar row to be
    /// the same thing as.
    @ViewBuilder private var detailHeader: some View {
        if let symbol {
            DetailHeader(symbol: symbol, title: title, purpose: purpose)
                .frame(maxWidth: contentMaxWidth ?? .infinity, alignment: .leading)
        }
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
