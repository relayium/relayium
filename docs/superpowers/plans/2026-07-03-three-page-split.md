# 三页拆分(局域网 / 实时直传 / 异步传输)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 站点从两页拆为三页:`/` 局域网(不变)、`/cross-network` 实时直传(瘦身,零账号 UI)、`/offline-transfer` 异步传输(新页,唯一登录入口)。

**Architecture:** 纯前端信息架构调整,服务端零改动。路由加 `"offline"`;CrossPage 删 stored 卡与 Account;新建 OfflinePage 承接 StoredUpload + 登录门控;HowItWorks 改为 per-page variant;新 CrossSell 组件双向引流;首页 CTA 双按钮。营销区 FeatureStrip/UseCases/Faq/ModeCompare 两页共用。

**Tech Stack:** Svelte 5 runes + TypeScript + Vitest(`web/`,`npx vitest run` / `npm run check` / `npm run build`);六语言 i18n(`web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`,types.ts 为 schema)。

**Spec:** `docs/superpowers/specs/2026-07-03-three-page-split-design.md`

## Global Constraints

- `/cross-network` 路径与 `#c=<code>` 加入链接格式**不变**;`#c=` 永远路由到实时页。
- 服务端(`server/`)零改动。
- 实时页与局域网页 DOM 中不得出现任何账号 UI(Account 组件/登录按钮)。
- 六语言 i18n 与 `types.ts` 必须同一 commit 同步;计划中的文案逐字使用。
- 每个 task 结束 `cd web && npx vitest run && npm run check` 全绿;涉及构建产物的 task 另跑 `npm run build`。
- 提交信息 `feat(web): …` / `docs: …`,结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 不引入新依赖;不做计量归因/熔断/收费/SEO 静态落地页(spec 非目标)。

---

### Task 1: 路由 "offline" + 导航三 tab

**Files:**
- Modify: `web/src/lib/router.svelte.ts`
- Modify: `web/src/lib/router.test.ts`
- Modify: `web/src/lib/Nav.svelte`
- Modify: `web/src/lib/i18n/types.ts:129`(nav 块)
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts:116`(nav 行)

**Interfaces:**
- Produces: `Route` 联合类型含 `"offline"`;`OFFLINE_PATH = "/offline-transfer"`(从 router.svelte.ts 导出);`navigate("offline")` 可用;`t.nav.offlineTab`。后续任务据此接线。

- [ ] **Step 1: router.test.ts 补失败用例**

在现有 `routeFromLocation` describe 中追加:

```ts
describe("routeFromLocation offline page", () => {
  it("maps /offline-transfer to the offline route", () => {
    expect(rfl("/offline-transfer", "")).toBe("offline");
  });
  it("a pairing code still wins over the offline path", () => {
    expect(rfl("/offline-transfer", "#c=424242")).toBe("cross");
  });
});
```

(`rfl` 为该文件既有的测试 helper,沿用。)

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: FAIL(`"offline"` 不是合法 Route / 返回 "lan")

- [ ] **Step 3: 改 router.svelte.ts**

```ts
export type Route = "lan" | "cross" | "offline" | "download" | "me";

/** Path of the async stored-transfer page (login-gated; the paid tier lives here). */
export const OFFLINE_PATH = "/offline-transfer";
```

`routeFromLocation` 在 `pathname === CROSS_PATH` 判断后追加:

```ts
  if (pathname === OFFLINE_PATH) return "offline";
```

`navigate()` 的路径映射改为:

```ts
  const pathname =
    r === "cross" ? CROSS_PATH : r === "offline" ? OFFLINE_PATH : r === "me" ? ME_PATH : "/";
```

文件头注释「Two routes」段落改为三页表述(LAN 默认 `/`、realtime `/cross-network`、async stored `/offline-transfer`)。

- [ ] **Step 4: i18n nav 键(types + 六语言)**

`types.ts`:`nav: { lanTab: string; crossTab: string; offlineTab: string };`

各语言 nav 行整行替换(crossTab 同步改为"实时直传"基调):

```ts
// zh
  nav: { lanTab: "局域网传输", crossTab: "实时直传", offlineTab: "异步传输" },
// en
  nav: { lanTab: "LAN transfer", crossTab: "Realtime direct", offlineTab: "Async transfer" },
// ja
  nav: { lanTab: "LAN 転送", crossTab: "リアルタイム直接転送", offlineTab: "非同期転送" },
// ko
  nav: { lanTab: "LAN 전송", crossTab: "실시간 직접 전송", offlineTab: "비동기 전송" },
// de
  nav: { lanTab: "LAN-Übertragung", crossTab: "Echtzeit-Direkt", offlineTab: "Asynchron senden" },
// fr
  nav: { lanTab: "Transfert LAN", crossTab: "Direct en temps réel", offlineTab: "Transfert asynchrone" },
```

- [ ] **Step 5: Nav.svelte 第三个 tab**

```ts
  import { currentRoute, navigate, CROSS_PATH, OFFLINE_PATH, type Route } from "./router.svelte";

  const tabs: { id: Route; label: () => string }[] = [
    { id: "lan", label: () => t.nav.lanTab },
    { id: "cross", label: () => t.nav.crossTab },
    { id: "offline", label: () => t.nav.offlineTab },
  ];
```

模板 href 三态:

```svelte
        href={tab.id === "cross" ? CROSS_PATH : tab.id === "offline" ? OFFLINE_PATH : "/"}
