# Cross-Network Login — Web Client Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the web client in line with the already-shipped Plan A server: gate cross-network code/link minting behind login (initiator-owned model), surface the server's `relayDenied` marker, warn the owner when they're over the monthly relay cap, and reconcile the "no sign-in" copy that the login gate makes inaccurate — all in six languages.

**Architecture:** Plan A (server, already on this branch) made `/api/pair` require a session and `/api/ice` withhold TURN with `relayDenied:"quota"` when the code owner is over `relay_monthly_free_bytes`. This plan is the client half. `ice.ts` gains a `relayDenied` field. `CodePairing.svelte` gates its *mint* actions behind `session().user` (the *join/receive* path stays anonymous), reusing OfflinePage's `<Account bind:open>` panel + session pattern. `App.svelte` captures `relayDenied` from `fetchIceConfig` and threads it to a proactive banner on the minter's code card and to a distinct failure message on the transfer surface. Existing "no sign-in" marketing copy on the cross-network page is re-worded to "recipient needs no account / sender signs in to send across networks" (LAN copy stays "no sign-in").

**Tech Stack:** Svelte 5 (runes), TypeScript, Vite, Vitest + jsdom. Tests: `cd web && npm test` (Vitest) and `npm run check` (svelte-check + tsc). No component-test harness exists (no `@testing-library/svelte`); UI tasks are gated by `npm run check`, the i18n parity test, and manual/headless verification.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-cross-network-login-relay-attribution-design.md`. Server plan (done): `docs/superpowers/plans/2026-07-06-cross-network-login-relay-attribution-server.md`.
- **Initiator-owned model:** minting a pairing code / share link (the "Send files", "Send folder", and bare "Create a connection" actions) requires a logged-in session. The receiver path — typing a 6-digit code, or opening a `#c=` join link — stays fully anonymous and must not be gated.
- **LAN is untouched:** the home/LAN page mints no `/api/pair` code and gets no TURN; its "no sign-in" copy stays true and must NOT be changed. Only *cross-network* page copy is reconciled.
- **`relayDenied` is the code owner's, not the caller's:** `/api/ice?code=` resolves the owner from the code and reports `relayDenied:"quota"` to whoever asks. The proactive banner therefore lives in the *minter-only* branch of the code card; the on-failure message is worded so it also reads sensibly for a receiver.
- **`Messages` type enforces i18n parity:** every language file (`en/zh/ja/ko/de/fr`) is typed `Messages`, so adding a required key to `types.ts` fails `npm run check` until all six are filled. Keep every task's tsc green by adding the type + all six languages together.
- **P2P still free:** when `relayDenied:"quota"` withholds TURN, `hasTurnServer(iceServers)` is false, so `rtcConfig()` already falls back to default-policy ICE and a direct P2P connection is still attempted (and, if it succeeds, is free and unmetered). The quota UX only appears on the *relay-would-have-been-needed* failure path — it must not block or pre-empt a P2P attempt.
- Module/paths are under `web/src`. Existing i18n tone: terse, `·`-separated fragments, em-dashes; match it.

---

### Task 1: `ice.ts` surfaces `relayDenied`

**Files:**
- Modify: `web/src/lib/ice.ts`
- Test: `web/src/lib/ice.test.ts`

**Interfaces:**
- Produces: `IceConfig` gains `relayDenied?: string` (present, `"quota"`, when the server withheld TURN over the cap; absent otherwise). `fetchIceConfig(code)` returns it; `fetchIceServers(code)` is unchanged (still returns just the list).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `web/src/lib/ice.test.ts` inside the existing top-level (a new `describe`, after the `fetchIceServers` block):

```ts
describe("fetchIceConfig relayDenied", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes through relayDenied when the server withholds TURN over the cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: STUN, relays: [], relayDenied: "quota" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBe("quota");
    expect(cfg.iceServers).toEqual(STUN);
  });

  it("leaves relayDenied undefined when the server does not send it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: STUN, relays: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBeUndefined();
  });

  it("leaves relayDenied undefined on a fallback (non-ok / network error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBeUndefined();
    expect(cfg.iceServers).toEqual(FALLBACK_STUN);
  });
});
```

`fetchIceConfig` is already imported? Check the import line at the top of the test file — it currently imports `{ fetchIceServers, hasTurnServer, pickRelay }`. Add `fetchIceConfig` to it. `STUN` already exists in the file. Add a `FALLBACK_STUN` const next to `STUN` mirroring `ice.ts`'s FALLBACK: `const FALLBACK_STUN = [{ urls: "stun:stun.l.google.com:19302" }];`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/lib/ice.test.ts`
Expected: FAIL — `relayDenied` is `undefined` in the first case (property not read yet).

