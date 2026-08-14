import SwiftUI

/// **The second and last level of hierarchy: a titled group with no chrome.**
///
/// `SectionCard` is level one and the app's only container background. Inside a
/// card, the parts of one task were previously separated by bare `Divider()`s
/// with a `subheadline` above some of them and nothing above others — which
/// reads as one flat box with lines in it, and gives a reader no way to tell a
/// new sub-task from a paragraph break.
///
/// The obvious repair is a second card, and it is the wrong one: a card inside a
/// card is the box-in-a-box this round exists to remove. So the second level has
/// no background at all. It is a name, a hairline rule above it, and its
/// content — which is exactly what the dividers were reaching for, with the name
/// attached to the group rather than floating beside it.
///
/// `children: .contain` with the title as the label is the same pattern
/// `SectionCard` uses: VoiceOver announces the group once and navigates into it,
/// instead of reading its controls as peers of everything else on the screen.
struct OpenSection<Content: View>: View {
    let title: String
    /// The rule above the title. False for the first group in a card, where a
    /// line immediately under the card's own heading is a line about nothing.
    let showsRule: Bool
    @ViewBuilder let content: () -> Content

    init(title: String, showsRule: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.showsRule = showsRule
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            if showsRule {
                Divider()
                    .padding(.bottom, Metrics.hairline)
            }
            Text(title)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}
