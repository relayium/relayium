# 跨网络传输独立页面 — 设计文档

日期：2026-06-30
状态：已确认设计，待写实现计划

## 背景

当前前端是 Svelte 5 单页应用（SPA，runes 模式，Vite + TS），由 Go 静态服务器
（`server/main.go` 的 `http.FileServer`）托管 `web/dist`。局域网传输（"附近的设备"
peers 区）和跨网络传输（`CrossNetwork.svelte`）**上下堆叠在同一个页面**，没有页面
切换；跨网络模式靠 URL 片段 `#t=<token>` 隐式触发。登录按钮固定显示在右上角。

问题：局域网传输体验已经不错，但跨网络传输混在同一页里、且登录按钮对纯局域网用户
是噪音。需要把跨网络传输拆成独立页面，并按场景区分登录提示。

## 目标

1. 跨网络传输成为一个独立"页面"。
2. 访问 `https://relayium.com/`（`/`）默认展示**局域网传输**。
3. 用户可切换到**跨网络传输**页面。
4. 局域网传输页**不显示**任何登录/账户入口。
5. 跨网络传输页**提示用户需要登录**。

## 已确认的产品决策

- **切换形式**：顶部 Tab 切换 + 改写 URL（`history.pushState`）。
- **登录入口**：登录按钮/账户入口**只在跨网络页**出现；局域网页完全不显示账户 UI。
- **公共部分**：顶部 Logo + Tab 栏两页共享；其余内容（连接状态、peers、功能卡片、
  指南）各页专属。
- **接收方登录**：通过分享链接接收跨网络传输的人**不需要登录**（保持现状）；"需要
  登录"提示只针对主动发起传输的人。

## 架构

### 路由（新增，轻量自实现，不引第三方库）

App.svelte 升级为"路由壳"，持有一个 `route` 状态：

- `/` → `route = 'lan'`（局域网传输，默认）
- `/cross-network` → `route = 'cross'`（跨网络传输）

规则：

- 初始化时从 `location.pathname` 推导 `route`。
- 若 URL 含有效的 `#t=<token>` 片段（接收/发起 token），强制 `route = 'cross'`。
- Tab 点击：`history.pushState({}, '', path)` 并更新 `route` 状态，**不刷新页面**——
  这样局域网的 signaling WebSocket / peer 发现保持在后台存活，切回来时 peer 列表
  仍在。
- 监听 `popstate` 同步 `route`，支持浏览器前进/后退。

### WebSocket 房间语义（保持现状）

整个应用只有一个 signaling WebSocket，其房间由 `roomToken` 决定（无 token = 按客户端
公网 IP 的局域网房；有 token = `t:<token>` 的 2 人房）。因此：

- **纯 Tab 切换（无 token）**：不动 WebSocket，沿用局域网房。
- **真正发起/接收跨网络传输（token 出现）**：整页导航 / reload，让 WS 重连到 token
  房——沿用现有 reload 机制，风险最低。

### 服务端 SPA fallback（必需）

`/cross-network` 不是真实文件，现有 `http.FileServer` 会返回 404。在 `server/main.go`
包一层 fallback handler：

- 请求路径能映射到 `dist` 下真实文件（资源、`privacy`/`terms` 等静态页）→ 原样
  服务（行为不变）。
- 否则（无扩展名、非 `/assets/`、非已知静态页的"应用路由"，如 `/cross-network`）→
  返回 `dist/index.html`，由前端路由接管。
- `/api/`、`/ws`、`/admin`、`/healthz` 等已有 handler 不受影响（它们注册在 fallback
  之外的更具体路径上）。

## 组件分解