- [ ] **Step 3: Add the field and parse it**

In `web/src/lib/ice.ts`, extend the interface:

```ts
export interface IceConfig {
  iceServers: RTCIceServer[]; // fallback / legacy single relay + STUN
  relays: RelayEntry[]; // the pool (empty unless the server advertises one)
  relayDenied?: string; // "quota" when the code owner is over the monthly relay cap and TURN was withheld
}
```

In `fetchIceConfig`, read it from the body and return it (the fallback paths carry no `relayDenied`):

```ts
export async function fetchIceConfig(code = ""): Promise<IceConfig> {
  const q = code ? `?code=${encodeURIComponent(code)}` : "";
  try {
    const res = await fetch(`/api/ice${q}`, { credentials: "include" });
    if (!res.ok) return { iceServers: FALLBACK, relays: [] };
    const body = (await res.json()) as {
      iceServers?: RTCIceServer[];
      relays?: RelayEntry[];
      relayDenied?: string;
    };
    return { iceServers: body.iceServers ?? FALLBACK, relays: body.relays ?? [], relayDenied: body.relayDenied };
  } catch {
    return { iceServers: FALLBACK, relays: [] };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/lib/ice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd web && npm run check
git add web/src/lib/ice.ts web/src/lib/ice.test.ts
git commit -m "feat(ice): surface relayDenied from /api/ice in fetchIceConfig"
```

---

### Task 2: i18n keys for the login gate and quota messages

