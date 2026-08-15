import Foundation

public enum AppDeepLink: Equatable {
    case download(URL)
    case realtime(code: String?)
    case realtimeWithMode(code: String, mode: TransferMode)
}

/// Must stay byte-identical to `signal.CodeAlphabet` (Go) and `CODE_ALPHABET`
/// (web). A pairing code is six decimal digits — nothing else — which is what
/// lets every client offer a numeric keypad and lets the copy say "six digits"
/// without listing an alphabet. It is NOT the same six digits as the SAS.
private let pairingAlphabet = Set("0123456789")
private let pairingCodeLength = 6

/// The same filtering the web and macOS pairing fields use: keep the digits,
/// discard everything else, and cap the result at six.
///
/// Deliberately string-only: "004291" and "000000" are ordinary codes, so any
/// Int round-trip here would silently destroy a tenth of the code space.
public func normalizedPairingCode(_ raw: String) -> String {
    let cleaned = raw.filter { pairingAlphabet.contains($0) }
    return String(cleaned.prefix(pairingCodeLength))
}

public func isCompletePairingCode(_ raw: String) -> Bool {
    normalizedPairingCode(raw) == raw && raw.count == pairingCodeLength
}

/// Build the same browser join URL shown as a QR code and as a copyable link.
///
/// Keeping this beside the parser makes the round trip testable and prevents
/// each native surface from inventing its own path or leaking the code into a
/// query parameter. The fragment is deliberate: it is not sent to the server.
/// A mode hint may sit in the query because it is neither secret nor authority;
/// receivers still validate it and require an explicit Join.
public func pairingJoinURL(baseURL: URL, code: String, mode: TransferMode? = nil) -> URL? {
    guard isCompletePairingCode(code),
          var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
        return nil
    }
    components.path = "/cross-network"
    components.queryItems = mode.map {
        [URLQueryItem(name: "mode", value: $0 == .files ? "file" : "text")]
    }
    components.percentEncodedFragment = "c=\(code)"
    return components.url
}

/// The Relayium join URL first-party native surfaces show as a QR code and as a
/// copyable link.
///
/// Keeping the origin out of the view layer leaves URL policy in one shared,
/// testable place. It is the *transfer* origin rather than the pinned production
/// one, and that is the whole point of the pairing link: it names the hub the
/// other device has to reach in order to meet this one. A build talking to a
/// local server that printed `relayium.com` here would hand the user a code
/// minted on one hub and a link to a different one, and neither half would look
/// wrong on its own. In Release the two values are identical.
public func transferPairingJoinURL(code: String, mode: TransferMode? = nil) -> URL? {
    pairingJoinURL(baseURL: AppEnvironment.transferBaseURL, code: code, mode: mode)
}

/// Parse only links that the production Associated Domains entitlement can
/// deliver. This intentionally does not reuse `parseTransferLink`'s
/// self-host-friendly origin policy: an OS-level app handoff is a trust boundary,
/// and Relayium must not claim arbitrary HTTPS links.
public func parseAppDeepLink(_ url: URL) -> AppDeepLink? {
    guard url.user == nil,
          url.password == nil,
          isAppDeepLinkOrigin(url) else {
        return nil
    }

    let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
    if parts.count == 2, parts[0] == "d", parseTransferLink(url.absoluteString) != nil {
        return .download(url)
    }

    guard parts.count == 1, parts[0] == "cross-network" else { return nil }
    guard let fragment = url.fragment, !fragment.isEmpty else {
        return .realtime(code: nil)
    }
    guard let items = URLComponents(string: "?\(fragment)")?.queryItems,
          items.count == 1,
          items[0].name == "c",
          let raw = items[0].value,
          isCompletePairingCode(raw) else {
        return nil
    }
    let modeItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
        .filter { $0.name == "mode" } ?? []
    if modeItems.count == 1, let value = modeItems[0].value {
        switch value {
        case "file": return .realtimeWithMode(code: raw, mode: .files)
        case "text": return .realtimeWithMode(code: raw, mode: .text)
        default: break
        }
    }
    return .realtime(code: raw)
}

