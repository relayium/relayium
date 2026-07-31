# Web realtime icon system — batch 4b

Date: 2026-08-01
Status: implemented, reviewed, and production-validated.
Scope owner: Web realtime transfer presentation. No protocol, route, state,
dependency, bitmap asset, marketing-icon or native-client changes.

## Intent

Realtime controls currently use platform emoji for file, folder, message and
bolt. Their weight, color and baseline vary by OS; dark mode cannot theme them,
and the bolt is split between one template literal and nine translated method
names. Replace this workflow with one small, direction-neutral SVG vocabulary.

## Contract

- `Icon.svelte` exposes only `name: "bolt" | "file" | "folder" | "message"`
  and optional numeric `size` (16 by default).
- Every glyph uses the existing HowToSteps visual language: 24px viewBox,
  `fill="none"`, `currentColor`, 1.8px rounded strokes.
- The component is always decorative: `aria-hidden="true"`,
  `focusable="false"`, no title/label API, ids, definitions or animation.
- Geometry is direction-neutral. In particular the message tail is centred, so
  RTL needs neither mirroring nor a separate asset.
- CSS stays with each layout. The component owns only `display:block` and
  `flex:none`; color, gap and alignment inherit from the caller.

## Exact migration

- Peer file/folder/message actions retain their existing semantic label/input/
  button structure and `.pa-icon` wrapper; only its text glyph becomes `Icon`.
- The message-availability callout becomes a start-aligned flex row so long
  localized copy wraps beside, not underneath, its 16px icon.
- CodePairing's two non-small primary actions use 18px file/folder icons.
- All three Cross realtime card headings render one 18px bolt with a local
  baseline-safe heading class. Remove the leading bolt and following space from
  all nine `methods.realtime.name` translations so icon presentation no longer
  lives in content.
- The heading and callout icons use the accent token. Action icons inherit the
  button color and disabled opacity as a unit.

## Deliberate boundaries

Marketing content remains separate: HowToSteps already has purpose-built SVG
badges, while HowItWorks, ModeCompare, UseCases and CLI data still use authored
emoji. They have different component/data contracts and are not interactive
realtime actions. This leaves two bolt styles lower on the same Cross landing
page, an acknowledged follow-up rather than silently expanding a control batch
through all marketing data.

Do not change the file/folder labels into buttons, add a second button under
`.peer-actions`, alter picker focus ownership, touch transfer handlers, or add a
global `.ui-icon` rule.

## Acceptance

- component tests cover all four geometries, decorative/focus behavior,
  `currentColor`, lack of ids/titles, default size and explicit size;
- every locale's `methods.realtime.name` is trimmed, non-empty and contains no
  bolt; locale keys and other authored emoji remain untouched;
- source/E2E evidence shows the three peer action wrappers contain SVG and no
  emoji text, while the message action remains the sole button;
- real-browser review covers Cross unstarted/waiting/active where reachable,
  peer actions and callout at desktop/mobile, light/dark and Arabic RTL;
- no horizontal overflow or label geometry regression at the Batch-4 390/430/
  1180/1440 gates; keyboard picker focus ring and disabled opacity survive;
- check, full Vitest, build and complete LAN file/resume/text/old-peer E2E pass;
- Claude Opus reviews the implemented diff before delivery.
