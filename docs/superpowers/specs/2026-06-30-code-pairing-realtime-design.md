# 6 位短码配对 · 免登录实时直传 — 设计文档

日期：2026-06-30
状态：已批准，待写实现计划

## 目标

让两台**不同网络**下的设备，在**不登录、不生成链接**的前提下，靠一个 6 位短码完成配对，
进行**实时点对点直传**（文件浏览器↔浏览器，不经服务器）。

这是对现有跨网络能力的补充：
- 现有「分享链接」：需登录、带 TURN 中继、连通率高。
- 现有「存储链接」（Mode 1）：需登录、加密存服务器、异步下载。
- **本特性「短码配对」：免登录、仅 STUN、实时直传、不存服务器。**

## 关键约束与判断

1. **配对码是"找到对方的暗号"，不是密钥。** 它和现在局域网"相同公网 IP=同一房间"
   （`server/internal/signal/roomkey.go:27`）、以及分享链接的 token，属于同一类——
   只决定两边进同一个信令房间，**文件本身全程不经服务器**。
2. **本质是实时直传**：两台必须**同时在线**；文件走 WebRTC 直连。
3. **仅 STUN，无 TURN**：服务器连"中继转发密文"都没有，彻底兑现"实时不经服务器"。
   代价：对称型 NAT（公司网/校园网/移动网络常见）可能连不通——此时引导用户改用
   登录后的分享链接（带 TURN）。
4. **TURN 不在本期做新管线**：「登录提升连通性」复用已存在的分享链接+TURN 流程。

## 架构

### 信令：加入"第三种房间键"

现状 `/ws` 处理器（`server/main.go:89-110`）二选一：
- `?room=<token>` 且校验通过 → 房间 `"t:"+token`，`maxPeers=2`（分享链接）
- 否则 → 房间 `RoomKey(r)` = 客户端公网 IP，`maxPeers=0`（局域网自动发现）

**新增第三分支**：
- `?code=<6位码>` 且校验通过 → 房间 `"c:"+code`，`maxPeers=2`
- 校验失败（码不存在/已过期/房满）→ HTTP 403，不建立 socket

房间/转发逻辑（`Hub.rooms`、SDP/ICE 中继、`welcome`/`peers` 信令）**完全复用**，
不改 `hub.go` 的协议；只是房间键多了一种来源。

### 数据流

```
发送方                          服务器                          接收方
  │  点"发送"                      │                              │
  ├── POST /api/pair (匿名,限速) ──►│  Mint(): 生成全局唯一6位码     │
  │◄── { code:"424242", expiresAt }│  存入 PairRegistry (TTL 5min) │
  │  设 #c=424242 并 reload,显示码   │                              │
  │                               │              口头/IM 告知码 ──►│ 输入 424242
  │                               │◄── /ws?code=424242 ───────────┤ 设#c=并reload
  │── /ws?code=424242 ───────────►│  Validate(): 通过 → 房间c:424242│
  │◄═══════ 同一信令房间, 交换 SDP/ICE ═══════════════════════════►│
  │◄══════════ WebRTC DTLS 直连 (STUN), 文件直传 ════════════════►│
  │                               │ (满2人 → 房满, code 作废)       │
```

### 客户端如何进入 code 房间（复用现有 token 重载机制）

现有分享链接的进房方式是：把 token 放进 URL 片段 `#t=<token>`，
`history.replaceState(CROSS_PATH#t=token)` 后 `location.reload()`，
`App.svelte` 的 `onMount` 读 `#t=` 并用 `wsURL(location, token)` 连 `/ws?room=token`。

**code 配对完全复刻这套**，只是片段换成 `#c=<code>`：
- 新增 `parseCodeParam(hash)`（`/^#c=(\d{6})$/`）。
- `wsURL` 增加 code 形参 → 有 code 时拼 `/ws?code=<code>`。
- `routeFromLocation`：`#c=` 也判为 `cross` 路由（与 `#t=` 一致）。
- 发送方拿到码后 `replaceState(CROSS_PATH#c=code)` + `reload`，重载后从 `#c=` 读回码、连接、显示码供口头转告。
- 接收方输入码后同样 `replaceState(CROSS_PATH#c=code)` + `reload`。
- ICE：`fetchIceServers("")`（无 token）天然只返回 STUN——正符合 code 仅 STUN 的设计。

