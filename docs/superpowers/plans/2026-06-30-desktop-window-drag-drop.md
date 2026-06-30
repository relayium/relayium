# 桌面整页拖拽发送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端把文件拖到浏览器窗口任意位置即可发送给实时对端（仅 1 台对端时零选择；多台时引导落到设备卡片）。

**Architecture:** 判定逻辑抽成 DOM-free 的纯函数（`web/src/lib/drag.ts`：`hasFiles`、`dropTarget`）以便单测；`App.svelte` 注册窗口级 drag 监听，用纯函数决定是否激活与落下行为，并渲染一个全屏提示浮层。激活仅在"有实时对端且不忙"时发生，天然避开「存储链接」上传卡。

**Tech Stack:** Svelte 5 runes + TypeScript；Vitest。

## Global Constraints

- 激活条件：拖入的是文件（`dataTransfer.types` 含 `"Files"`）、`visiblePeers.length >= 1`、`!busy`。
- 落下行为由 `dropTarget(peerCount, busy)` 决定：`off`（busy 或 0 台）/`send`（恰 1 台 → 发给它）/`pick`（多台 → 须落到设备卡片，空白处不发）。
- 浮层 `pointer-events: none`，绝不拦截设备卡片的拖放命中。
- 设备卡片 `ondrop` 必须 `e.stopPropagation()`，避免事件冒泡到窗口 `drop` 造成双发。
- 纯桌面增强：移动端无拖放，不影响触控；不改任何传输/信令逻辑。
- 新 i18n 顶层键 `dragSendOne: (name) => string`、`dragSendMany: string`，覆盖全部 6 语言（zh/en/ja/ko/de/fr）；每个语言对象 `: Messages`，缺键由 `svelte-check` 报错兜底。
- 提交信息结尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 验证：`cd web && npm run check && npm test && npm run build`。

## File Structure

- `web/src/lib/drag.ts`（新）：`hasFiles`、`dropTarget` 纯函数。
- `web/src/lib/drag.test.ts`（新）：单测。
- `web/src/lib/i18n.svelte.ts`（改）：`dragSendOne`/`dragSendMany`（接口 + 6 语言）。
- `web/src/lib/i18n.test.ts`（改）：完整性断言。
- `web/src/App.svelte`（改）：窗口监听、`dragActive`、浮层、卡片 `stopPropagation` 与高亮、CSS。

执行顺序：1 → 2 → 3。

---

### Task 1: drag.ts 纯判定逻辑

**Files:**
- Create: `web/src/lib/drag.ts`
- Test: `web/src/lib/drag.test.ts`

**Interfaces:**
- Produces:
  - `hasFiles(types: readonly string[] | DOMStringList | undefined): boolean`
  - `dropTarget(peerCount: number, busy: boolean): "off" | "send" | "pick"`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/drag.test.ts
import { describe, it, expect } from "vitest";
import { hasFiles, dropTarget } from "./drag";

describe("hasFiles", () => {
  it("true when the drag types include Files", () => {
    expect(hasFiles(["Files"])).toBe(true);
    expect(hasFiles(["text/plain", "Files"])).toBe(true);
  });
  it("false for non-file drags, empty, or undefined", () => {
    expect(hasFiles(["text/plain"])).toBe(false);
    expect(hasFiles([])).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });
});

