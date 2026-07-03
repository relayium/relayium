# SEO P2 — 静态多语言落地页 + 长尾内容页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 泛化 `web/scripts/legal/` 静态页管线为 `web/scripts/pages/`，生成 5 个多语言落地页（/zh/ /ja/ /ko/ /de/ /fr/）+ 36 个长尾内容页（对比×3、教程×3 × 6 语言），带 hreflang/JSON-LD/sitemap/内链，并让 SPA 支持 `?lang=` 初始语言。

**Architecture:** 纯构建期静态生成：内容以 .mjs 数据模块存放，模板函数渲染为自包含 HTML（内联 CSS、无 JS），`gen-pages.mjs` 在 dev/build 前写入 `web/public/`。SPA 应用代码只改两处（i18n 的 `?lang=` 检测、页脚内链）。

**Tech Stack:** Node ESM 脚本（无依赖）、Vitest、Svelte 5 runes、Vite。

**Spec:** `docs/superpowers/specs/2026-07-03-seo-p2-static-pages-design.md`

## Global Constraints

- 语言集固定：`LANGS = ["en", "zh", "ja", "ko", "de", "fr"]`；BCP47 映射 `{ en: "en", zh: "zh-Hans", ja: "ja", ko: "ko", de: "de", fr: "fr" }`；`DEFAULT_LANG = "en"`。
- 站点常量：`SITE = { origin: "https://relayium.com", name: "Relayium" }`。
- URL 规则：英文页不带语言前缀（`/compare/snapdrop`），其余带前缀（`/zh/compare/snapdrop`）；落地页 URL 为 `/zh/`（英文首页是 `/`，即 SPA，不生成静态落地页）。
- 每个文档缺任何一种要求的语言翻译时，生成必须抛错（构建失败），不允许静默跳过。
- 生成的静态页必须自包含：内联 CSS，不引用 Vite 资产图；用户可见文本一律经 `esc()` 转义；JSON-LD 中 `<` 替换为 `<`。
- 所有对比页文案立场客观：明确承认对方产品的优点，事实必须与 README/privacy 页一致（文件数上限 10、SAS 6 位、X25519 + AES-256-GCM、Firefox/Safari 内存缓冲约 200 MB、分享/下载链接需发送方登录、MIT 开源）。
- 工作目录：所有命令在 `web/` 下执行；测试命令 `npx vitest run <file>`；提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 不要使用 haiku 模型执行任何子任务。

---

### Task 1: 管线目录重组（legal → pages）+ sitemap lastmod 修复

**Files:**
- Move: `web/scripts/legal/` → `web/scripts/pages/`（`git mv`）
- Rename: `web/scripts/pages/template.mjs` → `web/scripts/pages/legal-template.mjs`、`template.test.mjs` → `legal-template.test.mjs`
- Move: `web/scripts/pages/content/*.mjs` → `web/scripts/pages/content/legal/*.mjs`
- Rename: `web/scripts/gen-legal.mjs` → `web/scripts/gen-pages.mjs`
- Modify: `web/package.json`（dev/build/gen 脚本）
- Modify: `web/scripts/pages/shared.mjs`（新增 landing 助手 + 校验）
- Modify: `web/scripts/pages/build-pages.mjs`（`buildAllPages` → `buildLegalPages`；sitemap lastmod 按文档 updated）
- Test: `web/scripts/pages/build-pages.test.mjs`

**Interfaces:**
- Produces（后续任务依赖，签名必须一致）:
  - `shared.mjs`: `LANDING_LANGS = ["zh","ja","ko","de","fr"]`、`landingUrl(lang)`（en→`"/"`，其余→`"/zh/"` 形）、`landingPath(lang)`（`"zh/index.html"` 形，不接受 en）、`validateLangs(name, langs, expected = LANGS)`（缺翻译抛 Error）、`ctaHref(lang)`（en→`"/"`，其余→`"/?lang=zh"` 形）
  - `build-pages.mjs`: `buildLegalPages(docs)`（即原 `buildAllPages`）、`buildSitemap(docs, opts)` 暂保持原签名（Task 4 再扩展）

- [ ] **Step 1: git mv 重组目录与文件**

```bash
cd web
git mv scripts/legal scripts/pages
git mv scripts/pages/template.mjs scripts/pages/legal-template.mjs
git mv scripts/pages/template.test.mjs scripts/pages/legal-template.test.mjs
mkdir scripts/pages/content-legal-tmp
git mv scripts/pages/content/privacy.mjs scripts/pages/content-legal-tmp/
git mv scripts/pages/content/terms.mjs scripts/pages/content-legal-tmp/
git mv scripts/pages/content/security.mjs scripts/pages/content-legal-tmp/
git mv scripts/pages/content-legal-tmp scripts/pages/content/legal 2>/dev/null || { mkdir -p scripts/pages/content && git mv scripts/pages/content-legal-tmp scripts/pages/content/legal; }
git mv scripts/gen-legal.mjs scripts/gen-pages.mjs
```

（若 content/ 目录在移走三个文件后已空导致 git mv 报错，直接 `mkdir -p scripts/pages/content/legal` 后逐个 `git mv`。）

