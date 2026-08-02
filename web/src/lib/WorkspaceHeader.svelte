<script lang="ts">
  // The one trust header of a unified (`link/1`) peer workspace.
  //
  // Pure presentation + callbacks, like MessagePanel and DeviceRadar: it holds no
  // link, lane or protocol state. Its whole job is the product rule "one connected
  // peer workspace has one encrypted link and at most one SAS" — so this is the
  // ONLY place a mixed link's verification code, path badge and disconnect action
  // are rendered. The file and text lane cards below it must not repeat any of them.
  //
  // "At most one" because advanced verification is off by default: on a default
  // session `sasCode` stays empty and no code is shown at all. The link is still
  // encrypted and commit-reveal-complete (commit-reveal + AEAD, neither optional),
  // which is protocol integrity — each side revealed the key it committed to and
  // every frame is authenticated. What the absent code means is that nobody
  // compared endpoint keys out of band, so nothing here establishes that the peer
  // is the intended person; only a compared SAS does.
  import { lang, messages, type Messages } from "./i18n.svelte";
  // Taken off the workspace getter that feeds this prop rather than from
  // peer-link.svelte directly: that module specifier differs from the PeerLink
  // component only by case, which a case-insensitive filesystem cannot separate.
  import type { PeerWorkspace } from "./peer-workspace.svelte";
  import type { ConnPath } from "./webrtc";

  type LinkStatus = PeerWorkspace["linkStatus"];

  let {
    peerName, status, sasCode, path, onDisconnect, element = $bindable(),
  }: {
    peerName: string;
    status: LinkStatus;
    sasCode: string;
    path?: ConnPath;
    onDisconnect: () => void;
    /** The pinned box itself, handed back so a caller that must clear it can
     *  measure it at the moment it scrolls. Deliberately the element and not a
     *  measured number: this header wraps differently in nine locales and at
     *  every width, AND it grows by the SAS row the instant the link produces a
     *  code — a height sampled even one frame earlier is the wrong height. */
    element?: HTMLElement;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);

  function stateText(m: Messages, s: LinkStatus): string {
    switch (s) {
      case "requesting": return m.workspace.stateRequesting;
      // A held link is rebuilding its transport under the SAME authentication
      // step, so it must not read as a new connection or as a failure. A state
      // of its own is stage-4 work; reusing this string adds no locale churn.
      case "connecting": case "interrupted": return m.workspace.stateConnecting;
      case "open": return m.workspace.stateOpen;
      case "failed": return m.workspace.stateFailed;
      default: return m.workspace.stateIdle;
    }
  }
  function pathLabel(m: Messages, p: ConnPath): string {
    return p === "lan" ? m.pathLan : p === "relay" ? m.pathRelay : m.pathP2p;
  }
</script>

<!-- Sticky so a long activity column can never scroll the SAS — when advanced
     verification put one there — out of the verification context. Everything
     inside stays on one wrapping row set so a 320px viewport keeps it short
     enough to be worth pinning.

     What is pinned is deliberately only the trust state: who, what link, which
     code. Measured at 390px, adding the explanatory sentence below made this box
     274px — a third of the phone screen, taken from every subsequent scroll
     position, forever. The sentence is read once, so it scrolls away. -->
<section class="ui-card workspace-head" aria-label={t.workspace.heading} bind:this={element}>
  <div class="wh-top">
    <!-- An inbound link is briefly establishing before either lane names a peer.
         Say nothing rather than "Connected to " with an empty name. -->
    {#if peerName}
      <span class="wh-peer">{t.workspace.peer(peerName)}</span>
    {/if}
    <span class="wh-state">{stateText(t, status)}</span>
    {#if path}
      <span class="path path-{path}"><i class="dot" aria-hidden="true"></i>{pathLabel(t, path)}</span>
    {/if}
    <button type="button" class="btn btn-secondary btn-sm wh-disconnect" onclick={onDisconnect}>
      {t.workspace.disconnect}
    </button>
  </div>
  {#if sasCode}
    <div class="sas">{t.codeLabel} <code>{sasCode}</code> — {t.codeCompare}</div>
  {/if}
</section>
<p class="wh-note">{t.workspace.lanesNote}</p>

<style>
  .workspace-head {
    position: sticky;
    inset-block-start: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-block-end: var(--space-4);
    /* Restated (it matches .ui-card) because this element scrolls over other
       content: an opaque surface is load-bearing here, not decoration. The
       tighter block padding keeps a pinned header short on a 320px viewport. */
    background: var(--surface);
    padding-block: var(--space-3);
    /* The note below is a separate, unpinned block; keep them visually joined. */
    margin-block-end: var(--space-2);
  }
  .wh-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--fs-sm);
  }
  .wh-peer { font-weight: 600; color: var(--text-h); }
  .wh-state { color: var(--text); }
  /* Push the destructive-ish action to the row end in both directions; logical
     property so RTL mirrors without a second rule. */
  .wh-disconnect { margin-inline-start: auto; }
  .wh-note {
    margin: 0 0 var(--space-4);
    font-size: var(--fs-xs);
    color: var(--text);
    line-height: 1.5;
  }
  /* The shared .btn coarse-pointer rule already provides the 44px touch floor;
     nothing here raises specificity above it. */
</style>
