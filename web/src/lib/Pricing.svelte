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
  // /api/plans is in flight. This component now sits in the first viewport of
  // /pricing, so "no tiers yet" must read as loading rather than as an empty
  // decision area — see the skeleton grid below.
  let loadingPlans = $state(true);
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
  // Where the entitlement actually lives. "" for a free account and for any
  // server that predates the field, so every branch below must treat absence as
  // "no provider" rather than assuming Stripe.
  const entitlementProvider = $derived(session().user?.entitlementProvider ?? "");
  // A live entitlement Stripe does not (solely) own. Every Stripe action on this
  // page is refused server-side for such an account — change-plan/preview return
  // 409 managed_by_provider, and checkout returns 409 already_subscribed — so
  // offering one would be a button that cannot work, and offering "Subscribe"
  // would be an invitation to pay twice.
  const managedElsewhere = $derived(
    entitlementProvider === "apple" || entitlementProvider === "multiple",
  );
  const currentTier = $derived(tiers.find((x) => x.id === currentPlanId));
  // Tier a pending period-end downgrade will switch to ("" = none).
  const scheduledPlanId = $derived(session().user?.scheduledPlanId ?? "");
  const scheduledCycle = $derived(session().user?.scheduledCycle ?? "");
  const scheduledCycleName = $derived(scheduledCycle === "yearly" ? t.billing.cycleYearly
    : scheduledCycle === "monthly" ? t.billing.cycleMonthly : "");
  const scheduledTier = $derived(tiers.find((x) => x.id === scheduledPlanId));

  onMount(async () => {
    try {
      const res = await fetch("/api/plans");
      if (!res.ok) throw new Error("bad status");
      const loaded = await res.json();
      // An empty active-plan set is a valid 200 response from the server, but it
      // is not a usable pricing decision. Treat it like a load failure instead
      // of leaving the cycle control above an unexplained empty grid.
      if (!Array.isArray(loaded) || loaded.length === 0) throw new Error("no active plans");
      tiers = loaded as Tier[];
    } catch {
      loadError = t.billing.loadError;
    } finally {
      loadingPlans = false;
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
  function onModalClose(effect: "now" | "period_end" | "now_then_period_end" | "partial" | null) {
    const sameTierCycleChange = effect === "period_end" && modalTier?.id === currentPlanId;
    modalTier = null;
    checkoutError = "";
    if (effect) {
      changeMsg = effect === "now" ? t.billing.changeSuccess
        : effect === "period_end" ? (sameTierCycleChange
          ? t.billing.cycleChangeScheduled : t.billing.downgradeScheduled)
        : effect === "now_then_period_end" ? t.billing.compositeScheduled
        : t.billing.compositePartial;
      setTimeout(() => refreshSession(), 1500);
      setTimeout(() => refreshSession(), 4000);
    }
  }

  // Open the Stripe Billing Portal. Downgrading to Free is a cancellation —
  // Free has no Stripe price, so handleBillingChangePlan 400s on it — and the
  // cancel/refund/payment-method controls all live in the portal. Same call as
  // Account.svelte's onManageBilling.
  let portalBusy = $state(false);
  async function openPortal() {
    if (portalBusy) return;
    checkoutError = "";
    portalBusy = true;
    try {
      const res = await fetch("/api/billing/portal", { method: "POST", credentials: "include" });
      if (!res.ok) { checkoutError = t.billing.portalError; return; }
      const data = (await res.json()) as { url?: string };
      if (data.url) location.href = data.url;
      else checkoutError = t.billing.portalError;
    } catch {
      checkoutError = t.billing.portalError;
    } finally {
      portalBusy = false;
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
    <div class="toggle" role="group" aria-label={t.billing.cycleLabel}>
      <button
        type="button"
        class="toggle-btn"
        class:active={cycle === "monthly"}
        aria-pressed={cycle === "monthly"}
        onclick={() => (cycle = "monthly")}
      >
        {t.billing.monthly}
      </button>
      <button
        type="button"
        class="toggle-btn"
        class:active={cycle === "yearly"}
        aria-pressed={cycle === "yearly"}
        onclick={() => (cycle = "yearly")}
      >
        {t.billing.yearly}
      </button>
    </div>
    <span class="save-badge">{t.billing.save2mo}</span>
  </div>

  {#if loadError}<p class="err ui-callout ui-callout-danger" role="alert">{loadError}</p>{/if}
  {#if checkoutError}<p class="err ui-callout ui-callout-danger" role="alert">{checkoutError}</p>{/if}
  {#if changeMsg}<p class="ok-note ui-callout ui-callout-accent" role="status">{changeMsg}</p>{/if}

  {#if managedElsewhere}
    <p class="ui-callout" role="status" data-testid="managed-elsewhere">
      {entitlementProvider === "multiple" ? t.billing.multipleProvidersNote : t.billing.appleManagedNote}
    </p>
  {/if}

  <!-- A scheduled downgrade is STRIPE's state, and it outlives the Stripe
       subscription that created it: an account that later buys through the App
       Store still carries the stale scheduled_plan_id. Rendering it here would
       claim a switch that is not going to happen, and its only action —
       cancel-scheduled-change — is refused server-side with 409
       managed_by_provider for exactly these accounts. So the whole banner is
       suppressed rather than softened into read-only copy: there is nothing
       truthful left to say about a schedule that no longer applies, and the
       managed-elsewhere note above already says where the subscription lives.
       Ordinary Stripe scheduling is untouched. -->
  {#if scheduledPlanId && scheduledTier && !managedElsewhere}
    <div class="sched-banner">
      <span>{t.billing.scheduledNote(scheduledTier.name, scheduledCycleName)}</span>
      <button type="button" class="btn btn-ghost" disabled={busyPlanId === "__cancel__"} onclick={cancelScheduled}>
        {t.billing.keepCurrentPlan}
      </button>
    </div>
  {/if}

  {#if loadingPlans}
    <!-- Decorative placeholders only: same grid footprint so the decision area
         doesn't jump when the real tiers land. aria-hidden + no focusable
         content, so the status line below is the only thing announced. -->
    <p class="load-status" role="status">{t.billing.loadingPlans}</p>
    <div class="tiers" aria-hidden="true">
      {#each [0, 1, 2, 3] as i (i)}
        <div class="tier tier-skeleton ui-card ui-stack">
          <span class="sk sk-name"></span>
          <span class="sk sk-price"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-cta"></span>
        </div>
      {/each}
    </div>
  {:else if !loadError}
    <!-- Skipped entirely on a load failure: the danger callout above is the
         explanation, and an empty grid underneath it would only read as a bug. -->
    <div class="tiers">
      {#each tiers as tier (tier.id)}
        <div class="tier ui-card ui-stack" class:popular={tier.id === POPULAR_ID} class:is-current={tier.id === currentPlanId}>
          {#if tier.id === POPULAR_ID}<div class="ribbon ui-badge">{t.billing.popular}</div>{/if}
          <!-- h2, not h3: this grid is the first content under the page's h1 on
               /pricing, and jumping h1 → h3 is a real axe heading-order failure
               (it only shows once /api/plans resolves, which is why the scan now
               loads real tiers). Inside the account dialog the same level is
               still correct — nothing there opens a section above it. Only the
               level moves: .tier-name below pins the typography this used to
               render with, so nothing on the card changes visually. -->
          <h2 class="tier-name">{tier.name}</h2>
          {#if isFree(tier)}
            <div class="tier-price">{t.billing.free}</div>
          {:else}
            <div class="tier-price">
              <!-- Prices are USD literals (Stripe charges USD). In an RTL locale
                   a bare "$9.00" would reorder around the sign and the decimal
                   separator, so the amount is its own LTR bidi isolate. -->
              <bdi dir="ltr">{formatPrice(priceCents(tier))}</bdi>
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
          {:else if tier.id === scheduledPlanId && !managedElsewhere}
            <div class="current-badge">{t.billing.scheduledBadge}</div>
          {:else if managedElsewhere}
            <!-- Ahead of the free/paid split and behind the scheduled badge,
                 both deliberately: neither a checkout nor the portal (which
                 only ever cancels the Stripe side) is a truthful action for
                 this account, and a "Scheduled" badge on a tier it is not
                 moving to is a stale Stripe claim (see the banner gate above).
                 The note above says where the subscription actually lives. -->
            <div class="tier-note">{t.billing.appleManagedBadge}</div>
          {:else if isFree(tier)}
            {#if isSubscribed}
              <!-- A paid subscriber viewing Free: this is their downgrade/cancel
                   path. Free has no Stripe price, so it goes through the portal
                   (period-end cancel), not change-plan. -->
              <button
                type="button"
                class="btn btn-primary"
                disabled={portalBusy}
                onclick={openPortal}
              >
                {t.billing.downgradeToFree}
              </button>
            {:else}
              <div class="tier-note">{t.billing.free}</div>
            {/if}
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
  {/if}
</div>

{#if modalTier}
  <ChangePlanModal planId={modalTier.id} planName={modalTier.name} {cycle} onclose={onModalClose} />
{/if}

<style>
  /* Surfaces, badges and callouts come from app.css (.ui-card, .ui-stack,
     .ui-badge, .ui-callout*). What stays here is layout, the accent treatment
     the ribbon needs on top of .ui-badge, and the price hierarchy. */
  .pricing { display: flex; flex-direction: column; gap: var(--space-4); }
  .toggle-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .toggle { display: inline-flex; gap: var(--space-1); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px; width: fit-content; }
  .toggle-btn {
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); border: none;
    background: none; color: var(--text); font: inherit; font-size: var(--fs-xs); cursor: pointer;
  }
  .toggle-btn.active { background: var(--social-bg); color: var(--text-h); }
  /* Same touch floor .btn gets globally: on /pricing this control is now the
     first thing a phone user reaches for. */
  @media (pointer: coarse) {
    .toggle-btn { min-block-size: 44px; padding-inline: var(--space-4); }
  }
  .save-badge { font-size: var(--fs-xs); color: var(--accent-fg); font-weight: 600; }
  .load-status { font-size: var(--fs-xs); color: var(--text); margin: 0; }
  .tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); }
  /* min-inline-size:0 so a long localized tier name can't blow the grid track
     out past the page measure. */
  .tier { position: relative; min-inline-size: 0; }
  .tier.popular { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .tier.is-current { border-color: var(--text-h); }
  /* .ui-badge gives it the pill shape and metrics; only the accent fill and the
     "hangs off the card's top edge" placement are local. */
  .ribbon {
    position: absolute; inset-block-start: -10px; inset-inline-end: var(--space-3);
    background: var(--accent-action); border-color: transparent; color: #fff; font-weight: 600;
  }
  /* The declarations after the colour exist to keep this batch a pure
     semantics change. app.css styles `h2` globally (weight 600, line-height
     1.15, letter-spacing -0.4px and the heading font family) and styles `h3`
     not at all, so promoting the tier name for heading-order would otherwise
     also have re-typeset it:
     measured in Chrome, 700 → 600, 23.2px → 20.7px leading, normal → -0.4px
     tracking, and a 2px shorter box on every card. Adopting the app's h2
     treatment here may well be the right call — it is a design decision, and
     it is not this one. */
  .tier-name {
    margin: 0; font-size: var(--fs-h3); color: var(--text-h);
    /* `inherit`, not literal values: leading and tracking are inherited
       properties, so an unstyled h3 took whatever the card gave it. Spelling
       out "normal" here would have been a different 2px-shorter box. */
    font-family: inherit; font-weight: 700;
    line-height: inherit; letter-spacing: inherit;
  }
  /* The paid price is the decision, so it is the largest type on the page after
     the h1. Tabular numerals keep the column of prices aligned as the cycle
     flips between 2- and 3-digit amounts. */
  .tier-price {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px;
    font-size: var(--fs-h2); line-height: 1.1; font-weight: 600; color: var(--text-h);
    font-variant-numeric: tabular-nums;
  }
  .tier-suffix { font-size: var(--fs-xs); font-weight: 400; color: var(--text); }
  .tier-caps { list-style: none; margin: 0; padding: 0; font-size: var(--fs-xs); color: var(--text); display: flex; flex-direction: column; gap: 2px; }
  .tier-note { font-size: var(--fs-xs); color: var(--text); }
  .current-badge { font-size: var(--fs-xs); font-weight: 600; color: var(--text-h); padding: var(--space-1) 0; }
  .err { color: var(--danger); margin: 0; }
  .ok-note { color: var(--text-h); margin: 0; }
  .sched-banner {
    display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
    padding: var(--space-2) var(--space-3); border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--social-bg); font-size: var(--fs-xs);
  }
  .sched-banner span { color: var(--text-h); }

  /* Loading placeholders. Purely decorative (the parent is aria-hidden), sized
     to roughly the real card so the grid doesn't reflow on arrival. */
  .sk { display: block; border-radius: var(--radius-sm); background: var(--border); }
  .sk-name { block-size: 18px; inline-size: 45%; }
  .sk-price { block-size: 32px; inline-size: 65%; }
  .sk-line { block-size: 12px; inline-size: 80%; }
  .sk-cta { block-size: 38px; inline-size: 100%; margin-block-start: var(--space-1); }
  .tier-skeleton { animation: sk-pulse 1.4s ease-in-out infinite; }
  @keyframes sk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
  @media (prefers-reduced-motion: reduce) {
    .tier-skeleton { animation: none; }
  }
</style>