- [ ] **Step 2: 更新所有 import 路径与文件头注释**

`gen-pages.mjs`（整文件替换）：

```js
// web/scripts/gen-pages.mjs — writes all static pages (legal, landing, articles) + sitemap into public/.
// Run via `npm run gen:pages`; also runs automatically before dev/build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import privacy from "./pages/content/legal/privacy.mjs";
import terms from "./pages/content/legal/terms.mjs";
import security from "./pages/content/legal/security.mjs";
import { buildLegalPages, buildSitemap } from "./pages/build-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const legalDocs = [privacy, terms, security];

async function main() {
  const pages = buildLegalPages(legalDocs);
  for (const page of pages) {
    const abs = join(publicDir, page.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, page.html, "utf8");
  }
  await writeFile(join(publicDir, "sitemap.xml"), buildSitemap(legalDocs, { home: true }), "utf8");
  console.log(`gen-pages: wrote ${pages.length} pages + sitemap.xml to public/`);
}

main().catch((err) => {
  console.error("gen-pages failed:", err);
  process.exit(1);
});
```

`build-pages.mjs`：`buildAllPages` 改名 `buildLegalPages`，`renderLegalPage` 的 import 改自 `./legal-template.mjs`；sitemap 的 `const lastmod = "2026-06-29"` 删除，legal 条目改用 `lastmod: doc.langs.en.updated`，home 条目 `lastmod` 用 `new Date().toISOString().slice(0, 10)` 不可用（构建可复现性无所谓，但保持简单）——直接用最大的文档 updated：

```js
export function buildSitemap(docs, { home = true } = {}) {
  const urls = [];
  const newest = docs.map((d) => d.langs.en.updated).sort().at(-1);
  if (home) urls.push({ loc: SITE.origin + "/", lastmod: newest, priority: "1.0", changefreq: "weekly" });
  for (const doc of docs) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(doc.slug, lang)), lastmod: doc.langs.en.updated, priority: "0.3", changefreq: "yearly" });
    }
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
```

`legal-template.mjs` 与两个测试文件：更新相对 import（content 路径多一级 `legal/`，模板名改 `legal-template.mjs`，`buildAllPages`→`buildLegalPages`）。`legal-template.mjs` 文件头注释路径同步改。

- [ ] **Step 3: shared.mjs 追加落地页助手与校验**

在 `web/scripts/pages/shared.mjs` 末尾追加：

```js
// ── Landing-page helpers ──
// The English homepage is the SPA at "/"; static landing pages exist only for
// the other languages, at "/<lang>/".
export const LANDING_LANGS = ["zh", "ja", "ko", "de", "fr"];

export function landingUrl(lang) {
  return lang === DEFAULT_LANG ? "/" : `/${lang}/`;
}

export function landingPath(lang) {
  if (lang === DEFAULT_LANG) throw new Error("landingPath: the en homepage is the SPA, not a generated page");
  return `${lang}/index.html`;
}

/** Where a page's "open the app" CTA points: the SPA, pre-set to this language. */
export function ctaHref(lang) {
  return lang === DEFAULT_LANG ? "/" : `/?lang=${lang}`;
}

/** Throw (fail the build) when a doc is missing any required translation. */
export function validateLangs(name, langs, expected = LANGS) {
  const missing = expected.filter((l) => !langs[l]);
  if (missing.length) throw new Error(`${name}: missing translations: ${missing.join(", ")}`);
}
```

- [ ] **Step 4: package.json 脚本更新**

`web/package.json` 中 `gen:legal` → `gen:pages`，三处 `node scripts/gen-legal.mjs` → `node scripts/gen-pages.mjs`。

- [ ] **Step 5: 为新助手补测试**

在 `web/scripts/pages/build-pages.test.mjs` 追加：

```js
import { landingUrl, landingPath, ctaHref, validateLangs, LANDING_LANGS } from "./shared.mjs";

describe("landing helpers", () => {
  it("landingUrl maps en to / and others to /<lang>/", () => {
    expect(landingUrl("en")).toBe("/");
    expect(landingUrl("zh")).toBe("/zh/");
  });
  it("landingPath rejects en and nests others", () => {
    expect(() => landingPath("en")).toThrow();
    expect(landingPath("ja")).toBe("ja/index.html");
  });
  it("ctaHref presets the SPA language", () => {
    expect(ctaHref("en")).toBe("/");
    expect(ctaHref("zh")).toBe("/?lang=zh");
  });
  it("validateLangs throws listing missing languages", () => {
    expect(() => validateLangs("x", { en: {}, zh: {} })).toThrow(/missing translations: ja, ko, de, fr/);
    expect(() => validateLangs("x", { zh: {}, ja: {}, ko: {}, de: {}, fr: {} }, LANDING_LANGS)).not.toThrow();
  });
});

describe("buildSitemap lastmod", () => {
  it("uses each doc's updated date instead of a hardcoded one", () => {
    const xml = buildSitemap(docs, { home: true });
    expect(xml).toContain(`<lastmod>${privacy.langs.en.updated}</lastmod>`);
    expect(xml).not.toContain("2026-06-29");
  });
});
```