```

- [ ] **Step 6: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS / 0 errors(App 尚无 offline 分支——route 值暂时落到无渲染分支也不报错:确认 `currentRoute() === "offline"` 时 App 渲染主页分支不崩溃即可,下一任务接线)

注意:App.svelte 的渲染链是 `download → cross → me → else(lan)`,`"offline"` 会暂时落到 lan 分支显示局域网页——这是本任务的已知过渡态,Task 4 修正;svelte-check 不会报错。

```bash
git add web/src/lib/router.svelte.ts web/src/lib/router.test.ts web/src/lib/Nav.svelte web/src/lib/i18n
git commit -m "feat(web): offline-transfer route + three-tab nav"
```

---

### Task 2: i18n 新键(offline / crossSell / homeCross 双 CTA / realtimeFoot)+ 首页 CTA 双按钮

**Files:**
- Modify: `web/src/lib/i18n/types.ts`
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`
- Modify: `web/src/App.svelte`(crosscta 区,约 1111-1117 行,按内容定位)

**Interfaces:**
- Produces: `t.offline.{tagline,pitch,signIn}`;`t.crossSell.{realtime,offline}.{lead,cta}`;`t.homeCross.{title,desc,realtimeCta,offlineCta}`(旧 `cta` 删除);`t.crossnet.realtimeFoot` 新值。Task 4/5 消费。

- [ ] **Step 1: types.ts**

`crossnet` 块后新增两个顶层块,`homeCross` 类型改签名:

```ts
  offline: {
    tagline: string; // page subtitle — encrypt-then-store, ciphertext-only server
    pitch: string; // one-paragraph how/why under the header
    signIn: string; // hint beside the sign-in button on the gated card
  };
  crossSell: {
    // Directional cross-links between the two cross-network pages.
    realtime: { lead: string; cta: string }; // rendered on the OFFLINE page → go realtime
    offline: { lead: string; cta: string }; // rendered on the REALTIME page → go offline
  };
```

```ts
  homeCross: { title: string; desc: string; realtimeCta: string; offlineCta: string }; // homepage → the two cross-network pages
```

- [ ] **Step 2: 六语言值**

zh(`homeCross` 整块替换;`offline`/`crossSell` 插在 `crossnet` 块后;`crossnet.realtimeFoot` 行替换):

```ts
  crossnet: {
    // …realtimeTitle/realtimeSub 不变…
    realtimeFoot: "免登录 · 端到端加密",
  },
  offline: {
    tagline: "浏览器先加密再暂存 · 服务器只保存无法解密的密文",
    pitch: "对方现在不在线？先把文件加密上传，生成一条有有效期的下载链接发过去，对方有空时凭链接下载——全程零知识，服务器看不到内容。",
    signIn: "登录后即可上传并生成下载链接；接收方永远无需账号。",
  },
  crossSell: {
    realtime: { lead: "对方就在线？实时直传更快——点对点直连、文件不经服务器，免登录。", cta: "前往实时直传 →" },
    offline: { lead: "对方现在不在线？用异步传输——加密上传后生成下载链接，对方几天内随时来取。", cta: "前往异步传输 →" },
  },
  homeCross: {
    title: "不在同一个网络？",
    desc: "对方在线，用实时直传（免登录、文件不经服务器）；对方不在线，用异步传输（加密暂存，凭链接随时取）。",
    realtimeCta: "实时直传 →",
    offlineCta: "异步传输 →",
  },
```

en:

```ts
    realtimeFoot: "No sign-in needed · end-to-end encrypted",
  offline: {
    tagline: "Encrypted in your browser, then stored · the server only ever holds ciphertext",
    pitch: "Recipient not online right now? Encrypt and upload, send them a download link with an expiry — they fetch it whenever they're free. Zero-knowledge throughout: the server cannot see the content.",
    signIn: "Sign in to upload and create download links; recipients never need an account.",
  },
  crossSell: {
    realtime: { lead: "Is the other person online right now? Realtime direct is faster — peer-to-peer, files never touch the server, no sign-in.", cta: "Go to realtime direct →" },
    offline: { lead: "Recipient not online? Use async transfer — encrypt, upload, and leave a download link they can fetch for days.", cta: "Go to async transfer →" },
  },
  homeCross: {
    title: "Not on the same network?",
    desc: "If they're online, use realtime direct (no sign-in, files never touch the server); if not, use async transfer (encrypted storage, fetch by link anytime).",
    realtimeCta: "Realtime direct →",
    offlineCta: "Async transfer →",
  },
```

ja:

```ts
    realtimeFoot: "ログイン不要 · エンドツーエンド暗号化",
  offline: {
    tagline: "ブラウザで暗号化してから一時保存 · サーバーは復号できない暗号文のみ保持",
    pitch: "相手が今オンラインでない？暗号化してアップロードし、有効期限付きのダウンロードリンクを送っておけば、相手は都合のいいときに取得できます。全工程ゼロ知識——サーバーは内容を見られません。",
    signIn: "ログインするとアップロードとダウンロードリンクの生成ができます。受信者にアカウントは一切不要です。",
  },
  crossSell: {
    realtime: { lead: "相手が今オンライン？リアルタイム直接転送のほうが速い——P2P直結、ファイルはサーバーを経由せず、ログイン不要。", cta: "リアルタイム直接転送へ →" },
    offline: { lead: "相手がオフライン？非同期転送を——暗号化アップロードでダウンロードリンクを残せば、数日間いつでも取得できます。", cta: "非同期転送へ →" },
  },
  homeCross: {
    title: "同じネットワークにいない？",
    desc: "相手がオンラインならリアルタイム直接転送（ログイン不要・ファイルはサーバー非経由）、オフラインなら非同期転送（暗号化保存・リンクでいつでも取得）。",
    realtimeCta: "リアルタイム直接転送 →",
    offlineCta: "非同期転送 →",
  },
```

