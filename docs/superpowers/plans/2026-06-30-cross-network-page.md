# 跨网络传输独立页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把跨网络传输从单页堆叠改造成独立页面：`/` 默认局域网传输、`/cross-network` 跨网络传输，顶部 Tab 切换；局域网页不显示登录入口，跨网络页提示需登录。

**Architecture:** 在 Svelte 5 SPA 中引入一个极轻量的自实现客户端路由（`router.svelte.ts`，用 runes 持有 `route` 状态 + `history.pushState`/`popstate`）。App.svelte 变成路由壳，按 `route` 渲染局域网区域或新的 `CrossPage`。Go 服务端加一层 SPA fallback，使 `/cross-network` 这类应用路由回退到 `index.html`。WebSocket 房间语义不变——纯 Tab 切换不动 WS，真正发起/接收 token 传输时整页 reload 切换房间。

**Tech Stack:** Svelte 5（runes）、TypeScript、Vite、Vitest（前端）；Go `net/http`（服务端）。

## Global Constraints

- 局域网页（`/`）**不得**出现任何登录 / 账户 UI。
- 登录按钮 / 账户入口**只在**跨网络页（`/cross-network`）出现。
- 接收方（通过分享链接打开、持有 `#t=<token>`）**不需要登录**；"需要登录"提示只针对主动发起的人。
- 顶部 Logo + Tab 栏两页共享；连接状态、功能卡片、指南各页专属（法律页脚两页都保留）。
- 不引入前端路由库；不引入新的 npm 依赖。
- i18n 覆盖全部 6 种语言：`zh` `en` `ja` `ko` `de` `fr`。
- 路由常量统一用 `CROSS_PATH = "/cross-network"`（前端单一来源）。
- 提交信息结尾加：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: 服务端 SPA fallback

让 `/cross-network` 等无对应文件的"应用路由"回退到 `index.html`，同时保持真实文件（资源、`/privacy` 等目录页）与缺失资源 404 的行为不变。

**Files:**
- Create: `server/spa.go`
- Create: `server/spa_test.go`
- Modify: `server/main.go:149`（把 `mux.Handle("/", http.FileServer(...))` 换成 `spaHandler`）

**Interfaces:**
- Produces: `func spaHandler(dir string) http.Handler` — 包装 `http.FileServer`，对扩展名为空且无对应文件/目录的 GET/HEAD 请求返回 `index.html`。

- [ ] **Step 1: 写失败测试**

Create `server/spa_test.go`:

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestSPAHandler(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "index.html"), "INDEX")
	writeFile(t, filepath.Join(dir, "assets", "app.js"), "JS")
	writeFile(t, filepath.Join(dir, "privacy", "index.html"), "PRIVACY")

	h := spaHandler(dir)

	cases := []struct {
		name, path, wantBody string
		wantCode             int
	}{
		{"root serves index", "/", "INDEX", 200},
		{"app route serves index", "/cross-network", "INDEX", 200},
		{"real asset served", "/assets/app.js", "JS", 200},
		{"missing asset 404s", "/assets/missing.js", "", 404},
		{"directory with index served", "/privacy/", "PRIVACY", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
			if rec.Code != c.wantCode {
				t.Fatalf("%s: code = %d, want %d", c.path, rec.Code, c.wantCode)
			}
			if c.wantBody != "" && rec.Body.String() != c.wantBody {
				t.Fatalf("%s: body = %q, want %q", c.path, rec.Body.String(), c.wantBody)
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./... -run TestSPAHandler`
Expected: 编译失败 / `undefined: spaHandler`

- [ ] **Step 3: 实现 spaHandler**

Create `server/spa.go`:

```go
package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
)

// spaHandler serves static files from dir, but falls back to index.html for
// extensionless paths that don't map to a real file or directory — these are
// client-side SPA routes (e.g. /cross-network). Real files, directories that
// carry their own index.html (e.g. /privacy), and missing assets (paths with an
// extension) keep the plain FileServer behaviour.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			fs.ServeHTTP(w, r)
			return
		}
		upath := path.Clean("/" + r.URL.Path) // collapses any ".." traversal
		full := filepath.Join(dir, filepath.FromSlash(upath))
		if st, err := os.Stat(full); err == nil {
			if !st.IsDir() {
				fs.ServeHTTP(w, r) // a real file
				return
			}
			if _, err := os.Stat(filepath.Join(full, "index.html")); err == nil {
				fs.ServeHTTP(w, r) // a directory that has its own index.html
				return
			}
		}
		if path.Ext(upath) != "" {
			fs.ServeHTTP(w, r) // unknown path with an extension → genuine 404
			return
		}
		http.ServeFile(w, r, index) // extensionless unknown path → SPA shell
	})
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && go test ./... -run TestSPAHandler`
Expected: PASS

- [ ] **Step 5: 接入 main.go**

In `server/main.go`, replace line 149:

```go
	mux.Handle("/", http.FileServer(http.Dir(*static)))