- [ ] **Step 6: 跑测试 + 生成 + 构建验证**

```bash
cd web
npx vitest run scripts/pages/
npm run gen:pages
npm run build
```

Expected: 测试全过；gen-pages 输出 `wrote 18 pages + sitemap.xml`；build 成功。`git status` 确认 public/ 下生成物只有 sitemap.xml 的 lastmod 变化。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(web): generalize legal-page pipeline into scripts/pages"
```

---

### Task 2: 落地页模板 + 5 语言落地页内容

**Files:**
- Create: `web/scripts/pages/landing-template.mjs`
- Create: `web/scripts/pages/content/landing.mjs`
- Modify: `web/scripts/pages/build-pages.mjs`（`buildLandingPages`；sitemap 收录落地页）
- Modify: `web/scripts/gen-pages.mjs`（接入 landing）
- Test: `web/scripts/pages/landing-template.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `LANDING_LANGS/landingUrl/landingPath/ctaHref/validateLangs`
- Produces:
  - `renderLandingPage({ lang, doc, articleLinks })` → HTML string；`articleLinks` 为 `[{ slug, title }]`（本语言标题），Task 4 前传 `[]`
  - `buildLandingPages(landing, articleLinksByLang = {})` → `[{ path, html }]`（5 页）
  - `buildSitemap(docs, { home, landing })`：landing 为 content/landing.mjs 的默认导出；落地页条目 priority 0.8 / changefreq weekly / lastmod = `landing.updated`
  - `content/landing.mjs` 默认导出 `{ updated: "2026-07-03", langs: { zh: {...}, ja: {...}, ko: {...}, de: {...}, fr: {...} } }`

**落地页文档 schema**（每语言一份，全部字段必填）：

```js
{
  title,        // <title> 与 og:title，如 "Relayium — 端到端加密的 P2P 文件传输"
  description,  // meta description，~150 字符
  hero: { h1, pitch, cta },              // cta 按钮文字，href 用 ctaHref(lang)
  how: { heading, steps: [s1, s2, s3, s4] },
  why: { heading, items: [{ title, desc } × 5] },
  compare: { heading, items: [{ title, body } × 3] },   // vs AirDrop / Snapdrop&PairDrop / WeTransfer
  faq: { heading, items: [{ q, a } × 6] },
  learnHeading, // "深入了解" 小节标题（列出内容页链接）
  footer: { privacy, terms, security },  // 页脚 legal 链接文字
}
```

- [ ] **Step 1: 写失败测试**

`web/scripts/pages/landing-template.test.mjs`：

```js
import { describe, it, expect } from "vitest";
import landing from "./content/landing.mjs";
import { buildLandingPages } from "./build-pages.mjs";
import { renderLandingPage } from "./landing-template.mjs";

describe("buildLandingPages", () => {
  const pages = buildLandingPages(landing);

  it("produces 5 pages at <lang>/index.html", () => {
    expect(pages.map((p) => p.path).sort()).toEqual(
      ["de/index.html", "fr/index.html", "ja/index.html", "ko/index.html", "zh/index.html"]
    );
  });

  it("zh page has localized h1, canonical, and full hreflang cluster", () => {
    const zh = pages.find((p) => p.path === "zh/index.html").html;
    expect(zh).toContain('<html lang="zh-Hans">');
    expect(zh).toContain('<link rel="canonical" href="https://relayium.com/zh/" />');
    expect(zh).toContain('hreflang="en" href="https://relayium.com/"');
    expect(zh).toContain('hreflang="ja" href="https://relayium.com/ja/"');
    expect(zh).toContain('hreflang="x-default" href="https://relayium.com/"');
    expect(zh).toContain("<h1>");
  });

  it("CTA opens the SPA with the language preset", () => {
    const ja = pages.find((p) => p.path === "ja/index.html").html;
    expect(ja).toContain('href="/?lang=ja"');
  });

  it("embeds WebApplication + FAQPage JSON-LD in the page language", () => {
    const de = pages.find((p) => p.path === "de/index.html").html;
    expect(de).toContain('"@type":"FAQPage"');
    expect(de).toContain('"inLanguage":"de"');
  });

  it("renders article links when provided", () => {
    const html = renderLandingPage({
      lang: "zh",
      doc: landing.langs.zh,
      articleLinks: [{ slug: "compare/snapdrop", title: "对比 Snapdrop" }],
    });
    expect(html).toContain('href="/zh/compare/snapdrop"');
  });
});
```

Run: `npx vitest run scripts/pages/landing-template.test.mjs` → FAIL（模块不存在）。

- [ ] **Step 2: 实现 landing-template.mjs**

结构复用 legal 模板的内联 STYLE（可整段复制再加 hero/CTA 按钮样式）。要点：

```js
// web/scripts/pages/landing-template.mjs — renders one static localized landing page.
import { LANGS, LANG_LABELS, BCP47, SITE, landingUrl, ctaHref, urlPath, absUrl, esc } from "./shared.mjs";

function alternates() {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(landingUrl(l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(landingUrl("en"))}" />`);
  return links.join("\n    ");
}

