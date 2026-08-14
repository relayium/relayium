# Archived SPA message tables

These seven tables — `ja`, `ko`, `de`, `fr`, `ar`, `es`, `pt` — were the app's
runtime copy for those locales until 2026-08-14, when the product's maintained
language set became English and Simplified Chinese (`zh-Hans`).

They are kept, unchanged, for three reasons:

1. **History.** They are the source the archived static pages were translated
   alongside; deleting them would make the archived tutorials' vocabulary
   unverifiable against the app they describe.
2. **Restoration.** Bringing a locale back is an explicit product decision made
   one locale at a time, with a complete re-translation of current copy, layout
   and accessibility review, and regression coverage. Starting from a real prior
   table is cheaper than starting from nothing, and it is a starting point — not
   a shippable file.
3. **Honesty about what "frozen" means.** Frozen is not deleted. The static
   pages in these languages are still public and still indexable; see
   `web/scripts/pages/shared.mjs` (`FROZEN_LANGS`, `archiveNotice`).

## They are outside the type-checked program

`tsconfig.app.json` excludes this directory. That is deliberate. Governance
requires new product copy in English and Simplified Chinese only, so a new field
on `Messages` must not turn seven unmaintained files red — the alternative is
either seven machine translations nobody reviewed, or seven `// TODO` strings
that would ship if a locale were ever re-enabled by accident.

The consequence to know: **these files will drift out of `Messages` shape and
that is expected.** They are an archive, not a build input. Nothing imports
them, `LANGS` does not list them, `i18n.svelte.ts` has no loader for them, and
the PWA precache guard therefore never sees them.

Restoring one means re-translating it against the current `Messages`, adding it
back to `Lang`, `LANGS` and the loaders, and moving the file out of here — not
un-excluding this directory.
