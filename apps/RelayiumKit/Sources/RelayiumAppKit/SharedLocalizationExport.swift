/// `L10n`, `L10nKey`, `PluralKey`, `AppLanguage` and `LocalizationCatalog` moved
/// down into `RelayiumShareKit` so the iOS share extension can render the same
/// shipped catalogs without linking the transport stack. Nothing that used them had
/// to change: this re-export is what keeps `import RelayiumAppKit` a complete
/// import for both app targets and for every test in this package.
///
/// `@_exported` rather than a set of typealiases: a typealias would not carry
/// `L10nKey`'s cases, `PluralKey`'s, or the free functions, and the shells would
/// have started needing a second import for a refactor they had no part in.
///
/// It is deliberately one line in its own file. An `@_exported import` buried in
/// a source file that also declares types is the kind of thing a later edit
/// deletes while tidying imports, and the failure would be 70 files losing their
/// copy at once.
@_exported import RelayiumShareKit