export function renderLandingPage({ lang, doc, articleLinks = [] }) {
  const canonical = absUrl(landingUrl(lang));
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebApplication", "SoftwareApplication"],
        name: SITE.name,
        url: canonical,
        description: doc.description,
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        inLanguage: BCP47[lang],
      },
      {
        "@type": "FAQPage",
        inLanguage: BCP47[lang],
        mainEntity: doc.faq.items.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };
  // head: charset/viewport/title/description/robots/canonical/alternates/icon/
  //       theme-color/og:*(title,description,url,image=SITE.origin+"/og-image.jpg",locale)/
  //       twitter:card summary_large_image/JSON-LD/STYLE
  // body 区块顺序：header(logo + langbar) → hero(h1 + pitch + <a class="cta" href=ctaHref(lang)>) →
  //       how(ol 四步) → why(ul 五项，title 加粗) → compare(h3 + p ×3) → faq(h3 + p ×6) →
  //       learn(articleLinks 映射为 <a href=urlPath(slug, lang)>) → footer(legal 链接 urlPath("privacy", lang) 等 + GitHub)
  // 全部文本 esc()；JSON-LD 用 JSON.stringify(ld).replace(/</g, "\\u003c")
  return `<!doctype html> ... `;
}
```

（模板 HTML 骨架照 legal-template.mjs 的写法展开，此处不重复；langbar 用 `landingUrl(l)` 生成，当前语言 `aria-current="true"`。）

- [ ] **Step 3: 撰写 content/landing.mjs（5 语言完整文案）**

文案要求（每语言按 schema 全字段）：
- hero.h1 直接点名核心关键词（如 zh：`端到端加密的点对点文件传输`）；pitch 两句话：浏览器直传、文件不经服务器、无需安装。
- how.steps 对应 SPA 的四步：两台设备打开 relayium.com → 选择/拖入文件（最多 10 个）→ 双方核对 6 位校验码 → 直连传输、逐块 AES-256-GCM 加密 + SHA-256 校验。
- why.items 五项：端到端加密（X25519 + AES-256-GCM）；真正点对点（实时模式文件不过服务器）；SAS 防中间人；跨平台（Windows/macOS/Linux/Android/iOS 浏览器即用）；免费开源（MIT，实时传输无需账号）。
- compare.items 三项，客观：AirDrop（原生流畅但仅限 Apple 设备；Relayium 跨平台）；Snapdrop/PairDrop（同类先驱，但 Relayium 加了应用层 E2E + SAS，恶意信令服务器也无法 MITM）；WeTransfer/网盘（异步方便，但免费有 2GB 上限且文件存服务器；Relayium 实时模式无大小上限、零服务器存储）。
- faq.items 六问 = index.html 中 FAQPage 的六问本地化：免费吗 / 文件会上传服务器吗 / 是端到端加密吗 / 能跨系统传吗 / 大小限制 / 与 Snapdrop 区别。
- 语言风格：zh 由实现者精写；ja/ko/de/fr 语法正确、术语一致（端到端加密、点对点等术语参考 `src/lib/i18n.svelte.ts` 中对应语言的既有译法）。

- [ ] **Step 4: 接入 build 与 sitemap**

`build-pages.mjs` 追加：

```js
import { renderLandingPage } from "./landing-template.mjs";
import { LANDING_LANGS, landingPath, landingUrl, validateLangs } from "./shared.mjs";

export function buildLandingPages(landing, articleLinksByLang = {}) {
  validateLangs("landing", landing.langs, LANDING_LANGS);
  return LANDING_LANGS.map((lang) => ({
    path: landingPath(lang),
    html: renderLandingPage({ lang, doc: landing.langs[lang], articleLinks: articleLinksByLang[lang] ?? [] }),
  }));
}
```

`buildSitemap(docs, { home, landing })`：当传入 `landing` 时，为每个 `LANDING_LANGS` 追加 `{ loc: absUrl(landingUrl(lang)), lastmod: landing.updated, priority: "0.8", changefreq: "weekly" }`。

`gen-pages.mjs`：import landing，`pages` 拼上 `buildLandingPages(landing)`，`buildSitemap(legalDocs, { home: true, landing })`。

- [ ] **Step 5: 跑测试 + 生成验证**

```bash
npx vitest run scripts/pages/
npm run gen:pages
```

Expected: 全过；输出 `wrote 23 pages`；`web/public/zh/index.html` 存在且人工抽查 zh 页 hero/FAQ 渲染正确、无转义破损。sitemap 含 5 个落地页 URL（priority 0.8）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): static localized landing pages for zh/ja/ko/de/fr"
```

---

### Task 3: 根 index.html hreflang + noscript 内链

**Files:**
- Modify: `web/index.html`

**Interfaces:**
- Consumes: 落地页 URL 形如 `/zh/`；内容页 URL 见 Task 4 的六个 slug（本任务先写死链接，Task 4 生成对应页面——顺序无妨，只是构建出的链接短暂 404，全部任务完成后一致）。

- [ ] **Step 1: canonical 之后追加 hreflang 簇**

