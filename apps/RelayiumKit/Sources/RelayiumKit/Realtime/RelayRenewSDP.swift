import Foundation

/// What a renewal is allowed to change about a live PeerConnection, and what it
/// is not.
///
/// A migration restarts ICE on the SAME connection: a new ufrag, new
/// candidates, a new selected pair. It must not be able to change the DTLS peer,
/// the media shape, or the answering side's role — those are what
/// `RelayRenewSDPPin` holds fixed for every description at `epoch >= 1`.
///
/// **Pinning keeps the existing DTLS peer in place. It is NOT the root of
/// trust** — that remains the E2E key the SAS anchored. What it removes is the
/// one thing an authenticated renewal could otherwise be used for: handing a
/// live connection a description that re-points it at a different endpoint.

// MARK: - the pin

/// The three properties of an applied description a renewal may not move.
public struct RelayRenewSDPPin: Equatable, Sendable {
    /// `a=fingerprint` values, normalised to `<hash-lower> <HEX-UPPER>`, sorted
    /// and deduplicated.
    ///
    /// A SET rather than a list, and normalised rather than compared raw: the
    /// two ends may legitimately list the same fingerprints in a different
    /// order, and RFC 8122 leaves the hex case open. A raw comparison would
    /// reject a peer that merely re-rendered its own certificate.
    public let fingerprints: [String]
    /// The `a=mid` sequence, in order.
    public let mids: [String]
    /// How many `m=` lines the description has. Carried alongside `mids`
    /// because an m-line with no mid still changes the media shape.
    public let mLineCount: Int
    /// The first `a=setup` role, or nil. Compared ONLY for an answer: an offer
    /// legitimately restates `actpass`, so the role is only checked where it is
    /// actually chosen.
    public let setup: String?

    public init(fingerprints: [String], mids: [String], mLineCount: Int, setup: String?) {
        self.fingerprints = fingerprints
        self.mids = mids
        self.mLineCount = mLineCount
        self.setup = setup
    }

    /// Whether a description at `epoch >= 1` may be applied against this
    /// baseline.
    ///
    /// All three conditions, and the answer's role on top. Deliberately written
    /// as separate guards rather than one boolean chain so a future fourth
    /// condition cannot be added in a position where `&&` short-circuits past
    /// it.
    public func admits(_ other: RelayRenewSDPPin, as type: RelayRenewSDPType) -> Bool {
        guard fingerprints == other.fingerprints else { return false }
        guard mLineCount == other.mLineCount else { return false }
        guard mids == other.mids else { return false }
        guard type == .answer else { return true }
        return setup == other.setup
    }
}

/// Read the pin out of one SDP.
///
/// Total and lenient about everything it does not name: an SDP carries dozens
/// of attributes a renewal has no opinion about, and the only ones that matter
/// here are the three this extracts. A description with no fingerprint produces
/// an empty set, which can only ever equal another empty set — so a baseline
/// that never carried one cannot be used to admit a description that does.
public func relayRenewPin(sdp: String) -> RelayRenewSDPPin {
    var fingerprints: Set<String> = []
    var mids: [String] = []
    var mLineCount = 0
    var setup: String?

    for rawLine in sdp.split(whereSeparator: { $0 == "\r\n" || $0 == "\n" || $0 == "\r" }) {
        let line = String(rawLine)
        if line.hasPrefix("m=") {
            mLineCount += 1
        } else if let value = sdpAttribute(line, "fingerprint") {
            if let normalised = normalisedFingerprint(value) { fingerprints.insert(normalised) }
        } else if let value = sdpAttribute(line, "mid") {
            mids.append(value)
        } else if let value = sdpAttribute(line, "setup"), setup == nil {
            setup = value
        }
    }
    return RelayRenewSDPPin(fingerprints: fingerprints.sorted(),
                            mids: mids,
                            mLineCount: mLineCount,
                            setup: setup)
}

/// `<hash-lower> <HEX-UPPER>`, or nil for a value that is not a fingerprint.
///
/// The two halves are normalised in OPPOSITE directions on purpose, and that is
/// what the fixture pins: the hash name is a registered token compared
/// case-insensitively, while the hex digits are conventionally upper case and
/// legitimately arrive either way.
private func normalisedFingerprint(_ value: String) -> String? {
    let parts = value.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
    guard parts.count == 2 else { return nil }
    return parts[0].lowercased() + " " + parts[1].uppercased()
}

/// The value of `a=<name>:<value>` on one SDP line, or nil.
private func sdpAttribute(_ line: String, _ name: String) -> String? {
    let prefix = "a=" + name + ":"
    guard line.hasPrefix(prefix) else { return nil }
    return String(line.dropFirst(prefix.count))
}

// MARK: - ufrag binding

/// The `a=ice-ufrag` of one description, or the empty string.
///
/// This is where a LOCAL generation's name comes from: the ufrag of the
/// description whose `setLocalDescription` succeeded for that epoch. Nothing
/// here reads a "current epoch" variable, which is the whole point — see
/// `relayRenewCandidateUfrag`.
public func relayRenewICEUfrag(sdp: String) -> String {
    for rawLine in sdp.split(whereSeparator: { $0 == "\r\n" || $0 == "\n" || $0 == "\r" }) {
        if let value = sdpAttribute(String(rawLine), "ice-ufrag"), !value.isEmpty {
            return value
        }
    }
    return ""
}

/// The generation a candidate NAMES, parsed from its own ` ufrag <x>`
/// extension. The empty string when it names none.
///
/// A candidate belongs to whichever ICE generation the candidate itself names,
/// never to whatever epoch happens to be current when the callback fires.
/// `didGenerate` is asynchronous and a restart can land between gathering and
/// delivery, so labelling by a mutable "current epoch" variable attributes
/// candidates to the wrong generation — which is exactly how an old relay
/// candidate would be presented as proof of a new path.
///
/// Apple's `RTCIceCandidate` exposes no `usernameFragment` property at all, so
/// this parse is the only source on this platform, and a local candidate whose
/// ufrag cannot be parsed is dropped rather than sent.
///
/// The scan starts at the first extension pair rather than at token 0, so a
/// transport, an address or a candidate type that happened to read `ufrag`
/// cannot be mistaken for the extension's name.
public func relayRenewCandidateUfrag(candidate: String) -> String {
    var line = candidate
    if line.hasPrefix("a=") { line = String(line.dropFirst(2)) }
    let tokens = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    // foundation, component, transport, priority, address, port, "typ", type.
    let firstExtension = 8
    guard tokens.count > firstExtension else { return "" }
    var i = firstExtension
    while i + 1 < tokens.count {
        if tokens[i] == "ufrag" { return tokens[i + 1] }
        i += 2
    }
    return ""
}

/// The generation an INBOUND candidate names, reconciling its two possible
/// sources. The empty string means the candidate cannot be bound and must be
/// dropped.
///
/// - Both present and equal, or only one present: that value.
/// - Both present and contradictory: dropped. A peer that names two
///   generations for one candidate has named none this side may act on, and
///   preferring either source would let the disagreement decide which.
/// - Neither present: dropped, for the reason spec §3.2 gives — a candidate
///   whose generation cannot be named cannot be bound to an epoch.
public func relayRenewInboundCandidateUfrag(candidate: String,
                                            usernameFragment: String) -> String {
    let fromString = relayRenewCandidateUfrag(candidate: candidate)
    let fromField = usernameFragment
    if fromString.isEmpty { return fromField }
    if fromField.isEmpty { return fromString }
    return fromString == fromField ? fromString : ""
}
