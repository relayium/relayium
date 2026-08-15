import Foundation

/// **Which legacy generation a peer that cannot speak `link/1` gets — decided
/// from what the peer announced, never from a question put to the user.**
///
/// ## Why this is a type rather than a line inside one model
///
/// The shipped wire has two generations and they do not interoperate: a file
/// session offers with no capability at all, a text session announces `text/1`
/// and refuses to build until the peer announces it back
/// (`RealtimeConnectionFactory.connectInRoom`). Something has to pick, and the
/// two surfaces that pick now reach the answer at different moments:
///
///  - **A pairing code** learns its peer only after the room resolves, so
///    `LinkWorkspaceModel.fallBackToLegacy` asks at the end of the capability
///    window.
///  - **A same-network device** is in the roster with its announcement already
///    attached, so `LanConnectPane` asks the instant the user presses Connect —
///    before any session exists.
///
/// Those are one rule at two times. Written twice they drift, and the way they
/// drift is silent: a surface that answers `.text` where the other answers
/// `.files` hands a legacy peer an offer it will never build, and the user sees
/// a connection that hangs rather than a decision that was wrong. So the rule is
/// one pure function both call, and `LegacyLaneTests` drives it directly.
///
/// ## The rule
///
///  1. **This side has a batch armed** — then the answer is files whatever the
///     peer said. A staged batch is the user's stated intent, it is the one
///     thing a text lane cannot carry at all, and the file lane moves bytes in
///     either direction.
///
///     macOS no longer arms anything before connecting, so on that platform
///     this arm is only reached by the inbound-adoption path that hands a link
///     batch back. It stays because the rule is the wire's, not the surface's:
///     iOS still stages first, and a future re-enable of pre-staging must not
///     have to rediscover it.
///  2. **The peer announced exact `text/1`** — then text. On the shipped native
///     wire that announcement is only ever sent BY a text session (`Mode.file`
///     has no local capabilities), so it is a direct statement of what the peer
///     is doing rather than an inference about it.
///  3. **Anything else is files**, and that is the honest reading rather than a
///     coin toss: a legacy peer that announced NOTHING is a file peer by
///     construction, and answering it with a text offer would guarantee the one
///     failure this decision exists to avoid.
///
/// The one case it can still get wrong is a stale Web tab, which broadcasts
/// `text/1` at roster level whatever its user is doing. It is bounded: a
/// mismatched lane reaches a truthful terminal state (`.unsupported`) rather
/// than a hang.
///
/// ## What this narrows, stated rather than left to be discovered
///
/// A legacy peer announces `text/1` only while it is itself connecting in text
/// mode (`RealtimeConnectionFactory.connectInRoom` sends the hello from the
/// `.text` branch and from nowhere else). An idle legacy peer sitting in the
/// roster therefore announces nothing, so this rule answers `.files` for it —
/// and a macOS user can no longer *start* a message session with such a peer.
///
/// That is a real narrowing and it is the owner's decision taken to its
/// conclusion, not an oversight. Under the pre-connect pair the user could press
/// `Send a message` at an idle legacy peer, but the attempt only ever succeeded
/// when the other user happened to start a text session inside the same
/// capability window; otherwise it failed with `unsupportedPeer`. So what is
/// lost is a button that mostly produced a truthful failure, and what replaces
/// it is a lane that builds. Between current clients nothing is lost at all:
/// both announce `link/1`, `TransferLinkPane` carries messages and files on one
/// verified connection, and this rule is never consulted.
///
/// **Neither answer is a dead end for the user.** A text lane has its composer
/// from the moment it opens; a file lane has `RealtimeSessionModel.sendNow`,
/// which is what lets a connection made before anything was chosen still carry
/// files. Without that second half this rule would be a coin toss between "can
/// only talk" and "can do nothing", which is the shape a connect-first surface
/// must not have.
public enum LegacyLane {
    /// The lane, from the two facts that decide it.
    ///
    /// Both parameters are STATEMENTS about state already settled at the call
    /// site, not closures to re-read: the pairing path asks after clearing its
    /// room and the LAN path asks before claiming one, and a lane that changed
    /// answer between the question and the offer is the drift this exists to
    /// remove.
    public static func mode(peerAnnouncesText: Bool, hasArmedBatch: Bool) -> TransferMode {
        if hasArmedBatch { return .files }
        return peerAnnouncesText ? .text : .files
    }
}
