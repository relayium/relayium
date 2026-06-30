<script lang="ts">
  import type { Snippet } from "svelte";
  import Account from "./Account.svelte";
  import CrossNetwork from "./CrossNetwork.svelte";
  import CodePairing from "./CodePairing.svelte";
  import StoredUpload from "./StoredUpload.svelte";
  import { session } from "./auth.svelte";
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
  </header>

  <div class="cards">
    <!-- ⚡ Realtime direct — code pairing (login-free), files never touch the server -->
    <section class="card realtime">
      <h2>⚡ {t.crossnet.realtimeTitle}</h2>
      <p class="cardsub">{t.crossnet.realtimeSub}</p>

      {#if showTransfer && transferSurface}
        {@render transferSurface()}
      {:else if roomToken}
        <CrossNetwork {roomToken} />
      {:else if roomCode}
        <CodePairing {roomCode} expired={linkDead} />
      {:else}
        <CodePairing />
        {#if session().user}
          <div class="enhance">
            <CrossNetwork />
            <p class="hint">{t.pair.loginEnhance}</p>
          </div>
        {/if}
      {/if}

      {#if linkDead && !roomCode}
        <p class="error">{t.crossnet.linkDead}</p>
      {/if}
      <p class="foot">{t.crossnet.realtimeFoot}</p>
    </section>

    <!-- 📦 Stored link — encrypted-at-rest, async download (login required) -->
    {#if !inRoom}
      <section class="card stored">
        <h2>📦 {t.stored.title}</h2>
        <p class="cardsub">{t.stored.desc}</p>
        {#if session().user}
          <StoredUpload />
        {:else}
          <button class="primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
        {/if}
      </section>
    {/if}
  </div>

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

  .cards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; }
  .card {
    border: 1px solid var(--border); border-radius: 16px; padding: 20px;
    background: var(--social-bg); display: flex; flex-direction: column; gap: 12px;
  }
  .card h2 { font-size: 18px; margin: 0; }
  .cardsub { margin: 0; font-size: 13.5px; color: var(--text); }
  .enhance { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--border); padding-top: 12px; }
  .enhance .hint { margin: 0; font-size: 12.5px; color: var(--text); text-align: center; }
  .foot { margin: 0; font-size: 12px; color: var(--text); text-align: center; }
  .error {
    margin: 6px 0 0; text-align: center; padding: 10px 12px; border-radius: 10px; font-size: 13.5px;
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
</style>
