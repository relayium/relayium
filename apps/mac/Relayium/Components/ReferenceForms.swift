import SwiftUI

/// The small pieces every non-transfer screen is built from, so Account, the
/// stored-link screens, the Device Inbox and Settings use the accepted
/// reference vocabulary without each redrawing it.

/// A glyph on the reference's soft violet chip — the device chip of the LAN
/// roster, for any row that names a thing rather than a setting.
struct GlyphChip: View {
    let symbol: String
    var size: CGFloat = Metrics.deviceChip

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 9)
                .fill(Palette.actionSurface)
            Image(systemName: symbol)
                .font(.callout)
                .foregroundStyle(Palette.actionLabel)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A short word on a chip: a plan state, "This Mac", a billing cycle. Never
/// the only carrier of a state the user acts on.
struct TagChip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 7)
            .frame(minHeight: 18)
            .background(Capsule().fill(Palette.chip))
    }
}

/// The line under a row's name, and a group's own explanatory sentence.
struct SupportingText: View {
    let text: String
    var emphasis: Emphasis = .tertiary

    enum Emphasis { case secondary, tertiary }

    init(_ text: String, emphasis: Emphasis = .tertiary) {
        self.text = text
        self.emphasis = emphasis
    }

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(emphasis == .secondary ? Palette.textSecondary : Palette.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A value a person copies, compares or runs — a stored link, a command — set
/// in a field-coloured box, monospaced and selectable, never truncated.
struct CodeBlock: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout.monospaced())
            .foregroundStyle(Palette.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Palette.field))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Palette.hairline, lineWidth: 1))
    }
}

/// A small window's page: the reference's content colour behind a stack of
/// cards, at the window's own insets, scrolling inside whatever bounded size
/// its window gives it. The Settings tabs are built on it.
///
/// The scroll view is what keeps the last action reachable. The window has a
/// fixed size so switching tabs does not resize it; content taller than that —
/// a long translation, a large text size, a login-item remedy — scrolls rather
/// than being clipped or pushing the window past the screen.
struct ReferencePage<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.section) {
                content()
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Palette.pageBackground)
        .tint(Palette.action)
    }
}