ko:

```ts
    realtimeFoot: "로그인 불필요 · 종단간 암호화",
  offline: {
    tagline: "브라우저에서 암호화 후 임시 보관 · 서버는 복호화 불가능한 암호문만 보관",
    pitch: "상대가 지금 온라인이 아닌가요? 암호화해 업로드하고 유효기간이 있는 다운로드 링크를 보내 두면, 상대는 편할 때 받아가면 됩니다. 전 과정 제로 널리지 — 서버는 내용을 볼 수 없습니다.",
    signIn: "로그인하면 업로드와 다운로드 링크 생성이 가능합니다. 받는 사람은 계정이 전혀 필요 없습니다.",
  },
  crossSell: {
    realtime: { lead: "상대가 지금 온라인인가요? 실시간 직접 전송이 더 빠릅니다 — P2P 직접 연결, 파일은 서버를 거치지 않고, 로그인도 필요 없습니다.", cta: "실시간 직접 전송으로 →" },
    offline: { lead: "상대가 오프라인인가요? 비동기 전송을 쓰세요 — 암호화 업로드 후 다운로드 링크를 남기면 며칠 동안 언제든 받을 수 있습니다.", cta: "비동기 전송으로 →" },
  },
  homeCross: {
    title: "같은 네트워크가 아닌가요?",
    desc: "상대가 온라인이면 실시간 직접 전송(로그인 불필요, 파일은 서버를 거치지 않음), 아니면 비동기 전송(암호화 보관, 링크로 언제든 수령)을 쓰세요.",
    realtimeCta: "실시간 직접 전송 →",
    offlineCta: "비동기 전송 →",
  },
```

de:

```ts
    realtimeFoot: "Keine Anmeldung nötig · Ende-zu-Ende-verschlüsselt",
  offline: {
    tagline: "Im Browser verschlüsselt, dann zwischengespeichert · der Server hält nur Chiffretext",
    pitch: "Die Gegenseite ist gerade nicht online? Verschlüsseln, hochladen und einen Download-Link mit Ablaufdatum schicken — abgeholt wird, wann es passt. Durchgehend Zero-Knowledge: der Server kann den Inhalt nicht sehen.",
    signIn: "Melde dich an, um hochzuladen und Download-Links zu erzeugen; Empfänger brauchen nie ein Konto.",
  },
  crossSell: {
    realtime: { lead: "Ist die andere Person gerade online? Echtzeit-Direkt ist schneller — Peer-to-Peer, Dateien berühren nie den Server, ohne Anmeldung.", cta: "Zur Echtzeit-Direktübertragung →" },
    offline: { lead: "Gegenseite offline? Nutze die asynchrone Übertragung — verschlüsselt hochladen und einen Download-Link hinterlassen, tagelang abholbar.", cta: "Zur asynchronen Übertragung →" },
  },
  homeCross: {
    title: "Nicht im selben Netzwerk?",
    desc: "Ist die Gegenseite online, nutze Echtzeit-Direkt (ohne Anmeldung, Dateien berühren nie den Server); wenn nicht, die asynchrone Übertragung (verschlüsselt zwischengespeichert, Abruf per Link).",
    realtimeCta: "Echtzeit-Direkt →",
    offlineCta: "Asynchron senden →",
  },
```

fr:

```ts
    realtimeFoot: "Sans connexion · chiffré de bout en bout",
  offline: {
    tagline: "Chiffré dans votre navigateur, puis stocké · le serveur ne détient que du chiffré",
    pitch: "Le destinataire n'est pas en ligne ? Chiffrez, envoyez, et transmettez un lien de téléchargement à durée limitée — il récupère quand il veut. Zéro connaissance de bout en bout : le serveur ne peut pas voir le contenu.",
    signIn: "Connectez-vous pour téléverser et créer des liens de téléchargement ; les destinataires n'ont jamais besoin de compte.",
  },
  crossSell: {
    realtime: { lead: "L'autre personne est en ligne ? Le direct en temps réel est plus rapide — pair-à-pair, les fichiers ne passent jamais par le serveur, sans connexion.", cta: "Vers le direct en temps réel →" },
    offline: { lead: "Destinataire hors ligne ? Utilisez le transfert asynchrone — chiffrez, téléversez et laissez un lien de téléchargement, récupérable pendant plusieurs jours.", cta: "Vers le transfert asynchrone →" },
  },
  homeCross: {
    title: "Pas sur le même réseau ?",
    desc: "S'il est en ligne, utilisez le direct en temps réel (sans connexion, les fichiers ne passent jamais par le serveur) ; sinon, le transfert asynchrone (stockage chiffré, récupération par lien à tout moment).",
    realtimeCta: "Direct en temps réel →",
    offlineCta: "Transfert asynchrone →",
  },
```

- [ ] **Step 3: App.svelte 首页 CTA 双按钮**

crosscta 区(按内容定位 `t.homeCross.cta`)替换为:

```svelte
    <section class="crosscta">
      <div class="cc-text">
        <h3>{t.homeCross.title}</h3>
        <p>{t.homeCross.desc}</p>
      </div>
      <div class="cc-actions">
        <button class="btn btn-primary" onclick={() => navigate("cross")}>{t.homeCross.realtimeCta}</button>
        <button class="btn btn-ghost" onclick={() => navigate("offline")}>{t.homeCross.offlineCta}</button>
      </div>
    </section>
```

