# 免费额度调整、月中改档防套利与用户侧用量可见性

日期：2026-07-19
状态：设计已确认，待实现

## 背景

三件事促成本次改动：

1. 免费额度偏高（2 GiB/月流量），需要下调。
2. 月中按比例升级存在套利漏洞，**该漏洞现已在线上生效**，与本次免费额度调整无关，但顺手一起修。
3. 用户侧完全看不到自己的用量。`/api/me`、`/api/stats`、`/api/usage` 均不返回当月用量与上限，用户只能在撞到 429 时才知道超额。`/api/stats` 展示的"终身累计"与真正生效的当月配额是两个不同的数，反而具有误导性。

### 已确认的现状（勘误）

- **付费已经是订阅制**，不是买断。`stripe.go:234` 使用 `mode=subscription`，月付与年付都是 recurring price。本次不改订阅模式。
- **免费额度已经是按月重置**，且没有任何 cron。`usage_monthly` 以 `(user_id, period='YYYYMM')` 为主键，新月份行不存在时 `UserMonthlyUpDown` 返回 0（`sqlite.go:1786`），天然归零。本次保持该机制不变。

### 明确不做的事

- 不改订阅模式（已经是订阅制）。
- 不改 `periodOf()` / `monthRange()` 语义，不引入按订阅周期锚定的配额窗口。
- 不做"免费额度 + 套餐额度"叠加。收益过小（Plus 流量仅 +0.3%，存储 +2%），不值得引入概念复杂度。
- 不调整付费三档的存储/流量/价格。
- 不做免费额度一次性发放（曾考虑，后否决，保留月度重置）。

## 决策一：免费档数值下调

| 项 | 现值 | 新值 |
| --- | --- | --- |
| 流量 | 2 GiB/月 | **1 GiB/月** |
| 存储 | 100 MiB | 不变 |
| 保留期 | 3 天 | 不变 |

付费三档（Plus 5 GiB / 300 GiB / $3.90，Pro 50 GiB / 1 TiB / $8.90，Max 250 GiB / 5 TiB / $19.90）完全不动。

### 部署陷阱与迁移

`SeedPlans`（`settings.go:211`）只在 plan id **不存在**时写入，以保护 admin 后台的手工编辑。因此仅修改 `defaultPlans()`（`settings.go:203`）对已上线的库无效。

需要一条**幂等迁移**：仅当线上 `plans` 表 free 档的 `traffic_bytes` 仍等于旧值 `2 GiB` 时，才更新为 `1 GiB`。若值已被 admin 改成别的数，跳过不动。迁移必须可重复执行且第二次执行为 no-op。

## 决策二：额度不叠加

`cap = 用户当前档的 cap`。免费用户 1 GiB/月，Plus 用户 300 GiB/月（不是 301 GiB）。存储同理，Plus 是 5 GiB（不是 5 GiB + 100 MiB）。

`overTraffic` / `overStorage`（`plan_enforce.go:51`、`:69`）的 cap 取值逻辑在这一点上保持现状。

## 决策三：重置周期保持自然月

流量按自然月重置（每月 1 日 UTC 00:00）。前端必须明确写出重置日期。

### 为什么不锚定订阅日

曾考虑"赠送桶走自然月、订阅桶走订阅日锚定"的双桶方案，否决原因：

- 月中订阅并不会让用户吃亏。"重置"是 refill 而非作废——7/28 订阅的用户在 7/28–7/31 有完整额度，8/1 又 refill 一份完整额度。自然月对月中订阅者**永远是多给**。
- 唯一的真实风险是首月双份额度的成本敞口，而该敞口由决策四一并解决。
- 年付订阅的 Stripe `current_period` 长达一年，直接锚定会让年付用户变成"每年一份额度"，严重劣于月付。规避它需要额外引入"固定一个月长度、锚定订阅日"的自定义周期，复杂度不划算。

## 决策四：月中改档按分段累加计算流量额度（C2）

### 漏洞描述

`billing.go:154-166` 的升级**立即生效**，Stripe 按剩余天数比例收费；但流量额度按自然月发放整份。两者不对称：

