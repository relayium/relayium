<script lang="ts">
  import { onMount } from "svelte";
  import { formatSize } from "./format";

  // English strings only for now — Task 10 replaces these with the i18n
  // `t.billing.*` keys added there. Kept as one const object so that swap is
  // a mechanical find/replace of `L.foo` -> `t.billing.foo`.
  const L = {
    monthly: "Monthly",
    yearly: "Yearly",
    perMonth: "/mo",
    perYear: "/yr",
    free: "Free",
    currentFree: "Free plan",
    upgrade: "Upgrade",
    notAvailable: "Not available yet — contact us",
    signInRequired: "Sign in to upgrade",
    checkoutError: "Couldn't start checkout. Please try again.",
    loadError: "Couldn't load plans.",
    storage: "Storage",
    traffic: "Traffic",
    retention: "Retention",
    days: (n: number) => `${n} day${n === 1 ? "" : "s"}`,
  };

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

  let tiers = $state<Tier[]>([]);
  let cycle = $state<"monthly" | "yearly">("monthly");
  let loadError = $state("");
  let checkoutError = $state("");
  let busyPlanId = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await fetch("/api/plans");
      if (!res.ok) throw new Error("bad status");
      tiers = await res.json();
    } catch {
      loadError = L.loadError;
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
    return L.days(Math.round(secs / 86400));
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
        checkoutError = L.signInRequired;
        return;
      }
      if (!res.ok) {
        checkoutError = L.checkoutError;
        return;
      }
      const data = await res.json();
      if (data.url) {
        location.href = data.url;
      } else {
        checkoutError = L.checkoutError;
      }
    } catch {
      checkoutError = L.checkoutError;
    } finally {
      busyPlanId = null;
    }
  }
</script>

<div class="pricing">
  <div class="toggle" role="group" aria-label="Billing cycle">
    <button
      type="button"
      class="toggle-btn"
      class:active={cycle === "monthly"}
      onclick={() => (cycle = "monthly")}
    >
      {L.monthly}
    </button>
    <button
      type="button"
      class="toggle-btn"
      class:active={cycle === "yearly"}
      onclick={() => (cycle = "yearly")}
    >
      {L.yearly}
    </button>
  </div>

  {#if loadError}
    <p class="err">{loadError}</p>
  {/if}
  {#if checkoutError}
    <p class="err">{checkoutError}</p>
  {/if}

  <div class="tiers">
    {#each tiers as tier (tier.id)}
      <div class="tier">
        <h3 class="tier-name">{tier.name}</h3>
        {#if isFree(tier)}
          <div class="tier-price">{L.free}</div>
        {:else}
          <div class="tier-price">
            {formatPrice(priceCents(tier))}
            <span class="tier-suffix">{cycle === "monthly" ? L.perMonth : L.perYear}</span>
          </div>
        {/if}
        <ul class="tier-caps">
          <li>{L.storage}: {formatSize(tier.storageBytes)}</li>
          <li>{L.traffic}: {formatSize(tier.trafficBytes)}</li>
          <li>{L.retention}: {formatRetention(tier.retentionSecs)}</li>
        </ul>
        {#if isFree(tier)}
          <div class="tier-note">{L.currentFree}</div>
        {:else}
          <button
            type="button"
            class="btn btn-primary"
            disabled={!purchasable(tier) || busyPlanId === tier.id}
            onclick={() => checkout(tier.id)}
          >
            {L.upgrade}
          </button>
          {#if !purchasable(tier)}
            <div class="tier-note">{L.notAvailable}</div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .pricing { display: flex; flex-direction: column; gap: var(--space-4); }
  .toggle { display: inline-flex; gap: var(--space-1); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px; width: fit-content; }
  .toggle-btn {
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); border: none;
    background: none; color: var(--text); font: inherit; font-size: var(--fs-xs); cursor: pointer;
  }
  .toggle-btn.active { background: var(--social-bg); color: var(--text-h); }
  .tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); }
  .tier { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
  .tier-name { margin: 0; font-size: var(--fs-sm); color: var(--text-h); }
  .tier-price { font-size: var(--fs-lg, 1.25rem); font-weight: 600; color: var(--text-h); }
  .tier-suffix { font-size: var(--fs-xs); font-weight: 400; color: var(--text); }
  .tier-caps { list-style: none; margin: 0; padding: 0; font-size: var(--fs-xs); color: var(--text); display: flex; flex-direction: column; gap: 2px; }
  .tier-note { font-size: var(--fs-xs); color: var(--text); }
  .err { color: var(--danger); font-size: 12px; margin: 0; }
</style>
