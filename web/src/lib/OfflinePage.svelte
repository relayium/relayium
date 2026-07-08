<!-- web/src/lib/OfflinePage.svelte -->
<script lang="ts">
  import Account from "./Account.svelte";
  import StoredUpload from "./StoredUpload.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import CrossSell from "./CrossSell.svelte";
  import ModeCompare from "./ModeCompare.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import { session } from "./auth.svelte";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let loginOpen = $state(false);
</script>

<section class="offlinepage">
  <!-- The async page is the ONLY page with account UI: sign-in lives here (and /me),
       so the two free pages never show an account concept at all. -->
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.offlineTitle}</h1>
    <p class="tagline">{t.offline.tagline}</p>
    <p class="pitch">{t.offline.pitch}</p>
  </header>

  <div class="cards">
    <section class="card">
      <div class="mhead"><h2>{t.methods.stored.name}</h2><span class="badge">{t.methods.stored.badge}</span></div>
      <p class="cardsub">{t.methods.stored.sub}</p>
      {#if session().user}
        <StoredUpload />
      {:else}
        <div class="signin">
          <button class="btn btn-primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
          <p class="hint">{t.offline.signIn}</p>
        </div>
      {/if}
    </section>
  </div>

  <CrossSell target="realtime" />
  <HowItWorks variant="offline" />
  <ModeCompare />
  <FeatureStrip />
  <UseCases />
  <Faq />

  <footer>
    <nav class="legal">
      <a href={legalUrl("security", lang())}>{t.legal.security}</a>
      <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
      <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
      <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
    <span class="fineprint">{t.footer}</span>
  </footer>
</section>

<style>
  .offlinepage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: var(--space-3) 0 var(--space-5); }
  /* Mirrors CrossPage's page-header scale — smaller than the marketing hero. */
  .cn-head h1 { font-size: 34px; margin: 0 0 var(--space-2); letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: var(--fs-body); max-width: 44ch; margin: 0 auto; }
  .cn-head .pitch { color: var(--text); font-size: var(--fs-xs); max-width: 52ch; margin: var(--space-3) auto 0; line-height: 1.55; }

  .cards { max-width: 520px; margin: 0 auto; }
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

  .signin { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }

  footer {
    margin-top: var(--space-8); padding-top: var(--space-5); border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
</style>
