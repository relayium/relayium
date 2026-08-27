# Frozen localization archive

Translations Relayium once shipped and no longer offers. They are kept here as
source history, **outside every build target**, and are not selectable,
declared or packaged by any client.

## Why this directory exists rather than a `git rm`

The seven catalogs under `frozen-locales/` are finished work. Deleting them
would mean re-translating roughly 600 keys apiece if a language is ever
restored, and would leave the decision to stop shipping them legible only in a
reflog. They were moved here with `git mv`, so `git log --follow` on any file
below still reaches its full authoring history.

Equally, leaving them where they were was not an option. `RelayiumKit`'s
`Package.swift` declares `.process("Resources")` on the `RelayiumShareKit`
target, which packages *every* `.lproj` in that directory. A catalog that stays
next to `en.lproj` ships, whatever the enum says. Moving them out of
`Sources/RelayiumShareKit/Resources/` is what actually removes them from the
built bundle — the enum and the plists only stop the app from *asking* for them.

## What is here

| Locale | Directory |
| ------ | --------- |
| Arabic | `frozen-locales/ar.lproj/` |
| German | `frozen-locales/de.lproj/` |
| Spanish | `frozen-locales/es.lproj/` |
| French | `frozen-locales/fr.lproj/` |
| Japanese | `frozen-locales/ja.lproj/` |
| Korean | `frozen-locales/ko.lproj/` |
| Portuguese | `frozen-locales/pt.lproj/` |

The maintained languages are English and Simplified Chinese, and they live
where they always did, in
`apps/RelayiumKit/Sources/RelayiumShareKit/Resources/`.

## These files are frozen, not maintained

They were correct against the key set at the commit that moved them. They have
drifted since and will keep drifting: new `L10nKey` cases are added to the two
shipped catalogs only, and nothing tests these for completeness, placeholder
signatures or plural coverage. Treat every file here as a starting point for a
re-translation, never as copy that is ready to ship.

`LocalizationIntegrityTests` asserts only that these files remain present and
non-empty, and that none of them is inside the package's resource root.

## Restoring a language

Restoring a locale is an explicit owner and product decision, taken one locale
at a time — see the supported-language policy in the workspace governance
record. Prior translation alone does not make a locale maintained. Doing it
means, at minimum:

1. Moving that `.lproj` back under
   `apps/RelayiumKit/Sources/RelayiumShareKit/Resources/`.
2. Re-translating it to the *current* `L10nKey` set, including plural forms —
   `PluralRule` must regain that language's CLDR integer rules. The shipped
   languages do not agree with each other on this and neither is a template:
   English uses `one` and `other`, while Chinese has no grammatical number and
   defines only `other`. Arabic needs all six categories (`zero`, `one`, `two`,
   `few`, `many`, `other`), and French and Portuguese put a count of zero in
   `one` rather than in `other`.
3. Adding the case back to `AppLanguage`, and to `CFBundleLocalizations` in all
   three Mac bundles plus `knownRegions` in `Relayium.xcodeproj`.
4. For Arabic specifically, restoring genuine right-to-left support:
   `AppLanguage.isRightToLeft` currently answers `false` for every shipped
   language, and the scene-level layout direction and `L10n.token` isolation
   that depend on it have no RTL language left to exercise them.
5. Native-speaker review, layout and accessibility passes, and regression
   coverage.

Until all of that lands, a file here is history.
