import Foundation
import Security

/// The only Bonjour service iOS Nearby advertises or browses.
public let LOCAL_PEER_SERVICE_TYPE = "_relayium._tcp"
public let LOCAL_PEER_SERVICE_DOMAIN = "local."

/// Public, unauthenticated discovery metadata. Nothing here is a key or an
/// authenticated identity; commit/reveal SAS still authenticates the session.
public struct LocalPeerAdvertisement: Equatable, Sendable {
    public static let identityKey = "i"
    public static let nameKey = "n"
    public static let capabilitiesKey = "c"
    public static let identityLength = 32
    public static let maximumNameBytes = 64
    /// One separator, so the field is a list rather than a nested encoding a
    /// parser could be talked into walking.
    public static let capabilitySeparator: Character = ","
    public static let maximumCapabilityBytes = 24
    public static let maximumCapabilities = 8

    public let identity: String
    public let name: String
    /// What the peer says it can speak.
    ///
    /// A HINT, on exactly the footing `PeerCapabilityRegistry` already documents
    /// for a roster hello: it can be stripped (the feature is denied) or forged
    /// (we invite a peer that cannot answer — also a denial), and neither can put
    /// plaintext on the wire, because session keys are derived through
    /// commit/reveal rather than negotiated here.
    ///
    /// It is carried in the TXT record rather than synthesised locally, and that
    /// is the whole point of the field. Crediting a discovered peer with THIS
    /// build's capability list would mean the roster states a capability no peer
    /// ever announced — an announcement about ourselves wearing somebody else's
    /// id — and two builds that disagreed about what `_relayium._tcp` speaks
    /// would each invite the other into an establishment it cannot answer. The
    /// roster hello exists to land before anybody dials; on a local link the
    /// advertisement IS that hello.
    public let capabilities: [String]

    public init(identity: String, name: String, capabilities: [String]) {
        self.identity = identity
        self.name = name
        self.capabilities = capabilities
    }

    /// A per-channel value avoids broadcasting a durable installation handle.
    public static func mintIdentity() -> String {
        var bytes = [UInt8](repeating: 0, count: identityLength / 2)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(result == errSecSuccess, "local discovery requires a random identity")
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    public static func isValidIdentity(_ value: String) -> Bool {
        value.utf8.count == identityLength
            && value.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    /// Printable ASCII, no separator, bounded. A capability is compared for
    /// EXACT equality everywhere it is read, so anything a comparison could not
    /// match is rejected here rather than carried as an unusable token.
    public static func isValidCapability(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.count <= maximumCapabilityBytes else { return false }
        return bytes.allSatisfy { $0 > 0x20 && $0 < 0x7f && $0 != UInt8(ascii: ",") }
    }

    public var serviceInstanceName: String { identity }
    public var txtRecord: [String: String] {
        [Self.identityKey: identity,
         Self.nameKey: name,
         Self.capabilitiesKey: capabilities.joined(separator: String(Self.capabilitySeparator))]
    }

    /// Unknown keys and Bonjour-renamed instances are incompatible peers, not
    /// partially understood ones. A future record shape must use a new type.
    public static func parse(instanceName: String,
                             txtRecord: [String: String]) -> LocalPeerAdvertisement? {
        guard Set(txtRecord.keys) == [identityKey, nameKey, capabilitiesKey],
              let identity = txtRecord[identityKey],
              identity == instanceName,
              isValidIdentity(identity),
              let name = txtRecord[nameKey],
              !name.isEmpty,
              name.utf8.count <= maximumNameBytes,
              let field = txtRecord[capabilitiesKey],
              let capabilities = parseCapabilities(field) else { return nil }
        return LocalPeerAdvertisement(identity: identity,
                                      name: name,
                                      capabilities: capabilities)
    }

    /// A capability list a peer could not have meant is not a peer with fewer
    /// capabilities — it is a record this build does not understand, and the
    /// whole advertisement is refused rather than admitted with a guess.
    ///
    /// Duplicates are rejected rather than collapsed: two spellings of one
    /// claim is how a list gets read as longer than the bound that admitted it.
    static func parseCapabilities(_ field: String) -> [String]? {
        let tokens = field.split(separator: capabilitySeparator,
                                 omittingEmptySubsequences: false).map(String.init)
        guard !tokens.isEmpty, tokens.count <= maximumCapabilities,
              tokens.allSatisfy(isValidCapability),
              Set(tokens).count == tokens.count else { return nil }
        return tokens
    }
}