在 `<link rel="canonical" href="https://relayium.com/" />` 后追加：

```html
<link rel="alternate" hreflang="en" href="https://relayium.com/" />
<link rel="alternate" hreflang="zh-Hans" href="https://relayium.com/zh/" />
<link rel="alternate" hreflang="ja" href="https://relayium.com/ja/" />
<link rel="alternate" hreflang="ko" href="https://relayium.com/ko/" />
<link rel="alternate" hreflang="de" href="https://relayium.com/de/" />
<link rel="alternate" hreflang="fr" href="https://relayium.com/fr/" />
<link rel="alternate" hreflang="x-default" href="https://relayium.com/" />
```

- [ ] **Step 2: noscript 末段補链接**

在 `<noscript>` 内 GitHub/llms.txt 段落前追加：

```html
<h2>Learn more</h2>
<ul>
  <li><a href="/compare/snapdrop">Relayium vs Snapdrop and PairDrop</a></li>
  <li><a href="/compare/airdrop">Relayium vs AirDrop</a></li>
  <li><a href="/compare/wetransfer">Relayium vs WeTransfer</a></li>
  <li><a href="/how-to/transfer-files-android-to-iphone">Transfer files from Android to iPhone</a></li>
  <li><a href="/how-to/send-files-pc-to-phone-wirelessly">Send files from PC to phone wirelessly</a></li>
  <li><a href="/how-to/send-large-files-without-cloud">Send large files without the cloud</a></li>
</ul>
<p>Also available in: <a href="/zh/">中文</a> · <a href="/ja/">日本語</a> · <a href="/ko/">한국어</a> · <a href="/de/">Deutsch</a> · <a href="/fr/">Français</a></p>
```

- [ ] **Step 3: 构建验证 + Commit**

```bash
npm run build
git add index.html && git commit -m "feat(web): hreflang cluster + crawlable noscript links on the homepage"
```

---

### Task 4: 文章模板 + 构建接入 +第一篇内容（compare/snapdrop）

**Files:**
- Create: `web/scripts/pages/article-template.mjs`
- Create: `web/scripts/pages/content/articles/compare-snapdrop.mjs`
- Modify: `web/scripts/pages/build-pages.mjs`（`buildArticlePages`；sitemap 收录文章；落地页 learn 链接接入）
- Modify: `web/scripts/gen-pages.mjs`
- Test: `web/scripts/pages/article-template.test.mjs`

**Interfaces:**
- Consumes: Task 1 助手；Task 2 的 `buildLandingPages(landing, articleLinksByLang)`
- Produces:
  - 文章内容模块默认导出：`{ slug, updated, langs: { en: doc, zh: doc, ja: doc, ko: doc, de: doc, fr: doc } }`，doc = `{ title, description, updatedLabel, updated?, lead: [string], sections: [{ heading, body: [string], bullets?: [string] }], faq?: { heading, items: [{ q, a }] }, cta: { text, button }, relatedHeading }`
  - `renderArticlePage({ slug, lang, doc, related })` → HTML；`related` = `[{ slug, title }]`（其余文章 + 落地页/首页由模板自行加）
  - `buildArticlePages(articles)` → `[{ path, html }]`（每篇 6 页）
  - `buildSitemap(docs, { home, landing, articles })`：文章条目 priority 0.6 / changefreq monthly / lastmod = article.updated
  - `articleLinksByLang(articles)`（build-pages.mjs 导出）：`{ zh: [{slug,title}...], ... }` 供落地页 learn 小节

**六篇文章的 slug（全局固定，Task 3/5–9/11 均引用）：**

| slug | 类型 |
|---|---|
| `compare/snapdrop` | 对比 |
| `compare/airdrop` | 对比 |
| `compare/wetransfer` | 对比 |
| `how-to/transfer-files-android-to-iphone` | 教程 |
| `how-to/send-files-pc-to-phone-wirelessly` | 教程 |
| `how-to/send-large-files-without-cloud` | 教程 |

- [ ] **Step 1: 写失败测试**

`web/scripts/pages/article-template.test.mjs`：

```js
import { describe, it, expect } from "vitest";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";
import { buildArticlePages, articleLinksByLang } from "./build-pages.mjs";

describe("buildArticlePages", () => {
  const pages = buildArticlePages([compareSnapdrop]);

  it("produces 6 pages with en unprefixed", () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("compare/snapdrop/index.html");
    expect(paths).toContain("zh/compare/snapdrop/index.html");
    expect(paths.length).toBe(6);
  });

  it("en page has canonical + full hreflang cluster + Article JSON-LD", () => {
    const en = pages.find((p) => p.path === "compare/snapdrop/index.html").html;
    expect(en).toContain('<link rel="canonical" href="https://relayium.com/compare/snapdrop" />');
    expect(en).toContain('hreflang="zh-Hans" href="https://relayium.com/zh/compare/snapdrop"');
    expect(en).toContain('hreflang="x-default" href="https://relayium.com/compare/snapdrop"');
    expect(en).toContain('"@type":"Article"');
  });

  it("includes FAQPage JSON-LD when the doc has a faq", () => {
    const zh = pages.find((p) => p.path === "zh/compare/snapdrop/index.html").html;
    expect(zh).toContain('"@type":"FAQPage"');
  });

  it("CTA points at the SPA with language preset", () => {
    const fr = pages.find((p) => p.path === "fr/compare/snapdrop/index.html").html;
    expect(fr).toContain('href="/?lang=fr"');
  });

  it("articleLinksByLang exposes localized titles keyed by lang", () => {
    const links = articleLinksByLang([compareSnapdrop]);
    expect(links.zh[0].slug).toBe("compare/snapdrop");
    expect(links.zh[0].title).toBe(compareSnapdrop.langs.zh.title);
  });

  it("missing translation fails the build", () => {
    const broken = { slug: "x", updated: "2026-07-03", langs: { en: compareSnapdrop.langs.en } };
    expect(() => buildArticlePages([broken])).toThrow(/missing translations/);
  });
});
```

