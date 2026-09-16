import RelayiumAppKit
import SwiftUI

/// The route a transfer takes, drawn as the three places it passes through.
///
/// It may not say more than the model knows, and it may not say it with motion.
/// Every stop comes from `PathRailPresentation`, a tick appears only for a step
/// that was actually `.reached`, and the state a stop claims is also said in
/// words rather than in a private vocabulary for VoiceOver. It draws a rule
/// rather than an arrow, so it mirrors with the `HStack` in a right-to-left
/// layout instead of pointing the wrong way, and it never animates — its
/// meaning survives a still screen, a screenshot and a motion-sensitive reader
/// identically.
struct PathRail: View {
    let stops: [PathStop]

    private let badge: CGFloat = 28

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                if index > 0 {
                    connector(before: stop)
                }
                stopColumn(stop)
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(PathRailPresentation.routeLabel())
        .accessibilityIdentifier("path-rail")
    }

    private func stopColumn(_ stop: PathStop) -> some View {
        VStack(alignment: .leading, spacing: Metrics.caption) {
            marker(stop)
            Text(stop.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.text)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = stop.detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 168, alignment: .leading)
        // A stop says what it IS as well as what it says: collapsing the column
        // into one element leaves it with words and no role, which the system
        // audit reports as `Unknown role`. Descriptive text — no action, no
        // value to change, nothing to focus.
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityLabel(stop.detail.map { L10n.detail([stop.title, $0]) } ?? stop.title)
        .accessibilityValue(stop.progress == .reached ? L10n.t(.commonDone) : "")
    }

    /// A rounded chip rather than a circle: it is the reference's node, and it
    /// reads as a place rather than as a radio button next to a roster of them.
    private func marker(_ stop: PathStop) -> some View {
        let reached = stop.progress == .reached
        let current = stop.progress == .current
        return ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(reached ? Palette.action
                      : current ? Palette.actionSurface : Palette.chip)
            if reached {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.white)
            } else {
                Image(systemName: stop.symbol)
                    .font(.callout)
                    .foregroundStyle(current ? Palette.actionLabel : Palette.textSecondary)
            }
        }
        .frame(width: badge, height: badge)
        .accessibilityHidden(true)
    }

    private func connector(before stop: PathStop) -> some View {
        RailRule()
            .stroke(stop.progress == .reached ? Palette.actionLabel : Palette.hairline,
                    style: StrokeStyle(lineWidth: 2,
                                       lineCap: .round,
                                       dash: stop.progress == .reached ? [] : [2, 4]))
            .frame(height: 2)
            .frame(minWidth: Metrics.inner, maxWidth: .infinity)
            .padding(.top, badge / 2)
            .padding(.horizontal, Metrics.tight)
            .accessibilityHidden(true)
    }

    private struct RailRule: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}
