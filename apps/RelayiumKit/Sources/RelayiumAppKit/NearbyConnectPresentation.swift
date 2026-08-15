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
/// non-interoperating generations behind it, and iOS still stages before
/// connecting, so `Send` and `Start a message session` stay exactly as they are
/// for that peer.
///
/// ## What did NOT change, deliberately
///
/// **iOS still preselects before connecting.** macOS removed pre-connect staging
/// entirely (DECISION-LOG, 2026-08-15) because a Mac can open a picker inside a
/// live session with no consequence. On iOS the picker is a full-screen document
/// browser that takes the app to `.inactive`, and the session survives that only
/// because `ForegroundSessionCoordinator` is careful — which is a good reason to
/// keep the connect-time picker trip optional rather than mandatory. A batch
/// staged before Connect is ARMED on the link (`LinkWorkspaceModel.connect(files:
/// sources:)`), held behind the verification boundary like every other batch, and
/// released the moment the digits are answered. Nothing is sent early.
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
    /// rather than a third state: with nobody chosen the screen cannot know
    /// which product this connection will be, and the picker is the surface iOS
    /// already had. Hiding it pre-emptively would make the control appear when a
    /// legacy device was tapped, which reads as the app changing its mind.
    ///
    /// Asked of the DEVICE rather than of the room, because that is where the
    /// answer is: `NearbyDevice.supportsLink` is the roster's record of this
    /// peer's exact `link/1` announcement, and two devices in one room can
    /// legitimately differ.
    public static func sendChoice(for device: NearbyDevice?) -> SendChoice {
        guard let device, device.supportsLink else { return .legacyLanes }
        return .unifiedLink
    }

    /// Whether the Files/Text picker is on screen at all.
    ///
    /// A named function rather than `== .legacyLanes` at the call site, so the
    /// one thing this batch removes from the screen has a name a test can fail
    /// against.
    public static func showsModePicker(for device: NearbyDevice?) -> Bool {
        sendChoice(for: device) == .legacyLanes
    }

    /// Whether the file-staging section is offered.
    ///
    /// True for BOTH answers, and that is the deliberate part. For a legacy peer
    /// it is gated on the picker sitting at `.files`, exactly as it shipped. For
    /// a link peer there is no picker to sit anywhere, and staging is still
    /// worth offering — it is what makes one tap on Connect also carry the
    /// batch, instead of a connect followed by a picker trip that leaves the app
    /// for the document browser.
    public static func showsStaging(for device: NearbyDevice?, mode: TransferMode) -> Bool {
        switch sendChoice(for: device) {
        case .unifiedLink: return true
        case .legacyLanes: return mode == .files
        }
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
