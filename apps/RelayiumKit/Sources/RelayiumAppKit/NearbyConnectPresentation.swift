import Foundation
import RelayiumKit

/// What the iOS Nearby tab offers for the device the user has chosen — as pure
/// functions of the roster's own facts, so `swift test` drives the answers
/// rather than a simulator having to.
///
/// ## The question this exists to stop the screen asking
///
/// iOS Nearby shipped with a Files/Text segmented picker above the roster. It
/// was the right control for the legacy wire, where the two generations do not
/// interoperate and the connection genuinely is one or the other. It is
/// **meaningless** for a peer that announced exact `link/1`: that connection
/// carries a conversation and as many file or folder batches as the user wants,
/// at the same time, behind one verification. Asking "files or text?" before
/// connecting to such a peer is asking the user to pick a half of something that
/// has no halves — and whichever half they pick, the screen would then have to
/// ignore it.
///
/// So the picker is hidden for a link peer and one Connect action replaces the
/// two verbs. Not removed for everyone: a legacy peer still has two
/// non-interoperating generations behind it, and its one-shot protocol needs
/// the manifest at connect, so `Send` and `Start a message session` stay exactly
/// as they are for that peer.
///
/// ## Connect first (A25, 2026-09-23)
///
/// **Nothing is staged before a link exists.** The 2026-08-15 carve-out that
/// kept iOS pre-connect staging is superseded: with no device, or with a link
/// peer chosen, there is no picker and no chooser, and Connect carries no files.
/// Files are chosen inside the open workspace, exactly as Cross-network does and
/// as macOS has since 2026-08-15. The staged batch it replaced was sent the
/// moment the link opened — with verification off, the default, that was before
/// anybody had compared anything — and it survived the link ending, so the next
/// Connect carried it to whichever device came next.
///
/// A LEGACY peer in Files mode is the one exception, because its one-shot wire
/// needs the manifest at connect. It is being retired with the legacy wire.
///
/// **Nothing is preselected on the roster.** That is a different rule, it is
/// about which DEVICE, and it is untouched: not even a room holding exactly one
/// other entry selects it, because that is precisely the case where the only
/// candidate might be a stranger.
public enum NearbyConnectPresentation {

    /// What the "what to send" section offers for the chosen device.
    public enum SendChoice: String, Equatable, Sendable {
        /// The Files/Text picker, and the staging or message intent under it.
        /// Every legacy peer, and the state before a device is chosen at all.
        case legacyLanes
        /// No picker. One connection that carries both, so the only thing worth
        /// offering before it exists is an optional batch to arm.
        case unifiedLink
    }

    /// Which of the two the screen draws.
    ///
    /// `nil` means no device is chosen yet, and the answer is `legacyLanes`
    /// rather than a third state, because no action exists without a device.
    /// It no longer decides whether the picker or the chooser is drawn — both
    /// now need a chosen legacy peer (A25); see `showsModePicker`.
    ///
    /// Asked of the DEVICE rather than of the room, because that is where the
    /// answer is: `NearbyDevice.supportsLink` is the roster's record of this
    /// peer's exact `link/1` announcement, and two devices in one room can
    /// legitimately differ.
    public static func sendChoice(for device: NearbyDevice?) -> SendChoice {
        guard let device, device.supportsLink else { return .legacyLanes }
        return .unifiedLink
    }

    /// Whether the Files/Text picker is on screen at all: only for a CHOSEN
    /// legacy peer.
    ///
    /// With nobody chosen the screen has no question to ask yet — the roster is
    /// the first step — and a link peer has no halves to pick between.
    public static func showsModePicker(for device: NearbyDevice?) -> Bool {
        guard let device else { return false }
        return sendChoice(for: device) == .legacyLanes
    }

    /// Whether the file-staging section is offered: only for a chosen legacy
    /// peer with the picker at `.files`, whose one-shot wire needs the manifest
    /// at connect. See "Connect first" above.
    public static func showsStaging(for device: NearbyDevice?, mode: TransferMode) -> Bool {
        guard let device, sendChoice(for: device) == .legacyLanes else { return false }
        return mode == .files
    }

    /// The lane a legacy connection to this device will use.
    ///
    /// The same `LegacyLane` rule macOS asks at Connect, asked here so the two
    /// platforms cannot answer differently for one peer — and asked WITH the
    /// staged-batch fact, because iOS still stages and macOS no longer does.
    ///
    /// `nil` for a link peer: it has no lane, and returning one would be a value
    /// the caller could act on by mistake.
    public static func legacyMode(for device: NearbyDevice?,
                                  hasStagedBatch: Bool) -> TransferMode? {
        guard let device, !device.supportsLink else { return nil }
        return LegacyLane.mode(peerAnnouncesText: device.announcesLegacyText,
                               hasArmedBatch: hasStagedBatch)
    }
}
