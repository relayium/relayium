<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session } from "./auth.svelte";
  import { navigate } from "./router.svelte";
  import { formatSize } from "./format";
  import { fetchUsage, type PlanInfo } from "./usage.svelte";

  const t = $derived<Messages>(messages[lang()]);

  let plan = $state<PlanInfo | null>(null);
  let portalBusy = $state(false);
  let portalError = $state("");

  // 与 QuotaMeters 共用 fetchUsage 的缓存，所以同页两个组件只打一次请求。
  // 陈旧响应守卫同款：登出后不要把上一个账号的套餐画出来。
  //
  // 数据源只认这里的 u.plan。session().user 上也有一份 planId /
  // subscriptionStatus / subscriptionEnd，但那是登录那一刻的快照，改档或订阅到期
  // 后不会更新；两处混用必然漂移。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { plan = null; return; }
    fetchUsage(uid).then((u) => {
      if (session().user?.id !== uid) return;
      plan = u?.plan ?? null;
    });
  });

  // cap === 0 是无限档，显示"无限"而不是"0 B"。
  const cap = (v: number) => (v > 0 ? formatSize(v) : t.quota.unlimited);
  const retention = $derived(
    plan && plan.retentionSecs > 0
      ? t.me.plan.retentionDays(Math.round(plan.retentionSecs / 86400))
      : t.me.plan.retentionForever,
  );
  const subEnd = $derived(
    plan?.subscriptionEnd
      ? new Date(plan.subscriptionEnd * 1000).toLocaleDateString(lang())
      : "",
  );

  // 信息卡的四段派生态：是否付费档、周期徽章、价格行、状态行、排期降级行。
  const isPaid = $derived(!!plan && plan.priceMonthly > 0);
  const cycleLabel = $derived(
    plan?.billingCycle === "yearly" ? t.billing.cycleYearly
    : plan?.billingCycle === "monthly" ? t.billing.cycleMonthly : "",
  );
  const priceLine = $derived(() => {
    if (!plan || !isPaid) return "";
    const cents = plan.billingCycle === "yearly" ? plan.priceYearly : plan.priceMonthly;
    const suffix = plan.billingCycle === "yearly" ? t.billing.perYear : t.billing.perMonth;
    return `$${(cents / 100).toFixed(2)}${suffix}`;
  });
  const statusLine = $derived(() => {
    if (!plan) return "";
    switch (plan.subscriptionStatus) {
      case "active": return t.billing.renewsOn(subEnd);
      case "trialing": return t.billing.trialEndsOn(subEnd);
      case "past_due": return t.billing.pastDueNotice;
      case "canceled": return t.billing.canceledUntil(subEnd);
      default: return "";
    }
  });
  const scheduledLine = $derived(
    plan?.scheduledPlanId && plan.scheduledPlanName
      ? t.billing.scheduledDowngradeRow(plan.scheduledPlanName, subEnd) : "",
  );

  // 照抄 Account.svelte 的 onManageBilling：跳 Stripe 客户门户。
  async function onManageBilling() {
    if (portalBusy) return;
    portalError = "";
    portalBusy = true;
    try {
      const res = await fetch("/api/billing/portal", { method: "POST", credentials: "include" });
      if (!res.ok) { portalError = t.billing.portalError; return; }
      const data = (await res.json()) as { url?: string };
      if (data.url) location.href = data.url;
      else portalError = t.billing.portalError;
    } catch {
      portalError = t.billing.portalError;
    } finally {
      portalBusy = false;
    }
  }
</script>

<!-- 取不到套餐信息时整块不渲染，与 QuotaMeters 的策略一致：会员卡是附加信息，
     画一张空卡比不画更糟。 -->
{#if plan}
  <section class="plan-card">
    <div class="head">
      <h3>{t.billing.currentPlan}</h3>
      <span class="badge">{plan.name}{#if cycleLabel} · {cycleLabel}{/if}</span>
    </div>

    {#if priceLine()}<p class="price">{priceLine()}{#if statusLine()} · {statusLine()}{/if}</p>
    {:else if statusLine()}<p class="sub">{statusLine()}</p>{/if}

    <p class="perks">{t.me.plan.perks(cap(plan.storageBytes), cap(plan.trafficBytes), retention)}</p>

    {#if scheduledLine}<p class="sched">⏳ {scheduledLine}</p>{/if}

    <div class="actions">
      {#if plan.isTop}
        <span class="hint">{t.me.plan.topTier}</span>
      {:else}
        <button class="btn btn-primary" onclick={() => navigate("pricing")}>
          {isPaid ? t.billing.changePlan : t.billing.upgrade}
        </button>
      {/if}
      {#if session().user?.hasBilling}
        <button class="btn" disabled={portalBusy} onclick={onManageBilling}>{t.billing.manageBilling}</button>
      {/if}
    </div>
    {#if portalError}<p class="err">{portalError}</p>{/if}
  </section>
{/if}

<style>
  /* 与 QuotaMeters.svelte 的 .quota 同款卡片：两块在 /me 页上下相邻，视觉重量
     必须一致，否则会读成主次关系。 */
  .plan-card {
    padding: var(--space-5) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--social-bg);
    margin-bottom: var(--space-3);
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .head h3 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  /* 本仓没有"按钮前景色"变量：实心 accent 底的地方（Pricing 的 ribbon、Nav 的
     active tab 等）一律硬写 #fff。这里不引入新的颜色字面量，改用同样既有的
     淡底徽章配方（HowItWorks.svelte:48 / HowToSteps.svelte:81），全部走变量。 */
  .badge {
    padding: 2px var(--space-2);
    border-radius: 999px;
    background: var(--accent-bg);
    color: var(--accent);
    font-size: var(--fs-xs);
  }
  .price { margin: var(--space-2) 0 0; color: var(--text-h); font-weight: 600; }
  .perks { margin: var(--space-3) 0 0; color: var(--text-h); }
  .sub { margin: var(--space-2) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .sched { margin: var(--space-3) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .hint { margin: var(--space-3) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
  .err { margin: var(--space-2) 0 0; color: var(--danger); font-size: var(--fs-xs); }
</style>
