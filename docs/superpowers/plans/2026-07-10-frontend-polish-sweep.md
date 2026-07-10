# C-β — Frontend Polish Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear five independent frontend-polish followups — a reusable confirm modal, a shared page footer, an upload size-cap display, inline device-rename propagation, and a client-local realtime transfer history.

**Architecture:** Five self-contained items, each a task. Pure logic lands in small testable modules (`confirm-dialog.svelte.ts`, `maxSizeHint`, `applyRename`, `history.ts`) with Vitest; Svelte components (`ConfirmModal`, `PageFooter`, the rename affordance, the history panel) are covered by `npm run check`/`npm run build`. One small public Go handler (`GET /api/config`).

**Tech Stack:** Svelte 5 (runes) + Vitest in `web/`; Go (module root `server/`, CGO off) for the config endpoint.

## Global Constraints

- Frontend in `web/`; Go module root `server/`. Run Vitest as `cd web && npx vitest run <spec>`; type-check `npm run check`; build `npm run build`. Go: `cd server && go test ./... && go build ./...`.
- i18n: new UI strings go in `web/src/lib/i18n/types.ts` + all 6 locales (`zh,en,ja,ko,de,fr`) as FLAT function/string keys (else `npm run check` fails on `Messages`).
- All new user-visible text renders as plain text — NO `{@html}`. Rename + history display strings are length-capped (rename ≤ 64 chars).
- Bytes are formatted with the existing `formatSize(n: number): string` from `web/src/lib/format.ts`.
- Transfer history and device-name are CLIENT-LOCAL (`localStorage`); nothing new is sent to the server except the opaque `{ rename }` signal over the existing relay path.
- `confirmLeave` (App.svelte:471, a synchronous nav guard) stays native this round — do NOT convert it.

---

## Task 1: reusable confirm modal (replace MePage's two `confirm()` sites)