样式区 `.crosscta .btn { white-space: nowrap; }` 后追加:

```css
  .crosscta .cc-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; }
```

- [ ] **Step 4: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS / 0 errors(i18n.test.ts 的 key-parity 检查因类型系统天然通过)

```bash
git add web/src/lib/i18n web/src/App.svelte
git commit -m "feat(web): i18n for the offline page, cross-sell links, dual homepage CTA"
```

---

### Task 3: HowItWorks 拆为 per-page variant(六语言重写)

**Files:**
- Modify: `web/src/lib/i18n/types.ts:206-210`(howItWorks 块)
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`(howItWorks 块整体替换)
- Modify: `web/src/lib/HowItWorks.svelte`
- Modify: `web/src/lib/CrossPage.svelte:93`(调用处传 variant)

**Interfaces:**
- Produces: `t.howItWorks.{realtime,offline}` 均为 `{ title; sub; ways: { icon; name; how; tag }[] }`;`<HowItWorks variant="realtime" />` / `variant="offline"`。Task 4 的 OfflinePage 消费 offline variant。

- [ ] **Step 1: types.ts**

```ts
  howItWorks: {
    realtime: HowSection;
    offline: HowSection;
  };
```

并在 `Messages` 接口前定义并导出:

```ts
/** One page's "how it works" walkthrough: three sequential step cards. */
export interface HowSection {
  title: string;
  sub: string;
  ways: { icon: string; name: string; how: string; tag: string }[];
}
```

- [ ] **Step 2: HowItWorks.svelte variant 化**

script 区:

```ts
  import { lang, messages, type Messages } from "./i18n.svelte";
  let { variant }: { variant: "realtime" | "offline" } = $props();
  const t = $derived<Messages>(messages[lang()]);
  const sec = $derived(t.howItWorks[variant]);
```

模板中 `t.howItWorks.title` → `sec.title`、`t.howItWorks.sub` → `sec.sub`、`t.howItWorks.ways` → `sec.ways`(aria-label 同步用 `sec.title`)。样式不动(3 列步骤卡布局对 3 步刚好)。

- [ ] **Step 3: CrossPage.svelte 调用处**

`<HowItWorks />` → `<HowItWorks variant="realtime" />`

- [ ] **Step 4: 六语言 howItWorks 整块替换**

zh:

```ts
  howItWorks: {
    realtime: {
      title: "实时直传，三步完成",
      sub: "双方都在线时，跨网络也能点对点直连——免登录。",
      ways: [
        { icon: "📄", name: "选文件，生成配对码", how: "点「发送文件」选好要发的内容，自动生成 6 位配对码，同时附带加入链接和二维码。", tag: "免登录" },
        { icon: "🔢", name: "把码给对方", how: "念码、发链接或让对方扫码，任选一种；对方在任何现代浏览器里输入或点开即可加入。", tag: "码 15 分钟有效" },
        { icon: "⚡", name: "加入即自动开传", how: "对方加入后传输自动开始，点对点直连、端到端加密；打洞失败时经加密 TURN 中继转发，依然无法被解密。", tag: "文件不经服务器" },
      ],
    },
    offline: {
      title: "异步传输，三步完成",
      sub: "对方不在线也能发：先加密暂存，链接留给对方慢慢取。",
      ways: [
        { icon: "🔒", name: "登录并选择文件", how: "文件在你的浏览器里先用 AES-256-GCM 加密，再上传——服务器自始至终只保存无法解密的密文。", tag: "零知识加密" },
        { icon: "🔗", name: "生成下载链接", how: "可设 1 小时到 7 天有效期，或阅后即焚；解密密钥藏在链接的 # 片段里，不会发送到服务器。", tag: "有效期可控" },
        { icon: "📥", name: "对方随时下载", how: "把链接发给对方；对方无需账号、无需在线等待，凭链接在浏览器里解密下载。", tag: "接收方免账号" },
      ],
    },
  },
```

en:

```ts
  howItWorks: {
    realtime: {
      title: "Realtime direct, in three steps",
      sub: "When both sides are online, connect peer-to-peer across networks — no sign-in.",
      ways: [
        { icon: "📄", name: "Pick files, get a code", how: "Tap “Send files” and choose what to send — a 6-digit pairing code is minted automatically, along with a join link and QR.", tag: "No sign-in" },
        { icon: "🔢", name: "Give the code to the other side", how: "Read it out, send the link, or show the QR — any of the three; they type it in or open it in any modern browser.", tag: "Codes live 15 minutes" },
        { icon: "⚡", name: "Transfer starts on join", how: "The moment they join, the transfer starts automatically — peer-to-peer and end-to-end encrypted; if hole-punching fails it falls back to an encrypted TURN relay that still can't decrypt anything.", tag: "Files never touch the server" },
      ],
    },
    offline: {
      title: "Async transfer, in three steps",
      sub: "Send even when they're offline: encrypt and store now, they fetch by link later.",
      ways: [
        { icon: "🔒", name: "Sign in and pick files", how: "Files are encrypted with AES-256-GCM in your browser before upload — the server only ever stores ciphertext it cannot decrypt.", tag: "Zero-knowledge" },
        { icon: "🔗", name: "Create the download link", how: "Set an expiry from 1 hour to 7 days, or burn-after-reading; the decryption key lives in the link's # fragment and is never sent to the server.", tag: "Expiry you control" },
        { icon: "📥", name: "They download anytime", how: "Send them the link; no account and no waiting online — they decrypt and download right in the browser.", tag: "No account for recipients" },
      ],
    },
  },
