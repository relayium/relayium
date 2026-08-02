<!-- web/src/lib/OfflinePage.svelte -->
<script lang="ts">
  import StoredUpload from "./StoredUpload.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import CrossSell from "./CrossSell.svelte";
  import ModeCompare from "./ModeCompare.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import WhyAccount from "./WhyAccount.svelte";
  import { session } from "./auth.svelte";
  import { setLoginOpen } from "./login.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, PRICING_PATH } from "./router.svelte";
  import PageFooter from "./PageFooter.svelte";
  import Icon from "./Icon.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const cloudGuideSlug = "guides/push-to-cloud-pull-on-another-computer";
  const cloudGuideHref = $derived(lang() === "en" ? `/${cloudGuideSlug}` : `/${lang()}/${cloudGuideSlug}`);
</script>

<section class="offlinepage page-enter">
  <!-- Sign-in for this login-gated flow lives in the top nav (Nav.svelte renders
       the Account control for cross/offline/me); the two free pages never show
       an account concept at all. -->
  <header class="ui-page-head">
    <h1>{t.offlineTitle}</h1>
    <p class="tagline">{t.offline.tagline}</p>
    <p class="pitch">{t.offline.pitch}</p>
  </header>

  <div class="cards">
    <section class="ui-card ui-card-raised ui-stack">
      <div class="ui-card-head">
        <h2 class="mode-title"><Icon name="package" size={18} /><span>{t.methods.stored.name}</span></h2>
        <span class="ui-badge">{t.methods.stored.badge}</span>
      </div>
      <p class="ui-card-sub">{t.methods.stored.sub}</p>
      {#if session().user}
        <StoredUpload />
      {:else}
        <div class="signin">
          <button class="btn btn-primary" onclick={() => setLoginOpen(true)}>{t.account.signIn}</button>
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
  /* Layout only — the header, card surface, title row, sub-copy and badge come
     from the shared primitives in app.css (same set CrossPage uses). */
  .offlinepage { position: relative; }

  .cards { max-inline-size: 720px; margin-inline: auto; }

  .mode-title { display: flex; align-items: center; gap: var(--space-2); }

  .signin { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding-block: var(--space-2); }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }

  .cli-note {
    max-inline-size: 720px; margin-block: var(--space-4) 0; margin-inline: auto; text-align: center;
    font-size: var(--fs-xs); color: var(--text); line-height: 1.55;
  }
  .cli-note a { color: var(--accent-fg); text-decoration: none; white-space: nowrap; }
  .cli-note a:hover { text-decoration: underline; }
</style>
