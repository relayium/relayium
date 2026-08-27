import Foundation

/// Which closed protocol field carried a value this build does not understand.
///
/// Named rather than free text so a refusal can be asserted by a test and
/// reported by a caller without any part of the server's response text — which
/// is remote input — being carried further.
public enum InboxProtocolField: String, Equatable, Sendable {
    case taskState
    case errorCode
    case presence
    case autoAccept
    case protocolVersion
    case receiveCapability
    case keyAlgorithm
}

/// Everything the Device Inbox client half can refuse or fail on.
///
/// Deliberately a typed enum with NO message strings. Two reasons, and both are
/// load-bearing rather than stylistic:
///
///  * a case carries only tokens this protocol already defines, so there is no
///    field through which a file name, a destination path, a bearer, a claim
///    token or key material could reach a log line or a crash report;
///  * the localized sentence a user eventually reads belongs to the UI layer
///    (Phase 2B), which maps these cases through `L10n`. An English string here
///    would be an untranslated sentence shipped in every language.
public enum InboxError: Error, Equatable, Sendable {
    /// Central rejected the request. `code` is the machine-readable token when
    /// the body carried one — never the body itself.
    case api(status: Int, code: String)
    /// A 2xx body that is not the shape this build expects.
    case malformedResponse
    /// A closed set carried a value this build does not know. Fail closed.
    case unknownProtocolValue(field: InboxProtocolField)
    /// The transport failed. Carries nothing: a `URLError` composes its text
    /// from a URL, and an unbounded remote string has no business in a log.
    case network
    /// Central named a protocol version, receive capability or key algorithm
    /// this build does not implement. "Upgrade or stop", never "retry with a
    /// default".
    case unsupportedByServer(field: InboxProtocolField)
    /// The presented credential is not bound to a device row. A credential
    /// problem (revoked, rotated, or a cookie where a bearer was expected), not
    /// a transient failure.
    case noCurrentDevice
    /// A resumed ciphertext read was answered with a full `200` body. Splicing a
    /// fresh start into the middle of a stream would produce
    /// authenticated-looking garbage, so the caller must restart instead.
    case rangeIgnored
    /// An identifier that could not safely become a URL path component or a
    /// keychain account name.
    case invalidIdentifier
    /// A state central does not accept from a DEVICE. Refused before a request
    /// exists: `expired`/`revoked` are central's judgements about time and
    /// authorization, and a device that could report `queued` could reset its own
    /// backoff.
    case stateNotDeviceReportable(InboxTaskState)
    /// `saved` was named without the explicit commit assertion. Central cannot
    /// observe a local commit, so its absence is a refusal, never an assumption.
    case savedNotAsserted
    /// A sender-minted creation key central would refuse: empty, longer than
    /// the protocol bound, or carrying a byte outside printable ASCII.
    ///
    /// Refused locally rather than left to the 400, because this key is the
    /// ONLY thing that converges a retried create onto one task. A send that
    /// discovered its key was unusable after the ciphertext was uploaded would
    /// have no way to retry safely.
    case invalidIdempotencyKey
    /// A `wrappedKey` that is not canonical base64url of exactly
    /// `InboxProtocol.sealedBoxBytes`. Central applies the identical check; this
    /// one means a malformed box never becomes a request at all.
    case invalidWrappedKey
    /// A wrap algorithm token this build does not implement, named by the
    /// CALLER. Distinct from `unsupportedByServer(field: .keyAlgorithm)`, which
    /// is central naming one — the two have different culprits and different
    /// remedies.
    case unsupportedWrapAlgorithm
    /// A target key generation that cannot identify a key: central mints these
    /// from 1 upward, so zero or negative means the device row was never read.
    case invalidKeyGeneration

    /// The rejection token, when this is an `api` failure central named.
    public var rejection: InboxRejection? {
        guard case .api(_, let code) = self else { return nil }
        return InboxRejection(rawValue: code)
    }

    /// The HTTP status, when this is an `api` failure.
    public var status: Int? {
        guard case .api(let status, _) = self else { return nil }
        return status
    }
}

extension InboxWire {
    /// Fails closed. Every caller is a decoder, so an unknown value throws out of
    /// the decode rather than resolving to a default the server never sent.
    static func closed<T: RawRepresentable>(
        _ type: T.Type, _ raw: String, field: InboxProtocolField
    ) throws -> T where T.RawValue == String {
        guard let value = T(rawValue: raw) else {
            throw InboxError.unknownProtocolValue(field: field)
        }
        return value
    }
}
