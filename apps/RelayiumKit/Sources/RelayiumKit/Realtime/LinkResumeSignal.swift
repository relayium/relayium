import Foundation

/// The wire vocabulary of an authenticated `link/1` transport REPLACEMENT: the
/// `resume` generation, and the tag that is the only thing on it worth trusting.
///
/// ## Why this generation carries a tag at all
///
/// An initial establishment proves who it is talking to with commit-then-reveal
/// and six digits the two users compare. A replacement runs none of that — it
/// inherits an authentication that already exists, which is the entire point:
/// re-running the handshake would derive new session keys and hand the link a
/// second `LinkCodecs`, restarting AEAD sequences under keys that have already
/// used them.
///
/// What is left is a signalling path with no handshake on it, and a signalling
/// relay that sees every SDP in the clear. Without a tag that relay simply sends
/// its own resume offer and takes over half the session: it cannot read the
/// ciphertext, but it can watch progress metadata, deliver malformed lifecycle
/// frames and replay ciphertext until a receiver's sequence is unusable. The
/// HMAC is keyed by a value derived from the first connection's session keys, so
/// "can produce this tag" is exactly "holds the keys the user compared as a
/// SAS", and that is a thing the relay never saw.
///
/// ## Pinned to the deployed web
///
/// `web/src/lib/webrtc.ts`'s `connectResumeLink` runs `establish` with
/// `generation: "resume"` and a mandatory `auth`, and `webrtc-core.ts`'s `send`
/// tags the message and only THEN signs it — `authPayload(out)` is computed over
/// the complete outbound object. The order matters as a rule even though
/// `authPayload` lists its six fields explicitly and therefore ignores the tag
/// today: what a verifier recomputes is what it received, so what a signer signs
/// has to be what it sends.
///
/// Deliberately no `commit`, no `caps` and no `reveal`. `connectResumeLink`
/// passes no `sdpExtra`, so a genuine web peer sends none of them, and every one
/// of them describes a trust step a replacement did not perform.

/// One outbound `resume` SDP signal — offer or answer — tagged and signed.
///
/// `commit` is nil and `caps` empty, which is what keeps the emitted object to
/// exactly `{sdp, resume, auth}`.
public func resumeSDPSignal(kind: String, sdp: String, key: [UInt8]) -> JSONValue {
    signedResumeSignal(sdpSignal(kind: kind, sdp: sdp, commit: nil), key: key)
}

/// One outbound `resume` ICE candidate, tagged and signed.
///
/// Candidates are covered by the tag for the same reason descriptions are: a
/// relay that could inject candidates could steer a rebuilt connection onto a
/// path of its choosing, and `authPayload` covers `candidate`, `sdpMid`,
/// `sdpMLineIndex` and `usernameFragment` precisely so it cannot.
public func resumeICESignal(_ candidate: String,
                            sdpMid: String?,
                            sdpMLineIndex: Int32?,
                            key: [UInt8]) -> JSONValue {
    signedResumeSignal(iceSignal(candidate, sdpMid: sdpMid, sdpMLineIndex: sdpMLineIndex),
                       key: key)
}

/// Tag a signal as `resume`, then sign the COMPLETE tagged signal.
///
/// The order is the contract, not an implementation detail — see this file's
/// header. Signing the untagged object would be signing something this side
/// never sends.
public func signedResumeSignal(_ data: JSONValue, key: [UInt8]) -> JSONValue {
    let tagged = taggedSignal(data, generation: .resume)
    guard case var .object(fields) = tagged else { return tagged }
    fields["auth"] = .string(signResume(key: key, payload: authPayload(tagged)))
    return .object(fields)
}

/// Whether this signal was produced by something holding `key`.
///
/// The length check runs before any base64 decode or HMAC. It costs nothing
/// against a genuine peer — `signResume` always produces exactly this many
/// characters — and it is what stops a flood of long strings from spending this
/// side's CPU on decodes that could never have verified.
///
/// A `false` here is never a failure: the caller drops the signal in silence, so
/// the genuine peer's next one still gets through and an attempt that never
/// hears one is ended by its own deadline rather than by a stranger.
public func resumeSignalIsAuthentic(_ data: JSONValue, key: [UInt8]) -> Bool {
    guard case let .object(fields) = data,
          case let .string(auth)? = fields["auth"],
          auth.count == LINK_AUTH_TAG_LENGTH else { return false }
    return verifyResume(key: key, payload: authPayload(data), mac: auth)
}
