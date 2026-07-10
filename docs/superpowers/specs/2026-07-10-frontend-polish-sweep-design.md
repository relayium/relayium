# C-β — Frontend Polish Sweep

Date: 2026-07-10
Status: Approved (design)
Part of: "Bucket C cleanup" (C-α realtime guess-code hardening shipped, merge d5352fe; C-γ SEO
landing pages follow as a separate spec). Closes deferred items from
`memory/ui-ux-review-progress.md` (#19, #6, #9, #28) and
`memory/three-page-product-direction.md` (footer #1).

## Goal

Clear five independent frontend-polish followups as one coherent sweep — a reusable confirm
modal, a shared page footer, an upload size-cap display, inline device-rename propagation, and
a client-local realtime transfer history. Mostly `web/` (Svelte 5); one small public backend
endpoint. Each item is independently testable; they share no cross-item logic.

## Resolved decisions

- **Transfer history:** client-side `localStorage` only (the server never records P2P history —
  privacy). Realtime P2P transfers only (stored transfers are already listed via `/api/files`).
  Shown as a collapsible "recent transfers" panel on the main transfer page (usable without
  login). Capped at the most recent 20 entries.
- **Config endpoint:** a new PUBLIC `GET /api/config` (no auth — just limits) returning
  `{maxFileSize, dailyQuota, defaultTTL, maxTTL}` from live settings; the stored-upload page
  reads it to show the max size.
- **Confirm modal scope:** replace only the two async-friendly `confirm()` sites (MePage's
  delete-file and delete-node). The `confirmLeave` nav guard (App.svelte:471) is a SYNCHRONOUS
  navigation interrupt and stays native this round (converting it needs router surgery — a
  deferred, separate followup). YAGNI.

## Component 1 — reusable confirm modal (replaces two `confirm()` sites)

- New `web/src/lib/confirm-dialog.svelte.ts`: a module-level `$state` store
  `{ open: boolean, message: string, resolve: ((ok: boolean) => void) | null }` plus
  `export function confirmDialog(message: string): Promise<boolean>` that sets the store open
  and returns a promise resolved when the user chooses. `resolveConfirm(ok: boolean)` closes
  the store and resolves.
- New `web/src/lib/ConfirmModal.svelte`: reads the store; when `open`, renders a styled dialog
  (`role="dialog"`, `aria-modal="true"`, focus the confirm button, Escape = cancel, backdrop
  click = cancel) with the message and confirm/cancel buttons; on click calls `resolveConfirm`.
  Message text and button labels are the caller's responsibility (message) + existing/new i18n
  (`confirm`/`cancel` labels — add flat keys `dialogConfirm`/`dialogCancel` if none exist).
- Mount one `<ConfirmModal/>` in `web/src/lib/MePage.svelte` (both call sites live there).
  Replace `if (!confirm(t.me.confirmDel)) return;` (MePage:107) and
  `if (!confirm(t.me.confirmDelNode)) return;` (MePage:89) with
  `if (!(await confirmDialog(t.me.confirmDel))) return;` (the enclosing handlers are already
  `async`). No `t.me.*` string changes — reuse the existing confirm messages.
- **Test (Vitest):** `confirmDialog` returns a promise that resolves `true`/`false` when
  `resolveConfirm(true/false)` runs, and sets/clears `open`. (Pure store logic; no DOM mount,
  matching repo convention.)

## Component 2 — shared `PageFooter` component

- New `web/src/lib/PageFooter.svelte`: the legal nav (`security`/`privacy`/`terms` via
  `legalUrl(..., lang())`) + the `{t.footer}` fineprint + the footer CSS, lifted verbatim from
  the current duplicated footers.
- `web/src/lib/OfflinePage.svelte` and `web/src/lib/CrossPage.svelte`: replace their inline
  `<footer>…</footer>` blocks and the footer-specific CSS with `<PageFooter />`.
- **Test:** none new (presentational; covered by `npm run check` + `npm run build`). Verify the
  two pages render the same legal links + fineprint as before.

## Component 3 — `GET /api/config` + upload size-cap display

**Backend** (`server/internal/account/`): a public handler `handleConfig` returning the live
stored-transfer limits as JSON `{"maxFileSize":…, "dailyQuota":…, "defaultTTL":…, "maxTTL":…}`
(int64 bytes / seconds). Values come from `s.resolveSettings(ctx)` (DB overrides over cfg), so
the endpoint reflects live admin settings. Mount `GET /api/config` in `routeMux` WITHOUT
`RequireSession` (public — the limits aren't sensitive). A store read error → 500 with a
generic message; otherwise 200. Handler test asserts the JSON carries the configured values.

**Frontend:** the stored-transfer upload UI (the page/component with the upload control —
`OfflinePage`/the upload panel) fetches `/api/config` once on mount and shows the max file
size (bytes-formatted via the existing `format.ts`) near the file picker, e.g. "最大 200 MiB".
On fetch failure it simply omits the hint (non-blocking). A pure formatter helper
`maxSizeHint(maxFileSize: number, fmt): string` is Vitest-tested; the fetch/display is wired in
the component.

## Component 4 — inline device rename + peer propagation

Currently `selfName` (App.svelte:367) is derived from `deviceName()` and persisted; the peer's
roster name comes from the signaling join and does not update mid-session on a rename.

- **Inline edit:** add an inline edit affordance to the self device-name display in the main
  transfer UI (App.svelte) — click to edit, Enter/blur to commit, persist to the existing
  device-name localStorage. Empty/whitespace reverts to the readable default.
- **Propagate:** on commit, broadcast an opaque rename signal to each current peer via the
  existing `signaling.sendSignal(peerId, { rename: newName })` (same relay path as the #5 busy
  signal — the hub relays opaque `Data`, NO Go change). Extend the `InboundSignal` type with
  `rename?: string`. The `onSignal` handler, on receiving `{ rename }` from `peerId`, updates
  the local roster: `peers = peers.map(p => p.id === from ? { ...p, name: newName } : p)`.
- **Test (Vitest):** a pure helper `applyRename(peers, fromId, newName): Peer[]` (updates the
  matching peer's name, leaves others untouched, ignores an unknown id) — unit-tested. The
  component wires the edit + signal to it.
- **Safety:** `newName` is rendered as text (never `{@html}`); cap its length (e.g. 64 chars)
  on commit and on receipt so a peer can't inject an oversized roster label.

## Component 5 — client-local realtime transfer history

- New `web/src/lib/history.ts`:
  - `type HistEntry = { id: string; name: string; size: number; direction: "send" | "recv"; peer: string; at: number }`
  - `recordTransfer(e: Omit<HistEntry, "id" | "at">): void` — prepend to the list in
    `localStorage["relayium.history"]`, stamp `id` (random) + `at` (now), cap at the most recent
    `HISTORY_MAX = 20` (drop oldest). Best-effort: a storage error (quota/private mode) is
    swallowed.
  - `loadHistory(): HistEntry[]` — parse the list (return `[]` on missing/corrupt).
  - `clearHistory(): void`.
- **Record wiring (App.svelte):** where a transfer completes successfully
  (`s?.done && s.ok` at ~238, `r?.done && r.ok` at ~245), call `recordTransfer` once with the
  transfer's `{ name, size, direction, peer }` (name/size from the send/recv transfer object;
  `peer` = the resolved peer name). Guard against double-recording the same completion (the
  existing `sendNotified`/`recvNotified` latches, or an equivalent, gate it).
- **UI:** a collapsible "最近传输" panel on the main transfer page listing `loadHistory()`
  (name, direction arrow, `bytes`-formatted size, relative time, peer) with a "清空" button
  (`clearHistory()` + refresh). Client-only; no network. i18n: add flat keys for the panel
  title, the empty state, and the clear button across all 6 locales + `types.ts`.
- **Test (Vitest):** `recordTransfer`/`loadHistory`/`clearHistory` round-trip with a mocked
  `localStorage`; the 20-cap drops the oldest; a corrupt value yields `[]`.

## Error handling & privacy

- History and device-name are client-local; nothing new is sent to the server except the
  opaque rename signal (already-relayed data channel, ciphertext-agnostic — it carries only a
  short display name, which the roster already exchanges at join).
- `/api/config` exposes only non-sensitive limits, publicly.
- All new user-visible text (rename, history, dialog labels) renders as plain text — no
  `{@html}`; rename/history strings are length-capped.

## Testing summary

- Go: `handleConfig` returns the live limits (handler test).
- Vitest (pure helpers, no DOM mount): `confirmDialog` promise/open state; `maxSizeHint`
  formatting; `applyRename` roster update; `history.ts` CRUD + 20-cap + corrupt-safe.
- `npm run check` + `npm run build` cover the components (`ConfirmModal`, `PageFooter`, the
  edit affordance, the history panel) compiling and type-checking with all 6 locales satisfied.

## Out of scope / follow-ups

- Converting the synchronous `confirmLeave` nav guard to the in-app modal (router surgery).
- Server-side transfer history / cross-device history (deliberately client-local for privacy).
- C-γ SEO landing pages + sitemap (separate spec).
