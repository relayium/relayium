# Web UI Refresh + Legal Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the Relayium web app from a plain single column to a polished product page, and add crawlable Privacy + Terms pages in all 6 languages.

**Architecture:** Frontend-only changes under `web/`. The app stays a Svelte 5 SPA (no router, no SSR). Legal pages are **standalone static HTML documents** produced by a Node build script from plain-ESM content modules, written into `web/public/` so both `vite` (dev) and `vite build` (prod) serve them with zero JS. The app's new feature strip and footer links are wired through the existing `i18n.svelte.ts` runes system.

**Tech Stack:** Svelte 5 (runes), Vite 8, TypeScript, Vitest (jsdom), plain Node ESM for the legal generator.

## Global Constraints

- Node ESM only for scripts (`.mjs`); no new runtime/npm dependencies.
- All 6 languages, in this canonical order: `en, zh, ja, ko, de, fr`. Default/canonical language is `en`.
- Site origin is `https://relayium.com` (no trailing slash in canonical URLs).
- Contact email everywhere: `support@relayium.com`.
- Legal pages: **no "draft" wording visible to visitors**; show only `Last updated: 2026-06-29`. The "engineer-drafted, not lawyer-reviewed" caveat lives only in this repo's docs/comments.
- Legal page URLs: en at `/privacy` and `/terms`; other languages prefixed, e.g. `/zh/privacy`, `/ja/terms`.
- **No governing-law / jurisdiction clause** in Terms.
- Preserve every existing app behavior (LAN discovery, send/recv, SAS, hash transfer-token, busy gating, save picker, title progress, language switch, dark mode, unsupported-browser banner).
- Verification commands run from `web/`: `npm run check`, `npm test -- --run`, `npm run build`.

---

## File Structure

**New (legal generator + content):**
- `web/scripts/legal/shared.mjs` — langs, site constants, path/URL helpers, HTML escape.
- `web/scripts/legal/template.mjs` — `renderLegalPage()` → full HTML string (self-contained inline styles + dark mode).
- `web/scripts/legal/content/privacy.mjs` — Privacy doc, all 6 langs.
- `web/scripts/legal/content/terms.mjs` — Terms doc, all 6 langs.
- `web/scripts/legal/build-pages.mjs` — pure `buildAllPages()` → `[{path, html}]` + `buildSitemap()`.
- `web/scripts/legal/build-pages.test.mjs` — tests for the pure builders.
- `web/scripts/legal/content/content.test.mjs` — content completeness tests.
- `web/scripts/gen-legal.mjs` — disk-writing orchestrator (calls build-pages, writes to `public/`).

**Generated, committed (by `gen-legal.mjs`):**
- `web/public/privacy/index.html`, `web/public/terms/index.html`
- `web/public/{zh,ja,ko,de,fr}/{privacy,terms}/index.html`
- `web/public/sitemap.xml` (regenerated to include the new URLs)

**Modified (app):**
- `web/package.json` — add `gen:legal` script; prefix `dev`/`build` with it.
- `web/src/app.css` — remove dead Vite-template CSS; extend tokens.
- `web/src/lib/i18n.svelte.ts` — add `features` + `legal` keys (interface + 6 langs) + `legalUrl()` helper.
- `web/src/App.svelte` — use new components, device grid, transfer-card polish, footer legal links.

**New (app components):**
- `web/src/lib/Hero.svelte`
- `web/src/lib/FeatureStrip.svelte`

---

## Task 1: Legal generator foundation (shared + template)

**Files:**
- Create: `web/scripts/legal/shared.mjs`
- Create: `web/scripts/legal/template.mjs`

**Interfaces:**
- Produces:
  - `LANGS = ['en','zh','ja','ko','de','fr']`, `DEFAULT_LANG = 'en'`
  - `LANG_LABELS = { en:'English', zh:'中文', ja:'日本語', ko:'한국어', de:'Deutsch', fr:'Français' }`
  - `BCP47 = { en:'en', zh:'zh-Hans', ja:'ja', ko:'ko', de:'de', fr:'fr' }`
  - `SITE = { origin:'https://relayium.com', name:'Relayium' }`
  - `pagePath(slug, lang) -> string` — `en` → `'${slug}/index.html'`; else `'${lang}/${slug}/index.html'`
  - `urlPath(slug, lang) -> string` — `en` → `'/${slug}'`; else `'/${lang}/${slug}'`
  - `absUrl(path) -> string` — `SITE.origin + path`
  - `esc(s) -> string` — escapes `& < > " '`
  - `renderLegalPage({ slug, lang, doc }) -> string` — `doc` is one language's `LangDoc` (see Task 2 shape). Renders full HTML.

- [ ] **Step 1: Write the failing test**

Create `web/scripts/legal/template.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { renderLegalPage } from "./template.mjs";
import { urlPath, absUrl } from "./shared.mjs";

const doc = {
  title: "Privacy Policy",
  description: "How Relayium handles data.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
  lead: ["Relayium is privacy-first."],
  sections: [{ heading: "What we never collect", body: ["No file contents."], bullets: ["File names", "Keys"] }],
};

describe("renderLegalPage", () => {
  const html = renderLegalPage({ slug: "privacy", lang: "en", doc });

  it("sets the document title and meta description", () => {
    expect(html).toContain("<title>Privacy Policy · Relayium</title>");
    expect(html).toContain('name="description" content="How Relayium handles data."');
  });

  it("uses the BCP-47 html lang for the language", () => {
    const zh = renderLegalPage({ slug: "privacy", lang: "zh", doc });
    expect(zh).toContain('<html lang="zh-Hans">');
  });

  it("emits a self-referencing canonical and an x-default alternate", () => {
    expect(html).toContain(`<link rel="canonical" href="${absUrl(urlPath("privacy", "en"))}" />`);
    expect(html).toContain(`hreflang="x-default" href="${absUrl(urlPath("privacy", "en"))}"`);
  });

  it("emits an hreflang alternate for every language", () => {
    for (const [lang, code] of [["zh","zh-Hans"],["ja","ja"],["ko","ko"],["de","de"],["fr","fr"]]) {
      expect(html).toContain(`hreflang="${code}" href="${absUrl(urlPath("privacy", lang))}"`);
    }
  });

  it("renders headings, paragraphs, bullets and the last-updated line", () => {
    expect(html).toContain("<h1>Privacy Policy</h1>");
    expect(html).toContain("Last updated: 2026-06-29");
    expect(html).toContain("<h2>What we never collect</h2>");
    expect(html).toContain("<li>File names</li>");
  });

  it("escapes user-visible text", () => {
    const evil = renderLegalPage({ slug: "privacy", lang: "en", doc: { ...doc, title: "A & B <x>" } });
    expect(evil).toContain("<title>A &amp; B &lt;x&gt; · Relayium</title>");
  });

  it("contains no 'draft' wording", () => {
    expect(html.toLowerCase()).not.toContain("draft");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- --run scripts/legal/template.test.mjs`
