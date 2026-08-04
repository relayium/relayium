import Foundation

/// Reads the nine shipped `.strings` catalogs out of the package's own resource
/// bundle.
///
/// Two properties are the point of this type existing at all:
///
///  1. **It never touches the main bundle.** The copy belongs to `RelayiumAppKit`,
///     so it is read from `Bundle.module` and from the `.lproj` inside it. A
///     `NSLocalizedString(...)` written in a view would resolve against the app
///     bundle, find nothing, and render the key — silently, and only in whichever
///     language the developer was not testing. Nothing in this package or in the
///     macOS app calls `NSLocalizedString`; everything goes through `L10n`.
///  2. **A lookup is a function of the language argument alone.** No
///     `Locale.current`, no `Bundle.main.preferredLocalizations`, no host
///     settings. That is what makes an explicit-locale test assertion mean
///     something, and it is why `PluralRule` is Swift rather than `.stringsdict`.
///
/// Resolution order for a key: the asked language, then English, then the key
/// itself. The last step is a visible failure by design — a raw
/// `account.filesHeading` on screen is a bug report; a silently blank label is
/// not.
public final class LocalizationCatalog: @unchecked Sendable {
    /// The catalog every shipped call site uses.
    public static let shared = LocalizationCatalog(base: .module)

    /// Sentinel returned by `Bundle.localizedString` when a key is absent.
    /// Chosen so no real catalog value can collide with it.
    private static let missing = "\u{0}relayium.missing\u{0}"

    /// The bundle the catalogs are read from. Exposed so the integrity tests can
    /// inspect the shipped `.lproj` directories directly — they have to be able
    /// to see a hole that every lookup below is designed to hide.
    public let base: Bundle
    private let lock = NSLock()
    private var bundles: [AppLanguage: Bundle] = [:]

    public init(base: Bundle) {
        self.base = base
    }

    /// The `.lproj` bundle for a language, or `nil` when the catalog is not in
    /// the resource bundle at all — which is a packaging failure, not a missing
    /// translation, and is asserted separately.
    public func bundle(for language: AppLanguage) -> Bundle? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = bundles[language] { return cached }
        guard let path = lprojPath(language), let bundle = Bundle(path: path) else { return nil }
        bundles[language] = bundle
        return bundle
    }

    /// Find a language's `.lproj` directory, tolerating case.
    ///
    /// SwiftPM writes `zh-hans.lproj` into the built resource bundle while Xcode
    /// keeps the source spelling `zh-Hans.lproj`, and `path(forResource:ofType:)`
    /// is case-sensitive. A lookup that only tried the source spelling therefore
    /// resolved under Xcode and silently fell back to English under `swift test`
    /// — the one language whose regression no English-reading reviewer would
    /// notice.
    private func lprojPath(_ language: AppLanguage) -> String? {
        if let exact = base.path(forResource: language.lproj, ofType: "lproj") { return exact }
        let wanted = language.lproj.lowercased()
        return base.paths(forResourcesOfType: "lproj", inDirectory: nil).first {
            URL(fileURLWithPath: $0).deletingPathExtension()
                .lastPathComponent.lowercased() == wanted
        }
    }

    /// The value stored for `key` in `language`, or `nil` if this catalog does
    /// not define it. No fallback — the integrity tests need to be able to see a
    /// hole, which `string(_:language:)` is designed to paper over.
    public func rawValue(_ key: String, language: AppLanguage) -> String? {
        guard let bundle = bundle(for: language) else { return nil }
        let value = bundle.localizedString(forKey: key, value: Self.missing, table: nil)
        return value == Self.missing ? nil : value
    }

    /// The value to render: asked language, then English, then the key.
    public func string(_ key: String, language: AppLanguage) -> String {
        if let value = rawValue(key, language: language) { return value }
        if language != .fallback, let value = rawValue(key, language: .fallback) { return value }
        return key
    }
}
