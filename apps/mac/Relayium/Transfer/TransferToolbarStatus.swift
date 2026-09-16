import SwiftUI
import RelayiumAppKit

/// What the detail toolbar's chip says on the two transfer destinations.
///
/// Read from the same models the panes render, so the chip cannot claim a
/// state the page below it does not show: a connection first, because it is
/// the most specific fact, then the destination's own idle state.
@MainActor
enum TransferToolbarStatus {
    /// A claimed `link/1` attempt, or nil while there is none.
    static func link(_ connection: LinkWorkspaceConnection) -> ToolbarStatus? {
        switch connection {
        case .idle, .watching:
            return nil
        case .requesting, .establishing:
            return ToolbarStatus(label: L10n.t(.toolbarStatusConnecting), tone: .busy)
        case .open:
            return ToolbarStatus(label: L10n.t(.toolbarStatusConnected), tone: .good)
        case .ended:
            return ToolbarStatus(label: L10n.t(.toolbarStatusEnded), tone: .idle)
        }
    }

    /// LAN Transfer: the connection if there is one, otherwise whether this Mac
    /// can be reached.
    static func lan(connection: LinkWorkspaceConnection,
                    receive: NearbyReceiveState) -> ToolbarStatus {
        if let live = link(connection) { return live }
        switch receive {
        case .ready, .active:
            return ToolbarStatus(label: L10n.t(.toolbarStatusReceiving), tone: .good)
        case .connecting:
            return ToolbarStatus(label: L10n.t(.toolbarStatusJoining), tone: .busy)
        case .reconnecting:
            return ToolbarStatus(label: L10n.t(.toolbarStatusReconnecting), tone: .busy)
        case .paused:
            return ToolbarStatus(label: L10n.t(.toolbarStatusPaused), tone: .idle)
        case .off:
            return ToolbarStatus(label: L10n.t(.toolbarStatusOff), tone: .idle)
        }
    }

    /// Cross-network Transfer: the connection if there is one, otherwise the
    /// code's own phase.
    static func crossNetwork(connection: LinkWorkspaceConnection,
                             code: PairingCodeState,
                             unsupportedPeer: Bool,
                             now: Date) -> ToolbarStatus {
        if let live = link(connection) { return live }
        if unsupportedPeer {
            return ToolbarStatus(label: L10n.t(.toolbarStatusFailed), tone: .failure)
        }
        switch code {
        case .idle:
            return ToolbarStatus(label: L10n.t(.toolbarStatusReady), tone: .good)
        case .minting:
            return ToolbarStatus(label: L10n.t(.toolbarStatusCreatingCode), tone: .busy)
        case let .showing(_, expiresAt):
            guard PairingCodeExpiry.presentation(expiresAt: expiresAt, now: now).isUsable else {
                return ToolbarStatus(label: L10n.t(.toolbarStatusCodeExpired), tone: .idle)
            }
            return ToolbarStatus(label: L10n.t(.toolbarStatusWaiting), tone: .good)
        case .failed:
            return ToolbarStatus(label: L10n.t(.toolbarStatusFailed), tone: .failure)
        }
    }
}