Run: `npx vitest run scripts/pages/article-template.test.mjs` → FAIL。

- [ ] **Step 2: 实现 article-template.mjs**

与 legal 模板同风格（内联 STYLE + langbar + footer），差异点：

```js
// JSON-LD
const ld = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: doc.title,
      description: doc.description,
      inLanguage: BCP47[lang],
      dateModified: updated,          // 文章级 updated
      mainEntityOfPage: canonical,
      author: { "@type": "Organization", name: SITE.name, url: SITE.origin + "/" },
      publisher: { "@type": "Organization", name: SITE.name, url: SITE.origin + "/" },
    },
    ...(doc.faq ? [{ "@type": "FAQPage", inLanguage: BCP47[lang], mainEntity: doc.faq.items.map(...) }] : []),
  ],
};
// body: header → h1 → updated 行 → langbar(urlPath(slug, l)) → lead 段落 → sections →
//       faq(h2 + h3/p 对) → cta 卡片(<p>{doc.cta.text}</p><a class="cta" href=ctaHref(lang)>{doc.cta.button}</a>) →
//       related(h2 doc.relatedHeading + related.map(r => <a href=urlPath(r.slug, lang)>) + 落地页链接 landingUrl(lang)) →
//       footer(← Relayium / privacy / GitHub)
```

`build-pages.mjs` 追加：

```js
import { renderArticlePage } from "./article-template.mjs";

export function buildArticlePages(articles) {
  return articles.flatMap((a) => {
    validateLangs(a.slug, a.langs);
    return LANGS.map((lang) => ({
      path: pagePath(a.slug, lang),
      html: renderArticlePage({
        slug: a.slug,
        lang,
        doc: a.langs[lang],
        updated: a.updated,
        related: articles.filter((o) => o.slug !== a.slug).map((o) => ({ slug: o.slug, title: o.langs[lang].title })),
      }),
    }));
  });
}

export function articleLinksByLang(articles) {
  return Object.fromEntries(
    LANGS.map((lang) => [lang, articles.map((a) => ({ slug: a.slug, title: a.langs[lang].title }))])
  );
}
```

`gen-pages.mjs`：import 文章模块列表 `const articles = [compareSnapdrop]`（后续任务逐篇追加）；`buildLandingPages(landing, articleLinksByLang(articles))`；`buildSitemap(legalDocs, { home: true, landing, articles })`。

- [ ] **Step 3: 撰写 compare-snapdrop.mjs（en 母本 + 5 译文）**

英文母本结构（zh/ja/ko/de/fr 按同结构翻译，事实不变）：
- title: `Relayium vs Snapdrop & PairDrop: which secure P2P file transfer?`；description ~150 字符。
- lead：肯定 Snapdrop/PairDrop 是同类先驱、体验优秀；Relayium 同源思路但重点在加密强度，本文客观对比。
- sections：
  1. `What they have in common` — 浏览器 + WebRTC + 免安装 + LAN 发现。
  2. `Where Snapdrop and PairDrop shine` — 更成熟、社区大、PairDrop 有房间/持久配对、可自托管。
  3. `Where Relayium differs: application-layer end-to-end encryption` — WebRTC DTLS 指纹经信令服务器交换，恶意服务器可 MITM；Relayium 加 X25519 + AES-256-GCM 应用层 + 6 位 SAS，密钥不出两端。
  4. `Beyond the LAN` — 配对码/分享链接跨网络直连、TURN 兜底（仍 E2E）、零知识存储下载链接（发送方需登录）、断点续传。
  5. `Feature table`（bullets 形式列差异：E2E 层级 / SAS / 跨网络 / 存储模式 / 续传 / 文件数上限 10）。
- faq 三问：能否互相替代、Relayium 是否开源可自托管（MIT，见 GitHub）、性能是否有差异（同为 WebRTC 直连，加密开销可忽略）。
- cta.text/button：一句邀请 + `Try Relayium now`。

- [ ] **Step 4: 跑测试 + 生成验证 + Commit**

```bash
npx vitest run scripts/pages/
npm run gen:pages   # 期望 wrote 29 pages
git add -A && git commit -m "feat(web): article page pipeline + Relayium-vs-Snapdrop comparison (6 langs)"
```

