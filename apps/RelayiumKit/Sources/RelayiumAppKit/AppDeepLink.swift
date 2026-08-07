import Foundation

public enum AppDeepLink: Equatable {
    case download(URL)
    case realtime(code: String?)
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
public func pairingJoinURL(baseURL: URL, code: String) -> URL? {
    guard isCompletePairingCode(code),
          var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
        return nil
    }
    components.path = "/cross-network"
    components.query = nil
    components.percentEncodedFragment = "c=\(code)"
    return components.url
}

/// The public Relayium join URL used by first-party native surfaces.
///
/// Keeping the production origin out of the view layer leaves URL policy in
/// one shared, testable place.
public func productionPairingJoinURL(code: String) -> URL? {
    pairingJoinURL(baseURL: AppEnvironment.productionBaseURL, code: code)
}

/// Parse only links that the production Associated Domains entitlement can
/// deliver. This intentionally does not reuse `parseTransferLink`'s
/// self-host-friendly origin policy: an OS-level app handoff is a trust boundary,
/// and Relayium must not claim arbitrary HTTPS links.
public func parseAppDeepLink(_ url: URL) -> AppDeepLink? {
    guard url.scheme?.lowercased() == "https",
          url.host?.lowercased() == "relayium.com",
          url.user == nil,
          url.password == nil,
          url.port == nil || url.port == 443 else {
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
    return .realtime(code: raw)
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
