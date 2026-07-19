# Apps Hub Page (`/apps`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/apps` hub page that presents every Relayium client in one place — Web (available), CLI (available), macOS (Coming soon), iOS (Coming soon) — with a matching prerendered SEO page and nav/footer links.

**Architecture:** A new SPA route `apps` (path `/apps`, component `AppsPage.svelte`) rendered client-side and localized for all 9 languages, mirroring the existing `/cli` marketing-page pattern (self-contained `<section>`, shared `<Nav>` from `App.svelte`, own footer). Platform detection highlights the visitor's card. A prerendered static page for the 8 non-English locales is generated via the existing `buildModePages` pipeline (English is the SPA route, exactly like `/cross-network`). No server changes.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vite, Vitest + jsdom, the Node static-page generator under `web/scripts/`.

## Global Constraints

- **Route naming (locked):** route id `apps`, URL path `/apps`, SPA component `web/src/lib/AppsPage.svelte`, i18n object key `appsPage`, nav label key `nav.appsTab`. Do NOT reuse the name `download` (taken by the `/d/*` recipient route) or `DownloadPage.svelte` (the recipient page).
- **Keep the existing CLI nav tab.** Add the Apps tab as the **5th** tab, after `cli`.
- **9 languages, all required:** `en, zh, ja, ko, de, fr, ar, es, pt`. TypeScript (`npm run check`) fails if any `Messages` key is missing in any table; `validateLangs()` fails the static build if any locale is missing. `ar` is RTL — rely on existing logical-property CSS (`margin-inline`, `padding-inline`, etc.), never physical `left/right`.
- **"Coming soon" cards (macOS, iOS) are non-interactive:** a disabled control + badge, no `href`, no click handler. No email/notify capture anywhere.
- **App Store bundle ids are copy only:** `com.relayium.mac` (macOS) and `com.relayium.app` (iOS) may appear as descriptive text; they wire to nothing this round.
- **Commands run from `web/`:** `cd web` before `npm test` / `npm run check` / `npm run gen:pages`.
- **Run a single Vitest file** with `npm test -- src/lib/<file>.test.ts --run` (the `--run` flag disables watch mode).

---

### Task 1: Add the `apps` route to the router

**Files:**
- Modify: `web/src/lib/router.svelte.ts` (Route union line 10; add `APPS_PATH` const near line 16; `routeFromLocation` lines 35–46; `navigate` ternary lines 80–88)
- Test: `web/src/lib/router.test.ts`

