import Foundation

/// Builds/parses the realtime signaling `data` payloads exchanged over the
/// signaling WebSocket, matching `web/src/lib/webrtc-core.ts`'s `InboundSignal`
/// shape: `sdp` is an `RTCSessionDescriptionInit` (`{type, sdp}`), `ice` is an
/// `RTCIceCandidateInit` (`{candidate, sdpMid, sdpMLineIndex}`), and `commit`
/// rides alongside `sdp` at the top level (`sdpExtra` in webrtc.ts) rather than
/// nested inside it. `commit`/`reveal` parsing itself is *not* reimplemented
/// here — see `peerCommit`/`peerReveal` in Handshake/HandshakeMessage.swift.

/// Independent signalling generations sharing one signalling room.
///
/// Untagged is deliberately `file`: every already-deployed peer sends that
/// shape. Resume wins if an untrusted signal sets both flags, matching the web
/// implementation and preventing an ambiguous signal from entering text.
public enum RealtimeGeneration: Equatable {
    case file
    case resume
    case text
    /// The web's combined file+text peer link (`webrtc-core.ts`'s `"link"`).
    ///
    /// This client never opens one — it advertises no link capability, so a web
    /// peer falls back to the file/text generations. The case exists so a `link`
    /// signal is *recognised as not ours* instead of being read as an untagged
    /// file signal, which is what the three-case version did: a link offer would
    /// have been answered as a file transfer that then waits for a manifest
    /// nobody is going to send.
    case link
}

public func signalGeneration(_ data: JSONValue) -> RealtimeGeneration {
    guard case let .object(fields) = data else { return .file }
    // Same precedence as web/src/lib/webrtc-core.ts's signalGeneration.
    if case .bool(true)? = fields["resume"] { return .resume }
    if case .bool(true)? = fields["link"] { return .link }
    if case .bool(true)? = fields["text"] { return .text }
    return .file
}

/// The exact capability a text session requires of its peer, in both
/// directions. Not a security input — the relay sees and could forge every
/// frame — but a text offer without it means the peer cannot decode kind-9
/// frames, so answering one produces a session that can never carry a message.
public let TEXT_CAPABILITY = "text/1"

/// Which generation an inbound signal opens a *new* responder session for, or
/// `nil` if it opens none.
///
/// Mirrors the web's `routeOffer`/`isTextOffer` pair, and every clause is a way
/// a background listener goes wrong:
///
/// * Only a real SDP **offer** starts a session. An answer, an ICE candidate or
///   a reveal belongs to a connection that already exists; treating one as a new
///   session both loses the frame and spends a connection on nothing.
/// * `resume` re-attaches to a paused transfer this client does not implement,
///   and `link` is the web's own generation. Neither is a new session here, and
///   answering either would strand the initiator on a wire it is not speaking.
/// * A `text` offer must carry exact `text/1`. Anything else fails closed:
///   silence is the truthful answer to a dialect we cannot speak, and a `busy`
///   reply would tell the peer to try again later, which is not what is wrong.
public func inboundOfferGeneration(_ data: JSONValue) -> RealtimeGeneration? {
    guard parseSDP(data)?.type == "offer" else { return nil }
    switch signalGeneration(data) {
    case .file:
        return .file
    case .text:
        return peerCaps(from: data).contains(TEXT_CAPABILITY) ? .text : nil
    case .resume, .link:
        return nil
    }
}

/// Applies the generation tag to any outbound signal. File stays byte-for-byte
/// untagged for backward compatibility.
public func taggedSignal(_ data: JSONValue, generation: RealtimeGeneration) -> JSONValue {
    guard case var .object(fields) = data else { return data }
    switch generation {
    case .file:
        break
    case .resume:
        fields["resume"] = .bool(true)
    case .text:
        fields["text"] = .bool(true)
    case .link:
        // Never produced by this client (nothing constructs a `.link`
        // connection); present so the mapping stays total and a future link
        // implementation cannot silently emit untagged file signals.
        fields["link"] = .bool(true)
    }
    return .object(fields)
}

/// Merges capability hints alongside an SDP/commit object. Empty capabilities
/// add no field, preserving the legacy signal exactly.
public func addingCaps(_ caps: [String], to data: JSONValue) -> JSONValue {
    guard !caps.isEmpty, case var .object(fields) = data else { return data }
    fields["caps"] = .array(caps.map(JSONValue.string))
    return .object(fields)
}

/// `kind` is "offer" or "answer". When `commit` is non-nil it is merged in
/// alongside `sdp`, matching webrtc.ts's `send({ sdp, ...sdpExtra() })`.
public func sdpSignal(kind: String,
                      sdp: String,
                      commit: String?,
                      generation: RealtimeGeneration = .file,
                      caps: [String] = []) -> JSONValue {
    var fields: [String: JSONValue] = ["sdp": .object(["type": .string(kind), "sdp": .string(sdp)])]
    if let commit {
        fields["commit"] = .string(commit)
    }
    return taggedSignal(addingCaps(caps, to: .object(fields)), generation: generation)
}

public func iceSignal(_ candidate: String, sdpMid: String?, sdpMLineIndex: Int32?) -> JSONValue {
    .object(["ice": .object([
        "candidate": .string(candidate),
        "sdpMid": sdpMid.map(JSONValue.string) ?? .null,
        "sdpMLineIndex": sdpMLineIndex.map { .number(Double($0)) } ?? .null,
    ])])
}

public func busySignal() -> JSONValue {
    .object(["busy": .bool(true)])
}

public func parseSDP(_ data: JSONValue) -> (type: String, sdp: String)? {
    guard case let .object(o) = data, case let .object(s)? = o["sdp"],
          case let .string(type)? = s["type"], case let .string(sdp)? = s["sdp"] else { return nil }
    return (type, sdp)
}

public func parseICE(_ data: JSONValue) -> (candidate: String, sdpMid: String?, sdpMLineIndex: Int32?)? {
    guard case let .object(o) = data, case let .object(i)? = o["ice"],
          case let .string(candidate)? = i["candidate"] else { return nil }
    var sdpMid: String?
    if case let .string(m)? = i["sdpMid"] { sdpMid = m }
    var sdpMLineIndex: Int32?
    if case let .number(n)? = i["sdpMLineIndex"] { sdpMLineIndex = Int32(exactly: n) }
    return (candidate, sdpMid, sdpMLineIndex)
}

/// Capabilities this build advertises, merged alongside `sdp`/`commit` the way
/// webrtc.ts's `sdpExtra` does. A hint, never a security input: the signalling
/// relay sees every frame and can strip or forge it, which can only deny a
/// message session, never downgrade one -- the message key is derived, not
/// negotiated.
public func capsField(_ caps: [String]) -> JSONValue {
    .object(["caps": .array(caps.map(JSONValue.string))])
}

/// The peer's advertised capabilities, parsed leniently: absent is not an error
/// (every already-deployed peer sends none), a non-array is ignored, and
/// non-string entries are dropped rather than trusted.
public func peerCaps(from data: JSONValue) -> [String] {
    guard case let .object(o) = data, case let .array(items)? = o["caps"] else { return [] }
    return items.compactMap { if case let .string(s) = $0 { return s } else { return nil } }
}

public func parseBusy(_ data: JSONValue) -> Bool {
    guard case let .object(o) = data, case let .bool(b)? = o["busy"] else { return false }
    return b
}
