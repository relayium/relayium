<script lang="ts">
  import { onMount } from "svelte";
  import { formatSize } from "./format";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session, refreshSession } from "./auth.svelte";
  import { planRelation } from "./plan-relation";
  import ChangePlanModal from "./ChangePlanModal.svelte";

  const t = $derived<Messages>(messages[lang()]);

  interface Tier {
    id: string;
    name: string;
    storageBytes: number;
    trafficBytes: number;
    retentionSecs: number;
    priceMonthly: number; // cents
    priceYearly: number; // cents
    purchasableMonthly: boolean;
    purchasableYearly: boolean;
  }

  // Tier we highlight as the recommended default.
  const POPULAR_ID = "pro";

  let tiers = $state<Tier[]>([]);
  const initialCycle = (): "monthly" | "yearly" =>
    session().user?.billingCycle === "yearly" ? "yearly" : "monthly";
  let cycle = $state<"monthly" | "yearly">(initialCycle());
  let loadError = $state("");
  let checkoutError = $state("");
  let changeMsg = $state("");
  let busyPlanId = $state<string | null>(null);
  let modalTier = $state<Tier | null>(null);

  // Current subscription context (drives per-tier CTA: current / upgrade / downgrade).
  const currentPlanId = $derived(session().user?.planId ?? "free");
  const hasBilling = $derived(session().user?.hasBilling ?? false);
  // A live Stripe subscription we can switch in place (vs. a fresh checkout).
  const isSubscribed = $derived(!!session().user && hasBilling && currentPlanId !== "free");
  const currentTier = $derived(tiers.find((x) => x.id === currentPlanId));
  // Tier a pending period-end downgrade will switch to ("" = none).
  const scheduledPlanId = $derived(session().user?.scheduledPlanId ?? "");
  const scheduledTier = $derived(tiers.find((x) => x.id === scheduledPlanId));

  onMount(async () => {
    try {
      const res = await fetch("/api/plans");
      if (!res.ok) throw new Error("bad status");
      tiers = await res.json();
    } catch {
      loadError = t.billing.loadError;
    }
  });

  function isFree(tier: Tier): boolean {
    return tier.priceMonthly === 0 && tier.priceYearly === 0;
  }

  function purchasable(tier: Tier): boolean {
    return cycle === "monthly" ? tier.purchasableMonthly : tier.purchasableYearly;
  }

  function priceCents(tier: Tier): number {
    return cycle === "monthly" ? tier.priceMonthly : tier.priceYearly;
  }

  function formatPrice(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  function formatRetention(secs: number): string {
    return t.billing.days(Math.round(secs / 86400));
  }

  // "current" | "up" | "down" relative to the user's active plan AND cycle.
  // Cycle matters: the same tier billed yearly is a real, purchasable change,
  // so comparing tier alone would leave a monthly subscriber with no way to
  // switch to yearly. See plan-relation.ts for the rules (kept in step with the
  // server's handleBillingChangePlan).
  function relation(tier: Tier): "current" | "up" | "down" {
    return planRelation({
      tierId: tier.id,
      tierPriceMonthly: tier.priceMonthly,
      currentPlanId,
      currentPriceMonthly: currentTier?.priceMonthly ?? 0,
      currentCycle: session().user?.billingCycle ?? "",
      selectedCycle: cycle,
    });
  }

  // On the tier the user already holds, only the cycle can be changing, and
  // "Upgrade"/"Downgrade" would read as a tier move that isn't happening.
  function ctaLabel(tier: Tier): string {
    if (!isSubscribed) return t.billing.upgrade;
    if (tier.id === currentPlanId) {
      return cycle === "yearly" ? t.billing.switchToYearly : t.billing.switchToMonthly;
    }
    return relation(tier) === "down" ? t.billing.downgrade : t.billing.upgrade;
  }

  async function checkout(planId: string) {
    if (busyPlanId) return;
    checkoutError = "";
    busyPlanId = planId;
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, cycle }),
      });
      if (res.status === 401) {
        checkoutError = t.billing.signInRequired;
        return;
      }
      if (!res.ok) {
        checkoutError = t.billing.checkoutError;
        return;
      }
      const data = await res.json();
      if (data.url) {
        location.href = data.url;
      } else {
        checkoutError = t.billing.checkoutError;
      }
    } catch {
      checkoutError = t.billing.checkoutError;
    } finally {
      busyPlanId = null;
    }
  }

  // Primary action for a paid tier given the user's context. Existing
  // subscribers get a previewed confirmation (real charge/effective-date from
  // /api/billing/preview) instead of a blind confirm() before change-plan.
  function act(tier: Tier) {
    checkoutError = "";
    if (isSubscribed) modalTier = tier;
    else checkout(tier.id);
  }

  // The modal itself calls /api/billing/change-plan; here we just close it and,
  // on success, surface the toast and poll /api/me for the webhook-applied
  // change to land (same cadence the old inline flow used).
  function onModalClose(changed: boolean) {
    modalTier = null;
    checkoutError = "";
    if (changed) {
      changeMsg = t.billing.changeSuccess;
      setTimeout(() => refreshSession(), 1500);
      setTimeout(() => refreshSession(), 4000);
    }
  }

  // Cancel a pending period-end downgrade (stay on the current tier).
  async function cancelScheduled() {
    if (busyPlanId) return;
    checkoutError = "";
    changeMsg = "";
    busyPlanId = "__cancel__";
    try {
      const res = await fetch("/api/billing/cancel-scheduled-change", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        checkoutError = t.billing.cancelScheduledError;
        return;
      }
      await refreshSession();
    } catch {
      checkoutError = t.billing.cancelScheduledError;
    } finally {
      busyPlanId = null;
    }
  }