7/30 从 Plus 升到 Max，Stripe 只收约 2/31 的差价（约 $0.7），cap 立刻从 300 GiB 跳到 5120 GiB。**花 $0.7 买到约 4800 GiB 中继流量。** 配合 7/31 订阅 → 拿 7 月整份 + 8/1 refill 拿 8 月整份 → 周期末取消 → 次月末再订，可实现约 2 倍的持续套利。

### 方案对比

场景：Plus 用户 7 月已用满 300 GiB，7/30 升 Max，7 月共 31 天。

| 方案 | 升级后 cap | 正经用户多拿 | 套利者多拿 |
| --- | --- | --- | --- |
| C0 不补 | 5120 GiB | 4820 GiB | 4820 GiB（洞） |
| C1 纯按比例 | 5120 × 2/31 = 330 GiB | 30 GiB（挡转化） | 330 GiB |
| **C2 分段累加** | 280 + 330 = **610 GiB** | 310 GiB | 330 GiB |

C1 被否决的原因：它抹掉了用户 7/1–7/30 这 29 天作为 Plus 用户本就应得的额度（那 29 天他付了 Plus 的钱）。后果是月中超额的用户升级后几乎没有解封——而月中超额恰恰是升级转化最强的时刻，C1 在这个时刻给出最差体验。

### C2 算法

一个月按档位变更切成若干段，每段按「该段占全月的比例 × 该段档位的 cap」计算，求和：

```
7/1  – 7/30  Plus:  300  × 29/31 = 280 GiB
7/30 – 7/31  Max:   5120 × 2/31  = 330 GiB
                         当月 cap = 610 GiB
```

**仅对流量生效。存储不按比例发放**——存储是存量而非流量，按比例发意味着要求用户删除已有文件，语义荒谬。改档后存储 cap 立即为新档全额。

### 数据模型

`users` 表新增三列（沿用现有幂等 `ALTER` 迁移模式，参考 `sqlite.go:305-319`）：

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `plan_started_at` | INTEGER DEFAULT 0 | 当前档位从何时开始生效 |
| `quota_accrued_bytes` | INTEGER DEFAULT 0 | 本月此前各段累计应得的流量额度 |
| `quota_accrued_period` | TEXT DEFAULT '' | 该累计值所属月份（`YYYYMM`），跨月自动作废 |

无需回填历史数据。存量用户三列均为零值，`quota_accrued_period` 与当前月不匹配，直接走满额分支——即现状行为。

### 改档时（写路径）

```
if quota_accrued_period != periodOf(now):
    accrued = 0
monthStart, monthEnd = monthRange(periodOf(now))
segStart = max(plan_started_at, monthStart)
accrued += 旧档.TrafficBytes × (now - segStart) / (monthEnd - monthStart)
quota_accrued_period = periodOf(now)
plan_started_at      = now
plan_id              = 新档
```

按秒计算而非按天，避免边界日的舍入争议。

三个改档入口全部要接：

1. Stripe webhook（`billing.go:294` `customer.subscription.created/updated`，`:359` `deleted`）
2. 站内升降级（`billing.go:87` `handleBillingChangePlan`）
3. admin 手工改档（`admin.go:566`）

写路径必须与 `plan_id` 的更新在同一事务内，否则崩溃会导致额度错算。

### 查询时（读路径）

在 `plan_enforce.go` 新增 `monthlyTrafficCap(ctx, userID) (int64, error)`，`overTraffic` 改为调用它取 cap：

```
if quota_accrued_period == periodOf(now):
    monthStart, monthEnd = monthRange(periodOf(now))
    segStart = max(plan_started_at, monthStart)
    cap = quota_accrued_bytes + 当前档.TrafficBytes × (monthEnd - segStart) / (monthEnd - monthStart)
else:
    cap = 当前档.TrafficBytes        // 本月未改档，给满
```

绝大多数用户走 else 分支，无额外开销。

`cap <= 0 表示无限` 的现有语义保持不变：若当前档 cap 非正，`monthlyTrafficCap` 直接返回非正值，`overTraffic` 照常放行。

同样保持现有的 **fail-open** 原则（`plan_enforce.go:11-13`）：真实的 store 错误向上传播让门放行，而非误判成 Free。

### 覆盖的场景

