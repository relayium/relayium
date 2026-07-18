# Device Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inside of the LAN home `.peers` section with an animated radar that sweeps while searching and materializes real LAN peers as clickable blips.

**Architecture:** A pure position helper (`radar-layout.ts`) maps a peer id to a stable on-radar coordinate. A presentational `DeviceRadar.svelte` renders the rings/sweep/center and one focusable blip button per peer, emitting selection only. `App.svelte`'s `.peers` section owns selection state and renders the existing peer send-card below the radar for the selected/solo peer — no transfer/signaling logic changes.

**Tech Stack:** Svelte 5 (runes: `$props`, `$state`, `$derived`), TypeScript, Vitest (`mount`/`flushSync` from `svelte`), CSS custom props already defined app-wide (`--accent`, `--border`, `--surface`, `--text`, etc.).

## Global Constraints

- Scope is **LAN home only** — no changes to `/cross-network`, `/offline-transfer`, or any other route.
- **No new i18n keys.** Reuse existing: `t.peersTitle`, `t.emptyPeers`, `t.emptyCrossCta`, `t.pickSendTo(name)`, `t.pickHint(max)`, `t.sendFile`, `t.sendFolder`. (Adding a key means translating across all 9 locales — forbidden here.)
- **No `Math.random` / no `Date.now`** in blip placement — positions must be deterministic and stable per session.
- Respect `prefers-reduced-motion: reduce` (mirror the existing pattern in `CodePairing.svelte:226`).
- All colors come from existing CSS custom props — no hard-coded hex except where the codebase already does (match surroundings).
- `Peer` type is `{ id: string; name: string }` from `web/src/lib/protocol.ts`.
- No new dependencies.

---

### Task 1: Stable blip-position helper

**Files:**
- Create: `web/src/lib/radar-layout.ts`
- Test: `web/src/lib/radar-layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `hashId(id: string): number` — FNV-1a 32-bit unsigned hash.
  - `interface BlipPos { xPct: number; yPct: number }`
  - `blipPos(id: string, crowded?: boolean): BlipPos` — deterministic percent coords (0–100) within the radar box; distance from the 50/50 center stays in the band `[21, 41]` percent (INNER..OUTER × 50).

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/radar-layout.test.ts
import { describe, it, expect } from "vitest";
import { hashId, blipPos } from "./radar-layout";

const dist = (p: { xPct: number; yPct: number }) =>
  Math.hypot(p.xPct - 50, p.yPct - 50);

describe("radar-layout", () => {
  it("hashId is deterministic and unsigned", () => {
    expect(hashId("abc")).toBe(hashId("abc"));
    expect(hashId("abc")).toBeGreaterThanOrEqual(0);
    expect(hashId("abc")).not.toBe(hashId("abd"));
  });

  it("blipPos is deterministic per id", () => {
    expect(blipPos("peer-1")).toEqual(blipPos("peer-1"));
  });

  it("keeps every blip inside the mid-band, off the center node", () => {
    for (const id of ["a", "b", "peer-xyz", "9f3", "long-device-id-42"]) {
      const d = dist(blipPos(id));
      expect(d).toBeGreaterThanOrEqual(20.9); // >= INNER*50 (21) minus fp slack
      expect(d).toBeLessThanOrEqual(41.1);    // <= OUTER*50 (41) plus fp slack
    }
  });

  it("crowded mode quantizes radius to one of two rings", () => {
    const radii = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        Math.round(dist(blipPos(id, true)) * 100) / 100,
      ),
    );
    expect(radii.size).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/radar-layout.test.ts`
Expected: FAIL — `Failed to resolve import "./radar-layout"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/radar-layout.ts
// Deterministic on-radar position for a peer, derived only from its id so a
// device keeps the same spot across re-renders/renames within a session. No
// Math.random / Date.now — placement must be stable and reproducible.

const INNER = 0.42; // nearest fraction of the radius a blip may sit to center
const OUTER = 0.82; // farthest fraction of the radius a blip may sit from center

// FNV-1a 32-bit — tiny, stable, dependency-free.
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface BlipPos {
  xPct: number;
  yPct: number;
}

// crowded (>=4 peers) snaps the radius to one of two rings so labels are less
// likely to overlap; otherwise the radius spreads smoothly across the band.
export function blipPos(id: string, crowded = false): BlipPos {
  const h = hashId(id);
  const angle = (h % 360) * (Math.PI / 180);
  let frac: number;
  if (crowded) {
    frac = (h >>> 19) % 2 === 0
      ? INNER + (OUTER - INNER) * 0.3
      : INNER + (OUTER - INNER) * 0.8;
  } else {
    const t = ((h >>> 9) % 1000) / 1000; // independent slice, 0..1
    frac = INNER + (OUTER - INNER) * t;
  }
  return {
    xPct: 50 + Math.cos(angle) * frac * 50,
    yPct: 50 + Math.sin(angle) * frac * 50,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/radar-layout.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/radar-layout.ts web/src/lib/radar-layout.test.ts
git commit -m "feat(radar): stable per-id blip position helper"
```