```

with:

```go
	mux.Handle("/", spaHandler(*static))
```

- [ ] **Step 6: 整体编译 + 全量测试**

Run: `cd server && go build ./... && go test ./...`
Expected: build 成功，全部 PASS

- [ ] **Step 7: 提交**

```bash
git add server/spa.go server/spa_test.go server/main.go
git commit -m "feat(server): SPA fallback so client routes like /cross-network serve index.html

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 客户端路由模块

提供 `route` 状态、纯函数 `routeFromLocation`、`navigate`、`syncRouteFromLocation` 与共享常量 `CROSS_PATH`。

**Files:**
- Create: `web/src/lib/router.svelte.ts`
- Test: `web/src/lib/router.test.ts`

**Interfaces:**
- Produces:
  - `type Route = "lan" | "cross"`
  - `const CROSS_PATH = "/cross-network"`
  - `function routeFromLocation(pathname: string, hash: string): Route` — hash 含 `#t=<token>` 或 `pathname === CROSS_PATH` 时返回 `"cross"`，否则 `"lan"`。
  - `function currentRoute(): Route`（响应式读取）
  - `function syncRouteFromLocation(): void`（从 `window.location` 同步 `route`）
  - `function navigate(r: Route): void`（`history.pushState` 改写 URL 并更新 `route`，清空 hash）

- [ ] **Step 1: 写失败测试**

Create `web/src/lib/router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { routeFromLocation, CROSS_PATH } from "./router.svelte";

describe("routeFromLocation", () => {
  it("defaults to lan on root", () => {
    expect(routeFromLocation("/", "")).toBe("lan");
  });
  it("is cross on the cross-network path", () => {
    expect(routeFromLocation(CROSS_PATH, "")).toBe("cross");
  });
  it("is cross whenever a transfer token is present, regardless of path", () => {
    expect(routeFromLocation("/", "#t=abc123")).toBe("cross");
  });
  it("ignores non-token hashes", () => {
    expect(routeFromLocation("/", "#other=1")).toBe("lan");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: FAIL（找不到 `./router.svelte`）

- [ ] **Step 3: 实现 router.svelte.ts**

Create `web/src/lib/router.svelte.ts`:

```ts
// Minimal client-side router for the Relayium SPA, driven by Svelte 5 runes.
// Two routes: the LAN transfer page (default, "/") and the cross-network page
// ("/cross-network"). A transfer token in the URL fragment (#t=<token>) always
// implies the cross-network page so a shared link lands the recipient correctly.

import { parseTransferToken } from "./transfer-link";

export type Route = "lan" | "cross";

export const CROSS_PATH = "/cross-network";

/** Pure mapping from a location to a route. Safe to unit-test without a DOM. */
export function routeFromLocation(pathname: string, hash: string): Route {
  if (parseTransferToken(hash)) return "cross";
  return pathname === CROSS_PATH ? "cross" : "lan";
}

let route = $state<Route>("lan");

