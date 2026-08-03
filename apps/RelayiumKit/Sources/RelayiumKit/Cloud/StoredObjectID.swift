import Foundation

/// The one rule for a server-supplied stored-object or upload identifier.
///
/// Four subsystems compose one of these into something where a stray character
/// changes the meaning rather than the value:
///
/// - `KeychainStoredLinkKeyStore` concatenates it into `kSecAttrAccount`,
/// - `AccountClient.authedDelete` appends it as a URL path component,
/// - `HTTPResumableTransport` appends the resumable `uploadId` as a path
///   component of every PATCH, GET-offset and finalize,
/// - `buildDownloadLink` interpolates it into `origin/d/<id>#k=<key>`, which is
///   then shown to the user as the link that opens the upload.
///
/// All four need it to stay ONE inert token. Refusing separators, dot segments,
/// query/fragment delimiters, whitespace and non-ASCII means a hostile or merely
/// surprising id can neither name a *different* keychain item — including the
/// bearer token, which shares the service — nor steer a request at a different
/// endpoint, nor produce a link that points somewhere other than the object that
/// was just uploaded.
///
/// **Refused, never sanitised, never percent-encoded.** Escaping would let two
/// distinct ids collapse onto one keychain account, silently losing a key, and
/// percent-encoding cannot help a `.` or `..` that a server, proxy or
/// `URLSession` resolves for its own reasons. Refusing is the only defence that
/// does not depend on who normalises the path.
///
/// Every id any caller can be handed is `authx.NewID()`: 32 hex characters, so
/// nothing legitimate is anywhere near the edge of this.
///
/// It raises `StoredLinkKeyError.invalidIdentifier` rather than a case of its
/// own. That error is already the shared one — `AccountClient` has always raised
/// it without touching a key store — and it is the case `ErrorCopy` localizes,
/// so one refusal keeps one sentence in all nine catalogs.
public enum StoredObjectID {
    /// Wide enough for any plausible future id format, narrow enough that every
    /// member is inert in a keychain attribute, a URL path and a link.
    static let characters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    static let maxLength = 128

    public static func checked(_ id: String) throws -> String {
        guard !id.isEmpty, id.count <= maxLength,
              id.allSatisfy({ characters.contains($0) }) else {
            throw StoredLinkKeyError.invalidIdentifier
        }
        return id
    }
}