```

ja:

```ts
  howItWorks: {
    realtime: {
      title: "リアルタイム直接転送、3ステップ",
      sub: "双方がオンラインなら、ネットワークをまたいでP2P直結——ログイン不要。",
      ways: [
        { icon: "📄", name: "ファイルを選んでコード発行", how: "「ファイルを送信」で送る内容を選ぶと、6桁のペアリングコードが自動発行され、参加リンクとQRも付きます。", tag: "ログイン不要" },
        { icon: "🔢", name: "コードを相手に伝える", how: "口頭で伝える・リンクを送る・QRを見せる、いずれでもOK。相手はモダンブラウザで入力するか開くだけで参加できます。", tag: "コードは15分有効" },
        { icon: "⚡", name: "参加した瞬間に転送開始", how: "相手が参加すると転送が自動で始まります。P2P直結・エンドツーエンド暗号化。ホールパンチング失敗時は暗号化TURNリレー経由でも復号は不可能です。", tag: "ファイルはサーバー非経由" },
      ],
    },
    offline: {
      title: "非同期転送、3ステップ",
      sub: "相手がオフラインでも送れます：暗号化して保存し、リンクで後から取得。",
      ways: [
        { icon: "🔒", name: "ログインしてファイルを選択", how: "ファイルはアップロード前にブラウザ内でAES-256-GCM暗号化されます——サーバーは終始、復号できない暗号文しか保存しません。", tag: "ゼロ知識" },
        { icon: "🔗", name: "ダウンロードリンクを生成", how: "有効期限は1時間〜7日、または閲覧後削除。復号鍵はリンクの#フラグメント内にあり、サーバーへは送信されません。", tag: "有効期限を自分で設定" },
        { icon: "📥", name: "相手はいつでもダウンロード", how: "リンクを相手に送るだけ。アカウントもオンライン待機も不要で、ブラウザ内で復号してダウンロードできます。", tag: "受信者はアカウント不要" },
      ],
    },
  },
```

ko:

```ts
  howItWorks: {
    realtime: {
      title: "실시간 직접 전송, 3단계",
      sub: "둘 다 온라인이면 네트워크를 넘어 P2P로 직접 연결됩니다 — 로그인 불필요.",
      ways: [
        { icon: "📄", name: "파일 선택, 코드 생성", how: "'파일 보내기'로 보낼 내용을 고르면 6자리 페어링 코드가 자동 생성되고, 참여 링크와 QR도 함께 제공됩니다.", tag: "로그인 불필요" },
        { icon: "🔢", name: "코드를 상대에게 전달", how: "불러주거나, 링크를 보내거나, QR을 보여주거나 — 셋 중 아무거나. 상대는 최신 브라우저에서 입력하거나 열기만 하면 됩니다.", tag: "코드는 15분 유효" },
        { icon: "⚡", name: "참여하는 순간 전송 시작", how: "상대가 참여하면 전송이 자동으로 시작됩니다. P2P 직접 연결과 종단간 암호화. 홀 펀칭 실패 시 암호화된 TURN 중계로 전환되지만 복호화는 불가능합니다.", tag: "파일은 서버를 거치지 않음" },
      ],
    },
    offline: {
      title: "비동기 전송, 3단계",
      sub: "상대가 오프라인이어도 보낼 수 있습니다: 암호화해 보관하고, 링크로 나중에 수령.",
      ways: [
        { icon: "🔒", name: "로그인하고 파일 선택", how: "파일은 업로드 전에 브라우저에서 AES-256-GCM으로 암호화됩니다 — 서버는 처음부터 끝까지 복호화할 수 없는 암호문만 보관합니다.", tag: "제로 널리지" },
        { icon: "🔗", name: "다운로드 링크 생성", how: "유효기간은 1시간~7일, 또는 열람 후 삭제. 복호화 키는 링크의 # 프래그먼트에 있으며 서버로 전송되지 않습니다.", tag: "유효기간 직접 설정" },
        { icon: "📥", name: "상대는 언제든 다운로드", how: "링크만 보내면 됩니다. 계정도, 온라인 대기도 필요 없이 브라우저에서 복호화해 다운로드합니다.", tag: "받는 사람 계정 불필요" },
      ],
    },
  },
```

de:

```ts
  howItWorks: {
    realtime: {
      title: "Echtzeit-Direkt in drei Schritten",
      sub: "Sind beide online, verbindet ihr euch netzübergreifend Peer-to-Peer — ohne Anmeldung.",
      ways: [
        { icon: "📄", name: "Dateien wählen, Code erhalten", how: "Auf „Dateien senden“ tippen und auswählen — ein 6-stelliger Kopplungscode wird automatisch erzeugt, samt Beitrittslink und QR.", tag: "Ohne Anmeldung" },
        { icon: "🔢", name: "Code an die Gegenseite geben", how: "Vorlesen, den Link schicken oder den QR zeigen — die andere Person tippt ihn ein oder öffnet ihn in einem beliebigen modernen Browser.", tag: "Codes gelten 15 Minuten" },
        { icon: "⚡", name: "Übertragung startet beim Beitritt", how: "Sobald die Gegenseite beitritt, startet die Übertragung automatisch — Peer-to-Peer und Ende-zu-Ende-verschlüsselt; scheitert das Hole-Punching, springt ein verschlüsseltes TURN-Relay ein, das nichts entschlüsseln kann.", tag: "Dateien erreichen nie den Server" },
      ],
    },
    offline: {
      title: "Asynchron senden in drei Schritten",
      sub: "Senden, auch wenn die Gegenseite offline ist: jetzt verschlüsselt ablegen, später per Link abholen.",
      ways: [
        { icon: "🔒", name: "Anmelden und Dateien wählen", how: "Dateien werden vor dem Upload im Browser mit AES-256-GCM verschlüsselt — der Server speichert durchgehend nur Chiffretext, den er nicht entschlüsseln kann.", tag: "Zero-Knowledge" },
        { icon: "🔗", name: "Download-Link erzeugen", how: "Ablauf von 1 Stunde bis 7 Tagen oder Löschen nach dem Lesen; der Schlüssel steckt im #-Fragment des Links und erreicht den Server nie.", tag: "Ablauf selbst bestimmen" },
        { icon: "📥", name: "Abholen, wann es passt", how: "Schick den Link — kein Konto, kein Online-Warten: entschlüsselt und heruntergeladen wird direkt im Browser.", tag: "Empfänger ohne Konto" },
      ],
    },
  },
