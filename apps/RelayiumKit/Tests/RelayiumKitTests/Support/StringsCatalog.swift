import Foundation
@testable import RelayiumAppKit

/// One `.strings` catalog, read as data rather than through the localization
/// API.
///
/// The integrity tests have to be able to see a HOLE, and every production
/// lookup is designed to hide one — `L10n` falls back to English and then to the
/// key. So they parse the files directly: `NSDictionary(contentsOf:)` reads the
/// old-style property list that a `.strings` file is, which also means a syntax
/// error (an unescaped quote, a missing semicolon) shows up here as a nil rather
/// than as a string that silently disappears at runtime.
enum StringsCatalog {
    /// Every key/value pair in one language's catalog, or nil if the file is
    /// missing or unparseable.
    /// `LocalizationCatalog.shared.base`, not the test target's own
    /// `Bundle.module` — that one holds the crypto fixtures. Reading the package
    /// bundle here is also the assertion that package copy resolves without the
    /// app's main bundle.
    static var bundle: Bundle { LocalizationCatalog.shared.base }

    static func load(_ language: AppLanguage) -> [String: String]? {
        guard let url = bundle.url(forResource: "Localizable",
                                   withExtension: "strings",
                                   subdirectory: nil,
                                   localization: language.lproj)
        else { return nil }
        return NSDictionary(contentsOf: url) as? [String: String]
    }

    /// The `.lproj` directories the resource bundle actually ships.
    static var shippedLocalizations: [String] {
        bundle.localizations.filter { $0 != "Base" }
    }
}

/// One printf conversion found in a format string.
struct FormatSpecifier: Hashable, CustomStringConvertible {
    /// 1-based argument index — explicit for `%1$@`, positional otherwise.
    let index: Int
    /// The conversion character (`@`, `d`, `f`, …).
    let conversion: Character

    var description: String { "%\(index)$\(conversion)" }
}

/// Extract the argument specifiers from a format string.
///
/// `%%` is a literal percent and takes no argument, which matters: several
/// catalogs end a percentage format with it, and counting it would report a
/// placeholder mismatch on a string that is correct.
func formatSpecifiers(_ template: String) -> Set<FormatSpecifier> {
    var found: Set<FormatSpecifier> = []
    var implicit = 0
    let chars = Array(template)
    var i = 0
    while i < chars.count {
        guard chars[i] == "%" else { i += 1; continue }
        i += 1
        guard i < chars.count else { break }
        if chars[i] == "%" { i += 1; continue }   // literal percent
        var digits = ""
        while i < chars.count, chars[i].isNumber { digits.append(chars[i]); i += 1 }
        var index: Int
        if i < chars.count, chars[i] == "$", let explicit = Int(digits) {
            index = explicit
            i += 1
        } else {
            // Not positional after all: the digits were a width, and the
            // conversion is whatever comes next.
            implicit += 1
            index = implicit
        }
        // Skip any flags/width/precision before the conversion character.
        while i < chars.count, "0123456789.+- #'".contains(chars[i]) { i += 1 }
        guard i < chars.count else { break }
        found.insert(FormatSpecifier(index: index, conversion: chars[i]))
        i += 1
    }
    return found
}
