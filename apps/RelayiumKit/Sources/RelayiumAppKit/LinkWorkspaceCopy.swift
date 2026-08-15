import Foundation
import RelayiumShareKit

/// The words for a link's terminal reason and for a batch's state — as pure
/// functions of the model's own enums, on the layer both surfaces already link.
///
/// ## Why these are shared and the views are not
///
/// This batch gives iOS a unified workspace, and the one thing it must not do is
/// grow a second copy of macOS's. A `TextEditor` sized for a 560pt window, an
/// `NSOpenPanel`, `.bordered` buttons in an `HStack` and a keyboard shortcut are
/// answers to macOS's questions; iOS asks different ones and gets its own
/// answers in `NearbyLinkWorkspaceView`.
///
/// What is NOT platform is the mapping from a terminal reason to a sentence.
/// `LinkWorkspaceEnding` has nine cases and `LinkFileBatchState` has six, both
/// exhaustive by construction; written twice they drift exactly the way
/// `LegacyLane` records for the lane rule, and the drift is silent — one surface
/// saying "the connection ended" where the other says it failed, for the same
/// observed transition. So the mapping is one `switch` each, on the layer both
/// apps link, and the view renders what it returns.
///
/// It lives here rather than as a computed property on the enums for the reason
/// the macOS pane's own comment gives where the same mapping is written today:
/// `RelayiumAppKit` deliberately renders nothing, and a message baked into the
/// model layer would be one no view could override. A free enum in the same
/// module is a middle ground the views can decline to use, and it keeps `swift
/// test` able to drive every case without a window.
///
/// **What this does not yet do, and deliberately.** `TransferLinkPane` still
/// holds its own private copy of both switches. Retiring it is a macOS product
/// edit and this is an iOS batch, so the duplicate is reported rather than
/// removed here — the drift risk above is real and is the follow-up. Until then
/// the `#if os(macOS)` branches below are the correct answer for a macOS caller
/// and are exercised only by `swift test`.
public enum LinkEndingCopy {

    /// One terminal reason, in words.
    ///
    /// **Two of the nine are platform-specific**, because the sentence names the
    /// device it is about: `unavailable` and the room-loss note both say what
    /// this machine is doing, and "This Mac is already busy" on an iPhone is
    /// simply false. Everything else is one sentence on both, which is the point
    /// of the function.
    ///
    /// No `default`: a tenth ending has to state its own answer here rather than
    /// inherit somebody else's.
    public static func text(for reason: LinkWorkspaceEnding) -> String {
        switch reason {
        case .refused: return L10n.t(.linkEndedRefused)
        case .timedOut: return L10n.t(.linkEndedTimedOut)
        case .unavailable:
            #if os(macOS)
            return L10n.t(.linkEndedUnavailable)
            #else
            return L10n.t(.linkEndedUnavailableIOS)
            #endif
        case .failed: return L10n.t(.linkEndedFailed)
        case .closed: return L10n.t(.linkEndedClosed)
        case .verificationRejected: return L10n.t(.linkEndedVerificationRejected)
        case .roomLost: return L10n.t(.linkEndedRoomLost)
        case .relayExpired: return L10n.t(.linkEndedRelayExpired)
        case .roomUnavailable: return L10n.t(.linkEndedRoomUnavailable)
        }
    }

    /// Whether this ending is something that went wrong, or simply the end.
    ///
    /// The one thing a surface asks about an ending beyond its words, and it is
    /// asked here so the answer is one rule rather than an inline comparison at
    /// each call site. `closed` is the user's own hangup or the peer's; every
    /// other case is a failure the user did not choose — including
    /// `verificationRejected`, which they DID choose but which means "something
    /// may be wrong" and is the one ending that exists to say so.
    public static func isFailure(_ reason: LinkWorkspaceEnding) -> Bool {
        reason != .closed
    }

    /// The sentence about a link that outlived its discovery room.
    ///
    /// Split per platform for the same reason `unavailable` is: the shipped
    /// English names the machine ("This Mac left the discovery room"), and the
    /// claim is about this device rather than about the protocol.
    public static var signalingLost: String {
        #if os(macOS)
        L10n.t(.linkSignalingLost)
        #else
        L10n.t(.linkSignalingLostIOS)
        #endif
    }
}

/// One batch state, in words. Six cases, no `default`, for the same reason.
public enum LinkBatchCopy {
    public static func text(for state: LinkFileBatchState) -> String {
        switch state {
        case .offered: return L10n.t(.linkBatchOffered)
        case .queued: return L10n.t(.linkBatchQueued)
        case .transferring: return L10n.t(.linkBatchTransferring)
        case .finished: return L10n.t(.linkBatchFinished)
        case .received: return L10n.t(.linkBatchReceived)
        case .failed: return L10n.t(.linkBatchFailed)
        }
    }

    /// A batch's manifest DESCRIBED rather than listed: a folder batch can hold
    /// thousands of entries, and a transfer row is not a file browser.
    public static func summary(files: Int, totalBytes: Int) -> String {
        let count = L10n.plural(.selectionFiles, files)
        guard totalBytes > 0 else { return count }
        return L10n.detail([count, L10n.bytes(Int64(totalBytes))])
    }
}