```

fr:

```ts
  howItWorks: {
    realtime: {
      title: "Direct en temps réel, en trois étapes",
      sub: "Quand les deux sont en ligne, connectez-vous en pair-à-pair à travers les réseaux — sans connexion.",
      ways: [
        { icon: "📄", name: "Choisir les fichiers, obtenir un code", how: "Touchez « Envoyer des fichiers » et choisissez quoi envoyer — un code d'appairage à 6 chiffres est créé automatiquement, avec lien d'accès et QR.", tag: "Sans connexion" },
        { icon: "🔢", name: "Transmettre le code", how: "Dictez-le, envoyez le lien ou montrez le QR — au choix ; l'autre personne le saisit ou l'ouvre dans n'importe quel navigateur moderne.", tag: "Codes valables 15 minutes" },
        { icon: "⚡", name: "Le transfert démarre à l'arrivée", how: "Dès que l'autre appareil rejoint, le transfert démarre automatiquement — pair-à-pair et chiffré de bout en bout ; en cas d'échec du hole-punching, un relais TURN chiffré prend le relais sans rien pouvoir déchiffrer.", tag: "Les fichiers ne passent jamais par le serveur" },
      ],
    },
    offline: {
      title: "Transfert asynchrone, en trois étapes",
      sub: "Envoyez même hors ligne : chiffrez et stockez maintenant, récupération par lien plus tard.",
      ways: [
        { icon: "🔒", name: "Se connecter et choisir les fichiers", how: "Les fichiers sont chiffrés en AES-256-GCM dans votre navigateur avant l'envoi — le serveur ne stocke jamais que du chiffré indéchiffrable.", tag: "Zéro connaissance" },
        { icon: "🔗", name: "Créer le lien de téléchargement", how: "Expiration de 1 heure à 7 jours, ou destruction après lecture ; la clé de déchiffrement vit dans le fragment # du lien et n'atteint jamais le serveur.", tag: "Expiration maîtrisée" },
        { icon: "📥", name: "Récupération à tout moment", how: "Envoyez le lien — ni compte ni attente en ligne : le déchiffrement et le téléchargement se font directement dans le navigateur.", tag: "Sans compte pour le destinataire" },
      ],
    },
  },
```

- [ ] **Step 5: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS / 0 errors

```bash
git add web/src/lib/i18n web/src/lib/HowItWorks.svelte web/src/lib/CrossPage.svelte
git commit -m "feat(web): per-page how-it-works walkthroughs (6 locales)"
```

---

### Task 4: OfflinePage 组件 + App 路由分支

**Files:**
- Create: `web/src/lib/OfflinePage.svelte`
- Modify: `web/src/App.svelte`(import + 渲染分支)

**Interfaces:**
- Consumes: `t.offline.*`(Task 2)、`t.nav.offlineTab`(Task 1)、`<HowItWorks variant="offline" />`(Task 3)、既有 `Account`/`StoredUpload`/`ModeCompare`/`FeatureStrip`/`UseCases`/`Faq`/`session()`。
- Produces: `<OfflinePage />`(无 props)。CrossSell 接线在 Task 5(本任务页面先不含引流卡)。

- [ ] **Step 1: 新建 OfflinePage.svelte**

```svelte
<!-- web/src/lib/OfflinePage.svelte -->
<script lang="ts">
  import Account from "./Account.svelte";
  import StoredUpload from "./StoredUpload.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import ModeCompare from "./ModeCompare.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import { session } from "./auth.svelte";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let loginOpen = $state(false);
</script>

