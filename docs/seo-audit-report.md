# Relayium SEO 审查报告

> 审查对象：代码库（`web/scripts/` 静态页管线、`web/index.html` SPA 外壳、`server/` + `deploy/nginx/` 模板），非线上站点实测。
> 日期：2026-07-23
> 注意：`deploy/nginx/relayium.conf.example` 是模板文件，线上重定向/缓存头/SPA fallback 行为以实际生产配置为准，本报告相关结论假定生产与模板一致。

## 执行摘要

整体 SEO 卫生**远高于平均水平**:400+ 页完全静态、零 JS 依赖的页面；教科书级的 hreflang 实现（9 语言 + x-default、自引用、互指）；内容扎实的 robots.txt 与 llms.txt（明确的 GEO/AI 爬虫策略）；sitemap 405 个 URL 全部规范且带真实 lastmod；无重复标题、无孤儿页面。

**真正的问题集中在 SPA 外壳的服务模型上**:

1. **软 404**(High)——任意不存在的 URL 都返回 200 + 首页内容，可被索引的"重复首页"无限多。
2. **英文核心路由是 JS-only**(Medium)——`/cross-network`、`/pricing`、`/cli` 等裸 HTML 的头信息是首页的，与渲染后矛盾；不执行 JS 的爬虫（GPTBot、ClaudeBot、Bing 二次抓取、链接展开器）看到的全是首页副本，直接削弱项目自己声明的 GEO 战略。
3. **产品事实跨来源不一致**(Medium)——批次上限"1,000" vs "10" 在不同语言页面和 llms.txt 里互相矛盾。

---

## 一、可抓取性 / 索引

### 1.1 【High】软 404：所有未知无扩展名 URL 返回 200 + 首页

- **证据**:`server/spa.go:158-163` 无扩展名路径找不到文件即回退 `index.html`(200);nginx 模板 `deploy/nginx/relayium.conf.example:105-107` 同样 `try_files $uri $uri/ /index.html`;`web/src/lib/router.svelte.ts:38-50` 未匹配路径默认路由到首页，App 内**不存在 404 路由**。
- **影响**:`/compare/typo`、`/guides/deleted-article`、随机 URL 全部 200 渲染首页。GSC 会进"软 404"/"重复网页"桶，浪费抓取配额，已删除页面永不掉出索引。
- **修复**：服务端维护合法 SPA 路由白名单(`/`、`/cross-network`、`/offline-transfer`、`/apps`、`/pricing`、`/cli`、`/me`、`/d/*`、`/verify-email`、`/reset-password`)，其余返回真正的 404 状态 + 静态 404.html；客户端再补一个带 `noindex` 的 NotFound 路由作为第二层。

### 1.2 【Medium】英文营销路由 JS-only，裸 HTML 与渲染后头信息矛盾

