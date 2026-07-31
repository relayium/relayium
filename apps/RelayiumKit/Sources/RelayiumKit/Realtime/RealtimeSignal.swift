import Foundation

/// Builds/parses the realtime signaling `data` payloads exchanged over the
/// signaling WebSocket, matching `web/src/lib/webrtc-core.ts`'s `InboundSignal`
/// shape: `sdp` is an `RTCSessionDescriptionInit` (`{type, sdp}`), `ice` is an
/// `RTCIceCandidateInit` (`{candidate, sdpMid, sdpMLineIndex}`), and `commit`
/// rides alongside `sdp` at the top level (`sdpExtra` in webrtc.ts) rather than
/// nested inside it. `commit`/`reveal` parsing itself is *not* reimplemented
/// here — see `peerCommit`/`peerReveal` in Handshake/HandshakeMessage.swift.

/// Independent signalling generations sharing one pairing-code room.
///
/// Untagged is deliberately `file`: every already-deployed peer sends that
/// shape. Resume wins if an untrusted signal sets both flags, matching the web
/// implementation and preventing an ambiguous signal from entering text.
public enum RealtimeGeneration: Equatable {
    case file
    case resume
    case text
}

public func signalGeneration(_ data: JSONValue) -> RealtimeGeneration {
    guard case let .object(fields) = data else { return .file }
    if case .bool(true)? = fields["resume"] { return .resume }
    if case .bool(true)? = fields["text"] { return .text }
    return .file
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
