import Foundation

/// Which inbound signals an authenticated `link/1` transport REPLACEMENT will
/// act on, and what each one means.
///
/// ## Why it is separate from the driver
///
/// This object is the whole of the security boundary a replacement adds, and
/// none of it needs an `RTCPeerConnection` to decide. A replacement runs no
/// commit-reveal — it rebuilds the transport under an authentication that
/// already exists — so possession of that link's `resumeAuth` key is the only
/// thing standing between it and a signalling relay offering its own
/// replacement transport. Every rule below is a way that relay wins if the rule
/// is missing, and welding them into a WebRTC driver would make each one
/// reachable only from a two-peer run.
///
/// It reuses `LinkSignalAction` rather than inventing a parallel vocabulary,
/// and the actions it can produce are a strict SUBSET of an establishment's:
/// apply one description, add candidates. There is no `recordPeerCommit` and no
/// `verifyPeerReveal`, which is what makes "a replacement feeds no handshake"
/// structural rather than a promise — a `commit` or `reveal` smuggled onto an
/// authenticated resume signal reaches nothing, because nothing here can emit
/// the action that would carry it.
///
/// ## What it accepts
///
/// EXACTLY the `resume` generation, exactly from this link's peer, in exactly
/// the role the original connection settled, and only with a tag that verifies
/// under this link's own key. `signalGeneration` ranks `resume` above `link`,
/// so a signal carrying both flags is a rebuild and is this object's business
/// rather than `LinkSignalPolicy`'s.
///
/// ## What it never does
///
/// It never produces `.fail`. Everything it will not act on is dropped in
/// SILENCE, which is both halves of one decision: answering would tell a
/// signalling relay which peer holds a live link, and failing would hand any
/// stranger on the socket a one-message kill switch for a rebuild it otherwise
/// cannot touch. An attempt that never hears its genuine peer is ended by
/// `LinkEstablishmentWatchdog`'s bounded deadlines instead.
///
/// That deliberately includes `busy`, which the shared transport skeleton in
/// `webrtc-core.ts` handles BEFORE its authentication check. Nothing in the
/// deployed web sends a `busy` on the `resume` generation — `peer-link`'s
/// refusals all ride the `link` generation, and neither `connectResume` nor
/// `connectResumeLink` produces one — so ignoring it costs no interoperability
/// and removes an unauthenticated way to end an authenticated rebuild.
///
/// It performs the tag verification itself rather than routing it upward,
/// because the decision it protects — consuming the one remote description this
/// transport will ever apply — must not be reachable by anything unverified.
/// `signResume` is synchronous here, so unlike the web there is no window
/// between "this looks like the rebuild" and "this is provably the peer".
public final class LinkResumePolicy {
    private let peerId: String
    private let role: Role
    private let key: [UInt8]

    private var remoteOfferApplied = false
    private var remoteAnswerApplied = false

    /// - Parameters:
    ///   - role: the role the ORIGINAL connection settled, carried on the
    ///     inherited `LinkIdentity`. Never recomputed: both sides must keep the
    ///     offerer/responder split their first connection produced, or a rebuild
    ///     turns two peers into two offerers racing SDP into one pair of lanes.
    ///   - resumeAuthKey: this link's own `LinkCodecs.resumeAuthKey`. Two
    ///     concurrent rebuilds on one socket — a legacy file transfer's and a
    ///     link's — each verify under their OWN key, so neither can consume the
    ///     other's offer. The key, not the tag vocabulary, is what separates
    ///     them.
    public init(peerId: String, role: Role, resumeAuthKey: [UInt8]) {
        self.peerId = peerId
        self.role = role
        self.key = resumeAuthKey
    }

    public func plan(from: String, signal: JSONValue) -> [LinkSignalAction] {
        // A room is a broadcast surface. Anything from anyone else is not this
        // transport's business, whatever it claims to be.
        guard from == peerId else { return [] }
        // EXACTLY the resume generation. `.link` is an establishment's,
        // `.file`/`.text` the legacy connections'.
        guard signalGeneration(signal) == .resume else { return [] }

        let sdp = parseSDP(signal)
        let ice = parseICE(signal)
        // Nothing else on this generation is actionable — deliberately including
        // `busy`, see the type comment. Deciding that before the HMAC keeps a
        // signal shaped like nothing at all from costing a verification.
        guard sdp != nil || ice != nil else { return [] }

        if let sdp {
            // Whether this description is one we COULD act on, before spending
            // anything on it: a duplicate, an answer to nobody, or an offer
            // arriving at the original initiator is refused here. This only ever
            // rejects — the once-only slot below is set after verification — so
            // a cheap refusal can never consume it.
            switch sdp.type {
            case "offer": guard role == .responder, !remoteOfferApplied else { return [] }
            case "answer": guard role == .initiator, !remoteAnswerApplied else { return [] }
            default: return []
            }
        }

        // The one thing that proves who sent this. Everything above is a filter;
        // this is the boundary. Nothing below it can be reached by a signal
        // whose tag is missing, malformed, forged, from another session, or
        // computed over bytes that were rewritten in flight.
        guard resumeSignalIsAuthentic(signal, key: key) else { return [] }

        if let sdp {
            // Handled whole, matching `LinkSignalPolicy`: one decision per
            // signal, and nothing either side produces carries both a
            // description and a candidate.
            if sdp.type == "offer" {
                remoteOfferApplied = true
                return [.applyRemoteOffer(sdp.sdp)]
            }
            remoteAnswerApplied = true
            return [.applyRemoteAnswer(sdp.sdp)]
        }

        guard let ice else { return [] }
        // Ordering against the description this candidate belongs to is
        // `LinkCandidateGate`'s: `setRemoteDescription` is asynchronous, so a
        // verified candidate can still reach the driver before the verified
        // description it needs has been applied.
        return [.addRemoteCandidate(candidate: ice.candidate,
                                    sdpMid: ice.sdpMid,
                                    sdpMLineIndex: ice.sdpMLineIndex)]
    }
}