| 场景 | 结果 |
| --- | --- |
| 本月未改档 | 满额（else 分支） |
| 月中升级 | 分段累加，见上例 |
| 月中新订阅（free → plus，7/28） | `1 × 27/31 + 300 × 4/31 ≈ 39 GiB`；8/1 起满额 300 GiB |
| 降级 | 期末生效，webhook 改档时同样固化前一段 |
| 取消订阅 | `subscription.deleted` 降回 free，走同一路径 |
| 一月内多次改档 | 每次固化前一段，天然正确 |
| 跨月 | `quota_accrued_period` 不匹配，累计作废，给满 |

### 已知且接受的不精确

- admin 在 `plans` 表直接修改某档的 `traffic_bytes` 时，不会触发重新累计。该档 cap 的变化只影响当前段及之后的计算。影响面极小（admin 罕有操作），不值得为此增加复杂度。
- 中继流量经 `usage_periods` 异步上报，晚到的字节按上报时刻归入当月。C2 只改 cap 的计算，不改用量的归属，此行为维持现状。

## 决策五：用户侧用量 API

新增 `GET /api/me/usage`（需 session）：

```json
{
  "period": "202607",
  "resetsAt": 1754006400,
  "traffic": { "used": 0, "cap": 0 },
  "storage": { "used": 0, "cap": 0 }
}
```

- `traffic.used` = `currentMonthTraffic()`（`plan_enforce.go:34`）
- `traffic.cap` = `monthlyTrafficCap()`（决策四新增）
- `storage.used` = `CurrentStorage()`（`sqlite.go:1796`）
- `storage.cap` = 当前档的 `StorageBytes`
- `resetsAt` = 当月 `monthRange()` 的 end
- `cap` 为 0 表示无限，前端据此隐藏进度条

底层查询函数全部现成，此前唯一的消费者是 `plan_enforce.go` 的门禁逻辑。

## 决策六：前端展示

### MePage.svelte

新增两条进度条（流量、存储），各显示：已用 / 上限 / 剩余 / 重置日期。文案需明确写出"每月 1 日 (UTC) 重置"。

同时修正现有误导：`MePage` 当前只展示 `/api/stats` 的**终身累计**（transfers/downloads/uploadBytes/downloadBytes/relayBytes），与真正生效的当月配额是两个不同的数。需要把**当月用量放在主位**，终身累计降级展示或明确标注为"累计"。

### 临界提醒

用量达到 cap 的 **80%** 时，在传输界面展示提醒条，引导升级。目的是避免用户毫无预警地撞上 429。

免费用户与付费用户使用同一套提醒逻辑与阈值。

## 开工前的验证项

**线上 `plans` 表的 `stripe_price_yearly_id` 是否真的配置了。** 年付 UI 已存在（`Pricing.svelte`），若 price id 未配置，年付按钮点击会失败。

- 已配置 → 保留月付/年付双选项，定价页默认突出月付、年付作为"省 XX%"的切换项。
- 未配置 → 从定价页撤掉年付，只保留月付。

此项为运行时配置核查，不是设计决策。

## 测试要点

- 幂等迁移：旧值 2 GiB 时更新为 1 GiB；值已被改动时跳过；重复执行为 no-op。
- `monthlyTrafficCap`：本月未改档走满额分支；月中升级/降级/新订阅/取消各自的分段累加结果；一月内多次改档；跨月后累计作废。
- 秒级比例计算在月初、月末、闰年 2 月的边界正确性。
- `cap <= 0`（无限）时 `overTraffic` 仍放行。
- fail-open：store 报错时门放行而非误判 Free。
- 改档写路径与 `plan_id` 更新的事务性。
- `GET /api/me/usage` 需 session；未登录返回 401。
- 三个改档入口（webhook / 站内升降级 / admin）均正确固化前一段。

## 相关文档

- `2026-07-06-admin-per-user-usage-metering-design.md` — `usage_monthly` 按月计量的上游设计
- `2026-07-06-billing-plans-phase1-design.md` — 档位配置与额度强制；第 84 行是"自然按月重置"的原始决策
- `2026-07-14-billing-stripe-phase2-design.md` — Stripe 接入
- `2026-07-15-billing-upgrade-pricing-page-design.md` — 站内升降级与定价页
