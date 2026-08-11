<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RelayAvailability } from "./ice";
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
  import { resetPreupload } from "./preupload.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { setLoginOpen } from "./login.svelte";
  import PageFooter from "./PageFooter.svelte";
  import Icon from "./Icon.svelte";

  let { roomCode = "", linkDead = false, showTransfer = false, relayStatus = "ok", transferSurface, dismissLan }:
    { roomCode?: string; linkDead?: boolean; showTransfer?: boolean; relayStatus?: RelayAvailability; transferSurface?: Snippet; dismissLan?: () => void } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const inRoom = $derived(!!roomCode);

  // Leaving a room must also drop the sessionStorage role markers — otherwise a
  // stale "I minted this code" flag makes the next method choice render the
  // wrong side (e.g. showing a waiting screen instead of the code entry). Key
  // mirrors CodePairing (EXP_KEY).
  function startOver() {
    sessionStorage.removeItem("relayium_pair_exp");
    // Queued-but-unsent files belong to the abandoned pairing attempt — drop
    // them so they can't surprise-send to the next peer that appears. Any
    // pre-upload for that attempt goes with them: it is bound to the room being
    // abandoned, so the rest of its bytes would buy nothing.
    clearOutbox();
    resetPreupload();
    // A LAN auto-pair (and the share-link+same-LAN overlap) has no room to leave —
    // enterRoom({}) alone leaves the surface up, since it's driven by the visible
    // peer, not the URL. Suppress it so we fall back to the method choices; App
    // self-clears the flag once the peer drops.
    dismissLan?.();
    enterRoom({});
  }
</script>

<section class="crosspage page-enter">

  <header class="ui-page-head">
    <h1>{t.crossTitle}</h1>
    <p class="tagline">{t.tagline}</p>
    {#if !inRoom}
      <p class="pitch">{t.crossPitch}</p>
    {/if}
  </header>

  <div class="cards">
    {#if showTransfer && transferSurface}
      <!-- Active realtime transfer — one focused card, regardless of how they connected -->
      <section class="ui-card ui-card-raised ui-stack active">
        <h2 class="realtime-heading"><span class="realtime-icon" aria-hidden="true"><Icon name="bolt" size={18} /></span><span>{t.crossnet.realtimeTitle}</span></h2>
        <p class="ui-card-sub">{t.crossnet.realtimeSub}</p>
        {@render transferSurface()}
        <p class="foot">{t.crossnet.realtimeFoot}</p>
        <button class="btn btn-ghost btn-sm startover" onclick={startOver}>{t.startOver}</button>
      </section>
    {:else if roomCode}
      <!-- In a code room (minter waiting, or recipient who joined via code/link) -->
      <section class="ui-card ui-card-raised ui-stack active">
        <div class="ui-card-head"><h2 class="realtime-heading"><span class="realtime-icon" aria-hidden="true"><Icon name="bolt" size={18} /></span><span>{t.methods.realtime.name}</span></h2></div>
        <p class="ui-card-sub">{t.methods.realtime.sub}</p>
        <CodePairing {roomCode} expired={linkDead} {relayStatus} />
        <button class="btn btn-ghost btn-sm startover" onclick={startOver}>{t.startOver}</button>
      </section>
    {:else}
      <!-- Realtime transfer — the only method on this page (stored moved to /offline-transfer) -->
      <section class="ui-card ui-card-raised ui-stack">
        <div class="ui-card-head"><h2 class="realtime-heading"><span class="realtime-icon" aria-hidden="true"><Icon name="bolt" size={18} /></span><span>{t.methods.realtime.name}</span></h2><span class="ui-badge ui-badge-ok">{t.methods.realtime.badge}</span></div>
        <p class="ui-card-sub">{t.methods.realtime.sub}</p>
        <CodePairing requireLogin={() => setLoginOpen(true)} />
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
    <Faq variant="cross" />
  {/if}

  <PageFooter fineprint={t.footer} />
</section>

<style>
  /* Layout only. The page header, the card surface, its title/sub/badge and the
     "start over" control are all shared primitives now (app.css): .ui-page-head,
     .ui-card{,-raised,-head,-sub}, .ui-stack, .ui-badge, .btn. */
  .crosspage { position: relative; }
  @media (max-width: 700px) {
    /* Localized headings include long German/Portuguese compound words. At 320px
       their min-content width used to push the whole document 9–13px sideways;
       inherit a last-resort break opportunity only where it is needed, leaving
       desktop flex/grid intrinsic sizing unchanged. */
    .crosspage { overflow-wrap: anywhere; }
  }

  .cards { display: grid; grid-template-columns: 1fr; gap: var(--space-4); max-inline-size: 720px; margin-inline: auto; align-items: stretch; }

  .realtime-heading { display: inline-flex; align-items: flex-start; gap: var(--space-2); min-inline-size: 0; }
  .realtime-icon { flex: none; color: var(--accent); margin-block-start: 1px; }

  .startover { align-self: center; margin-block-start: 2px; flex: none; }
  .foot { margin-block: var(--space-1) 0; font-size: 12px; color: var(--text); text-align: center; }
</style>