---

### Task 2: `DeviceRadar.svelte` presentational component

**Files:**
- Create: `web/src/lib/DeviceRadar.svelte`
- Test: `web/src/lib/DeviceRadar.test.ts`

**Interfaces:**
- Consumes: `blipPos` from Task 1; `Peer` from `protocol.ts`; `messages/lang` from `i18n.svelte`.
- Produces: a component with props
  `{ peers: Peer[]; selfName: string; selectedId: string; onSelect: (id: string) => void }`.
  Renders one `<button class="blip">` per peer (with `aria-label={t.pickSendTo(name)}` and `aria-pressed`), a decorative `.scope`, and calls `onSelect(id)` on click. Renders no send controls.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/DeviceRadar.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import DeviceRadar from "./DeviceRadar.svelte";
import { loadLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  target.remove();
});

const PEERS = [
  { id: "p1", name: "Alice" },
  { id: "p2", name: "Bob" },
];

describe("DeviceRadar", () => {
  it("renders one blip button per peer with an aria-label", () => {
    app = mount(DeviceRadar, {
      target,
      props: { peers: PEERS, selfName: "Me", selectedId: "", onSelect: () => {} },
    });
    flushSync();
    const blips = target.querySelectorAll("button.blip");
    expect(blips.length).toBe(2);
    expect(blips[0].getAttribute("aria-label")).toContain("Alice");
  });

  it("marks the selected peer pressed", () => {
    app = mount(DeviceRadar, {
      target,
      props: { peers: PEERS, selfName: "Me", selectedId: "p2", onSelect: () => {} },
    });
    flushSync();
    const pressed = target.querySelector("button.blip[aria-pressed='true']")!;
    expect(pressed.getAttribute("aria-label")).toContain("Bob");
  });

  it("fires onSelect with the peer id on click", () => {
    const onSelect = vi.fn();
    app = mount(DeviceRadar, {
      target,
      props: { peers: PEERS, selfName: "Me", selectedId: "", onSelect },
    });
    flushSync();
    (target.querySelector("button.blip") as HTMLButtonElement).click();
    flushSync();
    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("renders no blips when there are no peers", () => {
    app = mount(DeviceRadar, {
      target,
      props: { peers: [], selfName: "Me", selectedId: "", onSelect: () => {} },
    });
    flushSync();
    expect(target.querySelectorAll("button.blip").length).toBe(0);
    expect(target.querySelector(".scope")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/DeviceRadar.test.ts`
Expected: FAIL — cannot resolve `./DeviceRadar.svelte`.

- [ ] **Step 3: Write the component**

```svelte
<!-- web/src/lib/DeviceRadar.svelte -->
<!-- Presentational only: renders the radar and one focusable blip per peer,
     emitting selection via onSelect. Knows nothing about files/transfers —
     App.svelte renders the selected peer's send card below this. -->
<script lang="ts">
  import type { Peer } from "./protocol";
  import { blipPos } from "./radar-layout";
  import { messages, lang, type Messages } from "./i18n.svelte";

  let { peers, selfName, selectedId, onSelect }:
    { peers: Peer[]; selfName: string; selectedId: string; onSelect: (id: string) => void } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const crowded = $derived(peers.length >= 4);
  const initial = $derived((selfName || "?").slice(0, 1).toUpperCase());
</script>

<div class="radar" role="group" aria-label={t.peersTitle}>
  <div class="scope" aria-hidden="true">
    <span class="ring r1"></span>
    <span class="ring r2"></span>
    <span class="ring r3"></span>
    <span class="grid gx"></span>
    <span class="grid gy"></span>
    <span class="sweep"></span>
    <span class="center"><span class="cdot">{initial}</span></span>
  </div>
  {#each peers as p (p.id)}
    {@const pos = blipPos(p.id, crowded)}
    <button
      type="button"
      class="blip"
      class:sel={p.id === selectedId}
      style="left:{pos.xPct}%; top:{pos.yPct}%"
      aria-label={t.pickSendTo(p.name)}
      aria-pressed={p.id === selectedId}
      onclick={() => onSelect(p.id)}
    >
      <span class="ping" aria-hidden="true"></span>
      <span class="bavatar">{p.name.slice(0, 1).toUpperCase()}</span>
      <span class="blabel">{p.name}</span>
    </button>
  {/each}
</div>

<style>
  .radar {
    position: relative;
    width: min(300px, 82vw);
    aspect-ratio: 1;
    margin: var(--space-4) auto var(--space-3);
  }
  .scope {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    overflow: hidden;
    background:
      radial-gradient(circle at center,
        color-mix(in srgb, var(--accent) 10%, transparent) 0%,
        transparent 70%),
      var(--surface-2);
    border: 1px solid var(--border);
  }
  .ring {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .r1 { width: 33%; height: 33%; }
  .r2 { width: 66%; height: 66%; }
  .r3 { width: 99%; height: 99%; }
  .grid {
    position: absolute;
    top: 50%; left: 50%;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .gx { width: 100%; height: 1px; transform: translate(-50%, -50%); }
  .gy { width: 1px; height: 100%; transform: translate(-50%, -50%); }
  .sweep {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      from 0deg,
      color-mix(in srgb, var(--accent) 45%, transparent) 0deg,
      transparent 60deg,
      transparent 360deg);
    animation: sweep 4s linear infinite;
  }
  @keyframes sweep { to { transform: rotate(360deg); } }
  .center {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
  }
  .cdot {
    display: grid; place-items: center;
    width: 34px; height: 34px; border-radius: 50%;
    background: var(--accent); color: #fff;
    font-size: var(--fs-sm); font-weight: 700;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .blip {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    background: none; border: none; padding: 4px; cursor: pointer;
    color: var(--text-h);
  }
  .bavatar {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 50%;
    background: var(--surface); border: 1px solid var(--accent-border, var(--border));
    font-size: var(--fs-xs); font-weight: 700;
    box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .blip.sel .bavatar {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .blabel {
    font-size: 11px; max-width: 10ch; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ping {
    position: absolute; top: 15px; left: 50%;
    width: 30px; height: 30px; margin: -15px 0 0 -15px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
    animation: ping 1.6s ease-out 2; /* two pulses on appearance, then rest */
    pointer-events: none;
  }
  @keyframes ping {
    0% { opacity: .8; transform: scale(.4); }
    100% { opacity: 0; transform: scale(2.4); }
  }
  .blip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
  @media (prefers-reduced-motion: reduce) {
    .sweep { animation: none; opacity: .5; }
    .scope .ring { animation: breathe 3s ease-in-out infinite; }
    .ping { animation: none; opacity: 0; }
    @keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  }
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/DeviceRadar.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/DeviceRadar.svelte web/src/lib/DeviceRadar.test.ts
git commit -m "feat(radar): DeviceRadar presentational component"
```

---

### Task 3: Wire the radar into the LAN home `.peers` section

**Files:**
- Modify: `web/src/App.svelte` (script: add selection state; template: `.peers` section body around lines 1265–1308; add `import DeviceRadar`)

**Interfaces:**
- Consumes: `DeviceRadar` (Task 2). Reuses existing App state/handlers: `visiblePeers`, `selfName`, `busy`, `dragActive`, `dropTarget`, `outbox`, `takeOutbox`, `sendFiles`, `pickFile`, `onDrop`, `MAX_FILES`, `navigate`, and `t`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the import**

In the import block near the other `./lib/*.svelte` imports (e.g. after `import Hero from "./lib/Hero.svelte";` at `App.svelte:50`), add:

```ts
import DeviceRadar from "./lib/DeviceRadar.svelte";
```

- [ ] **Step 2: Add selection state + derived effective selection**

Near the other `.peers`-related derivations (after `const visiblePeers = $derived(...)` at `App.svelte:207`), add:

```ts
// Which peer's send card is expanded below the radar. Solo auto-selects; a
// stale selection (peer left) falls back to none.
let selectedPeerId = $state("");
const effectiveSelected = $derived(
  visiblePeers.length === 1
    ? visiblePeers[0].id
    : visiblePeers.some((p) => p.id === selectedPeerId) ? selectedPeerId : "",
);
const selectedPeer = $derived(visiblePeers.find((p) => p.id === effectiveSelected) ?? null);
```

- [ ] **Step 3: Extract the existing peer card into a reusable snippet**

The existing `<li class="peer">…</li>` (currently `App.svelte:1275–1305`) is moved verbatim into a snippet so it can render for the selected peer. Immediately after `<main>` / alongside the `transferSurface` snippet definition, add this snippet (the markup is the current card, with `solo` replaced by a `solo` parameter):

```svelte
{#snippet peerCard(p, solo)}
  <li
    class="peer"
    class:disabled={busy}
    ondragover={(e) => { e.preventDefault(); if (!busy) (e.currentTarget as HTMLElement).classList.add("drag"); }}
    ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
    ondrop={(e) => { e.stopPropagation(); if (busy) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
  >
    <label class="pcard">
      <span class="pavatar" class:big={solo}>{p.name.slice(0, 1).toUpperCase()}</span>
      <span class="ptext">
        {#if solo}
          <span class="pname">{t.pickSendTo(p.name)}</span>
        {:else}
          <span class="pname">{p.name}</span>
          <span class="pick">{t.pickHint(MAX_FILES)}</span>
        {/if}
      </span>
      <input id={`pick-${p.id}`} type="file" multiple disabled={busy}
        onclick={(e) => { if (outbox().length) { e.preventDefault(); sendFiles(p.id, takeOutbox()); } }}
        onchange={(e) => pickFile(e, p.id)} />
    </label>
    <div class="peer-actions">
      <label class="act-btn" class:disabled={busy} for={`pick-${p.id}`}>📄 {t.sendFile}</label>
      {#if folderUploadSupported}
        <label class="act-btn" class:disabled={busy}>
          📁 {t.sendFolder}
          <input type="file" webkitdirectory multiple disabled={busy} onchange={(e) => pickFile(e, p.id)} />
        </label>
      {/if}
    </div>
  </li>
{/snippet}
```

- [ ] **Step 4: Replace the `.peers` empty/list body with the radar**

Replace the whole block currently at `App.svelte:1265–1308`:

```svelte
    {#if visiblePeers.length === 0}
      <div class="empty">
        <p class="empty-lead">{t.emptyPeers}</p>
        {#if currentRoute() === "lan"}
          <button class="btn btn-ghost empty-cta" onclick={() => navigate("cross")}>{t.emptyCrossCta}</button>
        {/if}
      </div>
    {:else}
      <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, busy) === "pick"}>
        {#each visiblePeers as p (p.id)}
          <li … > … </li>   <!-- the block being extracted in Step 3 -->
        {/each}
      </ul>
    {/if}
```

with:

```svelte
    <DeviceRadar
      peers={visiblePeers}
      {selfName}
      selectedId={effectiveSelected}
      onSelect={(id) => (selectedPeerId = id)}
    />
    {#if visiblePeers.length === 0}
      <div class="empty">
        <p class="empty-lead">{t.emptyPeers}</p>
        {#if currentRoute() === "lan"}
          <button class="btn btn-ghost empty-cta" onclick={() => navigate("cross")}>{t.emptyCrossCta}</button>
        {/if}
      </div>
    {:else if selectedPeer}
      <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, busy) === "pick"}>
        {@render peerCard(selectedPeer, visiblePeers.length === 1)}
      </ul>
    {/if}
```

Note: `{@const solo = visiblePeers.length === 1}` at `App.svelte:1252` may now be unused if nothing else in the snippet references it — if `svelte-check` flags it as unused, remove that line; otherwise leave it.

- [ ] **Step 5: Type-check**

Run: `cd web && npm run check`
Expected: no errors (0 problems). Fix any unused-variable warning per the Step 4 note.

- [ ] **Step 6: Run the full unit suite**

Run: `cd web && npx vitest run`
Expected: all tests pass (including Tasks 1–2).

- [ ] **Step 7: Manual end-to-end verification (headless WebRTC, 2 tabs)**

Use the repo's headless WebRTC harness (memory: `headless-webrtc-e2e`; launch Chrome with `--use-fake-ui-for-media-stream`, two tabs on the LAN home). Verify:
1. Idle LAN home (one tab): radar sweeps; empty caption `t.emptyPeers` + cross CTA visible; zero blips.
2. Second tab joins the same default room: a blip pings in on the first tab; since it is solo, its send card auto-expands below the radar; picking a file sends end-to-end.
3. Third tab joins: two blips; no card auto-expands; clicking a blip expands that peer's card; clicking the other switches; the selected blip shows the accent ring.
4. Close one peer tab: its blip disappears; if it was selected, the card collapses (radar-only).
5. Emulate `prefers-reduced-motion: reduce` (DevTools rendering pane): sweep stops, rings breathe, blips still shown.

Record pass/fail per step. If any fail, fix before committing (use systematic-debugging).

- [ ] **Step 8: Commit**

```bash
git add web/src/App.svelte
git commit -m "feat(radar): show nearby devices on a scanning radar (LAN home)"
```

---

## Self-Review

- **Spec coverage:** component boundary (Tasks 2–3), stable blip placement (Task 1), scan animation + reduced-motion (Task 2), blip = accessible send button (Task 2), selection rules incl. solo auto-select and stale fallback (Task 3 Step 2), reuse of existing card with 📄/📁 + drag-drop (Task 3 Steps 3–4), empty caption + cross CTA retained (Task 3 Step 4), LAN-only scope (unchanged route switch), no new i18n keys (reused throughout), verification (Task 3 Step 7). All covered.
- **Placeholders:** none — full code in every code step.
- **Type consistency:** `blipPos(id, crowded?) → {xPct,yPct}` defined in Task 1, consumed identically in Task 2; `DeviceRadar` prop shape `{peers, selfName, selectedId, onSelect}` defined in Task 2, passed identically in Task 3; `Peer = {id,name}` used consistently.
