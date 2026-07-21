# 订阅体验优化 设计文档

日期：2026-07-21
状态：已与用户确认，待写实现计划

## 背景与问题

用户在实际使用订阅功能时反馈三类问题。逐一排查代码后确认了根因：

### 问题 1：升级/改档流程有真实 bug

- **`trialing` 订阅改档必 500。** `stripeClient.ChangeSubscriptionPlan`（stripe.go:274）、`ScheduleDowngrade`（stripe.go:325）、`ReleaseSchedule`（stripe.go:409）在向 Stripe 列订阅时都写死了 `status=active`。而 webhook 把 `active` **和 `trialing`** 都当作有效订阅并授予套餐（billing.go:389）。于是一个处于试用期的用户：webhook 已把 `plan_id` 设成付费档、`/api/me` 显示已订阅、前端 `isSubscribed` 为真、定价页给出改档按钮——但一点改档，服务端 `status=active` 查不到那条 `trialing` 订阅，返回 `no active subscription` → handler 500。
- **首次订阅成功落地页错位。** `CreateCheckoutSession` 的 `SuccessURL` 是 `s.cfg.BaseURL + "/?billing=success"`（billing.go:53），跳首页而非 `/me`，用户付完款看不到自己的新套餐状态。

### 问题 2：订阅变更体验差

- **改周期路径隐蔽。** 月付改年付要：进 `/pricing` → 找到顶部不显眼的 monthly/yearly 小切换器 → 翻到 yearly → 再点自己那档的按钮。切换器与卡片按钮的因果关系不直观。
- **确认无信息。** 变更确认用浏览器原生 `confirm()`（Pricing.svelte:136），**不显示这次实际扣多少钱、何时生效**。升级是立即按比例扣款（stripe.go:309 `create_prorations`），用户却完全不知道会被扣多少。
- **周期切换器默认月付，不跟随当前订阅。** `cycle` 初始恒为 `"monthly"`（Pricing.svelte:26）。年付用户进定价页看到的是月付视图，自己那档的 CTA 显示成「切换到月付」（一个降级），严重误导。

### 问题 3：当前套餐显示不明显

- **卡片数据源缺周期字段。** `/me` 会员卡 `PlanCard.svelte` 刻意用 `fetchUsage` 返回的 `PlanInfo`（usage.svelte.ts）作为「新鲜」数据源（`session().user` 是登录快照会漂移）。但 `PlanInfo` **不含 `billingCycle`**，所以卡片在代码层面就无法显示月付/年付。
- **状态串未加工。** 卡片直接渲染原始 `subscriptionStatus`（"active" 等，PlanCard.svelte 的 `.sub`），未本地化、不友好；没有周期、没有下次续费/到期日、没有价格。

## 设计目标

让用户在 `/me` 一眼看清自己「哪档 + 月付还是年付 + 下次扣款/到期」，并让升级、降级、换周期、跨档换周期这几类变更都走同一个信息充分、可预知扣款的应用内确认流程；同时修掉 trialing 改档 500 与落地页错位两个 bug。

## 设计

### A. 服务端

#### A1. 修订阅查询的状态过滤（bug 修复）

`ChangeSubscriptionPlan`、`ScheduleDowngrade`、`ReleaseSchedule` 三处列订阅时不再写死 `status=active`。改为查 `status=all&limit=...`，在返回结果里挑第一条「可变更的活订阅」——状态属于 `{active, trialing, past_due}` 的那条。抽一个小私有 helper（如 `findLiveSubscription(list) (sub, ok)`）供三处复用，避免各写一份筛选逻辑漂移。

- 判定集合以常量/集合形式集中定义，注释写清为什么 `trialing` 必须纳入（与 webhook 的授予口径一致）。
- 找不到活订阅时仍返回原来的 `no active subscription` 错误（handler 会 500 或按现有语义处理），行为对「确实没有订阅」的情况不变。

#### A2. 新增 `POST /api/billing/preview`