## 架构修订：实时传输界面必须上跨网络页（修复既有缺口）

**核实发现**：真正的实时传输界面（设备列表 `peers`、选文件、进度卡、SAS 校验）
**全部在 `App.svelte` 内，且只在"局域网"路由分支渲染**；跨网络路由只渲染 `CrossPage`
（仅"分享链接/连接中/发送按钮"，无传输入口）。即**现有分享链接只到"配对/出链接"，
页面上并无"挑文件发送"的 UI**——这是既有缺口。

代码配对要真能传文件，跨网络页必须有这套界面；而它对 code 房间、token 房间、LAN 房间
是**同一套**。故本期：

- 用 **Svelte 5 snippet** 把 `App.svelte` 里"peers + incoming 接收确认卡 + xfer 进度卡"
  那段渲染抽成 `{#snippet transferSurface()}…{/snippet}`，**闭包复用** App 既有的
  transfer 状态与处理函数（`peers`/`send`/`recv`/`incoming`/`sendFiles`/`acceptFn` 等），
  **不搬动**那段微妙的传输逻辑（背压/flush/SAS/接受手势），把回归风险降到最低。
- LAN 分支 `{@render transferSurface()}`；并把该 snippet 作为 prop 传给 `CrossPage`，
  在"实时直传"卡里 `{@render transferSurface()}`。
- 结果：**code 路径与现有分享链接路径都获得真正可用的传输 UI**。
- （后续可选清理：把传输逻辑整体抽成独立组件以缩小 `App.svelte`；本期不做，避免大重构回归。）

## 组件

### 服务器（Go）

- **`PairRegistry`（新）**：内存结构，仿 Hub 风格。
  - `Mint() (code string, expiresAt int64)`：生成不与现存活跃码冲突的随机 6 位码，
    存 `{code, createdAt, expiresAt}`，TTL=5 分钟。
  - `Validate(code) bool`：存在且未过期。
  - 过期回收：后台 ticker（仿 metering/GC worker）清理过期码。
  - 满 2 人即作废：由 `maxPeers=2` 在 Hub 层保证第三者进不来；码本身随过期或房满失效。
- **`POST /api/pair`（新，匿名端点）**：返回 `{code, expiresAt}`；**按客户端 IP 限速**
  （防刷码占用码空间）。无需登录。
- **`/ws` 第三分支（改 `main.go`）**：解析 `?code=`，调 `PairRegistry.Validate`，
  通过则房间 `"c:"+code`、`maxPeers=2`，否则 403。

### 前端（Svelte）

- **`transfer-link.ts`（改）**：新增 `parseCodeParam(hash)`、`createPair()`（POST /api/pair）、
  `wsURL` 增加 code 形参。
- **`router.svelte.ts`（改）**：`routeFromLocation` 让 `#c=` 也判为 `cross`；
  `navigate` 的"有片段则整页重载"逻辑同时覆盖 `#c=`。
- **`CodePairing.svelte`（新）**：
  - 未持码时显示"发送 / 接收"两个入口。
  - 发送：点按钮 → `createPair()` → `replaceState(CROSS_PATH#c=code)` + `reload`；
    重载后从 `#c=` 读回码、大字显示 + 复制 + 倒计时（5 分钟）。
  - 接收：6 位输入 → `replaceState(CROSS_PATH#c=code)` + `reload`。
  - 错误（码非法/过期/房满，由 `App` 的 `linkDead` 信号驱动）→ 友好报错（`t.pair.err*`）。
- **`App.svelte`（改）**：解析 `#c=`（`roomCode`）；`wsURL`/路由判定纳入 code；
  把 peers/接收卡/进度卡那段包成 `{#snippet transferSurface()}`；LAN 分支与
  `CrossPage` 都渲染它。
- **`CrossPage.svelte`（改）**：拆成两张"处境卡"。
  - 「⚡ 实时直传」卡：未进房 → `CodePairing`（免登录）+ **登录用户**额外看到现有
    `CrossNetwork`"生成分享链接(带 TURN)"作为增强；已进房（code 或 token，有对端）→
    `{@render transferSurface()}`；底部注"免登录 · 登录可提升连通性"。
  - 「📦 存储链接」卡：放现有 `StoredUpload`（需登录），逻辑不动，仅位置归整。
  - 接收 `transferSurface`、`roomCode`、`joinedRoom`、`peers` 等 prop。