---

### Task 5–9: 其余五篇文章（每任务一篇，结构同 Task 4 Step 3–4）

每个任务：Create `web/scripts/pages/content/articles/<name>.mjs`（en 母本 + 5 译文，schema 同 Task 4）→ 在 `gen-pages.mjs` 的 `articles` 数组追加 → `npx vitest run scripts/pages/ && npm run gen:pages` → 单独 commit（`feat(web): <slug> article (6 langs)`）。测试文件中把页面总数断言随 articles 数组同步更新（若测试写死了数量）。

**Task 5 `compare-airdrop.mjs`**（slug `compare/airdrop`）：
- 肯定 AirDrop 在 Apple 生态内的体验（AWDL 直连、系统集成、离线可用）。
- 差异：AirDrop 仅限 Apple 设备；Relayium 浏览器即用，Windows/Android/Linux ↔ iPhone/Mac 全通。
- 诚实提醒：iOS 浏览器接收大文件不如原生顺滑（Safari 内存缓冲 ~200 MB）。
- faq：Windows 有 AirDrop 吗（无，Relayium 是替代路径）、iPhone→Windows 怎么传（步骤）、需要装 App 吗（不用）。

**Task 6 `compare-wetransfer.mjs`**（slug `compare/wetransfer`）：
- 肯定 WeTransfer 异步分享（对方不在线也能收）、体验成熟。
- 差异：免费 2 GB 上限、文件存服务器、链接非零知识；Relayium 实时模式无大小上限、文件不落服务器；存储下载链接为零知识密文（密钥只在 URL 片段，发送方需登录）。
- faq：无大小限制吗（实时模式无服务器上限；Firefox/Safari 内存缓冲 ~200 MB 提醒）、对方不在线怎么办（用存储下载链接）、免费吗（MIT 开源免费）。

**Task 7 `how-to/transfer-files-android-to-iphone`**：
- 痛点开头：无 AirDrop 互通、数据线/网盘绕路。
- 步骤化 sections（两台设备同 Wi-Fi 打开 relayium.com → 自动发现 → 选文件（≤10）→ 核对 6 位码 → 接收保存；不同网络时用配对码）。
- 备选方案小节（诚实列举：Google 快传/第三方 App/网盘，及各自局限）。
- faq：要装 App 吗、要同一 Wi-Fi 吗（否，配对码跨网络）、照片会压缩吗（原文件字节级传输 + SHA-256 校验）。

**Task 8 `how-to/send-files-pc-to-phone-wirelessly`**：
- 场景：电脑 ↔ 手机免数据线、免登录网盘。
- 步骤同上（强调拖拽、文件夹发送、PWA 可安装）。
- 备选：USB 线、蓝牙（慢）、微信/邮件自发（有大小限制且不加密）。
- faq：Mac 和 Android 也行吗、速度多快（LAN 直连以 Wi-Fi 为上限）、安全吗（E2E + SAS）。

**Task 9 `how-to/send-large-files-without-cloud`**：
- 场景：几 GB 视频/工程文件，网盘上传下载两次且有配额。
- 强调：实时直传无服务器上限、Chrome/Edge 流式写盘不占内存、断点续传、SHA-256 完整性。
- 诚实限制：Firefox/Safari 内存缓冲建议 <200 MB；双方需同时在线（否则用存储链接，注意其为零知识加密但有配额/过期）。
- faq：最大能传多大、中断了怎么办（自动续传）、隐私如何保证。

---

### Task 10: i18n `?lang=` 初始语言支持

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`（`detect()`）
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Produces: `detect(search?: string): Lang` — 优先级 `?lang=` 参数 > localStorage > navigator.language；非法参数忽略。签名向后兼容（无参调用行为不变时读 `location.search`）。

- [ ] **Step 1: 写失败测试**

在 `web/src/lib/i18n.test.ts` 追加（沿用该文件既有的 mock 风格；若其对 localStorage 有 beforeEach 清理则复用）：

```ts
import { detect } from "./i18n.svelte";

