<script lang="ts">
  import type { Snippet } from "svelte";
  import Account from "./Account.svelte";
  import CrossNetwork from "./CrossNetwork.svelte";
  import CodePairing from "./CodePairing.svelte";
  import StoredUpload from "./StoredUpload.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import ModeCompare from "./ModeCompare.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import { session } from "./auth.svelte";
  import { enterRoom } from "./room.svelte";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  let { roomToken = "", roomCode = "", linkDead = false, showTransfer = false, transferSurface }:
    { roomToken?: string; roomCode?: string; linkDead?: boolean; showTransfer?: boolean; transferSurface?: Snippet } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const inRoom = $derived(!!roomToken || !!roomCode);
  let loginOpen = $state(false);
</script>

<section class="crosspage">
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.nav.crossTab}</h1>
    <p class="tagline">{t.tagline}</p>
    {#if !inRoom}
      <p class="pitch">{t.crossPitch}</p>
    {/if}
  </header>

  <div class="cards" class:single={showTransfer || inRoom}>
    {#if showTransfer && transferSurface}
      <!-- Active realtime transfer — one focused card, regardless of how they connected -->
      <section class="card focus">
        <h2>⚡ {t.crossnet.realtimeTitle}</h2>
        <p class="cardsub">{t.crossnet.realtimeSub}</p>
        {@render transferSurface()}
        <p class="foot">{t.crossnet.realtimeFoot}</p>
      </section>
    {:else if roomToken}
      <!-- 🔗 Share link — originator shows link+QR, joiner connects -->
      <section class="card focus">
        <div class="mhead"><h2>{t.methods.share.name}</h2></div>
        <p class="cardsub">{t.methods.share.sub}</p>
        <CrossNetwork {roomToken} />
        <p class="foot">{t.crossnet.realtimeFoot}</p>
        <button class="startover" onclick={() => enterRoom({})}>{t.startOver}</button>
      </section>
    {:else if roomCode}
      <!-- 🔢 Pairing code — recipient joined via a code link -->
      <section class="card focus">
        <div class="mhead"><h2>{t.methods.pairing.name}</h2></div>
        <p class="cardsub">{t.methods.pairing.sub}</p>
        <CodePairing {roomCode} expired={linkDead} />
        <button class="startover" onclick={() => enterRoom({})}>{t.startOver}</button>
      </section>
    {:else}
      <!-- Three peer-to-peer / stored methods, side by side -->
      <section class="card">
        <div class="mhead"><h2>{t.methods.pairing.name}</h2><span class="badge ok">{t.methods.pairing.badge}</span></div>
        <p class="cardsub">{t.methods.pairing.sub}</p>
        <CodePairing />
      </section>

      <section class="card">
        <div class="mhead"><h2>{t.methods.share.name}</h2><span class="badge need">{t.methods.share.badge}</span></div>
        <p class="cardsub">{t.methods.share.sub}</p>
        {#if session().user}
          <CrossNetwork />
        {:else}
          <div class="signin">
            <button class="primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
            <p class="hint">{t.methods.share.signIn}</p>
          </div>
        {/if}
      </section>

      <section class="card">
        <div class="mhead"><h2>{t.methods.stored.name}</h2><span class="badge">{t.methods.stored.badge}</span></div>
        <p class="cardsub">{t.methods.stored.sub}</p>
        {#if session().user}
          <StoredUpload />
        {:else}
          <div class="signin">
            <button class="primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
          </div>
        {/if}
      </section>
    {/if}

    {#if linkDead && !roomCode}
      <p class="error">{t.crossnet.linkDead}</p>
    {/if}
  </div>

  {#if !inRoom}
    <HowItWorks />
    <ModeCompare />
    <FeatureStrip />
    <UseCases />
    <Faq />
  {/if}

  <footer>
    <nav class="legal">
      <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
      <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
      <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
    <span class="fineprint">{t.footer}</span>
  </footer>
</section>

<style>
  .crosspage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: 12px 0 20px; }
  .cn-head h1 { font-size: 34px; margin: 0 0 8px; letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: 15px; max-width: 44ch; margin: 0 auto; }
  .cn-head .pitch { color: var(--text); font-size: 13.5px; max-width: 52ch; margin: 12px auto 0; line-height: 1.55; }

  .cards { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); align-items: stretch; }
  .cards.single { grid-template-columns: 1fr; max-width: 520px; margin: 0 auto; }
  .card {
    border: 1px solid var(--border); border-radius: 16px; padding: 20px;
    background: var(--social-bg); display: flex; flex-direction: column; gap: 12px;
  }
  .card h2 { font-size: 17px; margin: 0; }
  .cardsub { margin: 0; font-size: 13px; color: var(--text); line-height: 1.5; }

  .mhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .mhead h2 { margin-right: auto; }
  .badge {
    flex: none; font-size: 11.5px; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    color: var(--text); background: var(--code-bg); border: 1px solid var(--border);
  }
  .badge.ok { color: #1f9d55; background: rgba(46, 204, 113, .12); border-color: rgba(46, 204, 113, .35); }
  .badge.need { color: var(--accent); background: var(--accent-bg); border-color: var(--accent-border); }
  @media (prefers-color-scheme: dark) {
    .badge.ok { color: #4ade80; background: rgba(46, 204, 113, .16); border-color: rgba(46, 204, 113, .4); }
  }

  .startover {
    align-self: center; margin-top: 2px;
    font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
    background: none; border: 1px solid var(--border); color: var(--text);
  }
  .startover:hover { border-color: var(--accent-border); color: var(--text-h); }
  .signin { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 6px 0; }
  .signin .hint { margin: 0; font-size: 12.5px; color: var(--text); text-align: center; }
  .foot { margin: 4px 0 0; font-size: 12px; color: var(--text); text-align: center; }
  .error {
    grid-column: 1 / -1;
    margin: 2px 0 0; text-align: center; padding: 10px 12px; border-radius: 10px; font-size: 13.5px;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .primary {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    background: var(--accent); border: 1px solid var(--accent); color: #fff; align-self: center;
  }
  .primary:hover { filter: brightness(1.08); }

  footer {
    margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }

  @media (max-width: 760px) {
    .cards { grid-template-columns: 1fr; }
  }
</style>