Expected: FAIL — cannot resolve `./template.mjs` / `./shared.mjs`.

- [ ] **Step 3: Implement `shared.mjs`**

```js
// web/scripts/legal/shared.mjs — constants + pure path/url/escape helpers.
export const LANGS = ["en", "zh", "ja", "ko", "de", "fr"];
export const DEFAULT_LANG = "en";

export const LANG_LABELS = {
  en: "English", zh: "中文", ja: "日本語", ko: "한국어", de: "Deutsch", fr: "Français",
};
export const BCP47 = { en: "en", zh: "zh-Hans", ja: "ja", ko: "ko", de: "de", fr: "fr" };

export const SITE = { origin: "https://relayium.com", name: "Relayium" };

export function pagePath(slug, lang) {
  return lang === DEFAULT_LANG ? `${slug}/index.html` : `${lang}/${slug}/index.html`;
}
export function urlPath(slug, lang) {
  return lang === DEFAULT_LANG ? `/${slug}` : `/${lang}/${slug}`;
}
export function absUrl(path) {
  return SITE.origin + path;
}
export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
```

- [ ] **Step 4: Implement `template.mjs`**

```js
// web/scripts/legal/template.mjs — renders one legal document (one language) to a
// self-contained static HTML string. No JS, no external CSS: styles are inlined so
// the page is independent of the Vite asset graph and crawlable with JS disabled.
import { LANGS, DEFAULT_LANG, LANG_LABELS, BCP47, SITE, urlPath, absUrl, esc } from "./shared.mjs";

const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:0 20px 64px}
header{display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border)}
header .logo{width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;color:#fff;background:linear-gradient(135deg,var(--accent),#6d28d9)}
header a{color:var(--text-h);text-decoration:none;font-weight:600}
h1{color:var(--text-h);font-size:34px;letter-spacing:-.5px;margin:36px 0 6px}
h2{color:var(--text-h);font-size:21px;margin:34px 0 10px}
.updated{color:var(--text);font-size:14px;margin:0 0 8px}
p{margin:12px 0}ul{margin:12px 0;padding-left:22px}li{margin:6px 0}
.langbar{display:flex;flex-wrap:wrap;gap:6px 14px;margin:24px 0 8px;font-size:14px}
.langbar a{color:var(--accent);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
`;