| 组件 | 职责 | 依赖 |
| --- | --- | --- |
| `App.svelte`（改） | 路由壳：持有 `route`、`popstate`/pushState；保留局域网传输引擎（WS、peers、send/recv 状态）；按 `route` 渲染局域网区域或 `CrossPage`。 | Nav、CrossPage、Hero、现有 LAN 逻辑 |
| `Nav.svelte`（新） | 顶部共享区：Logo + 两个 Tab（局域网传输 / 跨网络传输）。当前高亮项由 `route` 决定，点击触发路由切换回调。 | i18n |
| `CrossPage.svelte`（新） | 跨网络页外壳：右上角账户入口（`Account`）；未登录且非接收方时显示"需要登录"提示卡 + 登录按钮；登录后渲染 `CrossNetwork`；跨网络专属简短说明；页脚。 | Account、CrossNetwork、auth、i18n |
| `CrossNetwork.svelte`（微调） | 发起/分享/接收 UI 基本不变；分享链接生成指向 `/cross-network#t=<token>`；发起 `start()` 跳转到 `/cross-network#t=<token>`。 | auth、transfer-link、qrcode |
| `Hero.svelte`（微调） | 仅局域网页渲染；保留标语 + 连接状态/IP。与 Nav 的 Logo 去重（Hero 不再重复大 Logo，或 Nav 用紧凑 Logo、Hero 保留主视觉——实现时择一，避免重复）。 | — |

### 局域网页（`route === 'lan'`，URL `/`）内容

- Hero（标语 + 连接状态/IP）
- "附近的设备" peers 区（核心拖拽传输）
- 接收确认卡 / 进度卡（现有）
- FeatureStrip + 使用指南
- 页脚（法律链接）
- **不含任何登录/账户 UI**

### 跨网络页（`route === 'cross'`，URL `/cross-network`）内容

- 右上角账户入口（登录按钮 / 已登录显示邮箱 + 登出）——登录按钮**仅此页出现**
- 未登录且非接收方：醒目提示卡"跨网络传输需要登录后才能发起" + 【登录】按钮
  （点开账户登录框）
- `CrossNetwork` 传输 UI（发起按钮 / 分享链接 + 二维码 / 接收"连接中"）
- 跨网络专属简短使用说明
- 页脚（法律链接）

## 数据流：分享链接 & 接收方

1. 发起方（已登录）点"发送到其他网络的人" → `POST /api/transfers` 生成 token →
   跳转 `/cross-network#t=<token>`（整页导航，WS 重连到 token 房）。
2. 分享链接形如 `https://relayium.com/cross-network#t=<token>`。
3. 接收方点开链接 → `pathname=/cross-network` 且 hash 含 token → 落在跨网络页的
   "连接中"接收状态，**无需登录**。

## i18n

为 6 种语言各新增/调整：

- `nav.lanTab` = "局域网传输" / "LAN transfer" 等
- `nav.crossTab` = "跨网络传输" / "Cross-network" 等
- `crossnet.loginRequired`（新）：跨网络页未登录提示卡的醒目文案
- 复用已有 `crossnet.loginFirst`

## 错误处理 / 边界

- 失效/无效 token（`linkDead`）：现有逻辑保留，提示展示在跨网络页。
- 直接访问 `/cross-network`（无 token、未登录）：展示登录提示卡，不报错。
- `popstate` 在 token 已加载情况下的回退：回到 `/` 时若 WS 仍在 token 房，
  保持当前行为（不强制重连）；纯导航场景以整页导航为主，避免半状态。
- SPA fallback 不得吞掉真实静态文件（资源/法律页）——以"文件存在性"判断为准。

## 测试

- Vitest 单元测试：路由推导函数（pathname/hash → route）、Tab 切换更新 URL 与
  state、token 强制跨网络页。
- 服务端：SPA fallback handler 的单测——真实文件原样返回、未知应用路由返回
  index.html、`/api/`/`/ws` 不被吞。
- 手动验证：`/` 默认局域网且无登录按钮；切到跨网络显示登录提示；登录后可生成
  分享链接；用分享链接在另一浏览器接收无需登录。

## 涉及文件

- `web/src/App.svelte`
- `web/src/lib/Nav.svelte`（新）
- `web/src/lib/CrossPage.svelte`（新）
- `web/src/lib/CrossNetwork.svelte`
- `web/src/lib/Hero.svelte`
- `web/src/lib/i18n.svelte.ts`
- `server/main.go`

## 非目标（YAGNI）

- 不为 `/cross-network` 做独立的 SEO/SSR（沿用同一份 index.html 即可，后续可加）。
- 不引入前端路由库（自实现足够）。
- 不改动接收方的鉴权模型（接收方仍无需登录）。
- 不做局域网/跨网络以外的新页面。
