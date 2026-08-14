import RelayiumAppKit
import SwiftUI

/// **The short tutorial that ends every browseable destination — one line of it
/// always on screen, the rest one click away.**
///
/// The owner's report: a screen says what it is and hands you the controls, and
/// somebody who does not already know what a pairing code is, or where a sent
/// file ends up, has to leave the app to find out. So each destination ends with
/// three steps, one common question, and — only where a maintained document
/// exists — a link to it.
///
/// ## Why this is a disclosure now, and why that is not the old mistake
///
/// It shipped permanently open, and the reason was sound: the root view once hid
/// every signed-out CAPABILITY inside two collapsed groups, nobody found them,
/// and `MacSurfaceGuardTests` banned `DisclosureGroup` by name across the app so
/// it could not come back. What the ban could not distinguish is what is being
/// hidden. A collapsed group that hides the way to send a file removes the
/// feature; a collapsed group that hides the third paragraph about it does not.
///
/// Open, this block ran to eight or nine lines under every screen, permanently,
/// competing with the controls above it for a 560pt window — which is the defect
/// the audit actually found. So:
///
///  - **The decisive line stays visible.** Step one is rendered in the
///    disclosure's own label, numbered exactly as it is inside, so a reader who
///    needs only "what do I do first" never opens anything.
///  - **Everything else is one click away and complete when opened** — the
///    remaining steps, the common question with its answer, and the guide link.
///  - **The ban survives where it was aimed.** This file is the only place in
///    the app allowed to use `DisclosureGroup`, and the guard now says so by
///    name rather than banning the control outright.
///
/// It still adds no heading of the destination's own, and it still sits at the
/// bottom, below the controls.
///
/// ## Two shapes, one body
///
/// Four destinations are stacks of `SectionCard`s inside the scaffold's scroll
/// view; the Device Inbox is a grouped `Form`. A card dropped into a `Form`
/// draws a box inside a box, and a `Section` outside one draws nothing at all —
/// so the container differs and the content does not.
struct HelpCard: View {
    let surface: MacSurface

    var body: some View {
        if let topic = HelpPresentation.topic(for: surface) {
            HelpDisclosure(topic: topic)
                // Not a `SectionCard`: help is the quietest thing on the screen
                // and giving it the same chrome as the controls says the
                // opposite. The rule above it is what separates it instead.
                .padding(.top, Metrics.tight)
        }
    }
}

/// The Device Inbox's shape: a `Form` section, and the LAST one.
///
/// Last because help below the controls is the whole arrangement, and because
/// this surface has three account/status branches that render different sets of
/// sections above it — putting it anywhere else would move it depending on
/// whether the user happens to be signed in.
struct HelpFormSection: View {
    let surface: MacSurface

    var body: some View {
        if let topic = HelpPresentation.topic(for: surface) {
            Section {
                HelpDisclosure(topic: topic, showsRule: false)
            }
        }
    }
}

/// The content both shapes render: one visible step, and the rest behind a
/// disclosure.
private struct HelpDisclosure: View {
    let topic: HelpTopic
    /// The hairline above the label. The `Form` shape does not want one — a
    /// grouped section already draws its own boundary.
    var showsRule: Bool = true

    /// Collapsed by default, and per screen rather than per app: a reader who
    /// opened the Device Inbox's help has said nothing about wanting the LAN
    /// screen's. `@State` also means it resets when the destination is left,
    /// which is the behaviour a reader who opened it once expects.
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            if showsRule {
                Divider()
            }
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: Metrics.inner) {
                    remainingSteps
                    question
                    guideLink
                }
                .padding(.top, Metrics.tight)
                .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            } label: {
                label
            }
        }
    }

    /// The heading and the one step that is always readable.
    private var label: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(.helpHeading))
                .font(.subheadline.weight(.semibold))
                // On the leaf, never on the stack: a container identifier
                // propagates down and would rename the step under it.
                .accessibilityIdentifier("destination-help")
            if let first = topic.steps.first {
                step(first, number: 1)
                    .accessibilityIdentifier("destination-help-first-step")
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    /// Steps two onward. Step one is in the label above and is deliberately not
    /// repeated here — the numbering is continuous across the fold, so opening
    /// the group extends the list rather than restarting it.
    private var remainingSteps: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(.helpStepsHeading))
                .font(.subheadline.weight(.semibold))
            ForEach(Array(topic.steps.enumerated().dropFirst()), id: \.offset) { index, text in
                step(text, number: index + 1)
            }
        }
        // One spoken group. Read control by control, numbered fragments
        // announce as unrelated sentences.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.helpStepsHeading))
    }

    /// Numbered, with the numeral and its separator positioned by the catalog
    /// rather than composed here — `"\(n). "` is English punctuation, and this
    /// renders in nine languages including one that reads right to left.
    private func step(_ key: L10nKey, number: Int) -> some View {
        Text(L10n.t(.formatHelpStep, [L10n.number(number), L10n.t(key)]))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var question: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(topic.question))
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(topic.answer))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// Only where one exists. See `HelpPresentation` for why this is optional
    /// rather than a "learn more" on every screen.
    @ViewBuilder
    private var guideLink: some View {
        if let guide = topic.guide {
            Link(L10n.t(.helpGuideLink),
                 destination: HelpPresentation.url(for: guide, language: L10n.current))
                .font(.caption)
                .accessibilityIdentifier("destination-help-guide")
        }
    }
}
