import SwiftUI

/// The frame every destination is built in: a title, an optional subtitle, and a
/// scrolling body.
///
/// It owns the padding, the reading measure and the `navigationTitle` so five
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
    @ViewBuilder let content: () -> Content

    init(title: String,
         subtitle: String? = nil,
         contentMaxWidth: CGFloat? = 720,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.contentMaxWidth = contentMaxWidth
        self.content = content
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
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
                content()
                    .frame(maxWidth: contentMaxWidth ?? .infinity, alignment: .leading)
            }
            .padding(24)
            // Leading rather than centred: the sidebar is on the leading edge,
            // and a measure that drifts to the middle of a wide window reads as
            // a web page rather than as a Mac app.
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(title)
    }
}
