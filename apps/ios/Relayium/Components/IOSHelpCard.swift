import SwiftUI
import RelayiumAppKit

/// **A20: the help that ends each iOS destination — one line always on screen,
/// the rest behind a control that is obviously a control.**
///
/// The iOS counterpart of the macOS `HelpCard`, reading the iOS table
/// (`HelpPresentation.topic(forIOS:)`) rather than the Mac one: the two apps
/// discover nearby devices differently, save into different places, and the iOS
/// Device Inbox receives only while the app is open. Same six answers — purpose,
/// the shortest path, what Relayium can see, where things end up, what goes
/// wrong and what to do — and a guide link only where a maintained page exists.
///
/// **A full-row button, not a `DisclosureGroup`.** The whole row is the target
/// and at least `Metrics.hitTarget` tall; the chevron is decoration and the
/// expanded state is the button's accessibility VALUE, which is how VoiceOver
/// expects an expandable control to report itself. Every text wraps rather than
/// truncating, so the block reads at every Dynamic Type size, and nothing here
/// is a nested scroller.
///
/// It is the quietest thing on the page: a card in the page's own chrome, grey
/// supporting text, no accent fill.
struct IOSHelpCard: View {
    let surface: IOSSurface

    var body: some View {
        if let topic = HelpPresentation.topic(forIOS: surface) {
            IOSHelpBlock(topic: topic)
        }
    }
}

private struct IOSHelpBlock: View {
    let topic: HelpTopic

    /// Collapsed by default and per screen; it resets when the destination is
    /// rebuilt, which is what a reader who opened it once expects.
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            toggle
            if expanded {
                details
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.inner)
        .padding(.vertical, Metrics.tight)
        .background(Palette.cardBackground,
                    in: RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
        .overlay(CardEdge(cornerRadius: Metrics.corner))
    }

    private var toggle: some View {
        Button {
            expanded.toggle()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.tight) {
                Image(systemName: "questionmark.circle") // nonlocalized: SF Symbol name
                    .foregroundStyle(Palette.supportingLabel)
                    // The heading beside it already says "Help".
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    Text(L10n.t(.helpHeading))
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(L10n.t(topic.purpose))
                        .font(.footnote)
                        .foregroundStyle(Palette.supportingLabel)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: Metrics.tight)
                Image(systemName: expanded ? "chevron.up" : "chevron.down") // nonlocalized: SF Symbol name
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.supportingLabel)
                    // Stated as the button's value below.
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: Metrics.hitTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("destination-help")
        .accessibilityValue(L10n.t(expanded ? .helpExpandedValue : .helpCollapsedValue))
        .accessibilityHint(L10n.t(expanded ? .helpCollapseHint : .helpExpandHint))
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            steps
            block(heading: .helpBoundaryHeading, body: topic.boundary)
            block(heading: .helpWhereHeading, body: topic.destination)
            trouble
            guideLink
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, Metrics.tight)
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            heading(.helpStepsHeading)
            ForEach(Array(topic.steps.enumerated()), id: \.offset) { index, key in
                // The numeral and its separator are positioned by the catalog.
                prose(L10n.t(.formatHelpStep, [L10n.number(index + 1), L10n.t(key)]))
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var trouble: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            heading(.helpTroubleHeading)
            prose(L10n.t(topic.failure))
            prose(L10n.t(topic.recovery))
        }
        .accessibilityElement(children: .contain)
    }

    private func block(heading key: L10nKey, body: L10nKey) -> some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            heading(key)
            prose(L10n.t(body))
        }
        .accessibilityElement(children: .contain)
    }

    private func heading(_ key: L10nKey) -> some View {
        Text(L10n.t(key))
            .font(.subheadline.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private func prose(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.supportingLabel)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Only where a maintained page exists; see `HelpGuide`.
    @ViewBuilder
    private var guideLink: some View {
        if let guide = topic.guide {
            Link(destination: HelpPresentation.url(for: guide, language: L10n.current)) {
                Text(L10n.t(.helpGuideLink))
                    .font(.footnote.weight(.semibold))
                    // The label role, not the accent: small accent text on the
                    // card measured under 4.5:1 (`IOSActionColorGuardTests`).
                    .foregroundStyle(Palette.actionLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: Metrics.hitTarget, alignment: .leading)
            }
            .accessibilityIdentifier("destination-help-guide")
        }
    }
}
