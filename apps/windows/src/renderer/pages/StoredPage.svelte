<!--
  Send a link — receive, send and history, in one page.

  Only RECEIVE is built. The other two modes say so in their own words rather
  than showing controls that do nothing: a greyed button reads as "broken" and a
  spinner reads as "nearly there", and both are lies a user acts on.

  ## Opening a link is not downloading it

  Pasting a link, or having Windows hand one to this window, puts it on screen.
  Nothing is fetched until the user asks, and nothing is WRITTEN until they pick
  a folder in a native dialog main opens. That ordering is the product's consent
  model, not a nicety, and it is why there is no "save automatically".

  ## The link is a secret

  Its fragment is the decryption key. It goes to main on `receive` and nowhere
  else: never rendered back into a message, never put in a title, never logged.
  What this page shows about a failure is a closed code from main.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import type { StoredController, StoredFailure } from "../stored/stored-controller.svelte.js";

  let { stored, offered = "", onConsumed }: {
    /** App-lived: a transfer, its progress and the draft all outlive this page. */
    stored: StoredController;
    /** A link Windows handed this window. Shown, never acted on by itself. */
    offered?: string;
    onConsumed?: () => void;
  } = $props();

  // A link that arrived from outside lands in the box, and only there. The user
  // still has to ask, and still has to choose a folder.
  $effect(() => {
    if (offered === "" || stored.busy) return;
    stored.offer(offered);
    onConsumed?.();
  });

  const percent = $derived(stored.total > 0 ? Math.min(100, Math.round((stored.received / stored.total) * 100)) : 0);

  /** One sentence per closed code. Never the link, never a path. */
  function failureText(failure: StoredFailure): string {
    if (failure.code === "link-invalid") return t("storedFailedLinkInvalid");
    if (failure.code === "not-found") return t("storedFailedNotFound");
    if (failure.code === "forbidden") return t("storedFailedForbidden");
    if (failure.code === "integrity") return t("storedFailedIntegrity");
    if (failure.code === "network" || failure.code === "timeout") return t("storedFailedNetwork");
    if (failure.code === "runtime-unavailable") return t("storedFailedRuntime");
    return t("storedFailedGeneric");
  }

  function refusalText(code: string): string {
    if (code === "at-capacity") return t("storedAtCapacity");
    if (code === "too-long") return t("storedTooLong");
    return t("storedUnavailable");
  }
</script>

<h1>{t("storedTitle")}</h1>
<p class="lede">{t("storedSubtitle")}</p>

<Card title={t("storedReceiveHeading")}>
  <p class="dim">{t("storedReceiveBody")}</p>
  {#if stored.fromDeepLink}
    <p class="dim small" data-test="stored-from-link">{t("storedFromDeepLink")}</p>
  {/if}

  <form
    class="row"
    onsubmit={(e) => {
      e.preventDefault();
      void stored.open();
    }}
  >
    <label class="sr-only" for="stored-link">{t("storedLinkLabel")}</label>
    <input
      id="stored-link"
      data-test="stored-link"
      bind:value={stored.link}
      placeholder={t("storedLinkLabel")}
      disabled={stored.busy}
    />
    <button class="primary" type="submit" data-test="stored-open" disabled={stored.busy || stored.link.trim() === ""}>
      {t("storedReceiveAction")}
    </button>
  </form>

  {#if stored.busy}
    <p class="dim small" data-test="stored-progress">{t("storedProgress", { percent })}</p>
    <progress max="100" value={percent}></progress>
    <button data-test="stored-cancel" onclick={() => void stored.cancel()}>{t("storedCancel")}</button>
  {/if}

  {#if stored.refusal}
    <p class="problem" data-test="stored-refusal">{refusalText(stored.refusal)}</p>
  {/if}

  {#if stored.report}
    {#if stored.report.status === "saved"}
      <p data-test="stored-outcome">{t("storedSaved", { count: stored.report.publishedCount })}</p>
      {#if stored.report.residue}<p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>{/if}
    {:else if stored.report.status === "partially-saved"}
      <p class="problem" data-test="stored-outcome">
        {t("storedPartial", { count: stored.report.publishedCount, total: stored.report.total })}
      </p>
      {#if stored.report.residue}<p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>{/if}
    {:else if stored.report.status === "declined"}
      <p class="dim" data-test="stored-outcome">{t("storedDeclined")}</p>
    {:else if stored.report.status === "cancelled"}
      <p class="dim" data-test="stored-outcome">{t("storedCancelled")}</p>
      {#if stored.report.residue}<p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>{/if}
    {:else}
      <p class="problem" data-test="stored-outcome">{failureText(stored.report.failure)}</p>
      <!-- "Nothing was saved" is only said when it is PROVEN. An unconfirmed
           publication gets its own sentence, and it asks the user to look. -->
      {#if stored.report.failure.published === "unknown"}
        <p class="dim small" data-test="stored-unconfirmed">{t("storedUnconfirmed")}</p>
      {/if}
      {#if stored.report.failure.residue}
        <p class="dim small" data-test="stored-residue">{t("storedResidue")}</p>
      {/if}
      <!-- Offered only where a fresh attempt could genuinely differ. After an
           integrity or destination failure it is absent, because suggesting a
           retry there implies the key or the disk might be fine. -->
      {#if stored.report.failure.retryable}
        <button data-test="stored-retry" onclick={() => void stored.open()}>{t("storedRetry")}</button>
      {/if}
    {/if}
  {/if}

  {#if stored.retained.length > 0}
    <p class="problem small" data-test="stored-retained">{t("storedRetained", { count: stored.retained.length })}</p>
    {#each stored.retained as ticket (ticket)}
      <button data-test="stored-cleanup-retry" onclick={() => void stored.retryCleanup(ticket)}>
        {t("storedRetainedRetry")}
      </button>
    {/each}
    {#if stored.cleanupNote}
      <p class="dim small" data-test="stored-cleanup-note">{t(stored.cleanupNote)}</p>
    {/if}
  {/if}
</Card>

<!-- The two modes this build does not have. Named, not mocked up. -->
<Card title={t("soonTitle")}>
  <p class="dim" data-test="stored-send-soon">{t("storedSendSoon")}</p>
  <p class="dim" data-test="stored-history-soon">{t("storedHistorySoon")}</p>
</Card>

<style>
  h1 { margin: 0 0 var(--space-hairline); font-size: 20px; font-weight: 600; }
  .lede { margin: 0 0 var(--space-section); color: var(--text-dim); }
  .dim { color: var(--text-dim); margin: 0 0 var(--space-tight); }
  .small { font-size: 13px; }
  .problem { margin: 0 0 var(--space-inner); }
  .row { display: flex; gap: var(--space-tight); margin-bottom: var(--space-inner); }
  .row input { flex: 1; }
  progress { width: 100%; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