describe("dropTarget", () => {
  it("off when busy regardless of peer count", () => {
    expect(dropTarget(1, true)).toBe("off");
    expect(dropTarget(3, true)).toBe("off");
  });
  it("off when there are no peers", () => {
    expect(dropTarget(0, false)).toBe("off");
  });
  it("send for exactly one peer", () => {
    expect(dropTarget(1, false)).toBe("send");
  });
  it("pick for multiple peers", () => {
    expect(dropTarget(2, false)).toBe("pick");
    expect(dropTarget(5, false)).toBe("pick");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/drag.test.ts`
Expected: FAIL — `hasFiles` / `dropTarget` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/lib/drag.ts
// Pure logic for window-wide drag-to-send. Kept DOM-free so it is unit-testable.

/** Whether a drag carries files (vs. dragging a page element or selected text).
 *  `types` may be a DOMStringList (real DataTransfer) or a string[] (tests); both
 *  are indexable, so we iterate by index. */
export function hasFiles(
  types: readonly string[] | DOMStringList | undefined,
): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

/** Decide what a window-level file drop should do.
 *  - "off":  inactive (a transfer is in progress, or there is no peer) — let the
 *            page's own drop handling (e.g. the stored-upload card) take over.
 *  - "send": exactly one peer — dropping anywhere sends to it.
 *  - "pick": multiple peers — the user must drop onto a specific device card. */
export function dropTarget(
  peerCount: number,
  busy: boolean,
): "off" | "send" | "pick" {
  if (busy || peerCount <= 0) return "off";
  return peerCount === 1 ? "send" : "pick";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/drag.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/drag.ts web/src/lib/drag.test.ts
git commit -m "feat(web): drag.ts — hasFiles + dropTarget pure logic for window drop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: i18n — 拖拽提示文案（6 语言）

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Produces: `Messages` gains top-level `dragSendOne: (name: string) => string` and `dragSendMany: string`. Used by Task 3.

- [ ] **Step 1: Add the keys to the `Messages` interface**

In `web/src/lib/i18n.svelte.ts`, inside `export interface Messages { … }`, add right after `emptyPeers: string;`:

```ts
  dragSendOne: (name: string) => string;
  dragSendMany: string;
```

- [ ] **Step 2: Add both keys to all 6 language objects (verbatim)**

Each language object is typed `: Messages`, so `npm run check` fails until all six have these keys. Add to each language object next to its `emptyPeers` entry:

**zh:**
```ts
  dragSendOne: (name) => `松手发送给 ${name}`,
  dragSendMany: "拖到某台设备上发送",
```

**en:**
```ts
  dragSendOne: (name) => `Release to send to ${name}`,
  dragSendMany: "Drop onto a device to send",
```

**ja:**
```ts
  dragSendOne: (name) => `${name} に送信するには離してください`,
  dragSendMany: "送信先のデバイスにドロップしてください",
```

**ko:**
```ts
  dragSendOne: (name) => `놓으면 ${name}에게 전송`,
  dragSendMany: "보낼 기기 위에 놓으세요",
```

**de:**
```ts
  dragSendOne: (name) => `Loslassen, um an ${name} zu senden`,
  dragSendMany: "Zum Senden auf ein Gerät ziehen",
```

**fr:**
```ts
  dragSendOne: (name) => `Relâchez pour envoyer à ${name}`,
  dragSendMany: "Déposez sur un appareil pour envoyer",
```

- [ ] **Step 3: Add a completeness assertion (i18n.test.ts)**

Append inside the existing `describe("i18n completeness", …)`:

```ts
  it("every language has the window-drag strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.dragSendOne("Dev"), `${code}.dragSendOne`).toContain("Dev");
      expect(m.dragSendMany, `${code}.dragSendMany`).toBeTruthy();
    }
  });
```

- [ ] **Step 4: Type-check and test**

Run: `cd web && npm run check && npx vitest run src/lib/i18n.test.ts`
Expected: check 0 errors (all 6 langs satisfy `Messages`), i18n tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/i18n.svelte.ts web/src/lib/i18n.test.ts
git commit -m "feat(web): i18n window-drag hint strings across all 6 languages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: App.svelte — 窗口拖拽监听 + 浮层

**Files:**
- Modify: `web/src/App.svelte`

**Interfaces:**
- Consumes: `hasFiles`, `dropTarget` (Task 1); `t.dragSendOne`/`t.dragSendMany` (Task 2); existing `visiblePeers` (`$derived`), `busy` (`$derived`), `sendFiles(peerId, files)`.

- [ ] **Step 1: Import the pure logic**

Add to the import block of `web/src/App.svelte` (near the other `./lib/*` imports):

```ts
  import { hasFiles, dropTarget } from "./lib/drag";
```

- [ ] **Step 2: Add drag state**

Near the other reactive state (e.g. just after `let dragActive`-less existing state like `let notice = $state("");`), add:

```ts
  let dragActive = $state(false);
  let dragDepth = 0; // non-reactive: dragenter/dragleave fire per element; count to know when the drag truly leaves the window
```

- [ ] **Step 3: Register window drag listeners in a synchronous onMount**

The existing `onMount(async () => …)` returns a Promise, so Svelte will NOT call its return value as cleanup. Add a SECOND, synchronous `onMount` (Svelte allows multiple) right after the existing one, whose returned function removes the listeners:

```ts
  onMount(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      dragDepth++;
      dragActive = true;
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      e.preventDefault(); // without this the browser opens the dropped file
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dragActive = false;
    };
    const onWindowDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      dragDepth = 0;
      dragActive = false;
      if (dropTarget(visiblePeers.length, busy) === "send") {
        const files = e.dataTransfer?.files;
        if (files?.length) sendFiles(visiblePeers[0].id, files);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onWindowDrop);
    };
  });
```

- [ ] **Step 4: Stop the card drop from bubbling to the window (prevents double-send)**

In the `transferSurface` snippet, the peer `<li>` currently has:

```svelte
            ondrop={(e) => { if (busy) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
```

Change it to stop propagation so a card drop is never also handled by the window listener:

```svelte
            ondrop={(e) => { e.stopPropagation(); if (busy) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
```

- [ ] **Step 5: Highlight the device cards in "pick" mode**

In the `transferSurface` snippet, change the peers list `<ul>` opening tag from `<ul>` to:

```svelte
      <ul class:dragging={dragActive && dropTarget(visiblePeers.length, busy) === "pick"}>
```

- [ ] **Step 6: Add the overlay markup**

Immediately after the `{/snippet}` line (the close of `transferSurface`) and before `{#if currentRoute() === "download"}`, add the overlay (renders regardless of route; gated so it only shows when active and there is a real target):

```svelte
  {#if dragActive && dropTarget(visiblePeers.length, busy) !== "off"}
    <div class="dropzone">
      <div class="dropzone-inner">
        {dropTarget(visiblePeers.length, busy) === "send"
          ? t.dragSendOne(visiblePeers[0].name)
          : t.dragSendMany}
      </div>
    </div>
  {/if}
```

- [ ] **Step 7: Add the CSS**

Add to the component `<style>` block:

```css
  .dropzone {
    position: fixed; inset: 0; z-index: 50;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-bg);
    pointer-events: none; /* never intercept device-card drops */
  }
  .dropzone-inner {
    padding: 22px 34px; border-radius: 16px;
    border: 2px dashed var(--accent); color: var(--text-h);
    background: var(--bg); box-shadow: var(--shadow);
    font-size: 18px; font-weight: 500;
  }
  .peers ul.dragging .peer { border-color: var(--accent-border); background: var(--accent-bg); }
```

- [ ] **Step 8: Type-check, test, build**

Run: `cd web && npm run check && npm test && npm run build`
Expected: check 0 errors, all vitest PASS, build succeeds.

- [ ] **Step 9: Manual smoke (document in commit; not automated)**

With `npm run dev` + the Go server (two browser profiles on the same network):
1. LAN, exactly 1 other device: drag a file anywhere on the window → overlay "松手发送给 …" → release → it sends.
2. LAN, 2+ devices: drag a file → overlay "拖到某台设备上发送" + cards highlight; releasing on empty space does NOT send; releasing on a card sends to that device.
3. Cross-network, connected to a peer: window-wide drag/drop sends; before connecting (stored-upload card visible) a window drop does NOT trigger a realtime send.
4. During an in-progress transfer: dragging does not activate the overlay and does not send.

- [ ] **Step 10: Commit**

```bash
git add web/src/App.svelte
git commit -m "feat(web): window-wide drag-and-drop to send (overlay + single-target send)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

整支验证：`cd web && npm run check && npm test && npm run build`。
随后进入 `superpowers:finishing-a-development-branch`（含最终整支 opus 审查）。
