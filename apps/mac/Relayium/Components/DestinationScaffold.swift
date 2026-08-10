import SwiftUI

/// The frame every destination is built in: padding, a reading measure, and the
/// window's title — with the body deliberately starting at the first thing the
/// destination actually has to say.
///
/// ## No page heading, on any browseable destination
///
/// Each screen used to open with its own `largeTitle` and a one-line subtitle,
/// and both were a verbatim second printing of the sidebar row that had just
/// been clicked: the same name, the same sentence, three lines of the window's
/// height, above every screen, forever. On a Mac the sidebar IS the title bar
/// for the detail column — it is on screen at the same time, permanently, with
/// the selected row highlighted — so a heading that repeats it tells the user
/// nothing they are not already looking at.
///
/// So the sidebar is the single browseable source of a destination's name and
/// its compact explanation (and, being the row's `accessibilityHint`, its
/// spoken one), `navigationTitle` keeps naming the window for Mission Control,
/// window menus and VoiceOver's window chrome, and the content-specific labels
/// inside a destination — `SectionCard` titles, form section headers — stay
/// exactly as they were. They say what a *part* of a screen is, which the
/// sidebar never claimed to.
///
/// The 720pt cap is a reading measure, not a compatibility floor: the gate
/// explanations and the verification copy run to several lines, and prose set at
/// a thousand points is unreadable. A destination with structured data that
/// genuinely wants the rest of the width — a device roster, a file list — opts
/// out and constrains only its prose locally.
struct DestinationScaffold<Content: View>: View {
    /// The window's title. Rendered by `navigationTitle` only — never inside the
    /// content — which is the whole of the rule above.
    let title: String
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
         contentMaxWidth: CGFloat? = 720,
         scrolls: Bool = true,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.contentMaxWidth = contentMaxWidth
        self.scrolls = scrolls
        self.content = content
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
                    VStack(alignment: .leading, spacing: 20) {
                        measuredContent
                    }
                    .padding(24)
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
                GeometryReader { proxy in
                    // No padding in this mode: a grouped `Form` already insets
                    // its own sections, and padding it again would leave the one
                    // non-scrolling destination visibly narrower than the rest.
                    measuredContent
                        .frame(width: proxy.size.width, height: proxy.size.height,
                               alignment: .topLeading)
                }
            }
        }
        .navigationTitle(title)
    }
}
