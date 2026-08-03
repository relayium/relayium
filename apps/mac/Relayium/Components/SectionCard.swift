import SwiftUI

/// The app's only container chrome.
///
/// One card style, used everywhere, is what makes hierarchy readable without any
/// new colour or border vocabulary: before this the deepest grouping the app had
/// was `Text(...).font(.headline)` followed by a `Divider`.
///
/// `children: .contain` with the title as label is the pattern `NearbyPane`
/// already uses: VoiceOver announces the group's name once and then navigates
/// into it, instead of reading every control as a peer of everything else on the
/// screen.
struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}