- **i18n**：新增 `pair` 段（发送/接收/显示码/复制/倒计时/错误等键），覆盖全部 6 种语言。

## 安全模型

威胁模型：休闲式 P2P 文件传输，非对抗国家级攻击者。

- **抗暴力枚举**：码由服务器**均匀随机**生成（10⁶ 空间）；TTL 仅 5 分钟；`/ws` 按 IP 限速
  加入尝试；满 2 人即房满。真实配对窗口只有几十秒（读码给对方的时间），该窗口内扫中特定码
  且抢在真实接收方之前，在限速下不可行。
- **端到端加密**：数据走 WebRTC DTLS，即便有人占座也读不到内容，至多在建连阶段制造干扰/拒绝。
- **限速 `/api/pair`**：防止刷空码空间。
- **不泄露 IP**：延续现有设计（`hub.go:30` IP 仅回给本人），短码路径不向对端暴露 IP。
- **后续增强（本期不做）**：SAS——双方比对一个由连接密钥派生的短词/emoji，确认连的是对方而非中间人。

## 范围（YAGNI）

**本期做**：
- 匿名 `POST /api/pair` + `PairRegistry` + 过期回收 + IP 限速。
- `/ws` 的 `?code=` 第三分支（`maxPeers=2`）。
- 客户端 code 进房机制（`#c=` + `parseCodeParam` + `wsURL`/路由纳入 code）。
- `CodePairing.svelte`（发送/接收）。
- 把实时传输界面抽成 `transferSurface` snippet，**在跨网络页渲染**（修复既有分享链接缺口）。
- 跨网络页两卡重排；i18n `pair` 段（6 语言）。

**本期不做**：
- 短码的 TURN 新管线（登录增强复用已有分享链接流程）。
- SAS / 防中间人短词校验。
- 跨设备"我的文件"（已存档暂缓，见 `2026-06-30-cross-device-my-files-DEFERRED.md`）。

**复用不动**：
- 现有分享链接+TURN 流程（`/api/transfers`、token 房间、`/api/ice`）。
- 现有实时传输 UI（`CrossNetwork.svelte` 传输部分）。
- 现有存储链接卡（`StoredUpload.svelte`）。
- 现有信令协议（`hub.go` 的 `welcome`/`peers`/relay）。

## 测试

- **`PairRegistry`**：Mint 唯一性（不与活跃码冲突）、Validate 命中/未命中/过期、过期回收。
- **`/ws` code 分支**：合法码进 `"c:"+code` 房间；非法/过期码 403；第三者被 `maxPeers=2` 拒绝。
- **限速**：`/api/pair` 超频被限。
- **前端**：`CodePairing` 发送取码/接收输码状态；错误码报错文案；i18n 完整性测试纳入 `pair` 段。

## 集成点（现有代码）

- `server/main.go:89-110` — `/ws` 房间键分支，新增 `?code=`（`validatePair` 注入，仿 `validateRoom`）。
- `server/internal/signal/` — 新增 `PairRegistry` + 过期回收（与 Hub 同包）。
- `server/internal/account/files.go` 或新 `pair.go` + `handlers.go` `Routes()` — 注册匿名 `POST /api/pair`（**不**走 `RequireSession`）+ 简单的内存 IP 限速器。
- `web/src/lib/transfer-link.ts` — `parseCodeParam`、`createPair`、`wsURL` 加 code 形参。
- `web/src/lib/router.svelte.ts` — `routeFromLocation`/`navigate` 纳入 `#c=`。
- `web/src/lib/App.svelte` — 解析 `roomCode`；`transferSurface` snippet；LAN 与 CrossPage 共用。
- `web/src/lib/CodePairing.svelte`（新） — 发送/接收码 UI。
- `web/src/lib/CrossPage.svelte` — 两卡重排，渲染 `transferSurface`。
- `web/src/lib/i18n.svelte.ts` — 新增 `pair` 段（6 语言）。
