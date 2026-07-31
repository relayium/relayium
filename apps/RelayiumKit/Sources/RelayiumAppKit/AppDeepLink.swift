import Foundation

public enum AppDeepLink: Equatable {
    case download(URL)
    case realtime(code: String?)
}

private let pairingAlphabet = Set("ACDEFHJKMNPRTWXY23456789")
private let pairingCodeLength = 6

/// The same filtering the web and macOS pairing fields use: normalize case,
/// discard ambiguous/invalid characters, and cap the result at six.
public func normalizedPairingCode(_ raw: String) -> String {
    let cleaned = raw.uppercased().filter { pairingAlphabet.contains($0) }
    return String(cleaned.prefix(pairingCodeLength))
}

public func isCompletePairingCode(_ raw: String) -> Bool {
    normalizedPairingCode(raw) == raw.uppercased() && raw.count == pairingCodeLength
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
    return .realtime(code: raw.uppercased())
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
}
