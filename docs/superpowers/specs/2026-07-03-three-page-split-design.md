# 三页拆分(局域网 / 实时直传 / 异步传输)— 设计

**日期**:2026-07-03
**状态**:待用户评审
**背景**:实时模式合并(main `ee3f911`)后,跨网络页只剩两张卡——实时直传与下载链接。产品方向(见 memory three-page-product-direction):免费/付费边界与页面边界对齐,仅异步传输需登录、未来收费;局域网与实时直传永久免费且界面上零账号概念。

## 目标

把站点从两页拆为三页,每页承载单一功能:

| 页面 | 路径 | 功能 | 账号 |
|---|---|---|---|
| 局域网传输 | `/`(不变) | LAN 发现互传 + 营销首页 | 无 |
| 实时直传 | `/cross-network`(不变) | 配对码/链接/二维码实时传输 | 无,且界面上零账号概念 |
| 异步传输 | `/offline-transfer`(新) | 托管密文上传,对方凭链接稍后下载 | 需登录(未来收费板块) |

**硬约束**:`/cross-network` 路径与 `#c=<code>` 加入链接格式不变(已分发的二维码/链接必须继续可用);服务端零改动;六语言 i18n 同步。

## 非目标(明确不做)

- 计量归因(登录用户 mint 配对码归属账号)、猜码熔断、任何收费逻辑——另立项目。
- `/offline-transfer` 的多语言 SEO 静态落地页(gen-pages landing)——归下一轮 SEO 项目;本次只做 SPA 路由。
- `/cross-network` 重定向或路径变更——无需要。
- LAN 页/下载页/个人中心功能改动。

## 设计

### 1. 路由与导航

- `router.svelte.ts`:`Route` 增加 `"offline"`;新增 `OFFLINE_PATH = "/offline-transfer"`(定义在 router,不进 transfer-link——它与传输凭证无关);`routeFromLocation` 在 `pathname === OFFLINE_PATH` 时返回 `"offline"`;`navigate()` 补路径映射。`#c=` 仍优先路由到 `"cross"`。
- `Nav.svelte`:tabs 数组加第三项 `{ id: "offline", label: () => t.nav.offlineTab }`,href 用 `OFFLINE_PATH`。现有移动端断点(tabs 换行占整行)可容纳三个 tab,不改布局策略。
- Tab 中文文案(基调,其余五语言按此翻译):**局域网传输 / 实时直传 / 异步传输**。`nav.crossTab` 由「跨网络传输」改为「实时直传」,与页内卡片名(⚡ 实时直传)一致。*(此项用户未及确认,采用推荐项,评审时可改。)*

### 2. 页面组件

- **CrossPage.svelte 瘦身为实时页**:删除 stored 卡、`StoredUpload` import、`Account` 组件与 `session()` 登录门控——实时页从此无任何账号 UI。布局从两卡网格变单卡居中(复用现有 `.cards.single` 样式路径)。
- **新建 OfflinePage.svelte**:结构镜像实时页——右上 `Account`(登录组件从实时页整体迁来)、页头(标题/tagline/pitch)、单卡居中:已登录渲染 `StoredUpload`(组件不改),未登录渲染登录按钮 + 提示。
- **App.svelte**:`currentRoute() === "offline"` 分支渲染 OfflinePage。实时房间态(roomCode/transferSurface)只属于 cross 分支,不变。导航守卫(传输中确认)行为不变——navigate 已统一走 navGuard。

### 3. 营销区分配与互相引流

- **共用不改**:FeatureStrip、UseCases、Faq 在实时页与异步页尾部照旧渲染(现有 FAQ 六条讲的是统一故事,拆页后仍然全部成立)。
- **ModeCompare 两页共用**:它本来就是"实时 vs 异步"对比表,即互相引流的载体;表头两列各加一个跳转链接到对应页(小改)。
- **HowItWorks 拆分**:现「两种方式」结构废弃,改为每页专属的"怎么用"步骤区:
  - 实时页:三步(选文件生成码 → 念码/发链接/扫码 → 对方加入自动开传);
  - 异步页:三步(登录并选文件,浏览器端加密 → 生成链接设有效期/阅后即焚 → 对方凭链接随时下载,无需账号)。
  - i18n 结构:`howItWorks` 类型改为 `{ realtime: { title; steps: string[] }; offline: { title; steps: string[] } }`,六语言重写(文案工作量大头)。
- **定向引流卡**(新小组件 CrossSell.svelte,i18n 驱动):实时页尾部"对方现在不在线?用异步传输,链接可留存几天 →";异步页尾部"对方就在线?实时直传更快、文件不落服务器 →"。
- **首页 CTA**(`homeCross`):从单按钮改为双按钮,分别指向两页;desc 文案相应改写。

### 4. i18n 变更清单(六语言同步)

- 新增:`nav.offlineTab`;`offline: { title; tagline; pitch; signInHint }`;`crossSell: { toOffline; toRealtime; go }`;`howItWorks` 新结构。
- 修改:`nav.crossTab`(→实时直传基调);`homeCross`(双按钮);`crossnet.realtimeFoot`(现文案"免登录 · 登录后可用下载链接"改为纯"免登录 · 端到端加密",引流职责移交 CrossSell 卡)。
- 删除:旧 `howItWorks.ways` 结构;`methods.*` 保留(卡片名/副标题仍在用,stored 卡副标题移到异步页继续用)。

### 5. 对外口径

- llms.txt:产品结构段落改为三页三板块,路径写明。
- README:功能清单/结构段落同步三页表述。
- SEO 内容源(`web/scripts/pages/content/`):grep "cross-network" 类页面结构表述,把"跨网络页同时提供实时与下载链接"改为分页表述;改后 `npm run gen:pages` 重新生成。预期残留很少(2026-07-03 合并项目刚统一过口径)。

### 6. 测试与验证

- 单测:`router.test.ts` 补 `/offline-transfer` 路由用例;i18n 结构由类型系统把关;现有套件全绿。
- E2E(复用 headless Chrome CDP 手法,含 `--use-fake-ui-for-media-stream`):三 tab 导航互达;异步页未登录显示登录门控、无 StoredUpload;实时页 DOM 中无 Account/登录元素;引流卡链接落到正确页面;`#c=` 加入链接仍落实时页并可完成一次传输(回归)。
- 手工回归点:移动端宽度下三 tab 布局。

### 7. 风险与回滚

- 纯前端改动,回滚 = revert 单个 merge commit。
- 旧收藏的 `/cross-network` 用户若为了用下载链接而来:页内引流卡一步可达,可接受。
