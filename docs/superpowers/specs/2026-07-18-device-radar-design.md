# Device Radar — nearby-device scanner for the LAN home

**Date:** 2026-07-18
**Status:** design approved, pending spec review

## Problem

On the LAN home route Relayium silently sits in a signaling room waiting for
other devices on the same network. There is no visual signal that the app is
"looking" for nearby devices. Today the `.peers` section (`App.svelte:1253`)
shows either a flat empty-state text (`t.emptyPeers` + a cross-network CTA) or a
plain card list once peers appear. It reads as static and inert.

## Goal

Replace the inside of the `.peers` section on the LAN home with an animated
**radar**: while no device is found it sweeps ("searching your network"); when a
real LAN peer appears it materializes as a **blip** on the radar. Clicking a
blip expands that device's existing send card below the radar. The radar is
scan + real blips — decorative and functional at once.

Scope: **LAN home only.** The cross-network (`/cross-network`) pairing-code
page is unchanged.

## Non-goals (YAGNI)

- No radar on the cross-network / offline pages.
- No drop-a-file-directly-onto-a-blip target. Drag-drop keeps working on the
  expanded card and the existing page-level solo drop (`App.svelte:571`).
- No new fake/decoy blips — only real `visiblePeers` render as blips.
- No new user-facing strings that would require translating across all 9
  locales. Reuse existing `t.*` keys.

## Component boundary

**New: `web/src/lib/DeviceRadar.svelte` — pure presentational selector.**
Knows nothing about files, transfers, or outbox. Props:

- `peers: Peer[]` — the already-filtered `visiblePeers` (never includes self).
- `selfName: string` — label for the center node.
- `selectedId: string` — id of the peer whose card is expanded (`""` = none).
- `onSelect: (id: string) => void` — fired when a blip is clicked/keyboard-activated.

Renders: the circular radar (rings + faint grid + sweep line), the center
"you" node, and one **blip per peer**. Each blip is a real focusable
`<button>` with an `aria-label` (e.g. `t.pickSendTo(peer.name)` semantics) so
the radar is, underneath the visuals, an accessible list of "send to X"
buttons. Emits selection only; it renders no send controls itself.

**`App.svelte` changes (inside the `transferSurface` snippet, `.peers` section):**

- Add local UI state `selectedPeerId = $state("")`.
- Replace the `{#if visiblePeers.length === 0} … {:else} <ul> … {/if}` body with:
  1. `<DeviceRadar peers={visiblePeers} {selfName} selectedId={effectiveSelected} onSelect={(id) => selectedPeerId = id} />`
  2. When `visiblePeers.length === 0`: render the existing empty caption
     (`t.emptyPeers`) and the cross-network CTA **below** the radar (unchanged strings).
  3. When a peer is selected (see selection rules): render **the existing
     `<li class="peer">` card markup** for that one peer below the radar —
     same avatar / `📄 t.sendFile` / `📁 t.sendFolder` / hidden file inputs /
     `onDrop` / `pickFile` handlers as today. No handler logic changes.

Keeping the send card in `App.svelte` means `pickFile`, `sendFiles`,
`takeOutbox`, `onDrop`, `pendingPeer`, and the solo/outbox auto-send paths are
untouched — the radar only changes *which* peer's card is shown and adds the
visual scan.

### Selection rules (`effectiveSelected`)

- `visiblePeers.length === 0` → no card (`""`).
- `visiblePeers.length === 1` (**solo**) → auto-select that one peer; its card
  auto-expands with no click, preserving today's frictionless solo behavior
  (including outbox auto-send at `App.svelte:334`, which stays keyed on
  `visiblePeers.length === 1`, not on selection).
- `visiblePeers.length > 1` → `selectedPeerId` if it still matches a present
  peer, else `""` (show radar only; user clicks a blip to reveal its card).
- If the selected peer disconnects, `effectiveSelected` falls back to `""`.

## Blip placement

Positions must be **stable per device within a session** so a blip doesn't jump
on every re-render/rename. Derive from a hash of `peer.id`:

- `angle = hash(peer.id) mod 360` degrees.
- `radius` = mapped into a mid-band of the radar (e.g. 42–82% of the outer
  ring) using a second hash slice, so blips avoid the dead-center "you" node and
  the outer rim. With ≥4 peers, quantize `radius` into 2 rings so labels are
  less likely to collide.
- Pure function `blipPos(id) -> {xPct, yPct}`; deterministic, no `Math.random`.

A newly-appeared blip plays a one-shot "radar contact" ping ripple (CSS
animation keyed on the `{#each peers (p.id)}` enter). The selected blip gets an
accent ring.

## Visual / animation

- Circular SVG or CSS radar, ~220–260px, centered in the `.peers` section.
- 2–3 concentric rings + faint cross grid, `--border`/`--accent` tinted to
  match the existing card system (uses the same CSS custom props as the rest of
  the app — no hard-coded colors).
- Sweep: a `conic-gradient` wedge with a fading trail, rotating ~4s/turn via a
  single `@keyframes rotate`.
- Center node: small filled dot + `selfName` first initial, styled like the
  existing `.pavatar`.
- **`prefers-reduced-motion: reduce`**: sweep does not rotate; instead the rings
  do a slow opacity "breathe" (or are fully static). Blips and the contact
  ping are shown without motion. Mirrors the existing `.pulse` handling in
  `CodePairing.svelte:226`.

## Accessibility

- Each blip: `<button type="button">` with `aria-label` naming the peer and the
  send action; standard focus ring; Enter/Space activate `onSelect`.
- Radar container gets `role="group"` + `aria-label` from `t.peersTitle`.
- Tab order follows peer order (each blip focusable). With no visuals it
  degrades to a group of "send to X" buttons that expand a real send card.
- The center node is `aria-hidden` decorative (the name is already in the Hero).

## i18n

Reuse only: `t.peersTitle`, `t.emptyPeers`, `t.emptyCrossCta`, `t.pickSendTo`,
`t.pickHint`, `t.sendFile`, `t.sendFolder`. No new keys → no 9-locale
translation pass.

## Testing / verification

- Unit: `blipPos(id)` is deterministic and stays within the intended band for a
  spread of ids; two different ids rarely collide within a small set.
- Manual (headless WebRTC 2-tab harness, see memory `headless-webrtc-e2e`):
  1. Idle LAN home → radar sweeps, empty caption + cross CTA shown, no blips.
  2. Second tab joins same room → a blip pings in; solo auto-expands its card;
     sending a file still works end-to-end.
  3. Third tab joins → two blips, neither auto-expanded; clicking a blip expands
     that peer's card; clicking the other switches.
  4. A peer leaves → its blip disappears; if it was selected, card collapses.
  5. `prefers-reduced-motion` emulated → no rotation, blips still shown.
- `npm run check` (svelte-check) clean.

## Rollback

Self-contained: revert `DeviceRadar.svelte` + the `.peers` section edit in
`App.svelte`. No protocol, signaling, or transfer-path changes.