export function currentRoute(): Route {
  return route;
}

/** Read the live browser location into the reactive route (use on load + popstate). */
export function syncRouteFromLocation(): void {
  route = routeFromLocation(location.pathname, location.hash);
}

/** Switch tabs without reloading: rewrite the URL and update the route. Drops any
 *  stale token fragment so a plain tab switch never re-enters a transfer room. */
export function navigate(r: Route): void {
  const pathname = r === "cross" ? CROSS_PATH : "/";
  history.pushState({}, "", pathname);
  route = r;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/router.svelte.ts web/src/lib/router.test.ts
git commit -m "feat(web): client-side router for lan/cross-network pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: i18n — 新增 Tab 标签与"需要登录"文案

给 `Messages` 接口加 `nav` 块和 `crossnet.loginRequired`，并在全部 6 个语言对象中补齐。

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`（接口 + 6 个语言块）
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Produces: `Messages.nav: { lanTab: string; crossTab: string }` 和 `Messages.crossnet.loginRequired: string`。

- [ ] **Step 1: 写失败测试**

Create `web/src/lib/i18n.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { messages, LANGS } from "./i18n.svelte";

describe("i18n completeness", () => {
  it("every language has nav tab labels and the login-required string", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.nav.lanTab, `${code}.nav.lanTab`).toBeTruthy();
      expect(m.nav.crossTab, `${code}.nav.crossTab`).toBeTruthy();
      expect(m.crossnet.loginRequired, `${code}.crossnet.loginRequired`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/lib/i18n.test.ts`
Expected: FAIL（`m.nav` 为 undefined）

- [ ] **Step 3: 扩展接口**

In `web/src/lib/i18n.svelte.ts`, 在 `interface Messages` 内（紧挨 `crossnet` 块之前）加入：

```ts
  nav: { lanTab: string; crossTab: string };
```

并在 `crossnet` 块内（`linkDead` 之后）加入一行：

```ts
    loginRequired: string;
```

`crossnet` 块改成：

```ts
  crossnet: {
    sendAcross: string;
    loginFirst: string;
    loginRequired: string;
    shareHint: string;
    copy: string;
    copied: string;
    connecting: string;
    linkDead: string;
  };
```

- [ ] **Step 4: 在 6 个语言对象里补齐**

每个语言对象都加一个 `nav` 字段，并在其 `crossnet` 块里加 `loginRequired`。按下表逐一加入（`nav` 建议放在该语言对象的 `crossnet` 块前后皆可，保持与接口同名即可）。

`zh`:
```ts
  nav: { lanTab: "局域网传输", crossTab: "跨网络传输" },
```
`zh.crossnet.loginRequired`:
```ts
    loginRequired: "跨网络传输需要登录后才能发起。请登录后再继续。",
```

`en`:
```ts
  nav: { lanTab: "LAN transfer", crossTab: "Cross-network" },
```
`en.crossnet.loginRequired`:
```ts
    loginRequired: "Starting a cross-network transfer requires signing in. Please sign in to continue.",
```

`ja`:
```ts
  nav: { lanTab: "LAN 転送", crossTab: "ネットワーク間転送" },
```
`ja.crossnet.loginRequired`:
```ts
    loginRequired: "ネットワーク間転送を開始するにはログインが必要です。ログインして続行してください。",
```

`ko`:
```ts
  nav: { lanTab: "LAN 전송", crossTab: "네트워크 간 전송" },
```
`ko.crossnet.loginRequired`:
```ts
    loginRequired: "네트워크 간 전송을 시작하려면 로그인이 필요합니다. 로그인 후 계속하세요.",
```

`de`:
```ts
  nav: { lanTab: "LAN-Übertragung", crossTab: "Netzübergreifend" },
```
`de.crossnet.loginRequired`:
```ts
    loginRequired: "Für eine netzübergreifende Übertragung ist eine Anmeldung erforderlich. Bitte melde dich an, um fortzufahren.",
```

`fr`:
```ts
  nav: { lanTab: "Transfert LAN", crossTab: "Inter-réseaux" },
```
`fr.crossnet.loginRequired`:
```ts
    loginRequired: "Lancer un transfert inter-réseaux nécessite une connexion. Veuillez vous connecter pour continuer.",
```

> 注意：每个语言块的 `crossnet` 已有 `loginFirst`/`shareHint`/`copy`/`copied`/`connecting`/`linkDead`，只需新增 `loginRequired` 一行，不要改动已有键值。各语言 `crossnet` 起始行参考：`zh`≈161、`en`≈244、`ja`≈327、`ko`≈410、`de`≈493、`fr`≈576（实现时以实际匹配 `crossnet: {` 为准）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd web && npx vitest run src/lib/i18n.test.ts`
Expected: PASS

- [ ] **Step 6: 类型检查**

Run: `cd web && npm run check`
Expected: 0 errors（确认 6 个语言对象都满足扩展后的 `Messages` 接口）

- [ ] **Step 7: 提交**

```bash
git add web/src/lib/i18n.svelte.ts web/src/lib/i18n.test.ts
git commit -m "feat(web): i18n strings for page tabs and cross-network login notice

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 分享链接指向 /cross-network + 发起流程适配

让分享链接落在 `/cross-network#t=<token>`，并让 `CrossNetwork.start()` 改写到该路径后 reload（无论当前在哪个 Tab 都能正确切换 WS 房间）。

**Files:**
- Modify: `web/src/lib/transfer-link.ts:13-15`（`buildTransferLink`）
- Modify: `web/src/lib/transfer-link.test.ts:21-27`（更新期望）
- Modify: `web/src/lib/CrossNetwork.svelte:1-49`（import `CROSS_PATH`，改 `start()`）

**Interfaces:**
- Consumes: `CROSS_PATH` from `./router.svelte`（Task 2）。
- Produces: `buildTransferLink(origin, token)` 现在返回 `${origin}/cross-network#t=${token}`。

- [ ] **Step 1: 改测试为新的期望（先让它失败）**

In `web/src/lib/transfer-link.test.ts`, 把 `buildTransferLink` 用例改成：

```ts
describe("buildTransferLink", () => {
  it("puts the token in the fragment of the cross-network path", () => {
    expect(buildTransferLink("https://relayium.app", "tok")).toBe(
      "https://relayium.app/cross-network#t=tok",
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts`
Expected: FAIL（仍返回 `/#t=tok`）

- [ ] **Step 3: 改 buildTransferLink**

In `web/src/lib/transfer-link.ts`, 在文件顶部 import 之下加入常量（避免与 router 形成循环引用——router 反过来 import 本文件的 `parseTransferToken`，所以这里**不**从 router import，改为本地常量）：

```ts
/** Path of the cross-network page; shared links and the originator both target it. */
export const CROSS_PATH = "/cross-network";
```

把 `buildTransferLink` 改为：

```ts
/** Build the shareable link for a token against the given origin. */
export function buildTransferLink(origin: string, token: string): string {
  return `${origin}${CROSS_PATH}#t=${token}`;
}
```

> 说明：`CROSS_PATH` 的单一来源放在 `transfer-link.ts`（router 已 import 本文件，故无环）。Task 2 的 `router.svelte.ts` 已自带同名常量；将其改为从这里 re-export 以保持唯一来源——见 Step 4。

- [ ] **Step 4: 让 router 复用同一常量**

In `web/src/lib/router.svelte.ts`, 把：

```ts
import { parseTransferToken } from "./transfer-link";

export type Route = "lan" | "cross";

export const CROSS_PATH = "/cross-network";
```

改为：

```ts
import { parseTransferToken, CROSS_PATH } from "./transfer-link";

export type Route = "lan" | "cross";

export { CROSS_PATH };
```

- [ ] **Step 5: 改 CrossNetwork.start()**

In `web/src/lib/CrossNetwork.svelte`, 第 3 行 import 改为同时引入 `CROSS_PATH`：

```ts
  import { createTransfer, buildTransferLink, CROSS_PATH } from "./transfer-link";
```

把 `start()` 里的成功分支：

```ts
      const { token } = await createTransfer();
      sessionStorage.setItem(ORIGIN_KEY, token);
      location.hash = `t=${token}`;
      location.reload();
```

改为：

```ts
      const { token } = await createTransfer();
      sessionStorage.setItem(ORIGIN_KEY, token);
      // Rewrite to the cross-network path + token, then reload so the signaling
      // socket reconnects into the 2-peer token room (works from either tab).
      history.replaceState({}, "", `${CROSS_PATH}#t=${token}`);
      location.reload();
```

- [ ] **Step 6: 运行相关测试 + 类型检查**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts && npm run check`
Expected: 测试 PASS，check 0 errors

- [ ] **Step 7: 提交**

```bash
git add web/src/lib/transfer-link.ts web/src/lib/transfer-link.test.ts web/src/lib/router.svelte.ts web/src/lib/CrossNetwork.svelte
git commit -m "feat(web): cross-network share links target /cross-network path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Nav 组件（共享：品牌 + Tab + 语言选择）

两页共享的顶部栏：紧凑品牌、两个 Tab、语言下拉。当前高亮项由 `route` 决定。

**Files:**
- Create: `web/src/lib/Nav.svelte`

**Interfaces:**
- Consumes: `currentRoute`、`navigate`、`type Route` from `./router.svelte`；`lang`/`setLang`/`LANGS`/`messages` from `./i18n.svelte`。
- Produces: `<Nav />`（无 props；内部读 router 与 i18n 状态）。

- [ ] **Step 1: 创建 Nav.svelte**

Create `web/src/lib/Nav.svelte`:

```svelte
<script lang="ts">
  import { currentRoute, navigate, type Route } from "./router.svelte";
  import { lang, setLang, LANGS, messages, type Lang, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const tabs: { id: Route; label: () => string }[] = [
    { id: "lan", label: () => t.nav.lanTab },
    { id: "cross", label: () => t.nav.crossTab },
  ];
</script>

<nav class="topnav">
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <span class="mark">⇌</span><span class="word">Relayium</span>
  </a>

  <div class="tabs" role="tablist">
    {#each tabs as tab (tab.id)}
      <button
        role="tab"
        class="tab"
        class:active={currentRoute() === tab.id}
        aria-selected={currentRoute() === tab.id}
        onclick={() => navigate(tab.id)}
      >{tab.label()}</button>
    {/each}
  </div>

  <select
    class="lang"
    aria-label={t.langLabel}
    value={lang()}
    onchange={(e) => setLang((e.currentTarget as HTMLSelectElement).value as Lang)}
  >
    {#each LANGS as l (l.code)}
      <option value={l.code}>{l.label}</option>
    {/each}
  </select>
</nav>

<style>
  .topnav {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 0 10px; margin-bottom: 4px;
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text-h); font-weight: 600; }
  .brand .mark {
    width: 28px; height: 28px; line-height: 28px; text-align: center;
    border-radius: 9px; color: #fff; font-size: 16px;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
  }
  .brand .word { font-size: 16px; letter-spacing: -0.4px; }

  .tabs { display: flex; gap: 6px; margin: 0 auto 0 8px; }
  .tab {
    font: inherit; font-size: 14px; padding: 7px 14px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border); background: var(--social-bg); color: var(--text);
    transition: border-color .15s, color .15s, background .15s;
  }
  .tab:hover { border-color: var(--accent-border); }
  .tab.active { color: #fff; background: var(--accent); border-color: var(--accent); }

  .lang {
    font: inherit; font-size: 13px; padding: 5px 28px 5px 10px;
    border-radius: 8px; border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  @media (max-width: 560px) {
    .topnav { flex-wrap: wrap; gap: 8px; }
    .brand .word { display: none; }
    .tabs { margin: 0; order: 3; width: 100%; }
    .tab { flex: 1; }
  }
</style>
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npm run check`
Expected: 0 errors

- [ ] **Step 3: 提交**

```bash
git add web/src/lib/Nav.svelte
git commit -m "feat(web): shared Nav with brand, page tabs and language picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Account 可控开关 + CrossPage 组件

让 `Account` 的下拉开关可由父组件控制，并新建 `CrossPage` 把账户入口、"需要登录"提示、`CrossNetwork`、跨网络专属说明与页脚组装成完整的跨网络页。

**Files:**
- Modify: `web/src/lib/Account.svelte:11`（`open` 改为 bindable prop）
- Create: `web/src/lib/CrossPage.svelte`

**Interfaces:**
- Consumes: `Account`（现在支持 `bind:open`）；`CrossNetwork`；`session` from `./auth.svelte`；`messages`/`lang`/`legalUrl` from `./i18n.svelte`。
- Produces: `<CrossPage roomToken={string} linkDead={boolean} />`。

- [ ] **Step 1: 让 Account.open 可绑定**

In `web/src/lib/Account.svelte`, 把第 11 行：

```ts
  let open = $state(false);
```

改为：

```ts
  let { open = $bindable(false) }: { open?: boolean } = $props();
```

（其余逻辑不变：`open = !open` 等仍可写。）

- [ ] **Step 2: 创建 CrossPage.svelte**

Create `web/src/lib/CrossPage.svelte`:

```svelte
<script lang="ts">
  import Account from "./Account.svelte";
  import CrossNetwork from "./CrossNetwork.svelte";
  import { session } from "./auth.svelte";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  let { roomToken = "", linkDead = false }:
    { roomToken?: string; linkDead?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  // The login notice is only for someone trying to *start* a transfer:
  // a recipient (roomToken present) never needs to log in.
  const needsLogin = $derived(!session().user && !roomToken);

  let loginOpen = $state(false);
</script>

<section class="crosspage">
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.nav.crossTab}</h1>
    <p class="tagline">{t.tagline}</p>
  </header>

  {#if needsLogin}
    <section class="login-required">
      <p>{t.crossnet.loginRequired}</p>
      <button class="primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
    </section>
  {/if}

  <CrossNetwork {roomToken} />

  {#if linkDead}
    <p class="notice error">{t.crossnet.linkDead}</p>
  {/if}

  <footer>
    <nav class="legal">
      <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
      <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
      <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
    <span class="fineprint">{t.footer}</span>
  </footer>
</section>

<style>
  .crosspage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: 12px 0 20px; }
  .cn-head h1 { font-size: 34px; margin: 0 0 8px; letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: 15px; max-width: 44ch; margin: 0 auto; }

  .login-required {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    text-align: center; margin: 0 auto 22px; max-width: 520px;
    padding: 18px; border-radius: 14px;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .login-required p { margin: 0; font-size: 14.5px; }
  .login-required .primary {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    background: var(--accent); border: 1px solid var(--accent); color: #fff;
  }
  .login-required .primary:hover { filter: brightness(1.08); }

  .notice.error {
    margin: 14px auto 0; max-width: 520px; text-align: center;
    padding: 12px 14px; border-radius: 10px;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }

  footer {
    margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
</style>
```

- [ ] **Step 3: 类型检查**

Run: `cd web && npm run check`
Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
git add web/src/lib/Account.svelte web/src/lib/CrossPage.svelte
git commit -m "feat(web): CrossPage with account entry and login-required notice

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: App.svelte 路由壳整合 + 收尾验证

把 App.svelte 改成路由壳：顶部渲染 `Nav`，按 `route` 渲染局域网内容或 `CrossPage`；移除原 `.topbar`（`Account` 与语言下拉已分别迁到 CrossPage / Nav）；接好 `popstate`。

**Files:**
- Modify: `web/src/lib/App.svelte`（import、onMount、模板、样式）

**Interfaces:**
- Consumes: `Nav`、`CrossPage`；`currentRoute`/`syncRouteFromLocation` from `./router.svelte`。
- Produces: 最终页面行为——`/`=局域网（无登录），`/cross-network`=跨网络（有登录入口 + 提示）。

- [ ] **Step 1: 调整 import**

In `web/src/lib/App.svelte`, 在 `<script>` 顶部 imports 区：

- 删除：`import Account from "./lib/Account.svelte";`
- 把 `import CrossNetwork from "./lib/CrossNetwork.svelte";` 替换为：

```ts
  import CrossPage from "./lib/CrossPage.svelte";
  import Nav from "./lib/Nav.svelte";
  import { currentRoute, syncRouteFromLocation } from "./lib/router.svelte";
```

> 注意 App.svelte 位于 `web/src/App.svelte`，其现有 import 用的是 `"./lib/..."` 前缀，新增的也保持该前缀。

- [ ] **Step 2: onMount 接入路由同步**

In `onMount`（约 85-105 行），在 `roomToken = parseTransferToken(location.hash);` 之后插入路由同步与 popstate 监听：

```ts
    roomToken = parseTransferToken(location.hash);
    syncRouteFromLocation();
    window.addEventListener("popstate", syncRouteFromLocation);
```

> `syncRouteFromLocation` 是幂等的；`onMount` 早于 `await ready()` 之外的逻辑无妨。若 `unsupported` 提前 return，路由仍默认 `"lan"`，行为安全。为确保即便 `unsupported` 早退也同步过路由，把这两行放在 `onMount` 开头 `document.documentElement.lang = lang();` 之后亦可——实现时择一，确保它们一定被执行（即放在 `if (!window.isSecureContext ...) return;` **之前**）。

最终把这两行放在 `onMount` 的最前面更稳：

```ts
  onMount(async () => {
    document.documentElement.lang = lang();
    syncRouteFromLocation();
    window.addEventListener("popstate", syncRouteFromLocation);
    if (!window.isSecureContext || !crypto.subtle) {
      unsupported = true;
      return;
    }
    ...
```

并删除后面重复添加的那一处（保持只有一处 `syncRouteFromLocation()` + 监听）。`roomToken = parseTransferToken(location.hash);` 保持原位不动。

- [ ] **Step 3: 改模板——Nav + 路由分支**

把 `<main>` 内从 `.topbar` 到 LAN 内容的结构改造。将：

```svelte
<main>
  <div class="topbar">
    <Account />
    <select
      class="lang"
      aria-label={t.langLabel}
      value={lang()}
      onchange={(e) => setLang((e.currentTarget as HTMLSelectElement).value as Lang)}
    >
      {#each LANGS as l (l.code)}
        <option value={l.code}>{l.label}</option>
      {/each}
    </select>
  </div>
  <CrossNetwork {roomToken} />
  {#if linkDead}
    <p class="notice error">{t.crossnet.linkDead}</p>
  {/if}

  <Hero {connState} {unsupported} {selfName} {selfIP} />
```

替换为：

```svelte
<main>
  <Nav />

  {#if currentRoute() === "cross"}
    <CrossPage {roomToken} {linkDead} />
  {:else}
    <Hero {connState} {unsupported} {selfName} {selfIP} />
```

并在 LAN 分支结束处补上 `{/if}`：原本 `<main>` 末尾是

```svelte
    </footer>
  {/if}
</main>
```

改为（在 `unsupported` 的 `{/if}` 之后、`</main>` 之前再加一个 `{/if}` 收掉路由分支）：

```svelte
    </footer>
    {/if}
  {/if}
</main>
```

> 结果：`{#if currentRoute() === "cross"} CrossPage {:else} <Hero/> ...LAN 全部内容... {/if}`。LAN 分支内部仍保留原有的 `{#if unsupported} banner {:else} peers/cards/features/guide/footer {/if}`。

- [ ] **Step 4: 删除不再使用的 import 与样式**

- 若 `Lang`、`LANGS`、`setLang` 在 App 中已无其他用处（lang 下拉已移走），从 import 中移除 `setLang`、`LANGS`；`type Lang` 若无引用也移除。保留 `lang`、`messages`、`legalUrl`、`type Messages`、`type StatusKey`（仍用于 LAN 渲染）。实现时以 `npm run check` 的"未使用"报错为准逐个清理。
- 删除 `<style>` 中 `.topbar`、`.topbar` 的媒体查询、`.lang` 这三段（已迁至 Nav）。LAN 仍在用的样式（`.toast`/`.banner`/`.peers`/`.card`/`footer` 等）全部保留。

- [ ] **Step 5: 类型检查 + 构建**

Run: `cd web && npm run check && npm run build`
Expected: check 0 errors；build 成功生成 `dist/`

- [ ] **Step 6: 全量前端测试**

Run: `cd web && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 7: 手动验证（关键路径）**

启动：`cd server && go run . -static ../web/dist`（如需账户功能确保有 DB；仅验证页面切换可不依赖账户）。在浏览器（https 或 localhost）验证：

1. 打开 `/` → 顶部有 Tab，默认高亮"局域网传输"；展示 Hero + "附近的设备"；**页面无任何登录按钮**。
2. 点"跨网络传输" Tab → URL 变为 `/cross-network`（无刷新）；右上角出现账户/登录入口；未登录时显示"需要登录"提示卡 + 登录按钮。
3. 点提示卡的【登录】→ Account 下拉打开。
4. 浏览器后退 → 回到 `/`，回到局域网页（Tab 高亮同步）。
5. 直接访问 `/cross-network`（地址栏输入回车，验证 SPA fallback）→ 正常加载跨网络页，不是 404。
6. （已登录）在跨网络页点"发送到其他网络的人" → 生成 `/cross-network#t=<token>` 并 reload，显示分享链接 + 二维码；复制链接形如 `https://<host>/cross-network#t=<token>`。
7. 在另一浏览器打开该链接 → 落在跨网络页"连接中"，**无需登录**。

- [ ] **Step 8: 提交**

```bash
git add web/src/App.svelte
git commit -m "feat(web): route App between LAN and cross-network pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage：**
  - 跨网络独立页面 → Task 2（路由）+ Task 6（CrossPage）+ Task 7（App 分支）✓
  - `/` 默认局域网 → `routeFromLocation` 默认 `"lan"`（Task 2）✓
  - 可切换 → Nav Tab（Task 5）+ `navigate`（Task 2）✓
  - 局域网页无登录入口 → App 移除 `.topbar`/`Account`（Task 7）✓
  - 跨网络页提示需登录 → CrossPage `needsLogin` + `loginRequired` 文案（Task 3/6）✓
  - 接收方免登录 → `needsLogin = !user && !roomToken`（Task 6）✓
  - Logo+Tab 共享、其余各页专属 → Nav 共享、Hero 留 LAN、CrossPage 自带页脚（Task 5/6/7）✓
  - 分享链接落 `/cross-network` + 服务端 fallback → Task 4 + Task 1 ✓
  - i18n 6 语言 → Task 3 ✓
- **Placeholder scan：** 无 TBD/TODO；每个改动步骤均给出完整代码。✓
- **Type consistency：** `Route`、`CROSS_PATH`（唯一来源在 `transfer-link.ts`，router re-export）、`currentRoute`/`navigate`/`syncRouteFromLocation`、`Messages.nav`/`crossnet.loginRequired`、`Account` 的 `bind:open`、`CrossPage` 的 `{roomToken, linkDead}` 在各 Task 间一致。✓
- **已知取舍：** 跨网络页未登录时 Account 的 `refreshSession` 在 Account 挂载时进行，登录态确定前会短暂显示"需要登录"提示——可接受（spec 已记录该 flash 取舍）。