在用户确认变更前，返回这次变更的真实后果，供前端弹窗展示。

- 入参：`{ planId, cycle }`（与 change-plan 同形）。
- 鉴权/前置：同 `handleBillingChangePlan`——`biller != nil`、`StripeCustomerID != "" && PlanSource == "stripe"`，否则 409 `no_active_subscription`。
- 复用 `handleBillingChangePlan` 里已有的方向判定逻辑（档位优先、同档看周期），把「升级 vs 降级」和目标 priceID 算出来。**这段方向判定要抽成一个纯函数**（如 `resolveChange(cur, target Plan, wantCycle string) (priceID string, downgrade bool)`），让 change-plan 和 preview 共用同一份规则，杜绝两条路径判定不一致。
- 升级（立即生效）：调新增的 `Biller.PreviewChange(ctx, customerID, newPriceID)`，内部走 Stripe `GET /v1/invoices/upcoming`（`customer` + `subscription` + `subscription_items[0][id]` + `subscription_items[0][price]` + `subscription_proration_behavior=create_prorations`），取即时应付总额与下一期金额/日期。
- 降级（期末生效）：无即时发票，直接返回 `effective=period_end` 与生效日（当前订阅的 `current_period_end`）。
- 响应 JSON（金额均为美分，前端负责格式化与本地化）：
  ```json
  {
    "effective": "now" | "period_end",
    "immediateChargeCents": 1234,     // effective=now 时的即时按比例应付；降级为 0
    "nextAmountCents": 5999,          // 下一期完整金额
    "nextCycle": "monthly" | "yearly",
    "effectiveDate": 1789999999       // unix 秒：now 时为下次续费日；period_end 时为生效日
  }
  ```
- 新增 `Biller` 接口方法 `PreviewChange(ctx, customerID, newPriceID string) (ChangePreview, error)`，`stripeClient` 实现，测试用的假 Biller 补一份。

#### A3. 扩展 `PlanInfo`（/api/me/usage 的套餐投影）

给 `PlanInfo`（usage.svelte.ts 对应的服务端结构，定位在返回 `/api/me/usage` 的 handler）补足卡片展示所需的、来自「新鲜」数据源的字段：

- `billingCycle`（"monthly" | "yearly" | ""）
- `priceYearly`（美分；已有 `priceMonthly`）
- `scheduledPlanId`、`scheduledPlanName`（排期降级的目标档；无则空）

`subscriptionStatus`、`subscriptionEnd` 已有，保留。前端据 `billingCycle` 选用 `priceMonthly`/`priceYearly` 显示当前周期价格。

#### A4. 修 checkout 落地页

`CreateCheckoutSession` 的 `SuccessURL` 改为 `s.cfg.BaseURL + "/me?billing=success"`。`CancelURL` 可一并指向 `/me?billing=cancel`（次要）。

### B. 前端

#### B1. PlanCard 重做为信息卡

按确认的信息卡布局渲染（数据全部取自扩展后的 `PlanInfo`）：

```
┌───────────────────────────────┐
│ 当前套餐           Plus 年付   │   ← 名称 + 周期徽章
│ $19.99/年 · 下次续费 2026-08-21 │   ← 当前周期价格 + 友好状态/日期
│ 存储 50GB · 流量 200GB · 7天    │   ← 额度
│ ⏳ 已排期：期末降到 Free        │   ← 仅当 scheduledPlanId 非空
│ [更改套餐]        [管理账单]    │
└───────────────────────────────┘
```

- **友好状态 + 日期**按 `subscriptionStatus` 分支本地化：
  - `active` → 「下次续费 {date}」
  - `trialing` → 「试用中 · {date} 到期」
  - `past_due` → 「扣款失败 · 请更新支付方式」（引导去管理账单）
  - `canceled` → 「已取消 · {date} 前有效」
  - `""`（免费/从未结账）→ 不显示状态行，CTA 为「升级」