/// The origins an OS-level hand-off may arrive from.
///
/// **A shipped build has exactly one**, and the check is written so that stays
/// visibly true: the `relayium.com` arm below is unconditional, and everything
/// that could ever add a second origin is inside `#if DEBUG`.
///
/// The acceptance arm exists because a pairing link built against a local server
/// carries that server's origin, so a build that could produce such a link but
/// not parse one would fail the round trip the link exists for. It is guarded
/// three times over, and each guard removes a different way it could go wrong:
///
///  1. `#if DEBUG` — a Release binary has no second arm to reach at all.
///  2. `isLoopbackTransferOrigin` — a Debug build that was *not* pointed
///     anywhere resolves production, and then this is `false`. Without it, a
///     developer's ordinary Debug build would start claiming `http://127.0.0.1`
///     links from any source the OS or a browser handed it.
///  3. Exact origin equality — not "some loopback address", but the one this
///     process resolved, port included. A run on `127.0.0.1:53219` must not
///     accept a link from `127.0.0.1:53220`, because on a shared machine that
///     is a different server belonging to somebody else's run.
private func isAppDeepLinkOrigin(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    // The production Associated Domains origin. Unconditional, and the only
    // thing a shipped build can answer to.
    if scheme == "https", url.host?.lowercased() == "relayium.com",
       url.port == nil || url.port == 443 {
        return true
    }
    #if DEBUG
    guard AppEnvironment.isLoopbackTransferOrigin else { return false }
    return isSameHTTPOrigin(url, as: AppEnvironment.transferBaseURL)
    #else
    return false
    #endif
}

/// Scheme, host and port equality — the comparison guard 3 above is made of.
///
/// **Extracted so the equality can be driven against an arbitrary origin.**
/// Inside `isAppDeepLinkOrigin` the origin is a launch-resolved global, fixed
/// for the life of the process, so the only origin a test in this process can
/// compare against is production — and production is the one case where the
/// `#if DEBUG` arm is never reached at all. The property worth having a test
/// for is precisely the one that keeps two concurrent acceptance runs on one
/// machine apart: `:53219` must not accept a link from `:53220`. Reached only
/// through the guarded arm above; it grants nothing on its own.
///
/// Compiled outside `#if DEBUG` for the reason `isLoopbackHost` is: a pure
/// comparison selects no origin, nothing calls it in a shipped build, and
/// keeping it compiled means `swift build -c release` type-checks it.
func isSameHTTPOrigin(_ url: URL, as origin: URL) -> Bool {
    // The port is compared through the same defaulting on both sides, so a
    // resolved `http://127.0.0.1` and a link to `http://127.0.0.1:80` are the
    // one origin they actually are — and `:8080` against `:80` still is not.
    func port(_ url: URL, scheme: String) -> Int {
        url.port ?? (scheme == "https" ? 443 : 80)
    }
    guard let scheme = url.scheme?.lowercased(),
          let originScheme = origin.scheme?.lowercased(), scheme == originScheme,
          let host = url.host?.lowercased(), host == origin.host()?.lowercased(),
          port(url, scheme: scheme) == port(origin, scheme: originScheme)
    else { return false }
    return true
}

@MainActor
public final class AppDeepLinkRouter: ObservableObject {
    @Published public private(set) var pending: AppDeepLink?

    public init() {}

    @discardableResult
    public func open(_ url: URL) -> Bool {
        guard let link = parseAppDeepLink(url) else { return false }
        pending = link
        return true
    }

    public func consume() {
        pending = nil
    }

    /// Clear `pending` only if it is still the link the caller acted on.
    ///
    /// The shells consume one main-actor turn after the link is delivered, for
    /// the `willSet` ordering reason `AppDeepLinkTests` pins. That gap is real
    /// time, and a second link can land inside it — an `open` from the browser
    /// while the first one's turn is still queued. A bare `consume()` would then
    /// throw the NEWER link away: the UI has never seen it, `Published` will not
    /// re-emit a value it has already emitted, and the link the user just tapped
    /// simply does nothing.
    public func consume(_ expected: AppDeepLink) {
        guard pending == expected else { return }
        pending = nil
    }
}