- **证据**:`/cross-network`、`/offline-transfer`、`/apps`、`/pricing`、`/cli` 无静态页(`web/scripts/pages/shared.mjs:37` SPA_ONLY_EN_SLUGS)，裸 HTML 是 `web/index.html`，其 head 硬编码**首页**的 title/description/`canonical https://relayium.com/` 和首页 hreflang 簇(`index.html:16-32`);JS 执行后才按路由重写(`App.svelte:209-223`、`page-meta.ts:11-47`)。而 8 个语言版本对应页全是静态且头信息正确。
- **影响**：裸/渲染 canonical 冲突("/" vs "/cross-network")是 GSC canonical 漂移的典型来源；不渲染 JS 的爬虫——多数 AI/答案引擎爬虫取原始 HTML、Bing 二次抓取、链接 unfurl——在这些 URL 上看到的都是首页重复副本。8 个语言版做对了、英文原版反而最差。
- **修复**：给英文模式页也出静态 HTML(emit `/cross-network/index.html` 等，带正确 head + noscript 内容块，SPA 从其上启动），或在 nginx/Go 层做按路由的 head 注入。

### 1.3 【Medium】`/pricing` 是公开营销页但不在 sitemap 且 JS-only

- **证据**:`router.svelte.ts:22` 明确定义为 "public marketing";`page-meta.ts:17` 有独立 title/description/canonical；但 `gen-pages.mjs` 从不生成，`sitemap.xml` 中出现 0 次。
- **修复**：在 gen-pages.mjs 生成静态 `/pricing/` 并加入 sitemap。

### 1.4 【Low】`/cli` 文档页 canonical 指向首页

- **证据**:route `"cli"` 不在 `pageMeta` 处理列表(`page-meta.ts:11-20`)，回落到首页 canonical——等于自我降索引。而仓库已有 7 篇全翻译 CLI 指南文章，做个静态 `/cli/` 枢纽页成本很低。
- **修复**：做成静态页 + sitemap，或明确接受现状。

### 1.5 【Low】`/d/*` 下载页只 Disallow 未 noindex；过期链接也是 200

- **证据**:`robots.txt:12` Disallow `/d/`（正确）；但 SPA 的"已过期"态是客户端渲染的，URL 永远 200，无 noindex。被外链的下载 URL 可能以"已索引但被 robots 屏蔽"的无标题条目出现在索引里。
- **修复**（可选）:Go 服务端对未知/过期 id 返回 404/410（它拥有 id 存储），或下载路由客户端注入 noindex。

### 1.6 【Low】noscript 与 llms.txt 中的无斜杠链接造成可避免的 301 跳转

- **证据**:`index.html:219-225` 链接 `/compare/snapdrop`（规范形式带尾斜杠，源站 301);`llms.txt:25,67,68` 同样。
- **修复**：两处补尾斜杠。

---

## 二、技术

### 2.1 【Low】Sitemap 无 `xhtml:link` hreflang 注解

- **证据**:`build-pages.mjs:134-141` 生成纯 urlset。HTML head 的 hreflang 对 Google 已足够，此项是增强——但 405 URL × 9 语言的规模下，sitemap 级 hreflang 能强化语言簇，对 Bing 等权重 sitemap 的引擎有帮助。
- sitemap 其余方面全部正确：URL 数量与代码精确吻合、每页真实 lastmod、尾斜杠一致、无非索引 URL、构建期 slug 同步断言。

### 2.2 【Low】文章 JSON-LD 缺 `datePublished` 和 `image`

- **证据**:`article-template.mjs:188-197` 只有 `dateModified`;publisher/author Organization 无 `logo`（对比 `index.html:107-114` 有）。
- **修复**：补 `datePublished`、`image: origin + "/og-image.jpg"`、publisher logo。

### 2.3 【Low】静态页模板缺 `og:image:width/height` 和 `og:site_name`

- **证据**:`index.html:50-54` 有，其余 4 个模板没有。影响部分平台（LinkedIn）的展开可靠性，不影响排名。og:image 本身是绝对 URL 且正确（1200×630)。

### 2.4 【Info】缓存头、HTTPS、www 仅在 nginx 模板中保证

- **证据**:`deploy/nginx/relayium-perf.conf:58-70`（资产 1 年 immutable、HTML no-cache)、`relayium.conf.example:123-157`(www→apex 301、HTTP→HTTPS 单跳、HSTS 在 `spa.go:86`)。全部正确，但需人工核对生产配置与模板一致；Go 兜底路径不给 HTML 设 Cache-Control（仅影响无 nginx 的自托管者）。

### 2.5 【正面】robots.txt 堪称范本