<section class="offlinepage">
  <!-- The async page is the ONLY page with account UI: sign-in lives here (and /me),
       so the two free pages never show an account concept at all. -->
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.nav.offlineTab}</h1>
    <p class="tagline">{t.offline.tagline}</p>
    <p class="pitch">{t.offline.pitch}</p>
  </header>

  <div class="cards">
    <section class="card">
      <div class="mhead"><h2>{t.methods.stored.name}</h2><span class="badge">{t.methods.stored.badge}</span></div>
      <p class="cardsub">{t.methods.stored.sub}</p>
      {#if session().user}
        <StoredUpload />
      {:else}
        <div class="signin">
          <button class="btn btn-primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
          <p class="hint">{t.offline.signIn}</p>
        </div>
      {/if}
    </section>
  </div>

  <HowItWorks variant="offline" />
  <ModeCompare />
  <FeatureStrip />
  <UseCases />
  <Faq />

  <footer>
    <nav class="legal">
      <a href={legalUrl("security", lang())}>{t.legal.security}</a>
      <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
      <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
      <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
    <span class="fineprint">{t.footer}</span>
  </footer>
</section>

<style>
  .offlinepage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: var(--space-3) 0 var(--space-5); }
  /* Mirrors CrossPage's page-header scale — smaller than the marketing hero. */
  .cn-head h1 { font-size: 34px; margin: 0 0 var(--space-2); letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: var(--fs-body); max-width: 44ch; margin: 0 auto; }
  .cn-head .pitch { color: var(--text); font-size: var(--fs-xs); max-width: 52ch; margin: var(--space-3) auto 0; line-height: 1.55; }

  .cards { max-width: 520px; margin: 0 auto; }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-5);
    background: var(--social-bg); display: flex; flex-direction: column; gap: var(--space-3);
  }
  .card h2 { font-size: var(--fs-h3); margin: 0; }
  .cardsub { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.5; }
  .mhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .mhead h2 { margin-right: auto; }
  .badge {
    flex: none; font-size: 11.5px; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    color: var(--text); background: var(--code-bg); border: 1px solid var(--border);
  }

  .signin { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }

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

- [ ] **Step 2: App.svelte 接线**

import 区(CrossPage import 旁)加:

```ts
  import OfflinePage from "./lib/OfflinePage.svelte";
```

渲染链(按内容定位 `currentRoute() === "me"` 分支)改为:

```svelte
  {#if currentRoute() === "cross"}
    <CrossPage {roomCode} {linkDead} {showTransfer} {transferSurface} dismissLan={() => (lanDismissed = true)} />
  {:else if currentRoute() === "offline"}
    <OfflinePage />
  {:else if currentRoute() === "me"}
    <MePage />
  {:else}
```

同时检查 `surfaceShown`(App.svelte 约 131-137 行的三元链):`currentRoute() === "cross" ? showTransfer : !unsupported` 会让 offline 路由沿用 `!unsupported` → 窗口级拖放在 offline 页仍然指向 LAN peers,不符合预期。改为:

```ts
  const surfaceShown = $derived(
    currentRoute() === "download" || currentRoute() === "offline" || currentRoute() === "me"
      ? false
      : currentRoute() === "cross"
        ? showTransfer
        : !unsupported,
  );
```

(顺带把 me 路由也归入 false——它此前同样走 `!unsupported`,属既有小瑕疵,一并修正。)

