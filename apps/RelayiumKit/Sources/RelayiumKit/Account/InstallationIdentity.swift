import Foundation
import Security

/// Where an installation identity is kept.
///
/// Deliberately narrower than `TokenStore`: there is no `clear()` here, because
/// nothing in the product is allowed to erase this value. `KeychainTokenStore`
/// satisfies it, so the identity uses the same audited keychain path as the
/// bearer — under its own account key, which is what keeps a sign-out that
/// clears the bearer from taking this with it.
public protocol InstallationIdentityStoring {
    func save(_ id: String) throws
    func load() throws -> String?
}

extension KeychainTokenStore: InstallationIdentityStoring {}

/// The opaque, account-independent identifier for THIS installation of the app.
///
/// It exists to answer one question — "which device row is this Mac" — so that
/// signing out and signing back in lands on the row this machine already owns
/// instead of minting a third one. It is **not a credential**: presenting it
/// authenticates nothing, returns no token, and is consulted by central only
/// after a human has approved a device-code login, and only within the
/// approving account (`server/account/deviceauth.go`, `RegisterApprovedDevice`).
///
/// It is random, never derived from the machine. A serial number, MAC address
/// or hostname would make the value guessable by anyone who knows the machine,
/// would follow the hardware across owners, and would turn a lookup hint into a
/// fingerprint the product has no business collecting.
public enum InstallationIdentity {
    /// 32 bytes, which is far more than a lookup key needs — the point is that
    /// two independently generated installations colliding is not a case anyone
    /// has to reason about.
    public static let byteCount = 32
    /// The unpadded RawURLEncoding length of `byteCount` bytes.
    public static let characterCount = 43

    /// A fresh identity from the system CSPRNG.
    ///
    /// `SecRandomCopyBytes` rather than any convenience wrapper: this value is
    /// long-lived and account-visible in effect, and a failure to gather real
    /// entropy must be loud rather than silently degraded. A refusal here means
    /// no identity, which the caller degrades to "send no hint".
    public static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return ""
        }
        return encode(Data(bytes))
    }

    /// Whether a string is one this product could have produced.
    ///
    /// The server compares this value as TEXT, so a second spelling of the same
    /// bytes would be a second identity for one installation. Only the exact
    /// canonical form is accepted, which mirrors `validInstallID` in
    /// `server/account/installid.go` — the two must agree or a value this app
    /// keeps is one the server silently ignores.
    public static func isValid(_ candidate: String) -> Bool {
        guard candidate.count == characterCount else { return false }
        guard let data = decode(candidate), data.count == byteCount else { return false }
        // Round-trip rather than a character-class check: it is the one test
        // that rejects a non-canonical final character (a 32-byte value leaves
        // two unused bits there) without restating base64's own rules.
        return encode(data) == candidate
    }

    private static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decode(_ s: String) -> Data? {
        // Rejected before padding, not after: `Data(base64Encoded:)` is
        // tolerant of several inputs this product never emits, and a string
        // carrying '+', '/' or '=' is already not the URL-safe unpadded form.
        guard !s.contains("+"), !s.contains("/"), !s.contains("=") else { return nil }
        var padded = s.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
        return Data(base64Encoded: padded)
    }
}

/// Reads this installation's identity, creating it the first time.
///
/// Memoized, so the keychain is consulted once per launch and every caller in
/// one run agrees. Failure is a `nil` answer, never a thrown error and never an
/// invented value: the identity is an optimisation, and losing it costs device-
/// row reuse, while failing a sign-in over it would cost the user the product.
public final class InstallationIdentityProvider {
    private let store: InstallationIdentityStoring
    private var cached: String?
    private var resolved = false

    public init(store: InstallationIdentityStoring) { self.store = store }

    /// This installation's identity, or nil when the store cannot answer.
    public func current() -> String? {
        if resolved { return cached }
        resolved = true
        cached = resolve()
        return cached
    }

    private func resolve() -> String? {
        let stored: String?
        do {
            stored = try store.load()
        } catch {
            // A read that FAILED is not a read that found nothing. Minting here
            // would overwrite an identity that is very likely still there —
            // turning a locked keychain into a permanently split device list.
            return nil
        }
        if let stored, InstallationIdentity.isValid(stored) { return stored }
        // Either nothing was stored, or what was stored is not a value this
        // product could have written (a truncated item, a hand-edited one, a
        // format from a future version). Neither is safe to send: the server
        // would refuse it, and keeping it would pin this installation to an
        // identity that can never match a row.
        let minted = InstallationIdentity.generate()
        guard InstallationIdentity.isValid(minted) else { return nil }
        do {
            try store.save(minted)
        } catch {
            // An identity that does not survive this launch is worse than none:
            // it would register a device row that the next launch could never
            // find again, which is the very defect this whole mechanism exists
            // to remove. Send no hint instead.
            return nil
        }
        return minted
    }
}