精确屏蔽非页面路径(`/d/`、`/me`、`/admin`、安装脚本），营销路由全部放行，Bingbot 分组正确重复 Disallow，明确欢迎 AI 爬虫（GEO 战略），声明 Sitemap。无需改动。

---

## 三、页面内优化

### 3.1 【正面】标题/描述/标题层级干净

每页单一 H1、h2→h3 层级正确（5 个模板逐一验证）;36 篇英文文章标题全部唯一；文章与法律页有可见 "Last updated" + JSON-LD dateModified。

### 3.2 【正面】内链全网格，无孤儿页

每篇文章链接其余 35 篇 + 落地页 + 枢纽页；本地化落地页链接全部文章；指南索引按分类分组。

### 3.3 【Low】"相关文章"块是全量 36 链，不够聚焦

- **证据**:`build-pages.mjs:40-42` 把所有其他文章都作为 related 传入。全网格稀释相关性信号和锚文本价值。
- **修复**（可选优化）：策展 4–8 篇同类文章，集中内部 PageRank。

---

## 四、内容

### 4.1 【Medium】跨语言/跨来源的产品事实不一致：批次上限 "1,000" vs "10"

- **证据**：本地化落地页写"每批最多 1,000 个文件"(`landing.mjs:19` zh,ja:113、ko:207、ar:489 及对应 FAQ 同），而 `index.html:173,184` 与 `llms.txt:8,38` 写"一次最多 10 个"。必有一侧过时。
- **影响**：项目的 GEO 战略依赖 AI 引擎引用一致的事实，矛盾数字正是答案引擎会错误传播的东西；也影响 FAQ 富媒体结果的准确性。
- **修复**：确认真实上限并更新过时一侧；建议把产品事实抽成两个管线共享的单一常量来源。

### 4.2 【正面】内容扎实且真正本地化

抽样 `compare-snapdrop.mjs`(739 行、9 个完整 locale)、阿拉伯语全文翻译、隐私政策等：每篇文案独立，对比类文章诚实平衡（E-E-A-T 姿态好），构建期对缺失翻译硬失败。llms.txt 异常详尽准确。

---

## 五、i18n / hreflang

### 5.1 【正面】hreflang 实现教科书级

每个静态页输出全部 9 语言 + x-default，自引用且互指（单一 `alternates()` 构造保证）,BCP-47 正确（`zh-Hans`)，尾斜杠一致，模式页簇正确指向无斜杠 SPA URL;`<html lang>`、阿拉伯语 `dir="rtl"`、每页 `og:locale`。

### 5.2 【Medium】英文 SPA 路由的 hreflang 仅在 JS 执行后存在

- 与 1.2 同根因：`altHreflangs()` 客户端重写（`App.svelte:218-222`)，裸 HTML 给的是首页 hreflang 簇。不渲染的爬虫看到错误的 alternates;Google 看到裸/渲染不一致。
- **修复**：同 1.2——英文模式页静态化。

### 5.3 【Low】葡语页 `og:locale` 为 `pt_BR`

- 若翻译是欧洲/中性葡语则不匹配；OG 层面无害（`shared.mjs:19`)。

---

## 优先级行动清单

**关键修复（影响索引/排名）**

1. **1.1 软 404** —— 服务端对未知路径返回真 404（影响最大，工作量中等）。
2. **1.2 + 5.2 英文模式路由静态化 head**(+ 1.3 `/pricing`)—— 对 SEO 和 GEO 都是最大战略收益。

**高影响改进**

3. **4.1** 统一 10 vs 1,000 的批次上限事实（所有语言 + llms.txt)。

**Quick wins（低成本即时收益）**

4. 2.2 文章 JSON-LD 补 datePublished/image/logo
5. 1.6 noscript 与 llms.txt 链接补尾斜杠
6. 2.3 模板补 og:image 尺寸与 og:site_name
7. 1.4 `/cli` 静态枢纽页（已有 7 篇现成 CLI 文章可挂）

**长期建议**

8. 2.1 sitemap 加 xhtml:link hreflang
9. 3.3 相关文章从全网格改为同类策展
10. 核对生产 nginx 配置与模板一致（1.1/2.4 的前提）

---

## 做得好的地方（保持）

- 400 页完全静态、零 JS、CSS 内联的自包含 HTML,JS 禁用时完整可读。
- 每静态页完整 head 栈：唯一 title/description、canonical、9 语言 hreflang + x-default、OG/Twitter 绝对图 URL、多种 JSON-LD(Article/FAQPage/SoftwareApplication/CollectionPage)。
- SPA 外壳：丰富 JSON-LD 图谱、`max-image-preview:large`、内容充实的 `<noscript>` 块带内链——对 GEO 罕见且有价值。
- robots.txt 与 llms.txt 均为最佳实践。
- 尾斜杠纪律是刻意设计且工作正常；构建期翻译完整性校验；无重复标题；无孤儿页。