</script>

<div class="pricing">
  <div class="toggle-row">
    <div class="toggle" role="group" aria-label="Billing cycle">
      <button type="button" class="toggle-btn" class:active={cycle === "monthly"} onclick={() => (cycle = "monthly")}>
        {t.billing.monthly}
      </button>
      <button type="button" class="toggle-btn" class:active={cycle === "yearly"} onclick={() => (cycle = "yearly")}>
        {t.billing.yearly}
      </button>
    </div>
    <span class="save-badge">{t.billing.save2mo}</span>
  </div>

  {#if loadError}<p class="err">{loadError}</p>{/if}
  {#if checkoutError}<p class="err">{checkoutError}</p>{/if}
  {#if changeMsg}<p class="ok-note">{changeMsg}</p>{/if}

  {#if scheduledPlanId && scheduledTier}
    <div class="sched-banner">
      <span>{t.billing.scheduledNote(scheduledTier.name)}</span>
      <button type="button" class="btn btn-ghost" disabled={busyPlanId === "__cancel__"} onclick={cancelScheduled}>
        {t.billing.keepCurrentPlan}
      </button>
    </div>
  {/if}

  <div class="tiers">
    {#each tiers as tier (tier.id)}
      <div class="tier" class:popular={tier.id === POPULAR_ID} class:is-current={tier.id === currentPlanId}>
        {#if tier.id === POPULAR_ID}<div class="ribbon">{t.billing.popular}</div>{/if}
        <h3 class="tier-name">{tier.name}</h3>
        {#if isFree(tier)}
          <div class="tier-price">{t.billing.free}</div>
        {:else}
          <div class="tier-price">
            {formatPrice(priceCents(tier))}
            <span class="tier-suffix">{cycle === "monthly" ? t.billing.perMonth : t.billing.perYear}</span>
          </div>
        {/if}
        <ul class="tier-caps">
          <li>{t.billing.storage}: {formatSize(tier.storageBytes)}</li>
          <li>{t.billing.traffic}: {formatSize(tier.trafficBytes)}</li>
          <li>{t.billing.retention}: {formatRetention(tier.retentionSecs)}</li>
        </ul>

        {#if relation(tier) === "current"}
          <div class="current-badge">{isFree(tier) ? t.billing.currentFree : t.billing.current}</div>
        {:else if tier.id === scheduledPlanId}
          <div class="current-badge">{t.billing.scheduledBadge}</div>
        {:else if isFree(tier)}
          <div class="tier-note">{t.billing.free}</div>
        {:else}
          <button
            type="button"
            class="btn btn-primary"
            disabled={!purchasable(tier) || busyPlanId === tier.id}
            onclick={() => act(tier)}
          >
            {ctaLabel(tier)}
          </button>
          {#if !purchasable(tier)}<div class="tier-note">{t.billing.notAvailable}</div>{/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if modalTier}
  <ChangePlanModal planId={modalTier.id} planName={modalTier.name} {cycle} onclose={onModalClose} />
{/if}

<style>
  .pricing { display: flex; flex-direction: column; gap: var(--space-4); }
  .toggle-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .toggle { display: inline-flex; gap: var(--space-1); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px; width: fit-content; }
  .toggle-btn {
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); border: none;
    background: none; color: var(--text); font: inherit; font-size: var(--fs-xs); cursor: pointer;
  }
  .toggle-btn.active { background: var(--social-bg); color: var(--text-h); }
  .save-badge { font-size: var(--fs-xs); color: var(--accent); font-weight: 600; }
  .tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); }
  .tier { position: relative; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
  .tier.popular { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .tier.is-current { border-color: var(--text-h); }
  .ribbon {
    position: absolute; top: -10px; inset-inline-end: var(--space-3);
    background: var(--accent); color: #fff; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: var(--radius-sm);
  }
  .tier-name { margin: 0; font-size: var(--fs-sm); color: var(--text-h); }
  .tier-price { font-size: var(--fs-lg, 1.25rem); font-weight: 600; color: var(--text-h); }
  .tier-suffix { font-size: var(--fs-xs); font-weight: 400; color: var(--text); }
  .tier-caps { list-style: none; margin: 0; padding: 0; font-size: var(--fs-xs); color: var(--text); display: flex; flex-direction: column; gap: 2px; }
  .tier-note { font-size: var(--fs-xs); color: var(--text); }
  .current-badge { font-size: var(--fs-xs); font-weight: 600; color: var(--text-h); padding: var(--space-1) 0; }
  .err { color: var(--danger); font-size: 12px; margin: 0; }
  .ok-note { color: var(--accent); font-size: 12px; margin: 0; }
  .sched-banner {
    display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
    padding: var(--space-2) var(--space-3); border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--social-bg); font-size: var(--fs-xs);
  }
  .sched-banner span { color: var(--text-h); }
</style>
