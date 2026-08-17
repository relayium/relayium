<script lang="ts">
  import { trapFocus } from "./focus-trap";
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);

  let { planId, planName, cycle, onclose }: {
    planId: string; planName: string; cycle: "monthly" | "yearly";
    onclose: (effect: "now" | "period_end" | "now_then_period_end" | "partial" | null) => void;
  } = $props();

  interface Preview {
    effective: "now" | "period_end" | "now_then_period_end";
    // What the card is actually charged today; Stripe floors it at zero.
    immediateChargeCents: number;
    // The SIGNED proration. Negative is a credit the customer is owed, which the
    // floored charge above would otherwise render as a misleading "$0.00 due now".
    immediateAdjustmentCents: number;
    nextAmountCents: number;
    nextCycle: string;
    effectiveDate: number;
    // Composite only: the immediate stage applies the target tier's yearly price,
    // and the requested monthly plan lands at the renewal that stage creates.
    immediateCycle?: string;
    immediateAmountCents?: number;
    scheduledCycle?: string;
    scheduledAmountCents?: number;
  }

  let preview = $state<Preview | null>(null);
  let loadFailed = $state(false);
  let submitting = $state(false);
  let submitError = $state("");

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const date = (secs: number) => (secs ? new Date(secs * 1000).toLocaleDateString(lang()) : "");
  const cycleWord = (c: string) => (c === "yearly" ? t.billing.cycleYearly : t.billing.cycleMonthly);

  const summary = $derived(() => {
    if (!preview) return "";
    if (preview.effective === "period_end") return t.billing.downgradeSummary(date(preview.effectiveDate));
    // effectiveDate is Stripe's projected post-change renewal, not the stale
    // current-period anchor, so both immediate branches date themselves correctly.
    const when = date(preview.effectiveDate);
    // Both stage amounts are required to describe a composite truthfully; without
    // them, fall through to the single-stage summary rather than quoting a $0.00
    // stage the server never sent.
    if (preview.effective === "now_then_period_end"
      && preview.immediateAmountCents !== undefined && preview.scheduledAmountCents !== undefined) {
      // A composite is always an upward tier move onto a yearly price, so its
      // proration is a charge; only the cycle switch is deferred.
      return t.billing.twoStageSummary(
        money(preview.immediateChargeCents),
        money(preview.immediateAmountCents), cycleWord(preview.immediateCycle ?? "yearly"),
        money(preview.scheduledAmountCents), cycleWord(preview.scheduledCycle ?? preview.nextCycle), when,
      );
    }
    const next = money(preview.nextAmountCents);
    const nextCycle = cycleWord(preview.nextCycle);
    // Fall back to the charge when the signed proration is absent, so an older
    // response can never turn a real charge into a "no extra cost" claim.
    const adjustment = preview.immediateAdjustmentCents ?? preview.immediateChargeCents;
    if (adjustment < 0) return t.billing.upgradeCreditSummary(money(-adjustment), next, nextCycle, when);
    if (adjustment === 0) return t.billing.upgradeNoChargeSummary(next, nextCycle, when);
    return t.billing.upgradeSummary(money(preview.immediateChargeCents), next, nextCycle, when);
  });

  $effect(() => {
    fetch("/api/billing/preview", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, cycle }),
    }).then(async (r) => {
      if (!r.ok) { loadFailed = true; return; }
      preview = (await r.json()) as Preview;
    }).catch(() => { loadFailed = true; });
  });

  async function confirm() {
    if (submitting) return;
    submitting = true; submitError = "";
    try {
      const r = await fetch("/api/billing/change-plan", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, cycle }),
      });
			const result = await r.json().catch(() => ({})) as {
        status?: string; effective?: string; requestedEffect?: string; failedStage?: string;
      };
			if (result.status === "payment_pending") {
        submitError = result.requestedEffect === "now_then_period_end"
          ? t.billing.compositePaymentPending : t.billing.paymentPending;
        return;
      }
      if (result.status === "partial" && result.effective === "now"
        && result.failedStage === "period_end") { onclose("partial"); return; }
			if (!r.ok) { submitError = t.billing.changeError; return; }
      if (result.effective === "now" || result.effective === "period_end"
        || result.effective === "now_then_period_end") onclose(result.effective);
      else submitError = t.billing.changeError;
    } catch {
      submitError = t.billing.changeError;
    } finally {
      submitting = false;
    }
  }
</script>

<!-- The heading already names this dialog ("Change plan · Pro monthly"), so it is
     the accessible name; a separate aria-label would be a second copy of the same
     sentence that nothing keeps in sync. -->
<div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="change-plan-title" use:trapFocus>
  <div class="modal">
    <h3 id="change-plan-title">{t.billing.changePlan} · {planName} {cycleWord(cycle)}</h3>
    {#if loadFailed}
      <p class="err">{t.billing.previewError}</p>
    {:else if !preview}
      <p class="muted">{t.billing.previewLoading}</p>
    {:else}
      <p class="summary">{summary()}</p>
    {/if}
    {#if submitError}<p class="err">{submitError}</p>{/if}
    <div class="actions">
      <button class="btn btn-primary" disabled={!preview || submitting} onclick={confirm}>{t.billing.confirmChange}</button>
      <button class="btn" disabled={submitting} onclick={() => onclose(null)}>{t.billing.cancel}</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-5); max-width: 420px; width: calc(100% - var(--space-4)); }
  .modal h3 { margin: 0 0 var(--space-3); font-size: var(--fs-h3); color: var(--text-h); }
  .summary { margin: 0 0 var(--space-4); color: var(--text-h); }
  .muted { margin: 0 0 var(--space-4); color: var(--text); }
  .err { color: var(--danger); font-size: var(--fs-xs); margin: 0 0 var(--space-3); }
  .actions { display: flex; gap: var(--space-2); }
</style>
