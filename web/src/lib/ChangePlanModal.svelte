<script lang="ts">
  import { trapFocus } from "./focus-trap";
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);

  let { planId, planName, cycle, onclose }: {
    planId: string; planName: string; cycle: "monthly" | "yearly"; onclose: (changed: boolean) => void;
  } = $props();

  interface Preview {
    effective: "now" | "period_end";
    immediateChargeCents: number;
    nextAmountCents: number;
    nextCycle: string;
    effectiveDate: number;
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
    return t.billing.upgradeSummary(
      money(preview.immediateChargeCents), money(preview.nextAmountCents),
      cycleWord(preview.nextCycle), date(preview.effectiveDate),
    );
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
      if (!r.ok) { submitError = t.billing.changeError; return; }
      onclose(true);
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
      <button class="btn" disabled={submitting} onclick={() => onclose(false)}>{t.billing.cancel}</button>
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