**Interfaces:**
- Produces: `export const APPS_PATH = "/apps"`; `Route` union gains `"apps"`; `routeFromLocation("/apps", "")` returns `"apps"`; `navigate("apps")` pushes `/apps`.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/lib/router.test.ts`. Extend the existing import from `./router.svelte` to include `APPS_PATH`, then add:

```ts
describe("routeFromLocation apps page", () => {
  it("is apps on the /apps path", () => {
    expect(rfl(APPS_PATH, "")).toBe("apps");
  });
  it("a pairing code still wins over /apps", () => {
    expect(rfl("/apps", "#c=424242")).toBe("cross");
  });
  it("does not collide with the /d/ download prefix", () => {
    expect(rfl("/apps", "")).toBe("apps");
    expect(rfl("/d/abc123", "")).toBe("download");
  });
});
```

And inside the existing `describe("navigate", …)` block add:

```ts
it("switches to apps and sets the /apps path", () => {
  navigate("apps");
  expect(currentRoute()).toBe("apps");
  expect(location.pathname).toBe(APPS_PATH);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- src/lib/router.test.ts --run`
Expected: FAIL — `APPS_PATH` is not exported (import error) / `"apps"` not a valid route.

- [ ] **Step 3: Implement the route**

In `web/src/lib/router.svelte.ts`:

Change the `Route` union (line 10) to add `"apps"`:

```ts
export type Route = "lan" | "cross" | "offline" | "download" | "me" | "cli" | "apps" | "pricing" | "verify-email" | "reset-password";
```

Add the path constant next to `CLI_PATH` (after line 16):

```ts
/** Apps / downloads hub: web, CLI, and (coming soon) native macOS/iOS. Marketing page. */
export const APPS_PATH = "/apps";
```

In `routeFromLocation`, add the check right after the `CLI_PATH` line (line 41). Order does not matter for correctness here (paths are exact-match and `/apps` is not a `/d/` prefix), but keep it grouped with the other marketing pages:

```ts
  if (pathname === CLI_PATH) return "cli";
  if (pathname === APPS_PATH) return "apps";
```

In `navigate`, add the ternary arm alongside `CLI_PATH` (line 84):

```ts
    : r === "cli" ? CLI_PATH
    : r === "apps" ? APPS_PATH
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- src/lib/router.test.ts --run`
Expected: PASS (all cases, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/router.svelte.ts web/src/lib/router.test.ts
git commit -m "feat(apps): add /apps SPA route"
```

---

### Task 2: Add `appsPage` + `nav.appsTab` i18n keys (all 9 languages)

**Files:**
- Modify: `web/src/lib/i18n/types.ts` (the `nav` key at line 295; add an `appsPage` object near the `cliPage` block at line 305)
- Modify: `web/src/lib/i18n/{en,zh,ja,ko,de,fr,ar,es,pt}.ts` (all 9 tables)

**Interfaces:**
- Produces the typed shape consumed by Tasks 3, 5 and the nav in Task 7:

```ts
nav: { lanTab: string; crossTab: string; offlineTab: string; cliTab: string; appsTab: string };
appsPage: {
  metaTitle: string;   // <title> for /apps (page-meta.ts)
  metaDesc: string;    // <meta description> for /apps
  heading: string;     // <h1>
  subhead: string;     // one-line pitch under the h1
  availableBadge: string;   // "Available"
  comingSoonBadge: string;  // "Coming soon"
  yourPlatformNote: (os: string) => string; // "We think you're on {os}." highlight caption
  cliInstallLabel: string;  // label above the curl one-liner
  androidNote: string;      // "On Android? Use the web app — it runs in your browser."
  cards: {
    web: { name: string; desc: string; cta: string };
    cli: { name: string; desc: string; cta: string };
    mac: { name: string; desc: string }; // no cta — coming soon
    ios: { name: string; desc: string }; // no cta — coming soon
  };
};
```

- [ ] **Step 1: Extend the type contract**

In `web/src/lib/i18n/types.ts`, change the `nav` line (295) to add `appsTab`:

```ts
  nav: { lanTab: string; crossTab: string; offlineTab: string; cliTab: string; appsTab: string };
```

Immediately after the `cliCallout` line (301), add the `appsPage` block (paste the exact interface from the Interfaces section above).

- [ ] **Step 2: Run the type check to see it fail across all tables**

Run: `cd web && npm run check`
Expected: FAIL — every `i18n/*.ts` table is missing `nav.appsTab` and `appsPage`. This is the completeness gate that drives the rest of this task.

- [ ] **Step 3: Fill the English table**

In `web/src/lib/i18n/en.ts`, add `appsTab: "Apps",` to the `nav` object, and add this `appsPage` object (place it near the existing `cliPage`/`cliCallout` entries):

```ts
  appsPage: {
    metaTitle: "Get Relayium — apps for web, CLI, macOS & iOS",
    metaDesc:
      "Download Relayium: use it in any browser, install the command-line tool, or get the native macOS and iOS apps (coming soon). End-to-end encrypted file transfer on every device.",
    heading: "Get Relayium",
    subhead: "One end-to-end encrypted file transfer, everywhere you work. Pick your platform.",
    availableBadge: "Available",
    comingSoonBadge: "Coming soon",
    yourPlatformNote: (os) => `Looks like you're on ${os} — highlighted below.`,
    cliInstallLabel: "Install from your terminal:",
    androidNote: "On Android? Use the web app — it runs right in your browser, nothing to install.",
    cards: {
      web: {
        name: "Web app",
        desc: "Nothing to install. Open it in any modern browser on any OS and start transferring.",
        cta: "Open the web app",
      },
      cli: {
        name: "Command line",
        desc: "Scriptable transfers, folder sync and server-to-server backups for macOS, Linux and Windows.",
        cta: "CLI docs & install",
      },
      mac: {
        name: "macOS app",
        desc: "A true native menu-bar app (com.relayium.mac). Signed & notarized for a one-click install — in the works.",
      },
      ios: {
        name: "iOS app",
        desc: "A native iPhone & iPad app (com.relayium.app) with share-sheet sending. Coming to the App Store.",
      },
    },
  },
```

- [ ] **Step 4: Run the type check to confirm English resolves and the other 8 still fail**

Run: `cd web && npm run check`
Expected: FAIL — now only `zh, ja, ko, de, fr, ar, es, pt` report the missing `nav.appsTab` / `appsPage`.

- [ ] **Step 5: Fill the other 8 tables**

In each of `web/src/lib/i18n/{zh,ja,ko,de,fr,ar,es,pt}.ts`: add `appsTab` to `nav` and a full `appsPage` object with the SAME keys as English, translated to match the tone and terminology already used in that file (reuse existing wording for "Web app", "Coming soon", platform names, "end-to-end encrypted"). Keep `com.relayium.mac` / `com.relayium.app` verbatim. Preserve the `yourPlatformNote: (os) => …` arrow-function signature (only the surrounding words are translated; `${os}` stays). For `ar.ts`, write natural Arabic — no layout concerns here, RTL is handled by CSS.

Reference — the Chinese (`zh.ts`) values, as a concrete model for the other translators:

```ts
  appsPage: {
    metaTitle: "获取 Relayium——网页版、命令行、macOS 与 iOS 应用",
    metaDesc:
      "下载 Relayium：在任意浏览器中直接使用、安装命令行工具，或获取原生 macOS 与 iOS 应用（即将推出）。端到端加密的文件传输，覆盖你的每一台设备。",
    heading: "获取 Relayium",
    subhead: "同一套端到端加密的文件传输，随处可用。选择你的平台。",
    availableBadge: "现已可用",
    comingSoonBadge: "即将推出",
    yourPlatformNote: (os) => `看起来你在使用 ${os}——下方已高亮。`,
    cliInstallLabel: "在终端中安装：",
    androidNote: "使用安卓？直接用网页版即可——在浏览器中运行，无需安装。",
    cards: {
      web: { name: "网页版", desc: "无需安装。在任意系统的现代浏览器中打开即可开始传输。", cta: "打开网页版" },
      cli: { name: "命令行", desc: "可脚本化的传输、文件夹同步与服务器间备份，支持 macOS、Linux 与 Windows。", cta: "命令行文档与安装" },
      mac: { name: "macOS 应用", desc: "真正的原生菜单栏应用（com.relayium.mac）。已签名并公证，一键安装——正在开发中。" },
      ios: { name: "iOS 应用", desc: "原生 iPhone 与 iPad 应用（com.relayium.app），支持分享菜单发送。即将登陆 App Store。" },
    },
  },
```

Add `appsTab: "应用",` to `zh.ts`'s `nav`. Suggested `nav.appsTab` per language: ja `アプリ`, ko `앱`, de `Apps`, fr `Applis`, ar `التطبيقات`, es `Apps`, pt `Apps`.

- [ ] **Step 6: Run the type check to confirm all tables resolve**

Run: `cd web && npm run check`
Expected: PASS (no missing-key errors). Also run `cd web && npm test -- src/lib/i18n.test.ts --run` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/i18n/
git commit -m "feat(apps): appsPage + nav.appsTab i18n across 9 languages"
```

---

### Task 3: Per-route `<title>`/description for `/apps` in page-meta

**Files:**
- Modify: `web/src/lib/page-meta.ts` (import at line 2; `pageMeta` at lines 15–18)
- Test: `web/src/lib/page-meta.test.ts`

**Interfaces:**
- Consumes: `APPS_PATH` (Task 1), `appsPage.metaTitle` / `appsPage.metaDesc` (Task 2).
- Produces: `pageMeta("apps", m)` → `{ title: m.appsPage.metaTitle, description: m.appsPage.metaDesc, canonicalPath: "/apps" }`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/lib/page-meta.test.ts` (extend the `./router.svelte` import to include `APPS_PATH`):

```ts
describe("pageMeta apps route", () => {
  it("uses the appsPage meta title/description and its own canonical", () => {
    const a = pageMeta("apps", m);
    expect(a.title).toBe(m.appsPage.metaTitle);
    expect(a.description).toBe(m.appsPage.metaDesc);
    expect(a.canonicalPath).toBe(APPS_PATH);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- src/lib/page-meta.test.ts --run`
Expected: FAIL — `pageMeta("apps", …)` returns the default home title, `canonicalPath` is `/`.

- [ ] **Step 3: Implement**

In `web/src/lib/page-meta.ts`, add `APPS_PATH` to the import on line 2:

```ts
import { CROSS_PATH, OFFLINE_PATH, PRICING_PATH, APPS_PATH } from "./router.svelte";
```

Add a branch in `pageMeta` before the final `return` (after the `pricing` line, 17):

```ts
  if (route === "apps") return { title: m.appsPage.metaTitle, description: m.appsPage.metaDesc, canonicalPath: APPS_PATH };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- src/lib/page-meta.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/page-meta.ts web/src/lib/page-meta.test.ts
git commit -m "feat(apps): per-route title/description for /apps"
```

---

### Task 4: Platform-detection helper for card highlighting

**Files:**
- Create: `web/src/lib/platform.ts`
- Test: `web/src/lib/platform.test.ts`

**Interfaces:**
- Produces: `export type Platform = "mac" | "ios" | "windows" | "linux" | "android" | "unknown";` and `export function detectPlatform(ua: string): Platform`.
- Consumed by `AppsPage.svelte` (Task 5) to decide which card to highlight (`mac` and `ios` map to the native cards; `windows`/`linux` highlight the CLI card; `android`/`unknown` highlight the Web card).

This is a separate, focused helper from `App.svelte`'s `deviceLabel()` (which produces device *names* like "iPhone" for the roster); this one produces an OS *class* for card matching. Do not refactor `deviceLabel()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/platform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectPlatform } from "./platform";

describe("detectPlatform", () => {
  it("detects iOS (iPhone and iPad)", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("ios");
  });
  it("detects macOS but not when it is actually iOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    // iPad UAs contain "Mac OS X" — iOS must win
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 16 like Mac OS X)")).toBe("ios");
  });
  it("detects Android before Linux (Android UAs contain 'Linux')", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
  });
  it("detects Windows and Linux", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
  it("falls back to unknown", () => {
    expect(detectPlatform("")).toBe("unknown");
    expect(detectPlatform("some-random-agent")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- src/lib/platform.test.ts --run`
Expected: FAIL — cannot resolve `./platform`.

- [ ] **Step 3: Implement**

Create `web/src/lib/platform.ts`. Order matters: iOS before macOS (iPad UAs contain "Mac OS X"); Android before Linux (Android UAs contain "Linux").

```ts
// A coarse OS class from the User-Agent, used only to highlight the matching card
// on the /apps hub. Best-effort and never throws — an unknown UA reads as "unknown".
// This is intentionally separate from App.svelte's deviceLabel() (which names the
// device for the peer roster): here we want an OS bucket, not a display name.
export type Platform = "mac" | "ios" | "windows" | "linux" | "android" | "unknown";

export function detectPlatform(ua: string): Platform {
  const s = ua || "";
  if (/iPhone|iPad|iPod/.test(s)) return "ios";
  if (/Android/.test(s)) return "android";
  if (/Macintosh|Mac OS X/.test(s)) return "mac";
  if (/Windows/.test(s)) return "windows";
  if (/Linux/.test(s)) return "linux";
  return "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- src/lib/platform.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/platform.ts web/src/lib/platform.test.ts
git commit -m "feat(apps): detectPlatform helper for card highlighting"
```

---

### Task 5: `AppsPage.svelte` component

**Files:**
- Create: `web/src/lib/AppsPage.svelte`

**Interfaces:**
- Consumes: `messages`/`lang` from `i18n.svelte`, `navigate`/`CLI_PATH` from `router.svelte`, `detectPlatform`/`Platform` from `platform.ts`, `appsPage` i18n (Task 2). Follows the `/cli` page shell pattern: a self-contained `<section class="apps page-enter">`; the shared `<Nav>` is rendered by `App.svelte` (Task 6), so this component does NOT render `<Nav>`.
- Produces: the default-exported Svelte component imported by `App.svelte`'s `routeLoaders.apps`.

- [ ] **Step 1: Create the component**

Create `web/src/lib/AppsPage.svelte`:

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, CLI_PATH } from "./router.svelte";
  import { detectPlatform, type Platform } from "./platform";

  const t = $derived<Messages>(messages[lang()]);
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";

  // Which OS the visitor is on (browser-only; SSR/tests never run this effect).
  const platform: Platform =
    typeof navigator !== "undefined" ? detectPlatform(navigator.userAgent) : "unknown";
  // Map the OS to the card it should highlight. windows/linux → CLI; android/unknown → web.
  const highlightId = $derived(
    platform === "mac" ? "mac"
    : platform === "ios" ? "ios"
    : platform === "windows" || platform === "linux" ? "cli"
    : "web",
  );
  // Human OS name for the "looks like you're on X" caption; empty when unknown/android.
  const osName =
    platform === "mac" ? "macOS"
    : platform === "ios" ? "iOS"
    : platform === "windows" ? "Windows"
    : platform === "linux" ? "Linux"
    : "";

  function openWeb(e: MouseEvent) { e.preventDefault(); navigate("lan"); }
  function openCli(e: MouseEvent) { e.preventDefault(); navigate("cli"); }
</script>

<section class="apps page-enter">
  <header class="head">
    <h1>{t.appsPage.heading}</h1>
    <p class="sub">{t.appsPage.subhead}</p>
    {#if osName}
      <p class="detected">{t.appsPage.yourPlatformNote(osName)}</p>
    {/if}
  </header>

  <div class="grid">
    <!-- Web -->
    <article class="card" class:me={highlightId === "web"}>
      <div class="badge on">{t.appsPage.availableBadge}</div>
      <h2>{t.appsPage.cards.web.name}</h2>
      <p>{t.appsPage.cards.web.desc}</p>
      <a class="cta" href="/" onclick={openWeb}>{t.appsPage.cards.web.cta}</a>
    </article>

    <!-- CLI -->
    <article class="card" class:me={highlightId === "cli"}>
      <div class="badge on">{t.appsPage.availableBadge}</div>
      <h2>{t.appsPage.cards.cli.name}</h2>
      <p>{t.appsPage.cards.cli.desc}</p>
      <p class="cli-install">{t.appsPage.cliInstallLabel}</p>
      <code class="cmd">{installCmd}</code>
      <a class="cta" href={CLI_PATH} onclick={openCli}>{t.appsPage.cards.cli.cta}</a>
    </article>

    <!-- macOS (coming soon) -->
    <article class="card soon" class:me={highlightId === "mac"}>
      <div class="badge">{t.appsPage.comingSoonBadge}</div>
      <h2>{t.appsPage.cards.mac.name}</h2>
      <p>{t.appsPage.cards.mac.desc}</p>
      <button class="cta" type="button" disabled>{t.appsPage.comingSoonBadge}</button>
    </article>

    <!-- iOS (coming soon) -->
    <article class="card soon" class:me={highlightId === "ios"}>
      <div class="badge">{t.appsPage.comingSoonBadge}</div>
      <h2>{t.appsPage.cards.ios.name}</h2>
      <p>{t.appsPage.cards.ios.desc}</p>
      <button class="cta" type="button" disabled>{t.appsPage.comingSoonBadge}</button>
    </article>
  </div>

  <p class="android">{t.appsPage.androidNote}</p>
</section>

<style>
  .apps { max-width: 960px; margin: 0 auto; padding-bottom: var(--space-8); }
  .head { text-align: center; margin: var(--space-6) 0 var(--space-6); }
  .head h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); letter-spacing: -0.4px; color: var(--text-h); }
  .head .sub { color: var(--text); max-width: 52ch; margin: var(--space-3) auto 0; }
  .head .detected { color: var(--accent); font-size: var(--fs-sm); margin-top: var(--space-2); }

  .grid { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .card {
    display: flex; flex-direction: column; gap: var(--space-2);
    padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--social-bg);
  }
  .card h2 { font-size: var(--fs-lg); color: var(--text-h); }
  .card p { color: var(--text); font-size: var(--fs-sm); }
  .card .cta { margin-top: auto; }
  .card.soon { opacity: 0.82; }
  /* The visitor's own platform, softly highlighted. */
  .card.me { border-color: var(--accent-border); box-shadow: 0 0 0 1px var(--accent-border); }

  .badge {
    align-self: flex-start; font-size: var(--fs-xs); padding: 2px 10px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text); background: var(--bg);
  }
  .badge.on { color: #fff; background: var(--grad-accent); border-color: transparent; }

  .cli-install { margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text); }
  .cmd {
    display: block; font-family: var(--mono, ui-monospace, monospace); font-size: var(--fs-xs);
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--bg); overflow-x: auto; white-space: nowrap;
  }

  a.cta, button.cta {
    display: inline-flex; align-items: center; justify-content: center;
    font: inherit; font-size: var(--fs-sm); padding: var(--space-2) var(--space-4);
    border-radius: 999px; text-decoration: none; cursor: pointer;
    color: #fff; background: var(--grad-accent); border: 1px solid transparent;
  }
  a.cta:hover { filter: brightness(1.05); }
  button.cta:disabled { cursor: default; color: var(--text); background: var(--bg); border-color: var(--border); }

  .android { text-align: center; color: var(--text); font-size: var(--fs-sm); margin-top: var(--space-6); }
</style>
```

- [ ] **Step 2: Type-check the component**

Run: `cd web && npm run check`
Expected: PASS (no type errors). The component is not yet reachable — Task 6 wires it in.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/AppsPage.svelte
git commit -m "feat(apps): AppsPage hub component with platform highlight"
```

---

### Task 6: Wire the `apps` route into `App.svelte`

**Files:**
- Modify: `web/src/App.svelte` (`routeLoaders` map lines 61–70; `surfaceShown` lines 238–245; render branches near lines 1423–1438)

**Interfaces:**
- Consumes: `AppsPage.svelte` (Task 5), route id `apps` (Task 1).
- Produces: navigating to `/apps` renders `<AppsPage />`; the drag-drop surface stays off it.

- [ ] **Step 1: Register the code-split loader**

In `web/src/App.svelte`, add to the `routeLoaders` object (after the `cli` line, 66):

```ts
    cli: () => import("./lib/CliPage.svelte"),
    apps: () => import("./lib/AppsPage.svelte"),
```

- [ ] **Step 2: Keep the transfer surface off the apps page**

In the `surfaceShown` `$derived` (lines 238–245), add `apps` to the excluded routes. Change the first condition line to include it:

```ts
    currentRoute() === "download" || currentRoute() === "offline" || currentRoute() === "me" || currentRoute() === "cli"
    || currentRoute() === "apps"
    || currentRoute() === "pricing" || currentRoute() === "verify-email" || currentRoute() === "reset-password"
```

- [ ] **Step 3: Add the render branch**

In the route render chain, add an `apps` branch next to the `cli` one (after lines 1423–1426):

```svelte
  {:else if currentRoute() === "cli"}
    {#await routePage("cli") then { default: CliPage }}
      <CliPage />
    {/await}
  {:else if currentRoute() === "apps"}
    {#await routePage("apps") then { default: AppsPage }}
      <AppsPage />
    {/await}
```

- [ ] **Step 4: Verify build + type check**

Run: `cd web && npm run check`
Expected: PASS.
Run: `cd web && npm run build`
Expected: build succeeds (Vite emits a code-split chunk for `AppsPage`).

- [ ] **Step 5: Commit**

```bash
git add web/src/App.svelte
git commit -m "feat(apps): render /apps route in App.svelte"
```

---

### Task 7: Nav tab + footer links

**Files:**
- Modify: `web/src/lib/Nav.svelte` (import line 2; `tabs` array lines 10–15; the `href` ternary line 37)
- Modify: `web/src/lib/PageFooter.svelte` (import line 3; footer nav lines 13–19)
- Modify: `web/scripts/pages/landing-template.mjs` (footer ~lines 168–175) and the footers in `article-template.mjs`, `legal-template.mjs`, `guides-index-template.mjs`, `mode-template.mjs`

**Interfaces:**
- Consumes: `APPS_PATH`/route `apps` (Task 1), `nav.appsTab` (Task 2).
- Produces: an "Apps" tab in the SPA nav (5th, after CLI) and an "Apps" link in every footer.

- [ ] **Step 1: Add the 5th nav tab (keep CLI)**

In `web/src/lib/Nav.svelte`, add `APPS_PATH` to the import on line 2:

```ts
  import { currentRoute, navigate, CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH, type Route } from "./router.svelte";
```

Append to the `tabs` array (after the `cli` entry, line 14):

```ts
    { id: "cli", label: () => t.nav.cliTab },
    { id: "apps", label: () => t.nav.appsTab },
```

Extend the `href` ternary on line 37 to map `apps`:

```svelte
        href={tab.id === "cross" ? CROSS_PATH : tab.id === "offline" ? OFFLINE_PATH : tab.id === "cli" ? CLI_PATH : tab.id === "apps" ? APPS_PATH : "/"}
```

- [ ] **Step 2: Add the SPA footer link**

In `web/src/lib/PageFooter.svelte`, add `APPS_PATH` to the import on line 3:

```ts
  import { navigate, PRICING_PATH, APPS_PATH } from "./router.svelte";
```

Add the link as the first item in the footer `<nav class="legal">` (before the Pricing link on line 14):

```svelte
    <a href={APPS_PATH} onclick={(e) => { e.preventDefault(); navigate("apps"); }}>{t.nav.appsTab}</a>
```

- [ ] **Step 3: Add the static-site footer links**

The static templates build plain HTML footers (no SPA router). Add an Apps link pointing at the per-language `/apps` URL. In `web/scripts/pages/landing-template.mjs`, `article-template.mjs`, `legal-template.mjs`, `guides-index-template.mjs`, and `mode-template.mjs`, locate the footer `<nav>`/link list (e.g. landing-template ~lines 168–175, which already links Guides/Privacy/Terms/Security) and add an anchor to the localized apps path. Use the same `urlPath(...)`/`landingPath(...)` helper the neighbouring links use in that file — match the existing pattern rather than hardcoding. English → `/apps`; other languages → `/<lang>/apps`. Example, mirroring an existing footer link in the same file:

```js
`<a href="${urlPath("apps", lang)}">Apps</a>`
```

(If a template's footer builds links from a shared array/helper, add the entry there instead of inline — follow that file's convention.)

- [ ] **Step 4: Verify**

Run: `cd web && npm run check`
Expected: PASS.
Run: `cd web && npm run gen:pages`
Expected: succeeds (static pages regenerate; footers now include Apps).
Manually confirm an Apps link is present: open `web/public/index.html` and a generated localized page (e.g. `web/public/zh/index.html`) and check the footer contains an `/apps` link.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/Nav.svelte web/src/lib/PageFooter.svelte web/scripts/pages/
git commit -m "feat(apps): Apps nav tab + footer links"
```

---

### Task 8: Prerendered static `/apps` page (SEO, 8 non-English locales)

**Files:**
- Create: `web/scripts/pages/content/apps.mjs`
- Modify: `web/scripts/gen-pages.mjs` (imports ~line 11; `pages` array ~line 108; `buildSitemap` modes list ~lines 126–128)

**Interfaces:**
- Consumes: the existing `buildModePages(modeDef, { slug })` builder and `mode-template.mjs` render shape (`hero.{h1,pitch,cta}`, `how.{heading,steps[]}`, `why.{heading,items[{title,desc}]}`, `compare.{heading,items[{title,body}]}`, optional `faq`). English is the SPA route (Task 1–6); this generates `/<lang>/apps` for the 8 non-English locales, exactly like `/cross-network`.
- Produces: static localized `/<lang>/apps` pages + sitemap entries.

Note: the interactive card UI lives in the SPA (Task 5). This prerendered page is prose-only (the mode-template shape) for crawlers and no-JS first paint — that is acceptable and matches how `/cross-network` and `/offline-transfer` already work.

- [ ] **Step 1: Create the content module**

Create `web/scripts/pages/content/apps.mjs`. Mirror the structure of `cross-network.mjs`: a top comment block holding the English master copy (source of truth), then one exported `langs` map for the 8 non-English locales, then `export default { updated: "2026-07-19", langs: { zh, ja, ko, de, fr, ar, es, pt } }`.

Map the apps content onto the mode-template fields:
- `hero.h1` = "Get Relayium" (localized), `hero.pitch` = the `appsPage.subhead` copy, `hero.cta` = "Open the web app" (the template links the CTA to `/apps?lang=<lang>`, i.e. the SPA hub).
- `how.heading` = "Which one should I use?", `how.steps` = 4 short lines: use the web app for zero-install on any OS; install the CLI for scripting/sync/backups; the macOS app (coming soon); the iOS app (coming soon).
- `why.heading` = "One transfer, every device", `why.items` = 4 `{title, desc}`: Web app / CLI / macOS app (coming soon) / iOS app (coming soon) — reuse the `appsPage.cards.*` desc copy.
- `compare.heading` = "Native or browser?", `compare.items` = 2 `{title, body}`: "Use the web app" (works everywhere today, nothing to install) and "Get a native app" (deeper OS integration, coming to macOS & iOS).
- Omit `faq` (the template guards `doc.faq ?`).
- `footer: { privacy, terms, security }` — reuse the same per-locale labels as `cross-network.mjs`.

Write the 8 translations following the tone/terminology already established in `cross-network.mjs` for each locale. `validateLangs` (Step 3) is the completeness gate.

- [ ] **Step 2: Wire it into the generator**

In `web/scripts/gen-pages.mjs`:

Add the import next to the other mode content (after line 11):

```js
import offlineTransfer from "./pages/content/offline-transfer.mjs";
import apps from "./pages/content/apps.mjs";
```

Add to the `pages` array next to the other `buildModePages` calls (~line 108):

```js
    ...buildModePages(apps, { slug: "apps" }),
```

Add to the `buildSitemap` modes list (~lines 127–128):

```js
        { def: crossNetwork, slug: "cross-network" },
        { def: offlineTransfer, slug: "offline-transfer" },
        { def: apps, slug: "apps" },
```

- [ ] **Step 3: Generate and verify**

Run: `cd web && npm run gen:pages`
Expected: succeeds — no `validateLangs` failure (all 8 locales present). If it reports a missing language, add that locale's block to `apps.mjs` and re-run.

Confirm the pages and sitemap entries exist:

Run: `ls web/public/zh/apps web/public/ja/apps web/public/ar/apps` and `grep -c "/apps" web/public/sitemap.xml`
Expected: the localized `apps/` directories exist with `index.html`; sitemap contains the `/apps` URLs (English + 8 locales).

- [ ] **Step 4: Full build sanity check**

Run: `cd web && npm run build`
Expected: succeeds.
Run: `cd web && npm test -- --run` (full suite)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/pages/content/apps.mjs web/scripts/gen-pages.mjs
git commit -m "feat(apps): prerendered localized /apps SEO pages + sitemap"
```

---

## Final verification (after all tasks)

- [ ] `cd web && npm run check` — no type/svelte-check errors.
- [ ] `cd web && npm test -- --run` — full suite green (router, page-meta, platform, i18n).
- [ ] `cd web && npm run build` — production build succeeds.
- [ ] Manual smoke: `npm run dev`, open `/apps` — the four cards render, the visitor's-OS card is highlighted, the Web and CLI CTAs navigate correctly, the macOS/iOS buttons are disabled, and the Apps tab shows as the 5th nav item with CLI still present. Switch language and confirm copy localizes (including RTL layout for Arabic).
```
