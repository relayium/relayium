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
  import WhyAccount from "./WhyAccount.svelte";
  import { session } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, PRICING_PATH } from "./router.svelte";
  import PageFooter from "./PageFooter.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let loginOpen = $state(false);
  const cloudGuideSlug = "guides/push-to-cloud-pull-on-another-computer";
  const cloudGuideHref = $derived(lang() === "en" ? `/${cloudGuideSlug}` : `/${lang()}/${cloudGuideSlug}`);
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

  <p class="cli-note">
    {t.offline.cliNote}
    <a href={cloudGuideHref}>{t.offline.cliLink}</a>
  </p>

  <p class="cli-note plan-note">
    {t.offline.planNote}
    <a href={PRICING_PATH} onclick={(e) => { e.preventDefault(); navigate("pricing"); }}>{t.pricingPage.navLink}</a>
  </p>

  {#if !session().user}
    <WhyAccount />
  {/if}

  <CrossSell target="realtime" />
  <HowItWorks variant="offline" />
  <ModeCompare />
  <FeatureStrip />
  <UseCases />
  <Faq variant="offline" />

  <PageFooter fineprint={t.offlineFooter} />
</section>

<style>
  .offlinepage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: var(--space-3) 0 var(--space-5); }
  /* Mirrors CrossPage's page-header scale — smaller than the marketing hero. */
  .cn-head h1 { font-size: 34px; margin: 0 0 var(--space-2); letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: var(--fs-body); max-width: 44ch; margin: 0 auto; }
  .cn-head .pitch { color: var(--text); font-size: var(--fs-xs); max-width: 52ch; margin: var(--space-3) auto 0; line-height: 1.55; }

  .cards { max-width: 720px; margin: 0 auto; }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-5);
    background: var(--surface); display: flex; flex-direction: column; gap: var(--space-3);
    box-shadow: 0 1px 2px rgba(0, 0, 0, .04), 0 12px 32px -18px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .card h2 { font-size: var(--fs-h3); margin: 0; }
  .cardsub { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.5; }
  .mhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .mhead h2 { margin-inline-end: auto; }
  .badge {
    flex: none; font-size: 11.5px; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    color: var(--text); background: var(--code-bg); border: 1px solid var(--border);
  }

  .signin { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }

  .cli-note {
    max-width: 720px; margin: var(--space-4) auto 0; text-align: center;
    font-size: var(--fs-xs); color: var(--text); line-height: 1.55;
  }
  .cli-note a { color: var(--accent); text-decoration: none; white-space: nowrap; }
  .cli-note a:hover { text-decoration: underline; }
</style>
