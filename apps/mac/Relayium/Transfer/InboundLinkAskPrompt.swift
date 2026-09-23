import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **A nearby device is asking to connect (A23).**
///
/// Two forms of ONE question, both answering through `LinkWorkspaceModel`:
///
///  - `InboundLinkAskCard`, at the top of LAN Transfer, where the user already
///    is when they are looking at the roster;
///  - `InboundLinkAskAlert`, window-level, for when another destination is
///    showing — the ask has a deadline and arrives from outside the view tree,
///    so waiting for the user to wander back to LAN Transfer would let it
///    time out unseen.
///
/// Nothing has happened while either is up: no transport, no claim on the
/// surface, no navigation. Accept runs the app's one admission gate — which
/// claims LAN Transfer and navigates to it — and only then the room's claim.
/// Decline tells the device no. A closed window shows neither, and the ask
/// answers itself `busy` at its deadline.
struct InboundLinkAskCard: View {
    @ObservedObject var link: LinkWorkspaceModel
    let ask: LinkInboundAsk

    var body: some View {
        SectionCard(title: L10n.t(.nearbyIncomingTitle, [L10n.token(ask.peerLabel)])) {
            VStack(alignment: .leading, spacing: Metrics.tight) {
                Text(L10n.t(.nearbyIncomingDetail))
                    .font(.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if link.inboundAskDiscardsLocalText {
                    InlineMessage(.warning, L10n.t(.nearbyIncomingDiscardsText))
                }
                HStack(spacing: Metrics.tight) {
                    Spacer(minLength: 0)
                    Button(L10n.t(.nearbyIncomingDecline)) { link.declineInboundAsk() }
                        .buttonStyle(.referenceSecondary)
                        .accessibilityIdentifier("lan-incoming-decline")
                    Button(L10n.t(.nearbyIncomingAccept)) { link.acceptInboundAsk() }
                        .buttonStyle(.referencePrimary)
                        .accessibilityIdentifier("lan-incoming-accept")
                }
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
        .accessibilityIdentifier("lan-incoming-ask")
    }
}

/// The window-level form. Up only while an ask is pending AND LAN Transfer is
/// not the destination drawn; the card there is the same question in place.
struct InboundLinkAskAlert: ViewModifier {
    @ObservedObject var link: LinkWorkspaceModel
    @ObservedObject var navigation: AppNavigationModel

    func body(content: Content) -> some View {
        content.alert(Text(title), isPresented: presented, presenting: link.inboundAsk) { _ in
            Button(L10n.t(.nearbyIncomingAccept)) { link.acceptInboundAsk() }
            Button(L10n.t(.nearbyIncomingDecline), role: .cancel) { link.declineInboundAsk() }
        } message: { _ in
            Text(message)
        }
    }

    /// The setter is inert on purpose: the alert goes when the MODEL says the
    /// ask was answered, withdrawn or timed out.
    private var presented: Binding<Bool> {
        Binding(get: { link.inboundAsk != nil && navigation.selection.macSurface != .lanTransfer },
                set: { _ in })
    }

    private var title: String {
        L10n.t(.nearbyIncomingTitle, [L10n.token(link.inboundAsk?.peerLabel ?? "")])
    }

    private var message: String {
        guard link.inboundAskDiscardsLocalText else { return L10n.t(.nearbyIncomingDetail) }
        return [L10n.t(.nearbyIncomingDetail), L10n.t(.nearbyIncomingDiscardsText)]
            .joined(separator: "\n\n")
    }
}

/// The card's slot on LAN Transfer. Its own view so it observes the LINK: the
/// pane observes its module, which does not republish the link's prompt.
struct InboundLinkAskSlot: View {
    @ObservedObject var link: LinkWorkspaceModel

    var body: some View {
        if let ask = link.inboundAsk {
            InboundLinkAskCard(link: link, ask: ask)
        }
    }
}