**Files:**
- Create: `web/src/lib/confirm-dialog.svelte.ts` (+ `confirm-dialog.test.ts`)
- Create: `web/src/lib/ConfirmModal.svelte`
- Modify: `web/src/lib/MePage.svelte`
- Modify: `web/src/lib/i18n/types.ts` + 6 locales (only if `dialogConfirm`/`dialogCancel` labels don't already exist)

**Interfaces:**
- Produces: `confirmDialog(message: string): Promise<boolean>`; `resolveConfirm(ok: boolean): void`; a `confirmState` `$state` store `{ open: boolean; message: string }`.

- [ ] **Step 1: Write the failing test**

`web/src/lib/confirm-dialog.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { confirmDialog, resolveConfirm, confirmState } from "./confirm-dialog.svelte";

describe("confirmDialog", () => {
  it("opens with the message and resolves true on confirm", async () => {
    const p = confirmDialog("Delete this?");
    expect(confirmState.open).toBe(true);
    expect(confirmState.message).toBe("Delete this?");
    resolveConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(confirmState.open).toBe(false);
  });
  it("resolves false on cancel", async () => {
    const p = confirmDialog("Sure?");
    resolveConfirm(false);
    await expect(p).resolves.toBe(false);
    expect(confirmState.open).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/confirm-dialog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store/helper**

`web/src/lib/confirm-dialog.svelte.ts`:
```ts
// A promise-based confirm dialog. confirmDialog(message) opens a single shared
// <ConfirmModal/> and resolves true/false when the user chooses — an async
// drop-in for window.confirm().
export const confirmState = $state<{ open: boolean; message: string }>({ open: false, message: "" });

let pending: ((ok: boolean) => void) | null = null;

export function confirmDialog(message: string): Promise<boolean> {
  // If a dialog is already open, resolve it as cancelled first.
  if (pending) { pending(false); pending = null; }
  confirmState.open = true;
  confirmState.message = message;
  return new Promise<boolean>((resolve) => { pending = resolve; });
}

export function resolveConfirm(ok: boolean): void {
  confirmState.open = false;
  const p = pending;
  pending = null;
  p?.(ok);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/confirm-dialog.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `ConfirmModal` component + i18n labels**

If flat keys `dialogConfirm`/`dialogCancel` don't exist in `types.ts`, add them (`dialogConfirm: string; dialogCancel: string;`) with values per locale: zh 确定/取消, en Confirm/Cancel, ja 確認/キャンセル, ko 확인/취소, de Bestätigen/Abbrechen, fr Confirmer/Annuler.

`web/src/lib/ConfirmModal.svelte`:
```svelte
<script lang="ts">
  import { confirmState, resolveConfirm } from "./confirm-dialog.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
  let confirmBtn: HTMLButtonElement | undefined = $state();
  $effect(() => { if (confirmState.open) confirmBtn?.focus(); });
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") resolveConfirm(false); }
</script>

{#if confirmState.open}
  <div class="modal-backdrop" onclick={() => resolveConfirm(false)} role="presentation">
    <div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
      <p class="msg">{confirmState.message}</p>
      <div class="actions">
        <button class="btn" onclick={() => resolveConfirm(false)}>{t.dialogCancel}</button>
        <button class="btn btn-primary" bind:this={confirmBtn} onclick={() => resolveConfirm(true)}>{t.dialogConfirm}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: var(--card, #fff); color: var(--text-h, inherit); border-radius: 12px; padding: 20px; max-width: 90vw; width: 340px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
  .msg { margin: 0 0 16px; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; }
</style>
```
(Match the repo's existing CSS variable names / `.btn` classes; adjust if the project uses different tokens — check an existing component like `Account.svelte` for the button/card classes.)

- [ ] **Step 6: Wire into MePage + replace the two `confirm()` sites**

In `web/src/lib/MePage.svelte`: import and mount `<ConfirmModal />` once (top level of the page markup); import `confirmDialog`. Replace:
- `deleteNode` (~line 89): `if (!confirm(t.me.confirmDelNode)) return;` → `if (!(await confirmDialog(t.me.confirmDelNode))) return;`
- `del` (~line 107): `if (!confirm(t.me.confirmDel)) return;` → `if (!(await confirmDialog(t.me.confirmDel))) return;`
(Both handlers are already `async`. Reuse the existing `t.me.confirmDel`/`confirmDelNode` messages — no new message strings.)

- [ ] **Step 7: Verify**

Run: `cd web && npx vitest run src/lib/confirm-dialog.test.ts && npm run check && npm run build`
Expected: PASS + clean type-check + build.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/confirm-dialog.svelte.ts web/src/lib/confirm-dialog.test.ts web/src/lib/ConfirmModal.svelte web/src/lib/MePage.svelte web/src/lib/i18n/
git commit -m "feat(web): reusable confirm modal replacing native confirm() in MePage"
```

---

## Task 2: shared `PageFooter` component

**Files:**
- Create: `web/src/lib/PageFooter.svelte`
- Modify: `web/src/lib/OfflinePage.svelte`, `web/src/lib/CrossPage.svelte`

**Interfaces:** none (self-contained presentational component reading i18n directly).

- [ ] **Step 1: Create `PageFooter.svelte`**

Lift the footer verbatim from `CrossPage.svelte` (lines ~88-96 markup + ~137-145 CSS). `web/src/lib/PageFooter.svelte`:
```svelte
<script lang="ts">
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<footer>
  <nav class="legal">
    <a href={legalUrl("security", lang())}>{t.legal.security}</a>
    <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
    <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
  </nav>
  <span class="fineprint">{t.footer}</span>
</footer>

<style>
  footer {
    margin-top: var(--space-8); padding-top: var(--space-5); border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
</style>
```
(This is CrossPage's exact footer block. Confirm OfflinePage's footer markup/CSS is equivalent — if it differs, unify on this CrossPage form and note the visual diff.)

- [ ] **Step 2: Replace in both pages**

In `CrossPage.svelte` and `OfflinePage.svelte`: import `PageFooter` and replace the inline `<footer>…</footer>` with `<PageFooter />`; delete the now-unused footer CSS rules from each page's `<style>`. Remove any now-unused imports (`legalUrl` if it was only used by the footer).

- [ ] **Step 3: Verify (no new test; presentational)**

Run: `cd web && npm run check && npm run build`
Expected: clean. Manually confirm both pages still show the three legal links + fineprint.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/PageFooter.svelte web/src/lib/OfflinePage.svelte web/src/lib/CrossPage.svelte
git commit -m "refactor(web): extract shared PageFooter from OfflinePage/CrossPage"
```

---

## Task 3: `GET /api/config` + upload size-cap display

**Files:**
- Modify: `server/internal/account/handlers.go` (handler + route)
- Test: `server/internal/account/config_test.go`
- Create: `web/src/lib/max-size.ts` (+ `max-size.test.ts`)
- Modify: `web/src/lib/StoredUpload.svelte`, `web/src/lib/i18n/types.ts` + 6 locales

**Interfaces:**
- Consumes: `s.resolveSettings(ctx)` → `Settings{ MaxFileSize, DailyQuota, DefaultTTL, MaxTTL, ... }` (existing).
- Produces: `GET /api/config` → `{ maxFileSize, dailyQuota, defaultTTL, maxTTL }` (int64); `maxSizeHint(maxFileSize: number): string`.

- [ ] **Step 1: Write the failing Go test**

`server/internal/account/config_test.go`:
```go
package account

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleConfigReturnsLimits(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, nil, Config{MaxFileSize: 200 << 20, DailyQuota: 1 << 30, DefaultTTL: 3600, MaxTTL: 7200})
	r := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()
	svc.handleConfig(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var got map[string]int64
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["maxFileSize"] != 200<<20 || got["defaultTTL"] != 3600 || got["maxTTL"] != 7200 {
		t.Fatalf("config = %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestHandleConfig`
Expected: FAIL — `handleConfig` undefined.

- [ ] **Step 3: Implement the handler + mount the route**

In `handlers.go`:
```go
func (s *Service) handleConfig(w http.ResponseWriter, r *http.Request) {
	st := s.resolveSettings(r.Context())
	writeJSON(w, http.StatusOK, map[string]int64{
		"maxFileSize": st.MaxFileSize,
		"dailyQuota":  st.DailyQuota,
		"defaultTTL":  st.DefaultTTL,
		"maxTTL":      st.MaxTTL,
	})
}
```
Mount it in `routeMux` (public — no `RequireSession`), next to the other GET routes:
```go
	mux.HandleFunc("GET /api/config", s.handleConfig)
```

- [ ] **Step 4: Run Go test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestHandleConfig && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 5: Write the failing frontend test**

`web/src/lib/max-size.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { maxSizeHint } from "./max-size";

describe("maxSizeHint", () => {
  it("formats a positive max", () => {
    expect(maxSizeHint(200 * 1024 * 1024)).not.toBe("");
    expect(maxSizeHint(200 * 1024 * 1024)).toContain("MiB");
  });
  it("returns empty for 0/negative", () => {
    expect(maxSizeHint(0)).toBe("");
    expect(maxSizeHint(-5)).toBe("");
  });
});
```
(If `formatSize` uses "MB" rather than "MiB", assert on the unit the repo actually produces — check `formatSize` output first.)

- [ ] **Step 6: Implement `max-size.ts`**

`web/src/lib/max-size.ts`:
```ts
import { formatSize } from "./format";

// maxSizeHint returns a human-readable maximum upload size, or "" when unknown.
export function maxSizeHint(maxFileSize: number): string {
  return maxFileSize > 0 ? formatSize(maxFileSize) : "";
}
```

- [ ] **Step 7: Wire into `StoredUpload.svelte` + i18n**

Add a flat i18n key `maxSize: (size: string) => string` (zh `(s)=>`最大 ${s}``, en `(s)=>`Max ${s}``, ja `(s)=>`最大 ${s}``, ko `(s)=>`최대 ${s}``, de `(s)=>`Max. ${s}``, fr `(s)=>`Max ${s}``) to `types.ts` + 6 locales. In `StoredUpload.svelte`: on mount, `fetch("/api/config").then(r => r.json())` into `let cfg = $state<{maxFileSize?: number}>({})` (swallow errors); derive `const hint = $derived(maxSizeHint(cfg.maxFileSize ?? 0))`; render `{#if hint}<span class="max-hint">{t.maxSize(hint)}</span>{/if}` near the file picker.

- [ ] **Step 8: Verify**

Run: `cd server && go test ./internal/account/ -run TestHandleConfig` then `cd web && npx vitest run src/lib/max-size.test.ts && npm run check && npm run build`
Expected: all PASS + clean.

- [ ] **Step 9: Commit**

```bash
git add server/internal/account/handlers.go server/internal/account/config_test.go web/src/lib/max-size.ts web/src/lib/max-size.test.ts web/src/lib/StoredUpload.svelte web/src/lib/i18n/
git commit -m "feat: public GET /api/config + upload max-size hint"
```

---

## Task 4: inline device rename + peer propagation

**Files:**
- Create: `web/src/lib/apply-rename.ts` (+ `apply-rename.test.ts`)
- Modify: `web/src/lib/webrtc.ts` (`InboundSignal` type), `web/src/App.svelte` (edit affordance + signal send/receive)

**Interfaces:**
- Consumes: existing `signaling.sendSignal(to, data)`, the App-level `onSignal` handler pattern (`onPeerRelayRtt(from, data)` at App.svelte:162), the persisted `deviceName()`/`selfName`.
- Produces: `applyRename<T extends { id: string; name: string }>(peers: T[], fromId: string, newName: string): T[]`.

- [ ] **Step 1: Write the failing test**

`web/src/lib/apply-rename.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { applyRename } from "./apply-rename";

const peers = [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }];

describe("applyRename", () => {
  it("renames the matching peer, leaves others", () => {
    expect(applyRename(peers, "a", "Alicia")).toEqual([{ id: "a", name: "Alicia" }, { id: "b", name: "Bob" }]);
  });
  it("ignores an unknown id", () => {
    expect(applyRename(peers, "z", "X")).toEqual(peers);
  });
  it("trims + caps at 64 chars and ignores an empty name", () => {
    expect(applyRename(peers, "a", "  ")).toEqual(peers);
    const long = "x".repeat(100);
    expect(applyRename(peers, "a", long)[0].name).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/apply-rename.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apply-rename.ts`**

`web/src/lib/apply-rename.ts`:
```ts
// applyRename returns a new roster with the peer `fromId`'s display name set to
// newName (trimmed, capped at 64 chars). An empty name or unknown id is a no-op.
export function applyRename<T extends { id: string; name: string }>(peers: T[], fromId: string, newName: string): T[] {
  const name = newName.trim().slice(0, 64);
  if (!name) return peers;
  return peers.map((p) => (p.id === fromId ? { ...p, name } : p));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/apply-rename.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend `InboundSignal` + receive-side handling**

In `web/src/lib/webrtc.ts`, add to the `InboundSignal` interface (next to `busy?: boolean` at ~line 37):
```ts
  rename?: string;
```
In `App.svelte`'s App-level signal handler `onPeerRelayRtt(from, data)` (~line 162 — the handler for non-WebRTC opaque signals), also handle rename:
```ts
  function onPeerRelayRtt(from: string, data: unknown) {
    const d = data as { relayRtt?: Record<string, number>; rename?: string };
    if (d.relayRtt) { /* existing relay-rtt handling */ }
    if (typeof d.rename === "string") { peers = applyRename(peers, from, d.rename); }
  }
```
Import `applyRename`. (Keep the existing relay-rtt body; only add the `rename` branch.)

- [ ] **Step 6: Inline edit affordance + broadcast (App.svelte)**

Add an inline edit to the self device-name display: a click toggles an `<input>` bound to a draft; Enter/blur commits `commitName(draft)`. `commitName`:
```ts
  function commitName(next: string) {
    const name = next.trim().slice(0, 64);
    if (!name) return; // keep current
    selfName = name;
    try { localStorage.setItem(DEVICE_NAME_KEY, name); } catch { /* ignore */ } // same key deviceName() reads
    for (const p of visiblePeers) signaling.sendSignal(p.id, { rename: name });
  }
```
(`DEVICE_NAME_KEY` is the existing constant `deviceName()` (App.svelte:524) reads/writes — reuse it, don't introduce a new key. Cap at 64.) The edit UI mirrors the existing device-name label styling.

- [ ] **Step 7: Verify**

Run: `cd web && npx vitest run src/lib/apply-rename.test.ts && npm run check && npm run build`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/apply-rename.ts web/src/lib/apply-rename.test.ts web/src/lib/webrtc.ts web/src/App.svelte
git commit -m "feat(web): inline device rename propagated to peers via opaque signal"
```

---

## Task 5: client-local realtime transfer history

**Files:**
- Create: `web/src/lib/history.ts` (+ `history.test.ts`)
- Modify: `web/src/App.svelte` (record on completion + history panel)
- Modify: `web/src/lib/i18n/types.ts` + 6 locales

**Interfaces:**
- Produces: `type HistEntry = { id: string; name: string; size: number; direction: "send" | "recv"; peer: string; at: number }`; `recordTransfer(e: Omit<HistEntry, "id" | "at">): void`; `loadHistory(): HistEntry[]`; `clearHistory(): void`; `HISTORY_MAX = 20`.

- [ ] **Step 1: Write the failing test**

`web/src/lib/history.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { recordTransfer, loadHistory, clearHistory, HISTORY_MAX } from "./history";

beforeEach(() => localStorage.clear());

describe("history", () => {
  it("records and loads newest-first", () => {
    recordTransfer({ name: "a.txt", size: 10, direction: "send", peer: "Bob" });
    recordTransfer({ name: "b.txt", size: 20, direction: "recv", peer: "Al" });
    const h = loadHistory();
    expect(h).toHaveLength(2);
    expect(h[0].name).toBe("b.txt"); // newest first
    expect(h[0].id).toBeTruthy();
    expect(h[0].at).toBeGreaterThan(0);
  });
  it("caps at HISTORY_MAX, dropping oldest", () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++) recordTransfer({ name: `f${i}`, size: 1, direction: "send", peer: "p" });
    const h = loadHistory();
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0].name).toBe(`f${HISTORY_MAX + 4}`); // newest kept
    expect(h.some((e) => e.name === "f0")).toBe(false); // oldest dropped
  });
  it("returns [] on corrupt storage and clears", () => {
    localStorage.setItem("relayium.history", "{not json");
    expect(loadHistory()).toEqual([]);
    recordTransfer({ name: "x", size: 1, direction: "send", peer: "p" });
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `history.ts`**

`web/src/lib/history.ts`:
```ts
export const HISTORY_MAX = 20;
const KEY = "relayium.history";

export type HistEntry = {
  id: string;
  name: string;
  size: number;
  direction: "send" | "recv";
  peer: string;
  at: number;
};

function randId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2));
}

export function loadHistory(): HistEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordTransfer(e: Omit<HistEntry, "id" | "at">): void {
  try {
    const entry: HistEntry = { ...e, id: randId(), at: Date.now() };
    const next = [entry, ...loadHistory()].slice(0, HISTORY_MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best-effort: quota / private mode */
  }
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
```
(`Math.random()` is used only for a non-security-sensitive local id fallback — acceptable. If the repo's lint forbids it, use `crypto.getRandomValues`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/history.test.ts`
Expected: PASS (the repo's Vitest env provides `localStorage`; if not, the test's `beforeEach(localStorage.clear())` will surface it — add a jsdom/happy-dom env note to the spec if missing).

- [ ] **Step 5: Record on completion (App.svelte)**

Where a transfer completes successfully — the send branch `if (s?.done && s.ok)` (~line 238) and the recv branch `if (r?.done && r.ok)` (~line 245) — call `recordTransfer` once, gated by the existing one-shot latches (`sendNotified`/`recvNotified`) so a completion is recorded exactly once. The `Xfer` object (App.svelte:62) has `{ peer, dir, files: FileMeta[], total, done, ok }`; `nameOf(peerId)` (App.svelte:546) resolves a peer's display name; `xferLabel` is a concise name (first file + count):
```ts
  // small local helper (module/top of App.svelte):
  const xferLabel = (x: Xfer) =>
    x.files.length === 1 ? x.files[0].name : `${x.files[0]?.name ?? "?"} +${x.files.length - 1}`;

  // inside the send-complete branch, alongside the existing `sendNotified` latch set:
  recordTransfer({ name: xferLabel(s), size: s.total, direction: "send", peer: nameOf(s.peer) });
  // inside the recv-complete branch, alongside `recvNotified`:
  recordTransfer({ name: xferLabel(r), size: r.total, direction: "recv", peer: nameOf(r.peer) });
```

- [ ] **Step 6: History panel UI + i18n**

Add flat i18n keys `historyTitle: string`, `historyEmpty: string`, `historyClear: string` to `types.ts` + 6 locales (zh: 最近传输 / 暂无记录 / 清空; en: Recent transfers / No transfers yet / Clear; and the other four). In `App.svelte`, add a collapsible `<details>`/section on the main page rendering `loadHistory()` rows (direction arrow ↑/↓, `{formatSize(e.size)}`, name, peer, relative time) with a "清空" button calling `clearHistory()` + refreshing the list (`let history = $state(loadHistory())`; refresh after record and on clear). Read-only, client-only.

- [ ] **Step 7: Verify**

Run: `cd web && npx vitest run src/lib/history.test.ts && npm run check && npm run build`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/history.ts web/src/lib/history.test.ts web/src/App.svelte web/src/lib/i18n/
git commit -m "feat(web): client-local recent-transfers history panel"
```

---

## Self-Review Notes

**Spec coverage:** Component 1 (confirm modal) → Task 1; Component 2 (PageFooter) → Task 2; Component 3 (config endpoint + upload hint) → Task 3; Component 4 (rename propagation) → Task 4; Component 5 (transfer history) → Task 5. Decisions A (localStorage/realtime-only/main-page/20-cap), B (public /api/config shape), C (confirmLeave stays native) are honored (Tasks 5, 3, and 1's note respectively).

**Cross-task consistency:** the five items share no logic; each task's produced module (`confirmDialog`, `maxSizeHint`, `applyRename`, `history.ts`, `handleConfig`) is consumed only within its own task. All new i18n keys are flat and added to `types.ts` + 6 locales in the same task that uses them.

**Grounded (pinned in the plan):** the `Xfer` type + `nameOf` resolver (Task 5), `DEVICE_NAME_KEY` (Task 4), the footer CSS block (Task 2), `resolveSettings`/`Settings` fields (Task 3), MePage's two async `confirm()` handlers + `t.me.confirmDel`/`confirmDelNode` (Task 1).

**Small details the implementer confirms against the current file:** the exact CSS token/`.btn`/`.card` class names for the modal (Task 1 — mirror `Account.svelte`); whether `formatSize` emits "MiB" vs "MB" (Task 3's test asserts the real unit — check `formatSize` output first); that the Vitest DOM env provides `localStorage` (Task 5 — if not, add a happy-dom/jsdom note). Each is a one-line locatable detail, not a design gap.