function langBar(slug, lang) {
  const links = LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${urlPath(slug, l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

function alternates(slug) {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

function sectionHtml(s) {
  let out = `<h2>${esc(s.heading)}</h2>`;
  for (const p of s.body || []) out += `<p>${esc(p)}</p>`;
  if (s.bullets?.length) out += `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  return out;
}

export function renderLegalPage({ slug, lang, doc }) {
  const otherSlug = slug === "privacy" ? "terms" : "privacy";
  const canonical = absUrl(urlPath(slug, lang));
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${doc.title} · ${SITE.name}`,
    description: doc.description,
    url: canonical,
    inLanguage: BCP47[lang],
    dateModified: doc.updated,
    isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.origin + "/" },
  };
  return `<!doctype html>
<html lang="${BCP47[lang]}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(doc.title)} · ${SITE.name}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />
    ${alternates(slug)}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <script type="application/ld+json">${JSON.stringify(ld)}</script>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo">⇌</span><a href="/">Relayium</a></header>
      <h1>${esc(doc.title)}</h1>
      <p class="updated">${esc(doc.updatedLabel)}: ${esc(doc.updated)}</p>
      ${langBar(slug, lang)}
      ${(doc.lead || []).map((p) => `<p>${esc(p)}</p>`).join("\n      ")}
      ${doc.sections.map(sectionHtml).join("\n      ")}
      <footer>
        <a href="/">← ${esc(SITE.name)}</a>
        <a href="${urlPath(otherSlug, lang)}">${esc(doc.otherDocLabel)}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npm test -- --run scripts/legal/template.test.mjs`
Expected: PASS (7 assertions). Note: the test `doc` needs an `otherDocLabel`; add `otherDocLabel: "Terms of Service"` to the test fixture `doc` if the footer assertion is added — it is referenced by the template. Update the fixture now: add `otherDocLabel: "Terms of Service"` and `updated: "2026-06-29"` (already present).

- [ ] **Step 6: Commit**

```bash
cd web && git add scripts/legal/shared.mjs scripts/legal/template.mjs scripts/legal/template.test.mjs
git commit -m "feat(web): legal-page template + shared helpers"
```

---

## Task 2: Legal content — Privacy & Terms (EN + ZH authored, structure for all 6)

**Files:**
- Create: `web/scripts/legal/content/privacy.mjs`
- Create: `web/scripts/legal/content/terms.mjs`
- Create: `web/scripts/legal/content/content.test.mjs`

**Interfaces:**
- Produces: each module `export default { slug, langs }` where `langs[lang]` is a `LangDoc`:
  ```
  LangDoc = {
    title: string, description: string,
    updatedLabel: string, updated: "2026-06-29",
    otherDocLabel: string,            // label linking to the sibling doc
    lead: string[],                    // intro paragraphs (no heading)
    sections: { heading: string, body?: string[], bullets?: string[] }[],
  }
  ```
- `langs` must contain all 6 keys: `en, zh, ja, ko, de, fr`.

**Authoring note (for the maintainer, not shown to users):** This copy is engineer-drafted and **not lawyer-reviewed**. The English text is the source of truth; review before relying on it in production.

- [ ] **Step 1: Write the failing completeness test**

Create `web/scripts/legal/content/content.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import privacy from "./privacy.mjs";
import terms from "./terms.mjs";
import { LANGS } from "../shared.mjs";

const docs = { privacy, terms };
const REQUIRED = ["title", "description", "updatedLabel", "updated", "otherDocLabel", "lead", "sections"];

describe("legal content", () => {
  for (const [name, doc] of Object.entries(docs)) {
    it(`${name} declares its slug`, () => expect(doc.slug).toBe(name));

    it(`${name} has all 6 languages`, () => {
      expect(Object.keys(doc.langs).sort()).toEqual([...LANGS].sort());
    });

    for (const lang of LANGS) {
      it(`${name}.${lang} has every required field`, () => {
        const d = doc.langs[lang];
        for (const k of REQUIRED) expect(d, `${name}.${lang}.${k}`).toHaveProperty(k);
        expect(d.updated).toBe("2026-06-29");
        expect(d.lead.length).toBeGreaterThan(0);
        expect(d.sections.length).toBeGreaterThan(0);
        for (const s of d.sections) expect(typeof s.heading).toBe("string");
      });
    }

    it(`${name} has the same section count across languages`, () => {
      const counts = LANGS.map((l) => doc.langs[l].sections.length);
      expect(new Set(counts).size).toBe(1);
    });

    it(`${name} contains no 'draft' wording`, () => {
      const blob = JSON.stringify(doc).toLowerCase();
      expect(blob).not.toContain("draft");
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- --run scripts/legal/content/content.test.mjs`
Expected: FAIL — cannot resolve `./privacy.mjs`.

- [ ] **Step 3: Write `privacy.mjs` — EN + ZH authored in full; ja/ko/de/fr added in Task 3**

Author the EN and ZH `LangDoc`s now (the four remaining languages are translated in Task 3 so the test stays red until then — that is expected and called out in Task 3). Use exactly this EN text (source of truth):

```js
// web/scripts/legal/content/privacy.mjs
const en = {
  title: "Privacy Policy",
  description:
    "How Relayium handles your data: files transfer peer-to-peer and never touch our servers. Accounts are optional and store only an email and display name.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
  otherDocLabel: "Terms of Service",
  lead: [
    "Relayium is built so that your files stay yours. File transfers happen directly between two devices, end-to-end encrypted, and never pass through our servers.",
    "This page explains the little data the service does handle, and the data it deliberately never sees.",
  ],
  sections: [
    {
      heading: "Local-network transfers collect nothing",
      body: [
        "When you transfer files between devices on the same network, no account is needed and the service stores nothing about you. The signaling server only helps the two devices find each other; the file bytes flow device-to-device over an encrypted WebRTC channel.",
      ],
    },
    {
      heading: "What an account stores (only if you sign in)",
      body: [
        "Signing in is optional and only unlocks cross-network transfers. If you sign in, we store the minimum needed to run an account:",
      ],
      bullets: [
        "Your email address and a display name.",
        "Which sign-in method you used (Google, or an email magic link). Magic-link tokens are stored only as a hash, never in clear text.",
        "A login session, kept in a secure, httpOnly cookie.",
        "Devices you register, as a random device id and a device name (e.g. your platform name).",
      ],
    },
    {
      heading: "What we never collect",
      body: ["The service is designed so that the following never reach our servers:"],
      bullets: [
        "The contents of your files.",
        "The names of your files.",
        "Your encryption keys.",
      ],
    },
    {
      heading: "Cross-network relay (TURN)",
      body: [
        "When two devices cannot connect directly across networks, the encrypted stream is relayed through a TURN server. The relay still cannot read your files — they remain end-to-end encrypted. For operating the service we record only the number of relayed bytes for a transfer, attributed to the signed-in user who created it. We never inspect relayed content.",
      ],
    },
    {
      heading: "Cookies and local storage",
      body: [
        "We use one session cookie to keep you signed in. In your browser's local storage we keep a random device id so a device you registered can be recognized. We do not use advertising or tracking cookies.",
      ],
    },
    {
      heading: "Third-party services",
      body: ["A couple of third parties are involved only when you choose to use them:"],
      bullets: [
        "Google, if you sign in with Google — we receive your email and basic profile to create the account.",
        "An email delivery provider, to send magic-link sign-in emails.",
      ],
    },
    {
      heading: "Data retention and deletion",
      body: [
        "Account data is kept while your account exists. You can ask us to delete your account and its data at any time by contacting us at support@relayium.com.",
      ],
    },
    {
      heading: "Changes to this policy",
      body: [
        "We may update this policy as the service evolves. When we do, we will change the \"Last updated\" date above.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about privacy? Email support@relayium.com."],
    },
  ],
};

const zh = {
  title: "隐私政策",
  description:
    "Relayium 如何处理你的数据:文件点对点传输,绝不经过我们的服务器。账号是可选的,仅存储邮箱与显示名。",
  updatedLabel: "最后更新",
  updated: "2026-06-29",
  otherDocLabel: "服务条款",
  lead: [
    "Relayium 的设计宗旨是让你的文件始终属于你。文件传输在两台设备之间直接进行,端到端加密,绝不经过我们的服务器。",
    "本页说明本服务确实会处理的少量数据,以及它刻意从不接触的数据。",
  ],
  sections: [
    {
      heading: "局域网传输不收集任何数据",
      body: [
        "在同一网络下的设备之间传输文件时,无需账号,服务也不会存储任何关于你的信息。信令服务器只帮助两台设备相互发现;文件字节通过加密的 WebRTC 通道在设备之间直接流动。",
      ],
    },
    {
      heading: "账号会存储什么(仅在你登录时)",
      body: ["登录是可选的,仅用于解锁跨网络传输。如果你登录,我们只存储运行账号所必需的最少信息:"],
      bullets: [
        "你的邮箱地址和一个显示名。",
        "你使用的登录方式(Google,或邮箱魔法链接)。魔法链接令牌只以哈希形式存储,绝不明文保存。",
        "登录会话,保存在安全的 httpOnly cookie 中。",
        "你注册的设备,以一个随机设备 id 和设备名(例如你的平台名称)的形式。",
      ],
    },
    {
      heading: "我们绝不收集什么",
      body: ["本服务的设计确保以下内容绝不会到达我们的服务器:"],
      bullets: ["你的文件内容。", "你的文件名。", "你的加密密钥。"],
    },
    {
      heading: "跨网络中继(TURN)",
      body: [
        "当两台设备无法跨网络直接连接时,加密流会通过 TURN 服务器中继。中继依然无法读取你的文件——它们始终保持端到端加密。出于运营目的,我们仅记录某次传输中继的字节数,并归属到创建该传输的登录用户。我们绝不检查中继内容。",
      ],
    },
    {
      heading: "Cookie 与本地存储",
      body: [
        "我们使用一个会话 cookie 来保持你的登录状态。在你浏览器的本地存储中,我们保存一个随机设备 id,以便识别你注册过的设备。我们不使用广告或追踪 cookie。",
      ],
    },
    {
      heading: "第三方服务",
      body: ["只有在你选择使用时,才会涉及少数第三方:"],
      bullets: [
        "Google——如果你用 Google 登录,我们会获取你的邮箱和基本资料以创建账号。",
        "邮件发送服务商——用于发送魔法链接登录邮件。",
      ],
    },
    {
      heading: "数据保留与删除",
      body: [
        "账号数据在你的账号存在期间保留。你可以随时通过 support@relayium.com 联系我们,要求删除你的账号及其数据。",
      ],
    },
    {
      heading: "本政策的变更",
      body: ["随着服务演进,我们可能会更新本政策。届时我们会更新上方的「最后更新」日期。"],
    },
    {
      heading: "联系我们",
      body: ["有隐私方面的疑问?请发邮件至 support@relayium.com。"],
    },
  ],
};

export default { slug: "privacy", langs: { en, zh, ja: en, ko: en, de: en, fr: en } };
```

> Note: `ja/ko/de/fr` are temporarily aliased to `en` so the module loads; Task 3 replaces each with a real translation and the `content.test.mjs` "same section count" + per-lang checks still pass (count is equal), but Task 3's added check enforces they are actually translated.

- [ ] **Step 4: Write `terms.mjs` — EN + ZH authored in full (same shape)**

Use exactly this EN text (source of truth); author the parallel ZH; alias `ja/ko/de/fr` to `en` for now:

```js
// web/scripts/legal/content/terms.mjs
const en = {
  title: "Terms of Service",
  description:
    "The terms for using Relayium — a free, open-source, end-to-end encrypted peer-to-peer file transfer service provided as is.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
  otherDocLabel: "Privacy Policy",
  lead: [
    "By using Relayium you agree to these terms. Relayium is a free and open-source service that lets you send files directly between devices, end-to-end encrypted.",
  ],
  sections: [
    {
      heading: "The service",
      body: [
        "Relayium transfers files peer-to-peer between devices. It is provided free of charge and its source code is open source under the MIT license.",
      ],
    },
    {
      heading: "Acceptable use",
      body: ["You agree not to use Relayium to:"],
      bullets: [
        "Break the law or infringe others' rights, including sending content you have no right to share.",
        "Distribute malware, or attempt to disrupt, overload, or abuse the service or its infrastructure.",
        "Circumvent security measures or attempt to access data that is not yours.",
      ],
    },
    {
      heading: "Accounts",
      body: [
        "An account is optional and only needed for cross-network transfers. You are responsible for keeping access to your email and account secure. You may delete your account at any time.",
      ],
    },
    {
      heading: "No warranty",
      body: [
        "The service is provided \"as is\" and \"as available\", without warranties of any kind, express or implied. We do not guarantee that transfers will always succeed or that the service will be uninterrupted or error-free.",
      ],
    },
    {
      heading: "Limitation of liability",
      body: [
        "To the maximum extent permitted by law, Relayium and its contributors are not liable for any indirect, incidental, or consequential damages, or for any loss of data, arising from your use of the service.",
      ],
    },
    {
      heading: "Open source and licenses",
      body: [
        "Relayium's source code is available under the MIT license. Your use of the source code is governed by that license.",
      ],
    },
    {
      heading: "Changes to these terms",
      body: [
        "We may update these terms as the service evolves. When we do, we will change the \"Last updated\" date above. Continued use after a change means you accept the updated terms.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about these terms? Email support@relayium.com."],
    },
  ],
};

const zh = {
  title: "服务条款",
  description: "使用 Relayium 的条款——一项免费、开源、端到端加密的点对点文件传输服务,按现状提供。",
  updatedLabel: "最后更新",
  updated: "2026-06-29",
  otherDocLabel: "隐私政策",
  lead: [
    "使用 Relayium 即表示你同意本条款。Relayium 是一项免费且开源的服务,让你在设备之间直接、端到端加密地发送文件。",
  ],
  sections: [
    {
      heading: "服务说明",
      body: ["Relayium 在设备之间点对点传输文件。本服务免费提供,其源代码以 MIT 许可证开源。"],
    },
    {
      heading: "可接受的使用",
      body: ["你同意不将 Relayium 用于:"],
      bullets: [
        "违反法律或侵犯他人权利,包括发送你无权分享的内容。",
        "传播恶意软件,或试图扰乱、过载或滥用本服务及其基础设施。",
        "规避安全措施,或试图访问不属于你的数据。",
      ],
    },
    {
      heading: "账号",
      body: [
        "账号是可选的,仅跨网络传输时需要。你有责任妥善保管你的邮箱和账号访问权限。你可以随时删除你的账号。",
      ],
    },
    {
      heading: "不提供担保",
      body: [
        "本服务按「现状」和「可用情况」提供,不附带任何明示或默示的担保。我们不保证传输总能成功,也不保证服务不中断或无错误。",
      ],
    },
    {
      heading: "责任限制",
      body: [
        "在法律允许的最大范围内,对于因你使用本服务而产生的任何间接、附带或后果性损害,或任何数据丢失,Relayium 及其贡献者概不负责。",
      ],
    },
    {
      heading: "开源与许可",
      body: ["Relayium 的源代码以 MIT 许可证提供。你对源代码的使用受该许可证约束。"],
    },
    {
      heading: "本条款的变更",
      body: [
        "随着服务演进,我们可能会更新本条款。届时我们会更新上方的「最后更新」日期。变更后继续使用即表示你接受更新后的条款。",
      ],
    },
    {
      heading: "联系我们",
      body: ["有关于条款的疑问?请发邮件至 support@relayium.com。"],
    },
  ],
};

export default { slug: "terms", langs: { en, zh, ja: en, ko: en, de: en, fr: en } };
```

- [ ] **Step 5: Run the completeness test (expect PASS)**

Run: `cd web && npm test -- --run scripts/legal/content/content.test.mjs`
Expected: PASS. (Section counts are equal across languages because the four placeholder languages alias `en`.)

- [ ] **Step 6: Commit**

```bash
cd web && git add scripts/legal/content/privacy.mjs scripts/legal/content/terms.mjs scripts/legal/content/content.test.mjs
git commit -m "feat(web): privacy + terms content (en, zh) with 6-lang structure"
```

---

## Task 3: Translate Privacy & Terms into ja, ko, de, fr

**Files:**
- Modify: `web/scripts/legal/content/privacy.mjs` (replace `ja/ko/de/fr` aliases with real `LangDoc`s)
- Modify: `web/scripts/legal/content/terms.mjs` (same)
- Modify: `web/scripts/legal/content/content.test.mjs` (add anti-alias assertion)

**Interfaces:**
- Consumes: the EN `LangDoc`s from Task 2 (the translation source of truth).
- Produces: `langs.ja`, `langs.ko`, `langs.de`, `langs.fr` as faithful, complete translations — same number of `sections`, same `bullets` count per section, same meaning. Keep `updated: "2026-06-29"`, `support@relayium.com`, and product terms (Relayium, WebRTC, TURN, MIT, Google) intact.

- [ ] **Step 1: Strengthen the test to forbid placeholder aliasing**

Add to `content.test.mjs` inside the `for (const [name, doc] ...)` loop:

```js
    it(`${name} translations are not identical to English`, () => {
      for (const lang of ["ja", "ko", "de", "fr"]) {
        expect(doc.langs[lang].title, `${name}.${lang}.title`).not.toBe(doc.langs.en.title);
        expect(doc.langs[lang].sections[0].heading).not.toBe(doc.langs.en.sections[0].heading);
      }
    });

    it(`${name} keeps bullets count per section across languages`, () => {
      for (let i = 0; i < doc.langs.en.sections.length; i++) {
        const en = (doc.langs.en.sections[i].bullets || []).length;
        for (const lang of LANGS) {
          expect((doc.langs[lang].sections[i].bullets || []).length, `${name}.${lang}.s${i}`).toBe(en);
        }
      }
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- --run scripts/legal/content/content.test.mjs`
Expected: FAIL — `ja/ko/de/fr` still alias `en`, so titles/headings are identical.

- [ ] **Step 3: Write the translations**

In `privacy.mjs` and `terms.mjs`, define `const ja = {...}`, `const ko = {...}`, `const de = {...}`, `const fr = {...}` as complete translations of the corresponding EN `LangDoc`, mirroring its exact structure (same `sections` order, same `bullets` per section, `lead` paragraph count). Then change the export to:

```js
export default { slug: "privacy", langs: { en, zh, ja, ko, de, fr } };
```
(and the analogous line in `terms.mjs`). Do not leave any language aliased to another. Translate faithfully; keep emails, license names, and protocol terms verbatim.

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- --run scripts/legal/content/content.test.mjs`
Expected: PASS (all languages distinct, structure preserved).

- [ ] **Step 5: Commit**

```bash
cd web && git add scripts/legal/content/privacy.mjs scripts/legal/content/terms.mjs scripts/legal/content/content.test.mjs
git commit -m "feat(web): translate privacy + terms into ja, ko, de, fr"
```

---

## Task 4: Page + sitemap builders, generator script, build wiring

**Files:**
- Create: `web/scripts/legal/build-pages.mjs`
- Create: `web/scripts/legal/build-pages.test.mjs`
- Create: `web/scripts/gen-legal.mjs`
- Modify: `web/package.json`
- Replace (generated): `web/public/sitemap.xml` + create the 12 HTML files.

**Interfaces:**
- Consumes: `renderLegalPage` (Task 1), `privacy`/`terms` docs (Task 2–3), `shared.mjs` helpers.
- Produces:
  - `buildAllPages(docs) -> { path: string, html: string }[]` — `path` is repo-relative under `public/`, one entry per (doc × lang) = 12.
  - `buildSitemap(docs, { home: true }) -> string` — XML including `/` plus every legal URL.

- [ ] **Step 1: Write the failing test**

Create `web/scripts/legal/build-pages.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import privacy from "./content/privacy.mjs";
import terms from "./content/terms.mjs";
import { buildAllPages, buildSitemap } from "./build-pages.mjs";

const docs = [privacy, terms];

describe("buildAllPages", () => {
  const pages = buildAllPages(docs);

  it("produces 12 pages (2 docs × 6 langs)", () => {
    expect(pages.length).toBe(12);
  });

  it("uses pretty paths with en unprefixed and others lang-prefixed", () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("privacy/index.html");
    expect(paths).toContain("terms/index.html");
    expect(paths).toContain("zh/privacy/index.html");
    expect(paths).toContain("fr/terms/index.html");
  });

  it("renders localized titles into the HTML", () => {
    const zhPrivacy = pages.find((p) => p.path === "zh/privacy/index.html");
    expect(zhPrivacy.html).toContain("<h1>隐私政策</h1>");
  });
});

describe("buildSitemap", () => {
  const xml = buildSitemap(docs, { home: true });

  it("includes the homepage and all 12 legal URLs", () => {
    expect(xml).toContain("<loc>https://relayium.com/</loc>");
    expect(xml).toContain("<loc>https://relayium.com/privacy</loc>");
    expect(xml).toContain("<loc>https://relayium.com/zh/terms</loc>");
    expect((xml.match(/<loc>/g) || []).length).toBe(13);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- --run scripts/legal/build-pages.test.mjs`
Expected: FAIL — cannot resolve `./build-pages.mjs`.

- [ ] **Step 3: Implement `build-pages.mjs`**

```js
// web/scripts/legal/build-pages.mjs — pure builders (no disk IO).
import { LANGS, SITE, pagePath, urlPath, absUrl } from "./shared.mjs";
import { renderLegalPage } from "./template.mjs";

export function buildAllPages(docs) {
  const out = [];
  for (const doc of docs) {
    for (const lang of LANGS) {
      out.push({
        path: pagePath(doc.slug, lang),
        html: renderLegalPage({ slug: doc.slug, lang, doc: doc.langs[lang] }),
      });
    }
  }
  return out;
}

export function buildSitemap(docs, { home = true } = {}) {
  const lastmod = "2026-06-29";
  const urls = [];
  if (home) urls.push({ loc: SITE.origin + "/", priority: "1.0", changefreq: "weekly" });
  for (const doc of docs) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(doc.slug, lang)), priority: "0.3", changefreq: "yearly" });
    }
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- --run scripts/legal/build-pages.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement the disk-writing generator `gen-legal.mjs`**

```js
// web/scripts/gen-legal.mjs — writes the legal pages + sitemap into public/.
// Run via `npm run gen:legal`; also runs automatically before dev/build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import privacy from "./legal/content/privacy.mjs";
import terms from "./legal/content/terms.mjs";
import { buildAllPages, buildSitemap } from "./legal/build-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const docs = [privacy, terms];

async function main() {
  const pages = buildAllPages(docs);
  for (const page of pages) {
    const abs = join(publicDir, page.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, page.html, "utf8");
  }
  await writeFile(join(publicDir, "sitemap.xml"), buildSitemap(docs, { home: true }), "utf8");
  console.log(`gen-legal: wrote ${pages.length} pages + sitemap.xml to public/`);
}

main().catch((err) => {
  console.error("gen-legal failed:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Wire npm scripts**

In `web/package.json`, change the `dev` and `build` scripts and add `gen:legal`:

```json
    "dev": "node scripts/gen-legal.mjs && vite",
    "build": "node scripts/gen-legal.mjs && vite build",
    "gen:legal": "node scripts/gen-legal.mjs",
```

- [ ] **Step 7: Generate the files and verify output**

Run: `cd web && npm run gen:legal`
Expected stdout: `gen-legal: wrote 12 pages + sitemap.xml to public/`

Run: `cd web && ls public/privacy/index.html public/zh/privacy/index.html public/fr/terms/index.html public/sitemap.xml`
Expected: all four paths exist.

Run: `grep -c "<loc>" public/sitemap.xml`
Expected: `13`.

- [ ] **Step 8: Commit (including generated output)**

```bash
cd web && git add scripts/legal/build-pages.mjs scripts/legal/build-pages.test.mjs scripts/gen-legal.mjs package.json public/privacy public/terms public/zh public/ja public/ko public/de public/fr public/sitemap.xml
git commit -m "feat(web): generate 12 legal pages + sitemap into public/"
```

---

## Task 5: app.css cleanup + design tokens

**Files:**
- Modify: `web/src/app.css`

**Interfaces:**
- Produces: an extended `:root` token set consumed by `App.svelte`, `Hero.svelte`, `FeatureStrip.svelte`. New tokens (light + dark):
  - `--radius: 14px`, `--radius-sm: 9px`
  - `--space: 16px`
  - `--surface` (raised card bg), `--surface-2` (subtler) — light/dark values
  - keep existing `--text, --text-h, --bg, --border, --code-bg, --accent, --accent-bg, --accent-border, --social-bg, --shadow`.

- [ ] **Step 1: Remove dead Vite-template CSS**

In `web/src/app.css`, delete these unused rule blocks (no markup references them after Task 9): `.hero` (and `.base/.framework/.vite`), `#center`, `#next-steps`, `#docs`, `#spacer`, `.ticks`, `.counter`, and the `#social .button-icon` rule inside the dark block. Keep: `:root` tokens, `@media dark` tokens, `body`, `h1`, `h2`, `p`, `code`, and `#app`.

- [ ] **Step 2: Simplify `#app` to a plain flex column**

Replace the `#app` block with:

```css
#app {
  width: 100%;
  margin: 0 auto;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
```

- [ ] **Step 3: Add new tokens to `:root` and the dark block**

Append inside `:root { ... }` (before the closing brace, after `--shadow`):

```css
  --surface: #ffffff;
  --surface-2: #faf9f6;
  --radius: 14px;
  --radius-sm: 9px;
  --space: 16px;
```

Append inside `@media (prefers-color-scheme: dark) :root { ... }`:

```css
    --surface: #1c1d25;
    --surface-2: #1a1b22;
```

- [ ] **Step 4: Verify type-check and build still pass**

Run: `cd web && npm run check`
Expected: no errors.

Run: `cd web && npm run build`
Expected: build succeeds (the dead-CSS removal does not break anything; `App.svelte` still uses scoped styles).

- [ ] **Step 5: Commit**

```bash
cd web && git add src/app.css
git commit -m "refactor(web): drop dead Vite-template CSS, add surface/radius tokens"
```

---

## Task 6: i18n keys for features + footer legal links

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`

**Interfaces:**
- Produces (added to the `Messages` interface and to all 6 language objects):
  ```ts
  features: { items: { title: string; desc: string }[] };   // exactly 4 items
  legal: { privacy: string; terms: string };
  ```
- Produces exported helper:
  ```ts
  export function legalUrl(slug: "privacy" | "terms", l: Lang): string
  // en -> `/privacy`; others -> `/zh/privacy` etc.
  ```

- [ ] **Step 1: Extend the `Messages` interface**

In `web/src/lib/i18n.svelte.ts`, inside `interface Messages { ... }` (e.g. after `crossnet`), add:

```ts
  features: { items: { title: string; desc: string }[] };
  legal: { privacy: string; terms: string };
```

- [ ] **Step 2: Add the `legalUrl` helper**

After the `LANGS` declaration (top of file), add:

```ts
export function legalUrl(slug: "privacy" | "terms", l: Lang): string {
  return l === "en" ? `/${slug}` : `/${l}/${slug}`;
}
```

- [ ] **Step 3: Add `features` + `legal` to every language object**

Add the following block inside each language object (`zh, en, ja, ko, de, fr`), e.g. right after its `crossnet: { ... }` block. Use the matching language's values:

`zh`:
```ts
  features: {
    items: [
      { title: "端到端加密", desc: "X25519 + AES-256-GCM,密钥只在两台设备间,服务器无法解密。" },
      { title: "文件不经服务器", desc: "文件通过 WebRTC 在设备间直接流动,绝不上传到任何服务器。" },
      { title: "防中间人", desc: "两边屏幕显示同一段校验码(SAS),核对一致即可排除中间人。" },
      { title: "跨平台", desc: "Windows、macOS、Linux、Android、iOS,任意现代浏览器都能用。" },
    ],
  },
  legal: { privacy: "隐私政策", terms: "服务条款" },
```

`en`:
```ts
  features: {
    items: [
      { title: "End-to-end encrypted", desc: "X25519 + AES-256-GCM; keys stay on the two devices and the server can't decrypt." },
      { title: "Files never touch the server", desc: "Bytes flow device-to-device over WebRTC and are never uploaded anywhere." },
      { title: "Man-in-the-middle check", desc: "Both screens show the same code (SAS); match it to rule out a MITM." },
      { title: "Cross-platform", desc: "Windows, macOS, Linux, Android, iOS — any modern browser." },
    ],
  },
  legal: { privacy: "Privacy Policy", terms: "Terms of Service" },
```

`ja`:
```ts
  features: {
    items: [
      { title: "エンドツーエンド暗号化", desc: "X25519 + AES-256-GCM。鍵は2台の端末だけに留まり、サーバーは復号できません。" },
      { title: "ファイルはサーバーを経由しない", desc: "データはWebRTCで端末間を直接流れ、どこにもアップロードされません。" },
      { title: "中間者攻撃の検知", desc: "両方の画面に同じコード(SAS)が表示されます。一致を確認して中間者を排除。" },
      { title: "クロスプラットフォーム", desc: "Windows、macOS、Linux、Android、iOS — 最新のブラウザならどれでも。" },
    ],
  },
  legal: { privacy: "プライバシーポリシー", terms: "利用規約" },
```

`ko`:
```ts
  features: {
    items: [
      { title: "종단 간 암호화", desc: "X25519 + AES-256-GCM. 키는 두 기기에만 있고 서버는 복호화할 수 없습니다." },
      { title: "파일은 서버를 거치지 않음", desc: "데이터는 WebRTC로 기기 간 직접 전송되며 어디에도 업로드되지 않습니다." },
      { title: "중간자 공격 확인", desc: "양쪽 화면에 같은 코드(SAS)가 표시됩니다. 일치를 확인해 중간자를 배제하세요." },
      { title: "크로스 플랫폼", desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저면 모두 가능." },
    ],
  },
  legal: { privacy: "개인정보 처리방침", terms: "이용약관" },
```

`de`:
```ts
  features: {
    items: [
      { title: "Ende-zu-Ende-verschlüsselt", desc: "X25519 + AES-256-GCM; Schlüssel bleiben auf den beiden Geräten, der Server kann nicht entschlüsseln." },
      { title: "Dateien berühren den Server nie", desc: "Bytes fließen per WebRTC direkt zwischen den Geräten und werden nirgends hochgeladen." },
      { title: "Schutz vor Man-in-the-Middle", desc: "Beide Bildschirme zeigen denselben Code (SAS); stimmt er überein, ist ein MITM ausgeschlossen." },
      { title: "Plattformübergreifend", desc: "Windows, macOS, Linux, Android, iOS — jeder moderne Browser." },
    ],
  },
  legal: { privacy: "Datenschutzerklärung", terms: "Nutzungsbedingungen" },
```

`fr`:
```ts
  features: {
    items: [
      { title: "Chiffrement de bout en bout", desc: "X25519 + AES-256-GCM ; les clés restent sur les deux appareils, le serveur ne peut pas déchiffrer." },
      { title: "Les fichiers ne touchent jamais le serveur", desc: "Les octets circulent d'appareil à appareil via WebRTC et ne sont jamais téléversés." },
      { title: "Détection de l'homme du milieu", desc: "Les deux écrans affichent le même code (SAS) ; vérifiez-le pour écarter un MITM." },
      { title: "Multiplateforme", desc: "Windows, macOS, Linux, Android, iOS — tout navigateur moderne." },
    ],
  },
  legal: { privacy: "Politique de confidentialité", terms: "Conditions d'utilisation" },
```

- [ ] **Step 4: Verify the type-checker enforces completeness**

Run: `cd web && npm run check`
Expected: PASS. (If any language is missing `features`/`legal`, `svelte-check`/`tsc` fails — that is the completeness guard.)

- [ ] **Step 5: Commit**

```bash
cd web && git add src/lib/i18n.svelte.ts
git commit -m "feat(web): i18n keys for feature strip + footer legal links"
```

---

## Task 7: FeatureStrip component

**Files:**
- Create: `web/src/lib/FeatureStrip.svelte`

**Interfaces:**
- Consumes: `lang()`, `messages` from `i18n.svelte` (reads `t.features.items`).
- Produces: a `<section class="features">` with one card per feature item. No props.

- [ ] **Step 1: Implement the component**

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="features" aria-label="Why Relayium">
  {#each t.features.items as f (f.title)}
    <div class="feature">
      <h3>{f.title}</h3>
      <p>{f.desc}</p>
    </div>
  {/each}
</section>

<style>
  .features {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin: 28px 0 8px;
  }
  .feature {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: 16px 18px;
  }
  .feature h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-h);
  }
  .feature p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text);
  }
  @media (max-width: 560px) {
    .features { grid-template-columns: 1fr; }
  }
</style>
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npm run check`
Expected: PASS (unused-import-free; `t.features.items` is typed).

- [ ] **Step 3: Commit**

```bash
cd web && git add src/lib/FeatureStrip.svelte
git commit -m "feat(web): FeatureStrip trust cards"
```

---

## Task 8: Hero component

**Files:**
- Create: `web/src/lib/Hero.svelte`

**Interfaces:**
- Consumes props from `App.svelte`:
  ```ts
  let { connState, unsupported, selfName }:
    { connState: "connecting" | "ready"; unsupported: boolean; selfName: string } = $props();
  ```
  and `lang()/messages` for copy (`t.tagline`, `t.connected`, `t.connecting`, `t.unavailable`).
- Produces: the `<header>` hero block (logo, title, tagline, status pill). This replaces the inline `<header>` currently in `App.svelte`.

- [ ] **Step 1: Implement the component**

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  let { connState, unsupported, selfName }:
    { connState: "connecting" | "ready"; unsupported: boolean; selfName: string } = $props();
  const t = $derived<Messages>(messages[lang()]);
</script>

<header class="hero">
  <div class="logo">⇌</div>
  <h1>Relayium</h1>
  <p class="tagline">{t.tagline}</p>
  <div class="statusbar">
    <span class="dot" class:on={connState === "ready"}></span>
    {#if unsupported}
      {t.unavailable}
    {:else if connState === "ready"}
      {t.connected(selfName)}
    {:else}
      {t.connecting}
    {/if}
  </div>
</header>

<style>
  .hero { text-align: center; padding-top: 44px; }
  .logo {
    width: 60px; height: 60px; line-height: 60px;
    margin: 0 auto 12px;
    font-size: 32px; color: #fff;
    border-radius: 18px;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
    box-shadow: var(--shadow);
  }
  h1 { font-size: 46px; margin: 0 0 8px; letter-spacing: -1.4px; }
  .tagline { color: var(--text); font-size: 15.5px; max-width: 44ch; margin: 0 auto; }
  .statusbar {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 14px; margin-top: 18px;
    padding: 6px 14px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface-2);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .dot.on { background: #2ecc71; box-shadow: 0 0 0 3px rgba(46, 204, 113, .18); }
  @media (max-width: 1024px) { .hero { padding-top: 30px; } h1 { font-size: 36px; } }
</style>
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd web && git add src/lib/Hero.svelte
git commit -m "feat(web): Hero header component"
```

---

## Task 9: Wire App.svelte — use Hero/FeatureStrip, device grid, footer legal links

**Files:**
- Modify: `web/src/App.svelte`

**Interfaces:**
- Consumes: `Hero` (props `connState, unsupported, selfName`), `FeatureStrip` (no props), `legalUrl` from `i18n.svelte`.
- Behavior unchanged; only markup/layout/styles change.

- [ ] **Step 1: Import the new pieces**

In the `<script>` block of `App.svelte`, add to the existing imports:

```ts
  import Hero from "./lib/Hero.svelte";
  import FeatureStrip from "./lib/FeatureStrip.svelte";
```
and extend the i18n import to include `legalUrl`:
```ts
  import { lang, setLang, LANGS, messages, legalUrl, type Lang, type Messages, type StatusKey } from "./lib/i18n.svelte";
```

- [ ] **Step 2: Replace the inline `<header>` with `<Hero>`**

Delete the entire inline `<header> ... </header>` block (currently `App.svelte:379-393`) and replace with:

```svelte
  <Hero {connState} {unsupported} {selfName} />
```

- [ ] **Step 3: Add the feature strip**

Immediately after the `{:else}` that opens the supported branch (currently `App.svelte:401`), before `<section class="guide">`, add:

```svelte
    <FeatureStrip />
```

- [ ] **Step 4: Convert the peers list to a responsive grid**

In the `.peers ul` style block, change the grid rule to auto-fill columns:

```css
  .peers ul {
    list-style: none; padding: 0; margin: 0;
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
```

- [ ] **Step 5: Replace the footer with legal links + GitHub**

Replace the existing `<footer> ... </footer>` block (currently `App.svelte:481-497`) with:

```svelte
    <footer>
      <nav class="legal">
        <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
        <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
        <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
      <span class="fineprint">{t.footer}</span>
    </footer>
```

- [ ] **Step 6: Update footer styles**

Replace the `footer { ... }` and `.gh { ... }` style rules with:

```css
  footer {
    margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
```

(The old GitHub SVG/`.gh` rule is removed; the GitHub link is now a plain text link in `.legal`.)

- [ ] **Step 7: Adjust the main container width for the wider grid**

In the `main { ... }` rule, widen the column so the feature/device grids breathe:

```css
  main {
    position: relative;
    width: 820px;
    max-width: 100%;
    margin: 0 auto;
    padding: 0 20px 48px;
    box-sizing: border-box;
    text-align: left;
  }
```

- [ ] **Step 8: Type-check, test, build**

Run: `cd web && npm run check`
Expected: PASS (no unused `Lang`/imports; `legalUrl` used).

Run: `cd web && npm test -- --run`
Expected: all existing + new tests PASS.

Run: `cd web && npm run build`
Expected: build succeeds; `dist/privacy/index.html` and `dist/zh/privacy/index.html` exist (copied from `public/`).

- [ ] **Step 9: Commit**

```bash
cd web && git add src/App.svelte
git commit -m "feat(web): product-page layout — hero, feature strip, device grid, legal footer"
```

---

## Task 10: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full check + test + build**

Run: `cd web && npm run check && npm test -- --run && npm run build`
Expected: all green; build emits `dist/` with all 12 legal pages + `dist/sitemap.xml`.

- [ ] **Step 2: Confirm legal pages are crawlable without JS**

Run: `cd web && grep -L "<h1>" dist/privacy/index.html dist/zh/privacy/index.html dist/terms/index.html dist/fr/terms/index.html`
Expected: no output (every file contains an `<h1>` in static HTML).

Run: `cd web && grep -c "hreflang" dist/privacy/index.html`
Expected: `7` (6 languages + x-default).

- [ ] **Step 3: Confirm sitemap completeness**

Run: `cd web && grep -c "<loc>" dist/sitemap.xml`
Expected: `13`.

- [ ] **Step 4: Manual visual smoke test**

Run: `cd web && npm run preview` and open the served URL.
Check:
- App: hero, feature strip (4 cards → 1 column on narrow), device grid, transfer card, footer with Privacy/Terms/GitHub.
- Toggle the language selector → hero tagline, feature cards, and footer labels all switch.
- Visit `/privacy`, `/zh/privacy`, `/terms`, `/fr/terms` → localized content, language bar switches between them, "← Relayium" returns home.
- Toggle OS dark mode → both app and legal pages theme correctly.

- [ ] **Step 5: Finish the branch**

Invoke `superpowers:finishing-a-development-branch` to choose how to integrate (merge / PR / cleanup).

---

## Self-Review (completed by plan author)

- **Spec coverage:** A1 cleanup+tokens → T5; A2 hero/features/grid/footer → T7,T8,T9; A3 componentization+i18n → T6,T7,T8; B1 content source → T2; B2 generation → T1,T4; B3 URLs/sitemap/hreflang → T1,T4; B4 content (privacy/terms, support email, no governing law, no public draft note) → T2,T3. Verification/testing section → T10. All covered.
- **Placeholder scan:** No "TBD/TODO". The only intentional temporary state is the EN-alias for ja/ko/de/fr in Task 2, explicitly replaced and test-enforced in Task 3.
- **Type consistency:** `LangDoc` fields (`title, description, updatedLabel, updated, otherDocLabel, lead, sections{heading,body,bullets}`) are identical across Task 1 template, Task 2 content, and Task 4 builders. `legalUrl(slug, lang)`, `features.items[]`, `legal.{privacy,terms}` consistent between Task 6 and Task 9. `Hero` props (`connState, unsupported, selfName`) match between Task 8 and Task 9.
