import RelayiumAppKit
import SwiftUI

/// **What a build the product no longer supports is allowed to show.**
///
/// One wrapper around the window's content, and it is deliberately here rather
/// than inside `AppShellView`: the shell's whole contract is that its split view
/// renders unconditionally, and `MacSurfaceGuardTests` holds it to that. This is
/// not a gate on who the user is or on what they have paid for — it is the
/// answer to "may this binary run at all", which is decided before there is a
/// product surface to gate.
///
/// Three states, and only the first replaces anything:
///
///  - **Blocked.** The content is not built at all. Not hidden behind an overlay
///    and not `.disabled` — NOT BUILT, so the transfer modules' `.task`
///    modifiers never run and a below-minimum build does not open a room socket
///    or register for notifications while it shows the reader an update button.
///  - **Recommended.** The content renders normally with one dismissible line
///    above it. Nothing is disabled and nothing is hidden.
///  - **Supported.** Exactly the content, with nothing added.
///
/// Neither action is chosen here. `update` is handed in by the scene from
/// `AppUpdates`, which is Sparkle in the direct build and the App Store in the
/// other — so no policy document, however malformed or hostile, can name where
/// an update comes from. This view has no `URL`, no `openURL` and no updater.
struct AppVersionGate<Content: View>: View {
    @ObservedObject var support: SupportedVersionModel
    let update: () -> Void
    let quit: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        if support.isBlocked, let policy = support.state.policy {
            UnsupportedVersionView(current: support.currentVersion,
                                   policy: policy,
                                   update: update,
                                   quit: quit)
        } else {
            content()
                // An inset rather than an overlay: the recommendation must not
                // sit on top of the sidebar or a destination's own controls, and
                // a banner that covers what it is recommending an update for is
                // a banner people dismiss without reading.
                .safeAreaInset(edge: .top, spacing: 0) {
                    if support.showsRecommendation, let policy = support.state.policy {
                        UpdateRecommendationBanner(current: support.currentVersion,
                                                   policy: policy,
                                                   update: update,
                                                   dismiss: support.dismissRecommendation)
                    }
                }
        }
    }
}

extension View {
    /// Put the version gate around this view.
    ///
    /// Applied ONCE, at the scene root, and written as a modifier rather than as
    /// a wrapper in the scene's body so the window's existing composition — the
    /// environment objects, the two hand-off subscriptions, the app-scoped tasks
    /// — is not re-indented around a new branch. What it produces is the same
    /// `AppVersionGate`: when the policy blocks, this view is not in the tree at
    /// all, and every `.task` attached to it stays unrun.
    func appVersionGate(_ support: SupportedVersionModel,
                        update: @escaping () -> Void,
                        quit: @escaping () -> Void) -> some View {
        AppVersionGate(support: support, update: update, quit: quit) { self }
    }
}

/// The whole window, for a build below the minimum supported version.
///
/// Two actions and no third. **Update** is the way out; **Quit** is the honest
/// alternative to it, and it is offered because the other way to leave a
/// blocking window — closing it — does not end this app: the menu-bar extra
/// keeps the process alive, so a user who "closed" a blocked Relayium would be
/// left with a background process they cannot see and cannot use.
///
/// There is no dismiss, no "continue anyway" and no countdown. A version below
/// the minimum is one the product will not answer for; a skip button would make
/// that a suggestion, and the state exists precisely for the cases where it is
/// not one.
struct UnsupportedVersionView: View {
    let current: AppVersion?
    let policy: SupportedVersionPolicy
    let update: () -> Void
    let quit: () -> Void
    #if DEBUG
    /// Whether the shipped update action has run in this process.
    ///
    /// Observed only so that a built-App acceptance run can assert the button
    /// below reaches `AppUpdates.startUpdate()` — Sparkle's own check in this
    /// build — instead of asserting on an appcast fetch it must not depend on.
    /// The property and the marker it renders are both inside `#if DEBUG`, so a
    /// Release build has neither; and the witness publishes nothing unless the
    /// process is a UI-test launch, so an ordinary Debug run has neither either.
    @ObservedObject private var updateAction = UITestUpdateActionWitness.shared
    #endif

    var body: some View {
        VStack(spacing: Metrics.section) {
            // `.title`, like every other symbol in this app draws itself. A
            // display size here would be this file inventing a page heading —
            // `MacSurfaceGuardTests` refuses one anywhere in the tree, and the
            // reason applies to the one screen that IS the whole window too.
            Image(systemName: "arrow.up.circle")
                .font(.title)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(L10n.t(.updateRequiredTitle))
                .font(.title2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            // Selectable: this sentence carries three version numbers, and they
            // are exactly what a person types into a bug report or a support
            // message from a Mac whose app will not open.
            Text(UpdateRequirementPresentation.requiredBody(current: current, policy: policy))
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: Metrics.inner) {
                Button(UpdateRequirementPresentation
                    .updateActionLabel(channel: AppDistribution.channel), action: update)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("version-blocked-update")
                Button(L10n.t(.updateActionQuit), action: quit)
                    .accessibilityIdentifier("version-blocked-quit")
            }
            #if DEBUG
            // The acceptance suite's evidence that the button above reached the
            // shipped update action. Absent from Release with the property it
            // reads, and false in every Debug launch that is not a UI test — so
            // no build a person can install renders this.
            if updateAction.wasReached {
                // nonlocalized: a UI-test marker, absent from Release
                Text(verbatim: "update-action-reached")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("version-blocked-update-reached")
            }
            #endif
        }
        .padding(Metrics.page)
        .frame(minWidth: 480, minHeight: 320)
        .frame(maxWidth: Metrics.readingMeasure)
        // Stable and nonlocalized, so the acceptance suite can assert the
        // blocked surface itself rather than the absence of a destination.
        .accessibilityIdentifier("version-blocked")
    }
}

/// One line above a product that works. Dismissible, and nothing else changes.
struct UpdateRecommendationBanner: View {
    let current: AppVersion?
    let policy: SupportedVersionPolicy
    let update: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: Metrics.inner) {
            InlineMessage(.info, UpdateRequirementPresentation
                .recommendedBody(current: current, policy: policy))
            Spacer(minLength: Metrics.tight)
            Button(UpdateRequirementPresentation
                .updateActionLabel(channel: AppDistribution.channel), action: update)
                .accessibilityIdentifier("version-recommendation-update")
            Button(L10n.t(.updateActionDismiss), action: dismiss)
                .accessibilityIdentifier("version-recommendation-dismiss")
        }
        .padding(.horizontal, Metrics.page)
        .padding(.vertical, Metrics.tight)
        .background(.regularMaterial)
        .accessibilityIdentifier("version-recommendation")
    }
}

/// The menu bar, for a blocked build.
///
/// It exists because the menu-bar extra is a live control surface: it can resume
/// nearby receiving and the Device Inbox, both of which make this Mac reachable.
/// Leaving it intact would mean a build the product refuses to run could still
/// be put back into service from a menu — so the blocked build's menu offers the
/// same two actions its window does and nothing else.
struct MenuBarVersionBlock: View {
    let update: () -> Void

    var body: some View {
        Text(L10n.t(.updateRequiredTitle))
        Divider()
        Button(UpdateRequirementPresentation
            .updateActionLabel(channel: AppDistribution.channel), action: update)
        Button(L10n.t(.updateActionQuit)) { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
