import Foundation

/// The parts of a native Sign in with Apple attempt that are NOT
/// `AuthenticationServices`.
///
/// `ASAuthorizationController` and its credential type live in the iOS app
/// target, because that is where the system UI is. Everything around them —
/// minting the nonce, reading the two credential fields, formatting the name
/// Apple sends once — is ordinary value logic with exactly the failure modes a
/// test can drive, so it lives here instead of inside a SwiftUI closure where
/// nothing can reach it.

/// One authorization attempt's nonce, and the identity that says which attempt
/// it belongs to.
///
/// The nonce is generated per tap and travels twice: onto the
/// `ASAuthorizationAppleIDRequest`, and — after Apple echoes it inside the
/// identity token — to the server, which refuses a token whose `nonce` claim is
/// anything else. That is what stops an identity token captured somewhere else
/// from being replayed into this app's sign-in.
///
/// It is sent RAW rather than hashed on purpose: Apple returns the nonce
/// verbatim in the token's `nonce` claim, and the server compares it for
/// equality — the same comparison the shipped browser flow already makes. A
/// SHA-256 of it would never match, and a client that hashed one copy and sent
/// the other would only be describing a protocol nobody on the far side speaks.
public struct AppleSignInAttempt: Equatable, Sendable {
    /// Distinguishes this attempt from the one before it. It travels as OAuth
    /// `state`, so a view can prove that the credential coming back is the
    /// authorization it still holds a nonce for rather than some older one.
    public let id: UUID
    public let nonce: String

    public init(id: UUID = UUID(), nonce: String) {
        self.id = id
        self.nonce = nonce
    }

    /// The opaque OAuth correlation value put on the Apple request.
    public var state: String { id.uuidString }

    /// Refuse a completion with no state as well as one from another attempt.
    /// Comparing the returned credential before consuming this attempt is what
    /// lets a late completion leave a newer pending authorization intact.
    public func matches(returnedState: String?) -> Bool {
        returnedState == state
    }

    /// A fresh attempt with 32 bytes of cryptographically secure randomness,
    /// base64url-encoded.
    ///
    /// base64url specifically: the value ends up inside a JWT claim and is
    /// compared as a string across three systems, so it may not contain `+`,
    /// `/` or `=` — characters that survive some transports and not others.
    public static func fresh() -> AppleSignInAttempt {
        var generator = SystemRandomNumberGenerator()
        var bytes = Data(capacity: 32)
        // `SystemRandomNumberGenerator` is documented as cryptographically
        // secure on every Apple platform (it reads the system CSPRNG). Four
        // 64-bit draws are 32 bytes.
        for _ in 0..<4 {
            var word = generator.next()
            withUnsafeBytes(of: &word) { bytes.append(contentsOf: $0) }
        }
        return AppleSignInAttempt(nonce: base64URL(bytes))
    }

    /// RFC 4648 §5 without padding.
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// What a completed authorization actually gives the server.
///
/// Both fields arrive from `AuthenticationServices` as `Data?` holding UTF-8
/// text, and both are required: the identity token is the claim, the one-time
/// authorization code is the proof that the claim is live. A missing or
/// non-UTF-8 value is not something to paper over with an empty string — the
/// server would refuse it anyway, one round trip later, having burned a
/// rate-limit slot to say so.
public struct AppleSignInCredential: Equatable, Sendable {
    public let idToken: String
    public let authorizationCode: String

    public init(idToken: String, authorizationCode: String) {
        self.idToken = idToken
        self.authorizationCode = authorizationCode
    }

    /// Read both fields, or say precisely which one was not there.
    public static func read(identityToken: Data?,
                            authorizationCode: Data?) throws -> AppleSignInCredential {
        guard let identityToken, let token = utf8(identityToken), !token.isEmpty else {
            throw AppleSignInError.missingIdentityToken
        }
        guard let authorizationCode, let code = utf8(authorizationCode), !code.isEmpty else {
            throw AppleSignInError.missingAuthorizationCode
        }
        return AppleSignInCredential(idToken: token, authorizationCode: code)
    }

    private static func utf8(_ data: Data) -> String? {
        String(data: data, encoding: .utf8)
    }
}

/// The display name Apple sends on the FIRST authorization and never again.
public enum AppleSignInName {
    /// Join the two components the way the server's browser flow already does
    /// (`appleNameFromForm`: first, a space, last, trimmed), so one Apple
    /// account reaches the same account row under the same name whichever
    /// surface it signed in from.
    ///
    /// Returns an empty string when Apple sent nothing — which is every
    /// authorization after the first. Empty is honest and the server treats it
    /// as "no name given"; inventing one from the email address would put a
    /// fabricated name on the account permanently.
    public static func format(givenName: String?, familyName: String?) -> String {
        let parts = [givenName, familyName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.joined(separator: " ")
    }
}

/// A native Apple authorization that produced nothing usable.
///
/// Distinct from `AccountError.appleRejected`, which is the SERVER refusing a
/// credential that did arrive. These never left the device, so the copy for
/// them may not talk about a sign-in being refused.
public enum AppleSignInError: Error, Equatable {
    /// The authorization succeeded but carried no identity token.
    case missingIdentityToken
    /// …or no one-time authorization code. Without it the server cannot prove
    /// the authorization is live and will refuse the attempt, so there is
    /// nothing to gain by sending it.
    case missingAuthorizationCode
    /// The credential was not the Apple ID kind (a password credential from the
    /// same API, chiefly) — nothing this flow can use.
    case unexpectedCredential
    /// `AuthenticationServices` failed for its own reasons: no network, the
    /// system sheet could not be presented, an unknown error. Cancellation is
    /// NOT one of these — a user who backed out asked for nothing to happen,
    /// including no error.
    case authorizationFailed
}