describe("detect with ?lang=", () => {
  it("prefers a valid ?lang= over saved and navigator language", () => {
    localStorage.setItem("relayium-lang", "fr");
    expect(detect("?lang=ja")).toBe("ja");
  });

  it("ignores an invalid ?lang= value", () => {
    localStorage.setItem("relayium-lang", "fr");
    expect(detect("?lang=klingon")).toBe("fr");
  });

  it("ignores prototype-chain keys", () => {
    localStorage.clear();
    expect(detect("?lang=toString")).not.toBe("toString");
  });
});
```

Run: `npx vitest run src/lib/i18n.test.ts` → FAIL（detect 不接受参数/不解析 lang）。

- [ ] **Step 2: 实现**

`i18n.svelte.ts` 的 `detect` 改为：

```ts
export function detect(search?: string): Lang {
  const s = search ?? (typeof location !== "undefined" ? location.search : "");
  try {
    const q = new URLSearchParams(s).get("lang");
    // Object.hasOwn (not `in`) so a poisoned key like "toString" can't match.
    if (q && Object.hasOwn(messages, q)) return q as Lang;
  } catch { /* malformed search — fall through */ }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && Object.hasOwn(messages, saved)) return saved as Lang;
  } catch { /* storage may be unavailable */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  for (const code of ["zh", "ja", "ko", "de", "fr"] as Lang[]) {
    if (nav.startsWith(code)) return code;
  }
  return "en";
}
```

（`let current = $state<Lang>(detect());` 无需改动。）

- [ ] **Step 3: 跑测试 + Commit**

```bash
npx vitest run src/lib/i18n.test.ts
git add src/lib/i18n.svelte.ts src/lib/i18n.test.ts
git commit -m "feat(web): honor ?lang= for initial language (landing-page CTA support)"
```

---

### Task 11: SPA 页脚内容页链接

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`（`Messages` 接口 + 6 语言字符串 + `pageUrl`）
- Modify: `web/src/App.svelte`（footer，约 1011–1019 行）
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Consumes: 六个文章 slug（见 Task 4 表格）
- Produces: `pageUrl(slug: string, l: Lang): string`（en 不带前缀）；`Messages.learn: { compareSnapdrop: string; compareAirdrop: string; compareWetransfer: string; howtoAndroidIphone: string; howtoPcPhone: string; howtoLargeFiles: string }`

- [ ] **Step 1: 写失败测试**

```ts
import { pageUrl, messages, LANGS } from "./i18n.svelte";

describe("pageUrl", () => {
  it("leaves en unprefixed and prefixes other languages", () => {
    expect(pageUrl("compare/snapdrop", "en")).toBe("/compare/snapdrop");
    expect(pageUrl("how-to/send-large-files-without-cloud", "zh")).toBe("/zh/how-to/send-large-files-without-cloud");
  });
});

describe("learn strings", () => {
  it("every language has all six learn labels", () => {
    for (const { code } of LANGS) {
      const learn = messages[code].learn;
      expect(Object.keys(learn).length).toBe(6);
      for (const v of Object.values(learn)) expect(v.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 实现**

`i18n.svelte.ts`：在 `legalUrl` 旁加

```ts
/** URL of a generated static page (article/landing) in the given language. */
export function pageUrl(slug: string, l: Lang): string {
  return l === "en" ? `/${slug}` : `/${l}/${slug}`;
}
```

`Messages` 接口加 `learn` 字段；六种语言各补 6 条短标签（如 zh：`对比 Snapdrop`、`对比 AirDrop`、`对比 WeTransfer`、`安卓 ↔ iPhone 互传`、`电脑无线传手机`、`不经云端传大文件`；en：`vs Snapdrop`、`vs AirDrop`、`vs WeTransfer`、`Android ↔ iPhone`、`PC to phone wirelessly`、`Large files without the cloud`；其余语言同义翻译）。

`App.svelte` footer 的 `.legal` 行后新增一行（沿用 `.legal` 的样式类）：

```svelte
<div class="legal">
  <a href={pageUrl("compare/snapdrop", lang())}>{t.learn.compareSnapdrop}</a>
  <a href={pageUrl("compare/airdrop", lang())}>{t.learn.compareAirdrop}</a>
  <a href={pageUrl("compare/wetransfer", lang())}>{t.learn.compareWetransfer}</a>
  <a href={pageUrl("how-to/transfer-files-android-to-iphone", lang())}>{t.learn.howtoAndroidIphone}</a>
  <a href={pageUrl("how-to/send-files-pc-to-phone-wirelessly", lang())}>{t.learn.howtoPcPhone}</a>
  <a href={pageUrl("how-to/send-large-files-without-cloud", lang())}>{t.learn.howtoLargeFiles}</a>
</div>
```

- [ ] **Step 3: 跑测试 + Commit**

```bash
npx vitest run src/lib/i18n.test.ts
npm run build
git add -A && git commit -m "feat(web): footer links to comparison and how-to pages"
```

---

### Task 12: 端到端验证

**Files:** 无新改动（验证任务）

- [ ] **Step 1: 全量测试与构建**

```bash
cd web
npx vitest run
npm run build
```

Expected: 全过。gen-pages 输出 `wrote 59 pages`（18 legal + 5 landing + 36 articles）。

- [ ] **Step 2: sitemap 完整性抽查**

```bash
grep -c "<loc>" public/sitemap.xml   # 期望 60（59 页 + 首页；注意 en 落地页即首页不重复计入）
grep "compare/snapdrop\|/zh/</loc>\|priority" public/sitemap.xml | head
```

（精确数：home 1 + legal 18 + landing 5 + articles 36 = 60。）

- [ ] **Step 3: dev server 抽查**

`npm run dev` 后浏览器/curl 抽查：`/zh/`、`/ja/`、`/compare/airdrop`、`/zh/how-to/send-large-files-without-cloud` 正常渲染；`/?lang=zh` 打开的 SPA 界面为中文；SPA 页脚出现六个内容页链接且随语言切换。

- [ ] **Step 4: 提交收尾 + 部署后动作（提醒用户）**

部署后需要在 Google Search Console 重新提交 sitemap.xml，并对 `/zh/` 与两三篇英文文章手动请求编入索引。
