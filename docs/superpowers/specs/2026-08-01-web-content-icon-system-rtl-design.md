# Web content icon system and RTL connectors — batch 5

Date: 2026-08-01
Status: implemented, reviewed, and production-validated.
Scope owner: Web Cross/LAN explanatory content plus the broken CLI daemon glyph.
No protocol, route, copy meaning, dependency, bitmap, or native-client change.

## Intent

Batch 4b made the interactive realtime workflow code-native, but the same Cross
page still renders platform emoji in HowItWorks, ModeCompare and UseCases. Eleven
icon fields are duplicated across all nine locale tables even though presentation
does not vary by language. HowToSteps separately duplicates four SVG geometries
and uses physical `right`/`left` positioning, so its connector and number badge are
wrong in Arabic RTL. CLI daemon mode uses U+1F5A7, which lacks reliable emoji-font
coverage and can render as a missing-glyph box.

This batch finishes the bounded Web content layer: code owns semantic icon maps;
locales own text; every geometry follows the established line-icon family; the
HowToSteps flow becomes direction-safe.

## Scope

Extend `IconName` with direction-neutral content glyphs:

- `link`, `pairing-code`, `lock`, `download`, `package`;
- `globe`, `clock`, `devices`, `network`;
- `nearby`, `shield`, `file-download`.

Keep the existing API (`name`, optional numeric `size`) and the same 24px viewBox,
1.8px rounded `currentColor` stroke, decorative/focusless semantics, no ids/titles,
and no external assets.

Exact consumers:

- HowItWorks owns two fixed three-item maps:
  realtime = link/pairing-code/bolt; offline = lock/link/download.
- UseCases owns a five-item map aligned with its existing positional slug map:
  globe/clock/devices/lock/message.
- ModeCompare removes bolt/package from localized column names and renders the
  two SVGs in its desktop header links. Narrow-card `data-label` text stays plain.
- OfflinePage renders `package` beside the stored-mode heading and removes the
  duplicate package glyph from all nine localized method names.
- HowToSteps replaces all four inline SVG branches with Icon and keeps its visual
  24px badge size. The number badge uses `inset-inline-start`; the inter-card
  chevron becomes a neutral border connector anchored with `inset-inline-end`, so
  source-order flow works in both LTR and RTL without glyph mirroring.
- CLI replaces the unreliable `🖧` with `network` in all three renderings of the
  daemon concept: mode picker, detailed heading and server-transfer guide. Its
  other functioning emoji are explicitly deferred.

Remove every `icon` field from `HowSection.ways` and `useCases.items` across nine
locales and from their Typescript interfaces. Remove the leading presentation
glyphs from `compare.colRealtime`, `compare.colStored` and `methods.stored.name`.
No translated name, description, instruction or tag changes.

## Invariants and traps

- Positional code maps must have exactly the same lengths as their content arrays;
  tests guard both HowItWorks variants and UseCases.
- SVGs remain `aria-hidden`; visible localized headings/names are unchanged and
  remain the only accessible names.
- No directional arrow is baked into any reusable icon. The download arrow is
  vertical; link, devices and network geometries do not mirror.
- ModeCompare's mobile pseudo-labels must not regain presentation glyphs.
- HowToSteps keeps reveal/reduced-motion behavior, responsive 4→2→1 grids and step
  numbering. The neutral connector disappears at the same row/mobile boundaries.
- The CLI change must not expand into its other icons, data, commands or copy.

## Acceptance

- Component tests lock every new per-name path array, direction-neutral invariants,
  shared SVG attributes, sizes, no titles/ids and explicit-name behavior.
- `npm run check` proves every locale matches the icon-free message interfaces.
- Locale tests prove HowItWorks and UseCases content retains correct lengths/order,
  contains no presentation-icon fields, and comparison labels are trimmed and free
  of their old glyphs.
- Source/component tests prove the code icon maps match content/slug lengths and all
  three CLI daemon surfaces contain SVGs rather than U+1F5A7.
- Real-browser review covers Cross and LAN explanatory sections at 1440/390,
  light/dark, English/German/Portuguese and Arabic RTL. It checks consistent glyph
  sizes/colors, no horizontal overflow, number-badge logical corner, connector side,
  and ModeCompare desktop/mobile labels.
- Full Vitest, check, build and complete LAN file/resume/text/old-peer E2E pass.
- Claude Opus reviews the implemented diff before delivery.

## Deferred

CLI's other working emoji, Me/account chrome, transfer status symbols, route arrows,
and native clients remain separate. A later batch may consolidate content icon size
tokens, but this batch does not add a global icon class or alter typography/color
tokens.
