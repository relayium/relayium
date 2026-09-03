import RelayiumAppKit
import SwiftUI

/// **Origin → encrypted middle → destination, drawn once and true everywhere.**
///
/// The one shared visual signature these screens have, and the iOS half of the
/// rail the Mac already ships. It is also the easiest thing in the app to make
/// dishonest, so the rules are in the type that feeds it
/// (`PathRailPresentation`, in the package, where a test drives it against real
/// model states) and enforced here:
///
///  - **A stop with no `progress` claims nothing.** The nearby rail is a
///    standing route rather than a task with a position, and it renders as
///    plain outlines with no tick and no current marker anywhere.
///  - **Nothing unfinished is drawn as finished.** `reached` is the only state
///    that gets a checkmark, and only a model that has published completion
///    sets it.
///  - **No animation, at all.** Not "reduced when Reduce Motion is on" — none.
///    State is carried by shape (filled versus outline, solid versus dashed) and
///    by the word under each stop, both of which survive with motion off, colour
///    filters on and Increase Contrast.
///  - **No direction glyph.** The connector is a rule, not an arrow, so the rail
///    mirrors correctly in Arabic and nothing points the wrong way. Order is the
///    direction.
///
/// ## Why these graphics use `Palette.actionLabel` and not `Palette.action`
///
/// Every marker and connector here is `accessibilityHidden(true)`, and the rule
/// above is why: the state is also in the words. That does NOT make them
/// decoration. A stop's fill is what a sighted reader looks at to see how far a
/// transfer has got, so it is a meaningful non-text graphic and owes 3:1 — and
/// on a real Dark screenshot the accent measured **2.99:1** as a reached stop's
/// fill on `Palette.cardBackground` and **2.70:1** as a current stop's ring and
/// symbol on `Palette.actionSurface`. The label role clears both.
///
/// The one thing here that IS decoration is the checkmark drawn inside a reached
/// stop, which repeats the fill it sits on. It is `Palette.cardBackground` on
/// the label role and measures 7.4:1 in Dark and 6.3:1 in Light anyway, so
/// nothing turned on classifying it.
///
/// ## The one thing it does that the Mac's does not
///
/// It turns. Three columns of caption text across a 375pt iPhone is already the
/// narrowest this can honestly be drawn, and at an accessibility content size
/// those columns are two words wide and eight lines tall — the rail becomes the
/// screen. So above `.xxLarge` the same stops stack, each on its own line, with
/// the connector running down instead of across. Same stops, same rules, same
/// order; only the axis changes, and it changes with the reader's own setting
/// rather than with a device width the phone alone cannot predict.
struct PathRail: View {
    let stops: [PathStop]

    @Environment(\.dynamicTypeSize) private var typeSize

    private var isStacked: Bool { typeSize >= .xxLarge }

    var body: some View {
        Group {
            if isStacked { stacked } else { across }
        }
        // One group. Read stop by stop, three fragments announce as three
        // unrelated labels between the controls above and below them.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(PathRailPresentation.routeLabel())
        .accessibilityIdentifier("path-rail")
    }

    // MARK: - the two axes

    private var across: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                if index > 0 {
                    // A FIXED width, and that is the whole difference from the
                    // Mac's rail. There the connector absorbs the slack and the
                    // columns take their natural width up to a cap, because
                    // there is slack. On a 375pt phone there is none: letting
                    // five elements share the row equally left each column
                    // sixty points, which is where "Encrypted connec-tion"
                    // came from. Pinning the connector gives every point that
                    // is left to the words.
                    connector(before: stop)
                        .frame(width: Metrics.section, height: 1)
                        .padding(.top, Metrics.pathBadge / 2)
                }
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    marker(stop)
                    titles(stop)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenLabel(stop))
                .accessibilityValue(spokenValue(stop))
            }
        }
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                if index > 0 {
                    connector(before: stop)
                        .frame(width: 1, height: Metrics.inner)
                        .padding(.leading, Metrics.pathBadge / 2)
                }
                HStack(alignment: .top, spacing: Metrics.tight) {
                    marker(stop)
                    titles(stop)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenLabel(stop))
                .accessibilityValue(spokenValue(stop))
            }
        }
    }

    // MARK: - one stop

    @ViewBuilder
    private func titles(_ stop: PathStop) -> some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
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
                              ? Palette.hairline : Palette.actionLabel,
                              lineWidth: stop.progress == .current ? 2 : 1)
            if stop.progress == .reached {
                Circle().fill(Palette.actionLabel)
                // nonlocalized: SF Symbol name
                Image(systemName: "checkmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Palette.cardBackground)
            } else {
                // `caption2`, not `caption`: two of these symbols are device
                // pairs and are half again as wide as they are tall, so at the
                // Mac's size they came out of the badge and sat on the word
                // beside them.
                Image(systemName: stop.symbol)
                    .font(.caption2)
                    .foregroundStyle(stop.progress == .current ? Palette.actionLabel
                                     : Color.secondary)
            }
        }
        // Fixed, and deliberately not scaled with Dynamic Type: it is a marker
        // on a rule, not a piece of reading, and a badge that grew with the text
        // would push the stacked rail's connector out of line with it.
        //
        // The cap has to be on the CONTENT as well as the frame. A frame does
        // not clip, so at Accessibility 5 the symbol simply drew straight
        // through the circle and over the word beside it.
        .dynamicTypeSize(...DynamicTypeSize.large)
        .frame(width: Metrics.pathBadge, height: Metrics.pathBadge)
        .accessibilityHidden(true)
    }

    // MARK: - between two stops

    /// Solid once the path up to here has actually been travelled, dashed
    /// otherwise — including for every stop of a rail that makes no progress
    /// claim, which is what stops a standing route reading as a stalled task.
    private func connector(before stop: PathStop) -> some View {
        let travelled = stop.progress == .reached
        return RailRule(vertical: isStacked)
            .stroke(travelled ? Palette.actionLabel : Palette.hairline,
                    style: StrokeStyle(lineWidth: 1, dash: travelled ? [] : [2, 3]))
            .accessibilityHidden(true)
    }

    /// A rule as a `Shape`, so the dash pattern is a stroke style rather than a
    /// row of hand-placed dots that would not mirror in Arabic.
    private struct RailRule: Shape {
        let vertical: Bool

        func path(in rect: CGRect) -> Path {
            var path = Path()
            if vertical {
                path.move(to: CGPoint(x: rect.midX, y: rect.minY))
                path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            } else {
                path.move(to: CGPoint(x: rect.minX, y: rect.midY))
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            }
            return path
        }
    }

    // MARK: - what it says out loud

    private func spokenLabel(_ stop: PathStop) -> String {
        stop.detail.map { L10n.detail([stop.title, $0]) } ?? stop.title
    }

    /// The only state said in words, and it is an existing one. `current` and
    /// `pending` are deliberately silent: the surface that owns a rail with real
    /// progress already states what it is doing in a sentence, and a second
    /// vocabulary for the same fact is how the two drift apart.
    private func spokenValue(_ stop: PathStop) -> String {
        stop.progress == .reached ? L10n.t(.commonDone) : ""
    }
}