**Files:**
- Modify: `web/src/lib/i18n/types.ts`
- Modify: `web/src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `ko.ts`, `de.ts`, `fr.ts`
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Produces three new keys under the existing `crossnet` block: `crossnet.signInToSend`, `crossnet.relayQuotaWarn`, `crossnet.relayQuotaFail` (all `string`). Tasks 3 and 4 consume them as `t.crossnet.signInToSend` etc.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

In `web/src/lib/i18n.test.ts`, add a new case inside the `describe("i18n completeness")` block (mirror the existing per-language loops):

```ts
  it("every language has the cross-network login-gate and relay-quota strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.crossnet.signInToSend, `${code}.crossnet.signInToSend`).toBeTruthy();
      expect(m.crossnet.relayQuotaWarn, `${code}.crossnet.relayQuotaWarn`).toBeTruthy();
      expect(m.crossnet.relayQuotaFail, `${code}.crossnet.relayQuotaFail`).toBeTruthy();
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/lib/i18n.test.ts`
Expected: FAIL — `m.crossnet.signInToSend` is `undefined` (and `npm run check` would also fail once used, since the keys aren't on the type yet).

- [ ] **Step 3: Add the three keys to the type**

In `web/src/lib/i18n/types.ts`, extend the `crossnet` block (currently `realtimeTitle`/`realtimeSub`/`realtimeFoot`):

```ts
  crossnet: {
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
    signInToSend: string; // gate hint on the mint card when signed out
    relayQuotaWarn: string; // proactive banner on the minter's code card when over the monthly relay cap
    relayQuotaFail: string; // shown when a cross-network transfer fails and no relay was available (over cap)
  };
```

- [ ] **Step 4: Fill all six languages**

Add the three keys to the `crossnet` block in each file. Exact copy:

**`en.ts`:**
```ts
    signInToSend: "Sign in to send across networks. The person receiving never needs an account.",
    relayQuotaWarn: "You've used up this month's relay traffic. A direct peer-to-peer connection still works — only the relay fallback is unavailable. Upgrade to restore relaying.",
    relayQuotaFail: "Couldn't connect directly, and this month's relay traffic is used up — no relay to fall back on. Try a download link instead, or upgrade to re-enable relaying.",
```

**`zh.ts`:**
```ts
    signInToSend: "登录后即可跨网络发送。接收方无需账号。",
    relayQuotaWarn: "本月中继流量已用尽。点对点直连仍可用——仅中继兜底不可用。升级后恢复中继。",
    relayQuotaFail: "直连失败,且本月中继流量已用尽——无中继可兜底。可改用下载链接,或升级以恢复中继。",
```

**`ja.ts`:**
```ts
    signInToSend: "ネットワークを越えて送るにはサインインが必要です。受け取る相手にアカウントは不要です。",
    relayQuotaWarn: "今月の中継トラフィックを使い切りました。P2P直結は引き続き利用できます——中継フォールバックのみ使えません。アップグレードで中継を回復できます。",
    relayQuotaFail: "直結できず、今月の中継トラフィックも使い切っています——フォールバックする中継がありません。ダウンロードリンクをお試しいただくか、アップグレードで中継を再有効化してください。",
```

**`ko.ts`:**
```ts
    signInToSend: "네트워크를 넘어 보내려면 로그인하세요. 받는 사람은 계정이 필요 없습니다.",
    relayQuotaWarn: "이번 달 중계 트래픽을 모두 사용했습니다. P2P 직접 연결은 계속 가능하며 중계 대체 경로만 사용할 수 없습니다. 업그레이드하면 중계가 복구됩니다.",
    relayQuotaFail: "직접 연결에 실패했고 이번 달 중계 트래픽도 모두 사용해 대체할 중계가 없습니다. 다운로드 링크를 사용하거나 업그레이드하여 중계를 다시 켜세요.",
```

**`de.ts`:**
```ts
    signInToSend: "Zum netzwerkübergreifenden Senden anmelden. Die empfangende Person braucht nie ein Konto.",
    relayQuotaWarn: "Das Relay-Kontingent dieses Monats ist aufgebraucht. Eine direkte Peer-to-Peer-Verbindung funktioniert weiterhin — nur der Relay-Rückfall steht nicht zur Verfügung. Upgraden, um das Relay wiederherzustellen.",
    relayQuotaFail: "Direkte Verbindung fehlgeschlagen und das Relay-Kontingent dieses Monats ist aufgebraucht — kein Relay als Rückfall. Nutze stattdessen einen Download-Link oder upgrade, um das Relay wieder zu aktivieren.",
```

**`fr.ts`:**
```ts
    signInToSend: "Connectez-vous pour envoyer d'un réseau à l'autre. La personne qui reçoit n'a jamais besoin de compte.",
    relayQuotaWarn: "Vous avez épuisé le trafic de relais de ce mois-ci. Une connexion directe pair-à-pair fonctionne toujours — seul le relais de secours est indisponible. Passez à une offre supérieure pour rétablir le relais.",
    relayQuotaFail: "Connexion directe impossible et le trafic de relais de ce mois-ci est épuisé — aucun relais de secours. Utilisez plutôt un lien de téléchargement, ou passez à une offre supérieure pour réactiver le relais.",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/lib/i18n.test.ts && npm run check`
Expected: PASS (test green; tsc green because all six languages now satisfy the extended `Messages` type).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/i18n/types.ts web/src/lib/i18n/en.ts web/src/lib/i18n/zh.ts web/src/lib/i18n/ja.ts web/src/lib/i18n/ko.ts web/src/lib/i18n/de.ts web/src/lib/i18n/fr.ts web/src/lib/i18n.test.ts
git commit -m "i18n(crossnet): add login-gate + relay-quota strings in six languages"
```

---

### Task 3: Gate the mint path behind login on the cross-network page

**Files:**
- Modify: `web/src/lib/CodePairing.svelte`
- Modify: `web/src/lib/CrossPage.svelte`

**Interfaces:**
- Consumes: `session()` from `auth.svelte`, `Account` from `Account.svelte`, `HttpError` from `transfer-link`, `t.crossnet.signInToSend` + `t.account.signIn` (existing).
- Produces: `CodePairing` gains an optional prop `requireLogin?: () => void`; `CrossPage` owns a `loginOpen` state, renders `<Account bind:open={loginOpen} />`, and passes `requireLogin={() => (loginOpen = true)}` to `CodePairing`.

Rationale: the *mint* actions (Send file / Send folder / bare "Create a connection") now require a session; the *join* path (enter code / open link) stays anonymous. So gate only the "choose" branch's send actions, and keep "Enter a code" available signed-out. Mirror OfflinePage's `session().user` gate + `<Account bind:open>` panel.

- [ ] **Step 1: Add the Account panel + login state to CrossPage**

In `web/src/lib/CrossPage.svelte`:

Add imports (top of `<script>`):
```ts
  import Account from "./Account.svelte";
  import { session } from "./auth.svelte";
```
Add state after the existing `const t = ...` / `const inRoom = ...` lines:
```ts
  let loginOpen = $state(false);
```
Render the account panel — add this as the FIRST child inside `<section class="crosspage">`, before `<header class="cn-head">` (mirrors OfflinePage's `.acct` row):
```svelte
  <div class="acct"><Account bind:open={loginOpen} /></div>
```
Pass the callback where the un-roomed `CodePairing` is rendered (the `{:else}` "Realtime direct" card — currently `<CodePairing />`):
```svelte
        <CodePairing requireLogin={() => (loginOpen = true)} />
```
Leave the in-room `<CodePairing {roomCode} expired={linkDead} />` (line ~62) unchanged — that path is either the minter (already signed in) or a receiver who joined, neither of which shows the mint choices.

Add the `.acct` style rule inside CrossPage's `<style>` (copy OfflinePage's):
```css
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }
```

- [ ] **Step 2: Gate the mint choices in CodePairing**

In `web/src/lib/CodePairing.svelte`:

Add imports / prop / session:
```ts
  import Account from "./Account.svelte"; // not rendered here; see note
  import { session } from "./auth.svelte";
  import { HttpError } from "./transfer-link";
```
Wait — `Account` is rendered by CrossPage, not here. Do NOT import `Account` in CodePairing. Only add:
```ts
  import { session } from "./auth.svelte";
  import { HttpError } from "./transfer-link";
```
Extend the props (line ~12):
```ts
  let { roomCode = "", expired = false, requireLogin }:
    { roomCode?: string; expired?: boolean; requireLogin?: () => void } = $props();
```

Replace the "choose" branch's contents (the final `{:else}` block, currently the `<div class="choices">…</div>` + the bare-connect `<button class="btn-link">`) so the mint UI shows only when signed in, and a sign-in prompt otherwise. The "Enter a code" button must stay available in BOTH states:

```svelte
  {:else}
    {#if session().user}
      <div class="choices">
        <label class="btn btn-primary" class:disabled={busy}>
          📄 {t.sendFile}
          <input type="file" multiple disabled={busy} onchange={pickAndSend} />
        </label>
        {#if folderUploadSupported}
          <label class="btn btn-primary" class:disabled={busy}>
            📁 {t.sendFolder}
            <input type="file" webkitdirectory multiple disabled={busy} onchange={pickAndSend} />
          </label>
        {/if}
        <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
      </div>
      <button class="btn-link" disabled={busy} onclick={send}>{busy ? t.generating : t.pair.bareConnect}</button>
    {:else}
      <div class="signin">
        <button class="btn btn-primary" onclick={() => requireLogin?.()}>{t.account.signIn}</button>
        <p class="hint">{t.crossnet.signInToSend}</p>
      </div>
      <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    {/if}
  {/if}
```

Add the `.signin` styles to CodePairing's `<style>` (mirror OfflinePage):
```css
  .signin { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; max-width: 34ch; }
```

- [ ] **Step 3: Make a 401 from a stale session re-open login instead of a bare error**

Still in `CodePairing.svelte`, update `send()`'s `catch` (line ~88) so an expired/absent session (server returns 401) prompts login rather than showing the generic mint-failed copy. Change:
```ts
    } catch {
      busy = false;
      if (!roomCode) clearOutbox();
      err = t.pair.mintFailed;
    }
```
to:
```ts
    } catch (e) {
      busy = false;
      if (!roomCode) clearOutbox();
      // A 401 means the session lapsed between render and mint — re-open the login
      // panel instead of a dead-end "couldn't create a code" error.
      if (e instanceof HttpError && e.status === 401) { requireLogin?.(); return; }
      err = t.pair.mintFailed;
    }
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npm run check`
Expected: PASS (no type errors; `requireLogin` optional, `session`/`HttpError` imported).

- [ ] **Step 5: Manual verification (signed-out gate)**

Run the app (`cd web && npm run dev`), open `/cross-network` in a fresh/private window (no session):
- The realtime card shows a **Sign in** button + the `signInToSend` hint; **no** Send-file/Send-folder/bare-connect buttons.
- **Enter a code** is still present; clicking it and typing a 6-digit code still joins (receiver path un-gated).
- Clicking **Sign in** opens the Account panel; after signing in, the Send file / Send folder / Create-connection actions appear and mint a code.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/CodePairing.svelte web/src/lib/CrossPage.svelte
git commit -m "feat(cross): require login to mint a cross-network code; receiver path stays anonymous"
```

---

### Task 4: Relay-quota UX — proactive banner + failure message

**Files:**
- Modify: `web/src/lib/ice.ts` — (already has `relayDenied`; no change)
- Modify: `web/src/App.svelte`
- Modify: `web/src/lib/CrossPage.svelte`
- Modify: `web/src/lib/CodePairing.svelte`

**Interfaces:**
- Consumes: `IceConfig.relayDenied` (Task 1), `t.crossnet.relayQuotaWarn` + `t.crossnet.relayQuotaFail` (Task 2).
- Produces: `App.svelte` holds `let relayDenied = $state<string>("")`, set from every `fetchIceConfig(roomCode)` result; passes `relayDenied` to `<CrossPage>`; uses it in the transfer surface. `CrossPage` forwards `relayDenied` to the in-room `<CodePairing>`. `CodePairing` shows the proactive banner in its minter branch.

- [ ] **Step 1: Capture `relayDenied` in App from both ICE fetches**

In `web/src/App.svelte`, add state near the other room-scoped `$state` (e.g. beside `let linkDead = $state(false)` at line ~100):
```ts
  let relayDenied = $state<string>(""); // "quota" when the code owner is over the monthly relay cap (no TURN issued)
```

At the initial-mount fetch (line ~335) set it alongside `iceServers`/`relayPool`:
```ts
    const ice = await fetchIceConfig(roomCode);
    iceServers = ice.iceServers;
    relayPool = ice.relays;
    relayDenied = ice.relayDenied ?? "";
```

At the `switchRoom` fetch (line ~407), after the stale-epoch guard (`if (epoch !== roomEpoch) return;`) set it too:
```ts
    iceServers = ice.iceServers;
    relayPool = ice.relays;
    relayDenied = ice.relayDenied ?? "";
```
Also, in `switchRoom`, reset it at the top with the other room-scoped resets (beside `linkDead = false;` at line ~400) so a new room starts clean:
```ts
    relayDenied = "";
```

- [ ] **Step 2: Pass `relayDenied` to CrossPage**

In `App.svelte`, the cross-network render (line ~1249):
```svelte
    <CrossPage {roomCode} {linkDead} {showTransfer} {relayDenied} {transferSurface} dismissLan={() => (lanDismissed = true)} />
```

- [ ] **Step 3: Show the failure message on a quota-denied transfer**

In `App.svelte`'s `transferSurface` snippet, augment the status line (line ~1214-1217). Currently:
```svelte
      <div class="status" aria-live="polite">
        {statusText(t, xf)}
        {#if sasCode && !xf.done} · {t.codeLabel} <code>{sasCode}</code>{/if}
      </div>
```
Add a quota note right after the status div, shown only when this transfer failed to connect and the owner was over cap:
```svelte
      <div class="status" aria-live="polite">
        {statusText(t, xf)}
        {#if sasCode && !xf.done} · {t.codeLabel} <code>{sasCode}</code>{/if}
      </div>
      {#if xf.done && !xf.ok && xf.status === "connectFail" && relayDenied === "quota"}
        <p class="quota-note">{t.crossnet.relayQuotaFail}</p>
      {/if}
```
Note: `relayDenied` is a top-level `$state` in App and the `transferSurface` snippet reads it directly (it already reads `sasCode`, `t`, etc. the same way). Add the style near the `.xfer .status` rules in App's `<style>`. App's stylesheet does NOT define `--danger` (its `.banner.error` uses `--text-h`/`--accent-bg`/`--accent-border`), so use those:
```css
  .xfer .quota-note {
    margin: var(--space-2) 0 0; font-size: var(--fs-xs); line-height: 1.5;
    color: var(--text-h);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3); background: var(--accent-bg);
  }
```

- [ ] **Step 4: Forward `relayDenied` through CrossPage to the in-room CodePairing**

In `web/src/lib/CrossPage.svelte`, extend props (line ~14):
```ts
  let { roomCode = "", linkDead = false, showTransfer = false, relayDenied = "", transferSurface, dismissLan }:
    { roomCode?: string; linkDead?: boolean; showTransfer?: boolean; relayDenied?: string; transferSurface?: Snippet; dismissLan?: () => void } = $props();
```
Pass it to the in-room CodePairing (line ~62):
```svelte
        <CodePairing {roomCode} expired={linkDead} {relayDenied} />
```

- [ ] **Step 5: Proactive banner on the minter's code card**

In `web/src/lib/CodePairing.svelte`, extend props to accept `relayDenied` (line ~12, building on Task 3's prop change):
```ts
  let { roomCode = "", expired = false, relayDenied = "", requireLogin }:
    { roomCode?: string; expired?: boolean; relayDenied?: string; requireLogin?: () => void } = $props();
```
In the minter branch (`{#if isMinter}` … after the `yourCode`/code/row block, before the `{/if}` that closes it — a good spot is right after the `{#if outbox().length}` queued line, still inside `{#if isMinter}`), add the banner:
```svelte
      {#if relayDenied === "quota"}
        <p class="quota-warn">{t.crossnet.relayQuotaWarn}</p>
      {/if}
```
Add its style to CodePairing's `<style>`:
```css
  .quota-warn {
    margin: 0; font-size: var(--fs-xs); line-height: 1.5; text-align: center; max-width: 34ch;
    color: var(--text-h);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3); background: var(--code-bg);
  }
```

- [ ] **Step 6: Typecheck**

Run: `cd web && npm run check`
Expected: PASS.

- [ ] **Step 7: Manual/headless verification (over-cap)**

Force the over-cap path to confirm the UX. Two options — pick one:
- **Admin route:** set `relay_monthly_free_bytes` to `0` in the admin settings (so any owner is instantly "over cap"), sign in, mint a code on `/cross-network`. Expect the **`relayQuotaWarn`** banner under the code immediately (minter side). Then attempt a cross-network transfer where P2P can't complete (e.g. two headless tabs behind simulated symmetric NAT per `docs/superpowers` headless-webrtc method) — on `connectFail`, expect the **`relayQuotaFail`** note under the failed transfer card. Restore the setting afterward.
- If NAT simulation is impractical, at minimum verify (a) the proactive banner appears when `relayDenied==="quota"`, and (b) `/api/ice?code=` returns `relayDenied:"quota"` for an over-cap owner (curl the endpoint with the minter's session cookie), and (c) the failure note renders by temporarily hard-coding `relayDenied = "quota"` and a fake `connectFail` xfer — then revert the hard-code.

Record which verification path you used.

- [ ] **Step 8: Commit**

```bash
cd web && npm test && npm run check
git add web/src/App.svelte web/src/lib/CrossPage.svelte web/src/lib/CodePairing.svelte
git commit -m "feat(cross): warn on relay-quota exhaustion (proactive banner + failure note)"
```

---

### Task 5: Reconcile "no sign-in" copy on the cross-network page

**Files:**
- Modify: `web/src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `ko.ts`, `de.ts`, `fr.ts`

**Interfaces:**
- Consumes/produces: no type change — only the *values* of existing keys change. Keys reconciled: `methods.realtime.badge`, `crossnet.realtimeFoot`, `crossSell.realtime.lead`, `howItWorks.realtime.sub`, `howItWorks.realtime.ways[0].tag`, `faq.items[…] "account" Q&A`, `homeCross.desc`.

Rationale (user decision: "精确改措辞"): the login gate makes the cross-network page's blanket "no sign-in / 免登录" claims inaccurate for the *sender*. Re-word each to "recipient needs no account" / "sender signs in to send across networks". **Do not touch LAN copy** (LAN mints no code and stays no-sign-in) or the async page's `offline.signIn` (about the async sender). Only the seven cross-network keys below.

For each language, replace the listed key's value verbatim.

- [ ] **Step 1: `methods.realtime.badge`** (short badge on the cross-network method card)

- en: `badge: "Recipient: no account"`
- zh: `badge: "接收方免注册"`
- ja: `badge: "受信側はアカウント不要"`
- ko: `badge: "받는 사람 계정 불필요"`
- de: `badge: "Empfänger ohne Konto"`
- fr: `badge: "Destinataire sans compte"`

- [ ] **Step 2: `crossnet.realtimeFoot`** (foot line on the active-transfer card)

- en: `realtimeFoot: "Recipient needs no account · end-to-end encrypted"`
- zh: `realtimeFoot: "接收方无需账号 · 端到端加密"`
- ja: `realtimeFoot: "受信側はアカウント不要 · エンドツーエンド暗号化"`
- ko: `realtimeFoot: "받는 사람은 계정 불필요 · 종단간 암호화"`
- de: `realtimeFoot: "Empfänger braucht kein Konto · Ende-zu-Ende-verschlüsselt"`
- fr: `realtimeFoot: "Le destinataire n'a pas besoin de compte · chiffré de bout en bout"`

- [ ] **Step 3: `crossSell.realtime.lead`** (promo shown on the async page → go realtime; drop the "no sign-in" clause)

- en: `lead: "Is the other person online right now? Realtime direct is faster — peer-to-peer, files never touch the server."`
- zh: `lead: "对方就在线？实时直传更快——点对点直连、文件不经服务器。"`
- ja: `lead: "相手が今オンライン？リアルタイム直結の方が速い——P2P直結、ファイルはサーバーを経由しません。"`
- ko: `lead: "상대가 지금 온라인인가요? 실시간 직접 전송이 더 빠릅니다 — P2P 직결, 파일은 서버를 거치지 않습니다."`
- de: `lead: "Ist die andere Person gerade online? Direkt in Echtzeit ist schneller – Peer-to-Peer, Dateien berühren nie den Server."`
- fr: `lead: "L'autre personne est en ligne maintenant ? Le direct en temps réel est plus rapide — pair-à-pair, les fichiers ne touchent jamais le serveur."`

Keep the `cta` on this key unchanged.

- [ ] **Step 4: `howItWorks.realtime.sub`** (drop the trailing "— no sign-in", make it recipient-focused)

- en: `sub: "When both sides are online, connect peer-to-peer across networks — the recipient needs no account."`
- zh: `sub: "双方都在线时,跨网络点对点直连——接收方无需账号。"`
- ja: `sub: "双方がオンラインなら、ネットワークを越えてP2P直結——受信側はアカウント不要。"`
- ko: `sub: "양쪽이 온라인이면 네트워크를 넘어 P2P로 직접 연결 — 받는 사람은 계정이 필요 없습니다."`
- de: `sub: "Wenn beide Seiten online sind, netzwerkübergreifend Peer-to-Peer verbinden — der Empfänger braucht kein Konto."`
- fr: `sub: "Quand les deux côtés sont en ligne, connexion pair-à-pair d'un réseau à l'autre — le destinataire n'a pas besoin de compte."`

- [ ] **Step 5: `howItWorks.realtime.ways[0].tag`** (the "Pick files, get a code" step — this is the *sender's* step, which now needs sign-in)

- en: `tag: "Sign in to send"`
- zh: `tag: "发送需登录"`
- ja: `tag: "送信にはサインイン"`
- ko: `tag: "보내려면 로그인"`
- de: `tag: "Zum Senden anmelden"`
- fr: `tag: "Connexion pour envoyer"`

Leave `ways[1].tag` ("Codes live 15 minutes") and `ways[2].tag` ("Files never touch the server") unchanged.

- [ ] **Step 6: The FAQ "create an account?" Q&A** (find the item whose question is the account question — en: "Do I have to create an account?"; grep each file for it). Replace its `a` value:

- en: `a: "LAN transfers on the same network need no sign-in. Sending across networks by pairing code or link requires the sender to sign in — the recipient never needs an account. Download links also require the sender to sign in, so the encrypted ciphertext can be stored."`
- zh: `a: "同一网络内的 LAN 传输无需登录。通过配对码或链接跨网络发送需要发送方登录——接收方永远无需账号。下载链接同样需要发送方登录,以便存放加密密文。"`
- ja: `a: "同一ネットワーク内のLAN転送はサインイン不要です。配対コードやリンクでネットワークを越えて送るには送信側のサインインが必要ですが、受信側にアカウントは不要です。ダウンロードリンクも、暗号化された暗号文を保存するために送信側のサインインが必要です。"`
- ko: `a: "같은 네트워크 내 LAN 전송은 로그인이 필요 없습니다. 페어링 코드나 링크로 네트워크를 넘어 보내려면 보내는 쪽이 로그인해야 하지만, 받는 쪽은 계정이 필요 없습니다. 다운로드 링크도 암호화된 암호문을 저장하기 위해 보내는 쪽의 로그인이 필요합니다."`
- de: `a: "LAN-Übertragungen im selben Netzwerk brauchen keine Anmeldung. Netzwerkübergreifendes Senden per Kopplungscode oder Link erfordert die Anmeldung des Absenders — der Empfänger braucht nie ein Konto. Auch Download-Links erfordern die Anmeldung des Absenders, damit der verschlüsselte Chiffretext gespeichert werden kann."`
- fr: `a: "Les transferts LAN sur le même réseau ne nécessitent aucune connexion. Envoyer d'un réseau à l'autre par code d'appairage ou lien exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte. Les liens de téléchargement exigent aussi la connexion de l'expéditeur, afin de stocker le texte chiffré."`

Fix the Japanese typo before pasting: use "ペアリングコード" (not "配対コード"). Verify against the file's existing term for "pairing code" and match it.

- [ ] **Step 7: `homeCross.desc`** (homepage two-page blurb — drop "no sign-in")

- en: `desc: "If they're online, use realtime direct (peer-to-peer, files never touch the server); if not, use async transfer (encrypted storage, fetch by link anytime)."`
- zh: `desc: "对方在线就用实时直传(点对点直连、文件不经服务器);不在线就用异步传输(加密存储,随时凭链接取回)。"` — but match the existing zh phrasing for `homeCross.desc`; only remove the "免登录/no sign-in" fragment, keep the rest as-is.
- ja/ko/de/fr: same rule — open each file's `homeCross.desc`, remove only the "no sign-in / 免登録 / no sign-in" fragment, leave the rest verbatim.

(Step 7 is a surgical deletion of one clause, not a rewrite — so match each file's existing wording and just drop the sign-in clause, to avoid drifting the rest of the copy.)

- [ ] **Step 8: Verify no stray cross-network "no sign-in" claims remain**

Run: `cd web && grep -rniE "no sign-in|no sign in|免登录|免登録|ログイン不要|로그인 없이|로그인 불필요|ohne Anmeldung|sans connexion|sans compte" src/lib/i18n` and review each hit — the only survivors should be LAN-scoped copy (if any) and the async page's `offline.signIn` context. Any cross-network survivor is a miss; fix it.

- [ ] **Step 9: Test + typecheck**

Run: `cd web && npx vitest run src/lib/i18n.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 10: Visual spot-check**

`npm run dev`, load `/cross-network` in en and zh: the method-card badge, FAQ, HowItWorks, and active-transfer foot no longer claim blanket "no sign-in"; they read "recipient needs no account / sign in to send". LAN home page copy is unchanged.

- [ ] **Step 11: Commit**

```bash
git add web/src/lib/i18n/en.ts web/src/lib/i18n/zh.ts web/src/lib/i18n/ja.ts web/src/lib/i18n/ko.ts web/src/lib/i18n/de.ts web/src/lib/i18n/fr.ts
git commit -m "i18n(cross): reconcile 'no sign-in' copy with the sender login gate"
```

---

## Self-Review Notes

- **Spec coverage (spec §4 + tests §6):**
  - CrossPage login gate for the initiator, receiver stays anonymous → Task 3 ✓ (mint gated by `session().user`; "Enter a code"/join-link un-gated; OfflinePage `<Account bind:open>` pattern reused).
  - `fetchIceConfig` reads optional `relayDenied` → Task 1 ✓.
  - Over-cap prompt distinct from "no TURN configured", shown on failure/degrade, P2P-if-lucky stays free → Task 4 ✓ (`relayQuotaFail` gated on `connectFail`; `hasTurnServer` false path already attempts P2P; proactive `relayQuotaWarn` added per user decision "铸码即预警").
  - i18n for the new strings + gate copy, six languages, existing key structure → Tasks 2 & 5 ✓.
  - Regression: LAN path untouched → guaranteed (gate only on `/cross-network` CodePairing choose-branch; LAN copy explicitly excluded in Task 5).
- **Placeholder scan:** all steps carry concrete code/copy; the only judgement calls are flagged (App `--danger` availability check in T4S3; JP "ペアリングコード" term-match in T5S6; homeCross surgical-delete in T5S7) with explicit instructions, not TODOs.
- **Type/name consistency:** `relayDenied?: string` (ice.ts) → `relayDenied` `$state` (App) → `relayDenied` prop (CrossPage, CodePairing); `requireLogin?: () => void` prop consistent across CodePairing/CrossPage; `crossnet.signInToSend|relayQuotaWarn|relayQuotaFail` keys identical in types.ts, all six languages, and both consumer tasks.
- **Decisions baked in (from user):** copy scope = "精确改措辞" (Task 5 reconciles the seven cross-network keys, LAN untouched); quota UX = "铸码即预警 + 失败时提示" (Task 4 does both the proactive banner and the failure note).
- **Out of scope (later):** per-plan traffic quota replacing the interim cap (billing phase-1); changing the relay-only ICE policy; any account UI on the LAN/home page.
- **Test-harness caveat:** no `@testing-library/svelte` — Tasks 3/4 UI behaviour is gated by `npm run check` + manual/headless steps, not unit tests. Only the pure `ice.ts` (T1) and i18n parity (T2) are unit-tested. Implementers must read `Account.svelte` (prop `open = $bindable(false)`) and `transfer-link.ts` (`HttpError` has `.status`) before wiring T3.
```
