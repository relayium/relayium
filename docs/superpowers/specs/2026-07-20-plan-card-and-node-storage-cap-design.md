# 个人中心会员区块 + 节点存储容量口径修正

**日期**: 2026-07-20
**状态**: 已确认，待实现

两个独立的改动，打包在一起交付。Part A 是产品功能（个人中心展示会员信息并引导升级），Part B 是 bug 修复（管理员后台节点存储数字口径错误）。两者不共享代码，可以并行实现、分别验证。

---

## Part A — 个人中心会员区块

### 问题

`/me` 页面（`web/src/lib/MePage.svelte`）已经通过 `QuotaMeters.svelte` 展示"本月用量"，但完全没有会员信息：用户不知道自己在哪个档、这个档包含什么、也没有升级入口。升级入口目前只藏在右上角账号弹窗里（`Account.svelte:290` 的 billing-section）。

### 设计

#### 后端：扩展 `/api/me/usage`

`handleMeUsage`（`server/internal/account/handlers.go:412`）在第 433 行已经为了算 storage cap 查过 `plan` 了。把它加进响应即可，**不产生额外查询**。

响应新增 `plan` 字段（纯增量，现有消费方 `QuotaMeters` / `QuotaNotice` 不受影响）：

```json
"plan": {
  "id": "free",
  "name": "免费版",
  "storageBytes": 104857600,
  "trafficBytes": 1073741824,
  "retentionSecs": 259200,
  "priceMonthly": 0,
  "isTop": false,
  "subscriptionStatus": "",
  "subscriptionEnd": 0
}
```

字段说明：

- `name` / `storageBytes` / `trafficBytes` / `retentionSecs` / `priceMonthly` 取自 `Plan` 结构体（`store.go:61`）。沿用现有约定：`<= 0` 规约成 `0` 表示无限。
- `subscriptionStatus` / `subscriptionEnd` 取自 `User`（`store.go:29`），用于判断是否显示"管理订阅"和到期日。
- `isTop`: 该套餐是否为 `plans` 表中 `active=1` 且 `sort_order` 最大的一档。用于在最高档时把「升级套餐」替换为「已是最高档」——把 Max 用户往定价页赶是负体验。需要 store 侧一个轻量查询（取最大 sort_order 的 active plan id）。

#### 前端：`PlanCard.svelte`

新组件，插在 `MePage.svelte:233` 的 `<QuotaMeters />` **上方**。会员身份是用量的上下文，应当先于用量出现。

卡片布局（沿用 `QuotaMeters.svelte:63` 的 `.quota` 卡片样式，保持视觉一致）：

```
┌────────────────────────────┐
│ 当前套餐   [ 免费版 ]       │
│ 100 MB 存储 · 1 GB/月流量   │
│ · 文件保留 3 天             │
│                            │
│ 空间不够用？升级可获得更大   │
│ 容量和更长保留期。          │
│           [ 升级套餐 ]      │
└────────────────────────────┘
```

行为：

- 「升级套餐」→ `navigate("pricing")`，照抄 `QuotaNotice.svelte:43`。
- 有订阅的用户（`subscriptionStatus` 非空）额外显示「管理订阅」，走 `POST /api/billing/portal` 并跳转返回的 `url`，照抄 `Account.svelte:150` 的 `onManageBilling`（含 `portalBusy` 防重复点击与 `portalError` 兜底）。
- `subscriptionStatus` 非空时在套餐名旁显示状态与 `subscriptionEnd` 日期。
- `isTop === true` 时隐藏「升级套餐」，显示 `me.plan.topTier` 文案。
- 取不到 `/api/me/usage` 时整块不渲染，与 `QuotaMeters.svelte:17` 的策略一致。

#### 顺带清理：共享 usage fetch

`/api/me/usage` 目前被 `QuotaMeters` 和 `QuotaNotice` 各 fetch 一次，加上 `PlanCard` 就是三次同样的请求。

抽 `web/src/lib/usage.svelte.ts`：导出一个函数返回缓存的首个 promise（模块级单例），三处共用。这是本次改动直接引入的问题，属于"改到哪就顺手修哪"，不是无关重构。

#### i18n

现有可复用（`t.billing.*`）：`currentPlan`、`upgrade`、`manageBilling`、`portalError`。

新增 3 个 key，放在 `Messages` 的 `me` 块下（`web/src/lib/i18n/types.ts`），再补齐 9 个语言文件（`zh/en/ja/ko/de/fr/ar/es/pt`）——缺任何一个 TS 编译会报错，这就是保障：

- `me.plan.perks(storage, traffic, days)` — 权益一行，插值函数
- `me.plan.hint` — 引导句
- `me.plan.topTier` — 最高档提示

