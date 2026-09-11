<!--
  The pairing handoff: scan on the left, copy on the right.

  `PairingCodeHandoffView` in `apps/mac/Relayium/QRCode.swift:95` is the parity
  target — QR beside the link so one cannot quietly lose an affordance the other
  has. This renders nothing at all when there is no live code; the PairPage above
  already says why, and saying it twice in different words is how two components
  come to disagree.

  The QR, the link and the "Copied" confirmation all belong to ONE generation.
  The controller drops all three the moment main reports a new one.
-->
<script lang="ts">
  import { lang } from "../i18n/index.svelte.js";
  import { pt } from "../pair/messages.js";
  import { QR_SIDE } from "../pair/qr.js";
  import type { PairHandoffController } from "../pair/pair-handoff-controller.svelte.js";

  let { controller }: { controller: PairHandoffController } = $props();

  const view = $derived(controller.view);
  const locale = $derived(lang());
</script>

{#if view.kind === "live"}
  <div class="handoff" data-test="pair-handoff" data-generation={view.generation} data-lang={locale}>
    <div class="scan">
      {#if controller.qrDataUrl !== null}
        <!-- A data URL into an <img>: the failure path is simply "no src". -->
        <img
          class="qr"
          data-test="pair-qr"
          src={controller.qrDataUrl}
          width={QR_SIDE}
          height={QR_SIDE}
          alt={pt("qrAlt")}
        />
        <p class="dim small" data-test="pair-scan-hint">{pt("scanHint")}</p>
      {:else if controller.qrPending}
        <div class="qr placeholder" data-test="pair-qr-pending" aria-hidden="true"></div>
        <p class="dim small">{pt("qrRendering")}</p>
      {:else}
        <!-- A failed QR is a missing accelerator, not a broken screen. -->
        <p class="dim small" data-test="pair-qr-unavailable">{pt("qrUnavailable")}</p>
      {/if}
    </div>

    <div class="share">
      <p class="label small dim">{pt("linkLabel")}</p>
      <!-- Shown so a person can see what they are about to send. It is not an
           input and not a link element: nothing here navigates. -->
      <p class="link" data-test="pair-link">{view.link}</p>
      <div class="row">
        <button
          data-test="pair-copy"
          disabled={controller.copying}
          onclick={() => void controller.copy()}
        >
          {pt("copyLink")}
        </button>
        {#if controller.copied}
          <span class="ok small" data-test="pair-copied" role="status" aria-live="polite">
            {pt("copied")}
          </span>
        {/if}
      </div>
      {#if controller.copyNotice?.kind === "expired"}
        <p class="problem small" data-test="pair-copy-expired">{pt("copyExpired")}</p>
      {:else if controller.copyNotice?.kind === "failed"}
        <p class="problem small" data-test="pair-copy-failed">{pt("copyFailed")}</p>
      {/if}
      <p class="dim small" data-test="pair-link-note">{pt("linkNote")}</p>
    </div>
  </div>
{/if}

<style>
  /* Scan left, share right — above the fold at the app's minimum width, then
     stacked when there is not room for two columns. */
  .handoff {
    display: flex;
    gap: var(--space-section);
    align-items: flex-start;
    margin-top: var(--space-inner);
  }
  .scan { flex: 0 0 auto; width: 160px; }
  .share { flex: 1 1 auto; min-width: 0; }
  .qr {
    display: block;
    width: 160px;
    height: 160px;
    border-radius: var(--space-hairline);
    background: #fff;
    /* Keep the modules crisp rather than smoothed, as the Mac does. */
    image-rendering: pixelated;
  }
  .placeholder { background: var(--border); }
  .dim { color: var(--text-dim); }
  .small { font-size: 13px; }
  .label { margin: 0 0 var(--space-hairline); }
  p { margin: 0 0 var(--space-tight); }
  .link {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 13px;
    overflow-wrap: anywhere;
    margin-bottom: var(--space-inner);
  }
  .row { display: flex; gap: var(--space-tight); align-items: center; }
  .ok { color: var(--accent); }
  .problem { margin-top: var(--space-tight); }

  @media (max-width: 680px) {
    .handoff { flex-direction: column; }
    .scan { width: auto; }
  }
</style>
