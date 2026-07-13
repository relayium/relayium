<script lang="ts">
  import type { Snippet } from "svelte";
  import CodePairing from "./CodePairing.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import ModeCompare from "./ModeCompare.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import CrossSell from "./CrossSell.svelte";
  import WhyAccount from "./WhyAccount.svelte";
  import { session } from "./auth.svelte";
  import { enterRoom } from "./room.svelte";
  import { clearOutbox } from "./outbox.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import Account from "./Account.svelte";
  import PageFooter from "./PageFooter.svelte";

  let { roomCode = "", linkDead = false, showTransfer = false, relayDenied = "", transferSurface, dismissLan }:
    { roomCode?: string; linkDead?: boolean; showTransfer?: boolean; relayDenied?: string; transferSurface?: Snippet; dismissLan?: () => void } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const inRoom = $derived(!!roomCode);
  let loginOpen = $state(false);

  // Leaving a room must also drop the sessionStorage role markers — otherwise a
  // stale "I minted this code" flag makes the next method choice render the
  // wrong side (e.g. showing a waiting screen instead of the code entry). Key
  // mirrors CodePairing (EXP_KEY).
  function startOver() {
    sessionStorage.removeItem("relayium_pair_exp");
    // Queued-but-unsent files belong to the abandoned pairing attempt — drop
    // them so they can't surprise-send to the next peer that appears.
    clearOutbox();
    // A LAN auto-pair (and the share-link+same-LAN overlap) has no room to leave —
    // enterRoom({}) alone leaves the surface up, since it's driven by the visible
    // peer, not the URL. Suppress it so we fall back to the method choices; App
    // self-clears the flag once the peer drops.
    dismissLan?.();
    enterRoom({});
  }
</script>

<section class="crosspage">
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.crossTitle}</h1>
    <p class="tagline">{t.tagline}</p>
    {#if !inRoom}
      <p class="pitch">{t.crossPitch}</p>
    {/if}
  </header>

  <div class="cards">
    {#if showTransfer && transferSurface}
      <!-- Active realtime transfer — one focused card, regardless of how they connected -->
      <section class="card focus">
        <h2>⚡ {t.crossnet.realtimeTitle}</h2>
        <p class="cardsub">{t.crossnet.realtimeSub}</p>
        {@render transferSurface()}
        <p class="foot">{t.crossnet.realtimeFoot}</p>
        <button class="startover" onclick={startOver}>{t.startOver}</button>
      </section>
    {:else if roomCode}
      <!-- In a code room (minter waiting, or recipient who joined via code/link) -->
      <section class="card focus">
        <div class="mhead"><h2>{t.methods.realtime.name}</h2></div>
        <p class="cardsub">{t.methods.realtime.sub}</p>
        <CodePairing {roomCode} expired={linkDead} {relayDenied} />
        <button class="startover" onclick={startOver}>{t.startOver}</button>
      </section>
    {:else}
      <!-- Realtime direct — the only method on this page (stored moved to /offline-transfer) -->
      <section class="card">
        <div class="mhead"><h2>{t.methods.realtime.name}</h2><span class="badge ok">{t.methods.realtime.badge}</span></div>
        <p class="cardsub">{t.methods.realtime.sub}</p>
        <CodePairing requireLogin={() => (loginOpen = true)} />
      </section>
    {/if}
  </div>

  {#if !inRoom && !session().user}
    <WhyAccount />
  {/if}

  {#if !inRoom}
    <CrossSell target="offline" />
    <HowItWorks variant="realtime" />
    <ModeCompare />
    <FeatureStrip />
    <UseCases />
    <Faq />
  {/if}

  <PageFooter fineprint={t.footer} />
</section>

<style>
  .crosspage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: var(--space-3) 0 var(--space-5); }
  /* Intentional page-header size — smaller than the marketing hero (--fs-display). */
  .cn-head h1 { font-size: 34px; margin: 0 0 var(--space-2); letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: var(--fs-body); max-width: 44ch; margin: 0 auto; }
  .cn-head .pitch { color: var(--text); font-size: var(--fs-xs); max-width: 52ch; margin: var(--space-3) auto 0; line-height: 1.55; }

  .cards { display: grid; grid-template-columns: 1fr; gap: var(--space-4); max-width: 720px; margin: 0 auto; align-items: stretch; }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-5);
    background: var(--social-bg); display: flex; flex-direction: column; gap: var(--space-3);
  }
  .card h2 { font-size: var(--fs-h3); margin: 0; }
  .cardsub { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.5; }

  .mhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .mhead h2 { margin-right: auto; }
  .badge {
    flex: none; font-size: 11.5px; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    color: var(--text); background: var(--code-bg); border: 1px solid var(--border);
  }
  .badge.ok { color: #1f9d55; background: rgba(46, 204, 113, .12); border-color: rgba(46, 204, 113, .35); }
  @media (prefers-color-scheme: dark) {
    .badge.ok { color: #4ade80; background: rgba(46, 204, 113, .16); border-color: rgba(46, 204, 113, .4); }
  }

  .startover {
    align-self: center; margin-top: 2px;
    font: inherit; font-size: var(--fs-xs); padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); cursor: pointer;
    background: none; border: 1px solid var(--border); color: var(--text);
    transition: border-color .13s, color .13s;
  }
  .startover:hover { border-color: var(--accent-border); color: var(--text-h); }
  .foot { margin: var(--space-1) 0 0; font-size: 12px; color: var(--text); text-align: center; }
</style>
