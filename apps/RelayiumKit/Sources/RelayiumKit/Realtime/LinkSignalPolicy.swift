import Foundation

/// One thing the driver must do with one inbound signal, in the order the
/// driver must do it.
public enum LinkSignalAction: Equatable {
    /// Record the peer's commitment. Always emitted BEFORE the SDP action it
    /// arrived with: answering an offer sends our own commit, and a reveal that
    /// arrives in the same signalling burst has nothing to verify against
    /// otherwise.
    case recordPeerCommit(String)
    /// Apply this offer, then create and send the answer.
    case applyRemoteOffer(String)
    /// Apply this answer, then reveal.
    case applyRemoteAnswer(String)
    case addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int32?)
    case verifyPeerReveal(Reveal)
    /// Terminal. Report and close; nothing after it in the same plan runs.
    case fail(LinkTransportError)
}

/// Which inbound signals an INITIAL `link/1` establishment will act on, and
/// what each one means.
///
/// ## Why it is separate from the driver
///
/// Every rule here is a way a transport is talked into doing something for
/// somebody it should not be listening to, and none of them need an
/// `RTCPeerConnection` to decide. `RealtimeConnection` answers the same
/// questions inline and, as its own header says, can therefore only be
/// exercised by two live peers.
///
/// ## What it accepts
///
/// EXACTLY the `link` generation, exactly from the admitted peer, and only
/// after that peer's first SDP has confirmed exact `link/1`. `signalGeneration`
/// ranks `resume` above `link`, so a signal carrying both flags is a rebuild
/// and is ignored here — this slice implements no authenticated resume, and
/// answering one would mean building a second transport into an authentication
/// this object cannot verify (`LINK_TRANSPORT_REPLACEMENT_SUPPORTED`).
///
/// ## What it never does
///
/// It performs no cryptography and holds no keys. `verifyPeerReveal` is a
/// routing decision — "this is worth spending a verification on" — exactly as
/// `LinkAdmission` splits routing from tag verification. It also never answers:
/// producing a `busy`, a leave, or a request belongs to admission, which owns
/// the one-link rule.
public final class LinkSignalPolicy {
    private let peerId: String
    private let role: Role

    private var capabilityConfirmed = false
    private var commitRecorded = false
    private var remoteOfferApplied = false
    private var remoteAnswerApplied = false
    private var revealSeen = false

    /// `role` is the deterministic one `LinkAdmission` supplied — `linkRole`'s
    /// smaller-id-offers rule — never a preference of this object's.
    public init(peerId: String, role: Role) {
        self.peerId = peerId
        self.role = role
    }

    /// True once the peer's first acted-on SDP carried exact `link/1`. Until
    /// then nothing but a `busy` reaches the PeerConnection.
    public var isPeerCapabilityConfirmed: Bool { capabilityConfirmed }

    public func plan(from: String, signal: JSONValue) -> [LinkSignalAction] {
        // A room is a broadcast surface. Anything from anyone else is not this
        // transport's business, whatever it claims to be.
        guard from == peerId else { return [] }
        // EXACTLY the link generation. `.file`/`.text` belong to the legacy
        // connections and `.resume` to a rebuild this slice cannot perform.
        guard signalGeneration(signal) == .link else { return [] }

        // Ahead of the capability gate on purpose: a busy is how the peer says
        // it cannot take this link, and it carries no SDP and therefore no caps.
        // Gating it would leave an initiator that has already sent its offer
        // waiting out its whole deadline for a refusal it was actually told.
        if parseBusy(signal) { return [.fail(.peerBusy)] }

        if let sdp = parseSDP(signal) {
            // Decide whether this SDP is one we will act on BEFORE looking at
            // anything else it carries. A duplicate offer, an answer to nobody,
            // or a glare offer arriving at the initiator is dropped WHOLE —
            // commit included. Recording a commit from an SDP we then ignore
            // would replace the commitment this handshake is bound to with one
            // the peer chose later, which is precisely the substitution
            // commit-before-reveal exists to prevent.
            let actionable: Bool
            switch sdp.type {
            case "offer": actionable = role == .responder && !remoteOfferApplied
            case "answer": actionable = role == .initiator && !remoteAnswerApplied
            default: actionable = false
            }
            guard actionable else { return [] }

            // Exact capability on the first SDP that reaches the connection.
            // The roster-level hello is a hint that can be stripped or forged;
            // this is the per-connection confirmation `webrtc.ts` sends as
            // `sdpExtra`, and requiring it exactly is what keeps a `link/2`
            // dialect from being read as this one.
            if !capabilityConfirmed {
                guard peerCaps(from: signal).contains(LINK_CAPABILITY) else {
                    return [.fail(.unsupportedPeer)]
                }
                capabilityConfirmed = true
            }

            var actions: [LinkSignalAction] = []
            if !commitRecorded {
                // Every deployed peer sends its commit alongside its SDP and
                // only alongside its SDP (`webrtc.ts` spreads `sdpExtra` into
                // offer and answer, never into an ICE or reveal message). One
                // without a commit can never complete the handshake, so failing
                // now is the same outcome as waiting for a reveal that could not
                // be verified — minus a PeerConnection held open for the whole
                // deadline.
                guard let commit = peerCommit(from: signal) else {
                    return [.fail(.missingPeerCommit)]
                }
                commitRecorded = true
                actions.append(.recordPeerCommit(commit))
            }

            if sdp.type == "offer" {
                remoteOfferApplied = true
                actions.append(.applyRemoteOffer(sdp.sdp))
            } else {
                remoteAnswerApplied = true
                actions.append(.applyRemoteAnswer(sdp.sdp))
            }
            return actions
        }

        // Nothing else from an unconfirmed peer touches the PeerConnection.
        // This costs no candidate: a remote candidate is only useful once a
        // remote description exists, and the SDP that would set one is exactly
        // what has not been accepted yet.
        guard capabilityConfirmed else { return [] }

        var actions: [LinkSignalAction] = []
        if let ice = parseICE(signal) {
            actions.append(.addRemoteCandidate(candidate: ice.candidate,
                                               sdpMid: ice.sdpMid,
                                               sdpMLineIndex: ice.sdpMLineIndex))
        }
        // One reveal per establishment. A second one — a replay, or an
        // ICE-restart answer dragging the first along — must never reach the
        // handshake again: it would re-derive keys and could hand the transport
        // a second identity, and with it a second set of codecs counting from
        // zero under keys that have already been used.
        if let reveal = peerReveal(from: signal), !revealSeen {
            revealSeen = true
            actions.append(.verifyPeerReveal(reveal))
        }
        return actions
    }
}