- [ ] **Step 3: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check && npm run build`
Expected: 全绿。手动 spot-check:`npm run dev` 打开 `/offline-transfer`,未登录见登录卡,三 tab 高亮正确。

```bash
git add web/src/lib/OfflinePage.svelte web/src/App.svelte
git commit -m "feat(web): /offline-transfer page — the only sign-in surface"
```

---

### Task 5: CrossPage 瘦身(零账号)+ CrossSell 组件双向引流 + ModeCompare 表头链接

**Files:**
- Create: `web/src/lib/CrossSell.svelte`
- Modify: `web/src/lib/CrossPage.svelte`
- Modify: `web/src/lib/OfflinePage.svelte`(插入 CrossSell)
- Modify: `web/src/lib/ModeCompare.svelte`

**Interfaces:**
- Consumes: `t.crossSell.*`(Task 2)、`navigate`/`OFFLINE_PATH`/`CROSS_PATH`(Task 1)。
- Produces: `<CrossSell target="realtime" | "offline" />`。

- [ ] **Step 1: 新建 CrossSell.svelte**

```svelte
<!-- web/src/lib/CrossSell.svelte -->
<script lang="ts">
  import { navigate, CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  // Directional cross-link between the two cross-network pages: target names the
  // page this card points TO (rendered on the other page).
  let { target }: { target: "realtime" | "offline" } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const copy = $derived(t.crossSell[target]);
  const route = $derived(target === "realtime" ? ("cross" as const) : ("offline" as const));
  const href = $derived(target === "realtime" ? CROSS_PATH : OFFLINE_PATH);
</script>

<aside class="xsell">
  <p>{copy.lead}</p>
  <a class="btn btn-ghost" {href} onclick={(e) => { e.preventDefault(); navigate(route); }}>{copy.cta}</a>
</aside>

<style>
  .xsell {
    margin: var(--space-5) auto 0; max-width: 640px;
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;
    padding: var(--space-4) var(--space-5); border-radius: var(--radius);
    border: 1px dashed var(--border); background: var(--surface-2);
  }
  .xsell p { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.55; flex: 1 1 300px; }
  .xsell .btn { white-space: nowrap; text-decoration: none; }
</style>
```

- [ ] **Step 2: CrossPage 瘦身**

删除:`Account`/`StoredUpload` import、`session` import、`loginOpen` state、`.acct` div、整个 stored 卡(`{t.methods.stored.name}` 那个 `<section class="card">`)、样式区 `.signin` 规则。

加:`import CrossSell from "./CrossSell.svelte";`

cards div 改为恒单卡:模板外层写死 `<div class="cards">`(删除 `class:single={showTransfer || inRoom}` 表达式);样式区删除两列 grid 定义与 `.cards.single` 选择器、760px 断点的单列覆写(恒单列后全部无用),`.cards` 直接用原 `.cards.single` 的规则:

```css
  .cards { display: grid; grid-template-columns: 1fr; gap: var(--space-4); max-width: 520px; margin: 0 auto; align-items: stretch; }
```

营销区块前插入引流卡(与营销区同受 `{#if !inRoom}` 门控):

```svelte
  {#if !inRoom}
    <CrossSell target="offline" />
    <HowItWorks variant="realtime" />
    <ModeCompare />
    <FeatureStrip />
    <UseCases />
    <Faq />
  {/if}
```

- [ ] **Step 3: OfflinePage 插入 CrossSell**

`<HowItWorks variant="offline" />` 上方插入:

```svelte
  <CrossSell target="realtime" />
```

并在 script 加 `import CrossSell from "./CrossSell.svelte";`

- [ ] **Step 4: ModeCompare 表头变链接**

script 区:

```ts
  import { navigate, CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
```

两个列头 span 改为可导航链接(样式继承列头,加下划线示意可点):

```svelte
      <a class="cell rt head-link" role="columnheader" href={CROSS_PATH}
         onclick={(e) => { e.preventDefault(); navigate("cross"); }}>{t.compare.colRealtime}</a>
      <a class="cell st head-link" role="columnheader" href={OFFLINE_PATH}
         onclick={(e) => { e.preventDefault(); navigate("offline"); }}>{t.compare.colStored}</a>
```

样式区追加:

```css
  .head-link { text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .head-link:hover { color: var(--accent); }
```

(移动端 `.row.header { display: none; }` 使窄屏无此链接——可接受,CrossSell 卡承担引流。)

- [ ] **Step 5: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check && npm run build`
Expected: 全绿。自查 grep:

```bash
grep -n "Account\|session(" web/src/lib/CrossPage.svelte   # 期望零匹配
```

```bash
git add web/src/lib/CrossSell.svelte web/src/lib/CrossPage.svelte web/src/lib/OfflinePage.svelte web/src/lib/ModeCompare.svelte
git commit -m "feat(web): account-free realtime page + directional cross-sell between the two pages"
```

---

### Task 6: 对外口径(llms.txt / README / SEO 源)

**Files:**
- Modify: `web/public/llms.txt`
- Modify: `README.md`
- Modify: `web/scripts/pages/content/**`(按 grep 结果)
- Regenerate: `cd web && npm run gen:pages`

**口径表(所有语言按此改写):** 站点三个页面——`/` 局域网(免登录)、`/cross-network` 实时直传(免登录,配对码/链接/二维码)、`/offline-transfer` 异步传输(发送方需登录,接收方永不需要)。"cross-network page" 单页双模式的旧表述改为两页表述。

- [ ] **Step 1: llms.txt**

- "Cross-network:" 行改为:`- **Cross-network:** two pages — realtime direct at /cross-network (pairing code / join link / QR, no account), and async stored transfer at /offline-transfer (sender signs in, recipients never need an account).`
- Transfer modes 小节里 stored 模式行补路径提及(`…created on the /offline-transfer page…`);其余"see Transfer modes"类引用核对一致。

- [ ] **Step 2: README**

功能清单与结构段落(grep `cross-network` 定位,约 3 处)按口径表改写;保持现有"realtime 免账号 / stored 需登录"事实句不变,只更新页面结构表述。

- [ ] **Step 3: SEO 内容源 grep + 定点改写**

```bash
grep -rn "cross-network page\|跨网络页\|ネットワーク間ページ" web/scripts/pages/content/
```

命中处把"the cross-network page offers a pairing code or a stored download link"类结构表述改为两页表述(每个内容文件六语言同步);事实句(免登录/需登录/加密)不变。预期命中 ≤3 个文件。

- [ ] **Step 4: 重新生成 + 验证 + 提交**

Run: `cd web && npm run gen:pages && npx vitest run`
Expected: 59 页重新生成,测试全绿;`grep -rn "offline-transfer" web/public/llms.txt` 有输出。

```bash
git add web/public README.md web/scripts/pages/content
git commit -m "docs: outward copy tells the three-page structure"
```

---

### Task 7: E2E 验证(无代码改动)

复用 2026-07-03 会话的 CDP 手法(见 memory headless-webrtc-e2e:headless Chrome 必须带 `--use-fake-ui-for-media-stream`;server 用显式 `-static` 指向 `web/dist`;`window.showSaveFilePicker = undefined` 让接收端走免手势保存)。

- [ ] **Step 1: 全量套件**

Run: `cd web && npx vitest run && npm run check && npm run build && cd ../server && go test ./...`
Expected: 全绿(server 零改动,跑一次确认无意外)。

- [ ] **Step 2: 浏览器流程走查**(build 后起 server,CDP 驱动)

1. 三 tab 互达:`/` ↔ `/cross-network` ↔ `/offline-transfer`,`aria-current` 高亮正确。
2. 实时页 DOM 无账号 UI:`document.querySelector('.acct')` 为 null,页面文本无 t.account.signIn。
3. 异步页未登录:显示登录按钮 + `t.offline.signIn` 提示,无 StoredUpload 上传控件。
4. 引流互达:实时页 CrossSell 点击落 `/offline-transfer`;异步页 CrossSell 点击落 `/cross-network`;首页双 CTA 各落对应页。
5. `#c=` 回归:tab A 实时页选文件 mint,tab B 开 `#c=<code>` → 自动收到确认卡 → 接受 → 传输完成(完整性 ok)。
6. 直接 URL 访问 `/offline-transfer`(SPA 深链,server spa.go 兜底)返回应用页而非 404。
7. 移动端宽度(设 viewport 390px)三 tab 不溢出。

- [ ] **Step 3: 通过后按 finishing-a-development-branch 处理分支。**
