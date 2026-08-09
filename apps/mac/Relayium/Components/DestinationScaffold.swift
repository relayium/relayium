import SwiftUI

/// The frame every destination is built in: a title, an optional subtitle, and a
/// body that usually scrolls.
///
/// It owns the padding, the reading measure and the `navigationTitle` so six
/// screens cannot drift apart — the failure this round exists to correct was
/// five surfaces each inventing their own spacing inside a 380pt window.
///
/// The 720pt cap is a reading measure, not a compatibility floor: the gate
/// explanations and the verification copy run to several lines, and prose set at
/// a thousand points is unreadable. A destination with structured data that
/// genuinely wants the rest of the width — a device roster, a file list — opts
/// out and constrains only its prose locally.
struct DestinationScaffold<Content: View>: View {
    let title: String
    let subtitle: String?
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
    /// one has nothing to scroll and swallows the gesture at the edges. The
    /// heading is laid out identically either way, so the two modes differ in
    /// exactly one thing.
    let scrolls: Bool
    @ViewBuilder let content: () -> Content

    init(title: String,
         subtitle: String? = nil,
         contentMaxWidth: CGFloat? = 720,
         scrolls: Bool = true,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.contentMaxWidth = contentMaxWidth
        self.scrolls = scrolls
        self.content = content
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.largeTitle)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 720, alignment: .leading)
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
                    VStack(alignment: .leading, spacing: 20) {
                        heading
                        measuredContent
                    }
                    .padding(24)
                    // Leading rather than centred: the sidebar is on the leading
                    // edge, and a measure that drifts to the middle of a wide
                    // window reads as a web page rather than as a Mac app.
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                // **Two deliberate pieces, and the destination is unusable
                // without either.** What shipped in the first draft of this mode
                // was `VStack { heading; Form }` with no height constraint, and
                // it was measured on macOS 26.6 at the shipped 860x560 minimum
                // to lay the detail column out 1326pt tall inside 560pt of
                // window. SwiftUI centres an overflowing child, so the top 251pt
                // — the heading, the first section header, and the sign-in,
                // create-account and Open Account buttons under it — sat ABOVE
                // the top of the window: not visible, and not clickable. The
                // primary account actions of a destination that is deliberately
                // shown signed out were the part that fell off.
                //
                // `GeometryReader` + an exact `.frame(height:)` is what bounds
                // it. A grouped `Form` was measured to IGNORE an inexact
                // proposal: `maxHeight: .infinity` around the stack changed the
                // reported height by nothing at all, because that modifier
                // offers a height and then reports whatever the child insisted
                // on. An exact frame is a size the child is given rather than
                // offered, and the same `Form` then reported 455pt and scrolled
                // its own overflow like any other scroll view.
                //
                // The heading is a safe-area INSET rather than a stack row for
                // the other half of the same reason: it leaves the content
                // itself at the root, so this destination is one scroll view
                // exactly like the other five instead of a stack wrapped around
                // one. It also pins the title while the sections scroll under
                // it, which is what a settings-shaped Mac screen does anyway.
                GeometryReader { proxy in
                    measuredContent
                        .safeAreaInset(edge: .top, spacing: 12) {
                            // The padding goes on the heading alone. The content
                            // owns its own insets in this mode — a grouped `Form`
                            // already insets its sections — and padding it again
                            // would leave the one non-scrolling destination
                            // visibly narrower than the other five.
                            heading
                                .padding(.horizontal, 24)
                                .padding(.top, 24)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(width: proxy.size.width, height: proxy.size.height,
                               alignment: .topLeading)
                }
            }
        }
        .navigationTitle(title)
    }
}
