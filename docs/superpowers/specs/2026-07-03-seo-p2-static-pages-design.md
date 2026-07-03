# SEO P2 — 静态多语言落地页 + 长尾内容页（设计）

日期：2026-07-03　状态：已批准

## 背景

relayium.com 已被 Google 收录（Search Console 已配置、sitemap 已提交），但：

- 首页是客户端渲染的 SPA，且全站只有一个首页 URL（语言靠客户端切换），首页无法做 hreflang，非英语市场没有可收录的入口页。
- 全站只有 1 个实质内容页（首页），能覆盖的关键词极少；legal 页（privacy/terms/security）不承载搜索意图。
- 现有 `web/scripts/legal/` 管线已经把多语言静态页做对了（hreflang、BCP47、canonical、sitemap、转义、单测），是本设计的复用基础。

## 目标

1. 5 个静态多语言落地页：`/zh/`、`/ja/`、`/ko/`、`/de/`、`/fr/`，纯 HTML、完整本地化营销内容，可被直接收录并参与 hreflang 簇。
2. 6 篇长尾内容页 × 6 语言 = 36 页：
   - 对比页：`/compare/snapdrop`（含 PairDrop）、`/compare/airdrop`、`/compare/wetransfer`
   - 教程页：`/how-to/transfer-files-android-to-iphone`、`/how-to/send-files-pc-to-phone-wirelessly`、`/how-to/send-large-files-without-cloud`
3. 内链与 sitemap 让上述页面可被发现。

**不做**：英文首页预渲染；blog 系统；路由/服务端改动。

## 方案

### 1. 管线泛化（`scripts/legal/` → `scripts/pages/`）

- 目录重组：
  - `scripts/pages/shared.mjs` — 原样迁移（LANGS、BCP47、pagePath/urlPath/absUrl/esc）。
  - `scripts/pages/legal-template.mjs` — 原 `template.mjs` 改名。
  - `scripts/pages/landing-template.mjs` — 新增，渲染落地页。
  - `scripts/pages/article-template.mjs` — 新增，渲染对比/教程页。
  - `scripts/pages/build-pages.mjs` — 扩展为构建全部页面类型 + sitemap。
  - 内容目录：`content/legal/`（原 content/ 迁移）、`content/landing/`、`content/articles/`。
- `scripts/gen-legal.mjs` → `scripts/gen-pages.mjs`；package.json 的 dev/build/gen 脚本同步更新（`gen:legal` → `gen:pages`）。
- 单测（`*.test.mjs`）随文件迁移并扩展。
- 生成器校验：每个文档必须 6 语言齐全，缺翻译 → 构建报错退出（防静默漏页）。

### 2. 落地页（5 个非英语首页）

- 路径：`public/{zh,ja,ko,de,fr}/index.html`（gen 时写入）。
- 内容区块（全部本地化）：Hero（H1 + 一句话定位 + CTA「打开应用」→ `/?lang=<l>`）、工作原理 4 步、Why Relayium 特性列表、与 AirDrop/Snapdrop/WeTransfer 的对比小节、FAQ（6 问）、页脚（legal 链接 + GitHub + 内容页链接）。
- head：本地化 title/description、canonical 指向自身、全套 hreflang（`en` 与 `x-default` → `https://relayium.com/`）、本地化 JSON-LD（WebApplication + FAQPage）、og/twitter 标签。
- 根 `web/index.html` 补 hreflang link 标签（en/zh-Hans/ja/ko/de/fr/x-default）。
- 语言栏：互链 6 个语言版本（English → `/`）。

### 3. 内容页（36 页）

- URL 规则沿用现有 `urlPath`：英文 `/compare/snapdrop`，本地化 `/zh/compare/snapdrop`（`pagePath` 已支持嵌套 slug）。
- 文章模板：内联样式（延续 legal 页风格）、canonical + hreflang、JSON-LD（`Article`；FAQ 小节处附 `FAQPage`）、语言栏、文内 CTA、页尾相关页互链（其余 5 篇 + 对应语言落地页/首页）。
- 文案：先写英文母本，再产出 zh/ja/ko/de/fr 版本。对比页立场客观（承认对方优点），教程页步骤化（适配 HowTo 意图）。

### 4. 内链

- `App.svelte` 页脚 footer 增加一行本地化链接指向 6 个内容页（新增 i18n 字符串）。
- 根 `index.html` `<noscript>` 内补 6 个内容页 + 5 个落地页链接。
- 落地页 ↔ 内容页互链（见模板设计）。

### 5. sitemap

- 全部新页面进 sitemap：落地页 priority 0.8 / weekly，内容页 0.6 / monthly，legal 维持 0.3 / yearly。
- `lastmod` 不再写死：取各文档自己的 `updated` 字段。

### 6. 应用小改动（唯一）

`i18n.svelte.ts` 初始语言检测优先级改为：`?lang=` URL 参数 > localStorage > navigator.language。参数值非法时忽略。

## 测试

- 单测（vitest，沿用 `.test.mjs` 模式）：每页 canonical/hreflang/title 断言；sitemap 覆盖全部 URL 且 lastmod 正确；翻译完整性校验（缺语言时抛错）；`?lang=` 解析（i18n.test.ts 扩展）。
- `npm test`、`npm run build` 通过；dev server 抽查生成页渲染。

## 风险与取舍

- 文案 6 语言 × 6 篇由 AI 撰写，发布前建议人工抽查中文/英文版；其余语言接受机器质量（竞争小，够用）。
- 静态落地页与 SPA 内文案将来可能漂移——接受：两者受众不同（搜索引擎入口 vs 应用 UI），不强制同步。