- 免费档：只显示额度 + 「升级」按钮，无价格/周期/管理账单。
- CTA 由「升级」改为「更改套餐」（因为现在也能降级/换周期），点击导航到 `/pricing`。付费档保留「管理账单」跳 Stripe 门户。

#### B2. Pricing 页三处改动

- **周期切换器默认跟随当前周期**：`cycle` 初值取 `session().user?.billingCycle`，未知/免费用户回退 `"monthly"`。
- **明确标注当前「档+周期」**：当前档在当前周期下显示醒目「当前套餐」徽章；切到另一周期时该档显示为可切换（升/降级），语义与服务端一致（已有 `plan-relation.ts` 保证）。
- **`confirm()` 换成 `ChangePlanModal`**（见 B3）。原 `changePlan()` 里的 `confirm(prompt)` 与静默 `changeMsg`/轮询都移入弹窗流程。

#### B3. 新增 `ChangePlanModal.svelte`

应用内变更确认弹窗，取代原生 confirm：

- 打开即以 loading 态调 `POST /api/billing/preview`。
- 展示：目标「档 + 周期」、以及
  - `effective=now`：「现在按比例扣 ${immediateCharge}，之后 ${nextAmount}/{周期}，下次续费 {effectiveDate}」
  - `effective=period_end`：「{effectiveDate} 期末生效，在那之前保持当前套餐；不退款不补差」
- `[确认变更]` → 调 `POST /api/billing/change-plan` → 成功态 → 关闭并 `refreshSession()`（升级异步落库，保留原有的二次 refresh 轮询）。`[取消]` 关闭。
- 预览失败给出可读错误并允许重试/取消；确认失败同样落到弹窗内错误区，不静默。

### C. i18n

新增文案键：卡片周期徽章与四类友好状态、价格/周期后缀、「更改套餐」、排期降级行；弹窗的 loading/升级摘要/降级摘要/确认/取消/错误。按仓库既定流程覆盖全部 9 种语言（en/zh/ja/de/fr/ko/ar/es/pt），并过 `validateLangs` 门槛。

### D. 测试（TDD）

- **服务端**
  - `PreviewChange` 与 `/api/billing/preview`：升级返回即时+下期金额与日期；降级返回 period_end 与生效日；无订阅 409；用假 Biller 断言方向判定与 change-plan 一致。
  - A1 状态过滤：假 Biller/记录式断言——`trialing` 订阅能被找到并成功改档（回归 500 bug）；`canceled` 不被选中。
  - `resolveChange` 纯函数的方向判定单测（升/降/同档换周期/跨档换周期）。
  - webhook 回归：现有行为不变。
- **前端**
  - `PlanCard`：四类状态 + 年/月周期 + 排期降级行 + 免费档 各自渲染正确。
  - `ChangePlanModal`：预览 loading→升级摘要 / 降级摘要 渲染；确认调用正确端点；错误态。
  - Pricing：默认周期跟随当前订阅；当前「档+周期」标注正确。
  - `plan-relation` 既有测试保留。

## 实现顺序

1. A1（trialing 改档 bug）+ A4（落地页）——独立的小修复，先落地止血。
2. A3（PlanInfo 扩字段）+ B1（PlanCard 信息卡）+ C 相关文案——解决「看不清当前套餐」。
3. A2（preview 端点 + PreviewChange + resolveChange 抽取）+ B2/B3（默认周期、当前标注、ChangePlanModal）+ C 相关文案——解决「变更体验差」。

整体一个 spec、一个实现计划分任务推进。

## 不做（Out of scope）

- 不自建发票/支付方式管理页：这些继续交给 Stripe Billing Portal（「管理账单」按钮）。
- 不改定价档位、价格、额度口径本身（另有 billing-metering 路线）。
- 不处理多币种本地化（已知 followup，当前 USD）。
- `ScheduleDowngrade` 遇既有 schedule 仍报错不在此改（现有 followup：amend in place）。