### 测试

- `handleMeUsage` 返回 `plan` 字段，免费用户与付费用户各一例。
- `isTop` 判定：最高档用户为 `true`，其它为 `false`。
- 套餐不存在时回落 `freePlanFallback()`（`plan_enforce.go:8`），`plan` 字段仍完整。

---

## Part B — 节点存储容量口径修正

### 问题

管理员后台节点表（`admin_templates.go:277`）有三个存储相关的数字，其中两个有问题：

1. 「存储」列显示 `StoredBytes`，节点上报为 `total - free`（`server/cmd/relayium-node/relay.go:242`）。这是**整卷已用字节**，包含操作系统和其它程序，不是 relayium 的存量。盘上装了别的东西时该数字严重虚高。
2. 「硬盘上限」显示 `DiskLimitBytes`，是管理员手填的值，默认 `0` 即 ∞。系统从来没有自动推导过一个合理的容量上限。

后果不止于展示。`StoredBytes` 同时驱动中心端调度过滤（`sqlite.go:2122` 的 `disk_limit_bytes - stored_bytes >= ?`）和节点本地写入准入（`cmd/relayium-node/storage.go:27` 的 507），节点会因为系统盘上的无关数据被误判为配额耗尽而排除出调度。

### 设计

#### 1. 修 `storedBytes` 口径

给 `storage.DiskStore` 加 `UsedBytes()`：`filepath.WalkDir` 累加 blob 目录下文件大小。

心跳每 30s 一次，目录遍历不能同步塞在心跳路径上。做法：后台按心跳周期刷新一个缓存值，心跳读缓存。首次上报前先算一次。

替换两处 `total - free`：

- `relay.go:242` 心跳上报的 `storedBytes`
- `relay.go:159` 的 `diskUsed` 闭包（与管理员限额比对的那个）

改完后「已用 vs 管理员限额」两侧终于是同一口径。

#### 2. 新增"可用容量"（剩余 × 70%）

不能把硬盘用满，保留 30% 余量。

**在中心端派生，不加协议字段、不加数据库列**：`adminNodeView`（`server/internal/account/admin.go:32`）计算 `UsableBytes = StorageFree * 7 / 10`。后台表格新增一列「可用(70%)」。

#### 3. 调度过滤应用 70%

`sqlite.go:2122` 的 `storage_free >= ?` 改为 `storage_free * 7 / 10 >= ?`，让 30% 余量在选节点阶段就生效。

#### 4. 写入硬闸保持不变

节点本地仍是 `relay.go:168` 的「剩余 < 总量 20% 拒写」。

**这是刻意的**：70% 若直接当写入闸门会自指——写进去 free 变小，阈值跟着变小，永远追不上。所以 70% 是**调度与展示**口径，硬闸是一个独立的、以总量为基准的绝对下限。两者互补，不互相替代。

### 测试

- `DiskStore.UsedBytes()` 只统计 blob 目录：在同一文件系统上放一个目录外的文件，断言不计入。
- 调度过滤：`storage_free = 2.9 GB` 的节点在请求 2.5 GB 时被排除（2.9 × 0.7 = 2.03 < 2.5），请求 1.5 GB 时入选。
- `adminNodeView` 派生 `UsableBytes`。
- 修正 `node_disk_cap_test.go`：它当前把 `stored_bytes` 当作"relayium 存量"来构造用例，正好掩盖了整卷口径问题；口径修正后用例语义需要跟着改。

### 部署提醒

存量节点上报的 `stored_bytes` 会从"整卷已用"骤降到"blob 实际占用"（示例：15.4 GB → 几 MB）。后台看起来像数据丢失，**这是修复的预期表现**，不是回归。

连带地，管理员按旧口径手填的 `disk_limit_bytes` 含义也变了，建议按新口径重新评估一遍。以那台 18.3 GB 的机器为例：旧版 stored 显示 15.4 GB，管理员填 16 GB 限额，剩余额度是 `16 GB − 15.4 GB = 0.6 GB`（过紧，正是本次要修的"被误判为配额耗尽"）；合并后同一个 16 GB 变成 `16 GB − 500 MB = 15.5 GB`，对一块 18.3 GB 的盘来说这道闸近似形同虚设。

**这不危险，只是那道闸没在起作用**：另外两道闸仍以语义未变的 `storage_free` 为准（`storage_free*7/10 >= minFree` 的可用容量判定，以及整卷 80% 满的熔断），实际可放置量依然被钉死，不会撑爆磁盘。所以这条属于"抽空重设一下，别误以为自己还有一道生效的配额闸"，不是需要紧急处理的事故。
