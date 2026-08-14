import RelayiumAppKit
import SwiftUI

/// **Origin → encrypted middle → destination, drawn once and true everywhere.**
///
/// The one shared visual signature these screens have. It is also the easiest
/// thing in the app to make dishonest, so the rules are in the type that feeds
/// it (`PathRailPresentation`) and enforced here:
///
///  - **A stop with no `progress` claims nothing.** Most rails are standing
///    routes rather than tasks with a position, and those render as plain
///    outlines with no tick and no "current" marker anywhere.
///  - **Nothing that has not finished is drawn as finished.** `reached` is the
///    only state that gets a checkmark, and `PathRailPresentation` sets it only
///    from a model that has published completion.
///  - **No animation, at all.** Not "reduced when Reduce Motion is on" — none.
///    A rail whose meaning lives in a moving dash is a rail that means nothing
///    on a still screen, in a screenshot, or to somebody who has asked the
///    system to stop moving things. State is carried by shape (filled versus
///    outline, solid versus dashed) and by the words under each stop, both of
///    which survive with motion off, colour filters on, and Increase Contrast.
///  - **No direction glyph.** The connector is a rule, not an arrow, so the rail
///    mirrors correctly in Arabic with the `HStack` and nothing points the wrong
///    way. Order is the direction.
struct PathRail: View {
    let stops: [PathStop]

    /// The badge's diameter. The connector is centred on it, so the two numbers
    /// are related rather than separately tuned.
    private let badge: CGFloat = 22

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
        // One group. Read stop by stop, three fragments announce as three
        // unrelated labels between the controls above and below them.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(PathRailPresentation.routeLabel())
        .accessibilityIdentifier("path-rail")
    }

    // MARK: - one stop

    private func stopColumn(_ stop: PathStop) -> some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            marker(stop)
            Text(stop.title)
                .font(.caption.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            if let detail = stop.detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 168, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stop.detail.map { L10n.detail([stop.title, $0]) } ?? stop.title)
        // The only state said in words, and it is an existing one. `current` and
        // `pending` are deliberately silent: the surface that owns a rail with
        // real progress already states what it is doing in a sentence, and a
        // second vocabulary for the same fact is how the two drift apart.
        .accessibilityValue(stop.progress == .reached ? L10n.t(.commonDone) : "")
    }

    /// Filled and ticked when it is finished, ringed while it is happening,
    /// outlined when it is not — and plainly outlined, with no state at all,
    /// when the rail is a route rather than a task.
    private func marker(_ stop: PathStop) -> some View {
        ZStack {
            Circle()
                .fill(stop.progress == .current ? Palette.actionSurface : Color.clear)
            Circle()
                .strokeBorder(stop.progress == nil || stop.progress == .pending
                              ? Palette.hairline : Palette.action,
                              lineWidth: stop.progress == .current ? 2 : 1)
            if stop.progress == .reached {
                Circle().fill(Palette.action)
                // nonlocalized: SF Symbol name
                Image(systemName: "checkmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color(nsColor: .controlBackgroundColor))
            } else {
                Image(systemName: stop.symbol)
                    .font(.caption)
                    .foregroundStyle(stop.progress == .current ? Palette.action
                                     : Color.secondary)
            }
        }
        .frame(width: badge, height: badge)
        .accessibilityHidden(true)
    }

    // MARK: - between two stops

    /// Solid once the path up to here has actually been travelled, dashed
    /// otherwise — including for every stop of a rail that makes no progress
    /// claim, which is what stops a standing route reading as a stalled task.
    private func connector(before stop: PathStop) -> some View {
        RailRule(dashed: stop.progress != .reached && stop.progress != .current)
            .stroke(stop.progress == .reached ? Palette.action : Palette.hairline,
                    style: StrokeStyle(lineWidth: 1,
                                       dash: stop.progress == .reached ? [] : [2, 3]))
            .frame(height: 1)
            .frame(minWidth: Metrics.inner, maxWidth: .infinity)
            .padding(.top, badge / 2)
            .padding(.horizontal, Metrics.tight)
            .accessibilityHidden(true)
    }

    /// A horizontal rule as a `Shape`, so the dash pattern is a stroke style
    /// rather than a row of hand-placed dots that would not mirror in Arabic.
    private struct RailRule: Shape {
        let dashed: Bool

        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}
