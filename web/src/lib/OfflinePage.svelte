<!-- web/src/lib/OfflinePage.svelte -->
<script lang="ts">
  import StoredUpload from "./StoredUpload.svelte";
  import HowItWorks from "./HowItWorks.svelte";
  import CrossSell from "./CrossSell.svelte";
  import FeatureStrip from "./FeatureStrip.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";
  import WhyAccount from "./WhyAccount.svelte";
  import { session } from "./auth.svelte";
  import { setLoginOpen } from "./login.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, PRICING_PATH, CROSS_PATH } from "./router.svelte";
  import PageFooter from "./PageFooter.svelte";
  import Icon from "./Icon.svelte";
  import Group from "./ui/Group.svelte";
  import Help from "./ui/Help.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const cloudGuideSlug = "guides/push-to-cloud-pull-on-another-computer";
  const cloudGuideHref = $derived(lang() === "en" ? `/${cloudGuideSlug}` : `/${lang()}/${cloudGuideSlug}`);

  // The comparison table lives ONCE, on the cross-network page. This page used
  // to render an identical copy; it now links to the one that exists. The hash
  // rides on the same in-app navigation, and the cross page opens and scrolls
  // to it on mount.
  const compareHash = "#compare";
  const compareHref = `${CROSS_PATH}${compareHash}`;
  function goCompare(e: MouseEvent) {
    e.preventDefault();
    // The hash is handed to the router instead of being written here, because
    // this handler cannot know when the navigation happens: the guard may put a
    // confirm in front of it (an upload in flight), and the route then moves
    // long after this function has returned. The router writes the hash in the
    // same history entry as the path, at the moment it commits — so a confirmed
    // navigation still lands on the table, and a deferred or declined one never
    // leaves `#compare` on THIS page's entry.
    navigate("cross", compareHash);
  }
</script>

<section class="offlinepage page-enter">
  <!-- Sign-in for this login-gated flow lives in the top nav (Nav.svelte renders
       the Account control for cross/offline/me); the two free pages never show
       an account concept at all.

       One title, same correction as the pairing page: `offlineTitle` and
       `methods.stored.name` are the same words, and both were on screen. The
       <h1> keeps the page's name; the group label names what the card DOES. -->
  <header class="ui-page-head">
    <h1>{t.offlineTitle}</h1>
    <p class="tagline">{t.offline.tagline}</p>
  </header>

  <div class="cards">
    <!-- The badge is the recipient fact — "Offline OK" — and it stays on the
         label row rather than folding away with the explanation: whether the
         other person has to be there is the first thing this page answers. -->
    <Group title={t.shell.linkGroup} note={t.methods.stored.badge} flush>
      {#snippet icon()}<Icon name="package" size={18} />{/snippet}
      <div class="op">
        {#if session().user}
          <StoredUpload />
        {:else}
          <div class="signin">
            <button class="btn btn-primary" onclick={() => setLoginOpen(true)}>{t.account.signIn}</button>
            <p class="hint">{t.offline.signIn}</p>
          </div>
        {/if}
      </div>
    </Group>

    <!-- Quota and plan are not optional reading: what you may store, how much you
       may move and how long a link lives are the limits this page operates
       under, so they stay visible under the group they qualify. -->
    <p class="cli-note">
      {t.offline.cliNote}
      <a href={cloudGuideHref}>{t.offline.cliLink}</a>
    </p>

    <p class="cli-note plan-note">
      {t.offline.planNote}
      <a href={PRICING_PATH} onclick={(e) => { e.preventDefault(); navigate("pricing"); }}>{t.pricingPage.navLink}</a>
    </p>

    <Help summary={t.shell.howSummary}>
      <p>{t.offline.pitch}</p>
      <p>{t.methods.stored.sub}</p>
    </Help>
  </div>

  {#if !session().user}
    <WhyAccount collapsible />
  {/if}

  <CrossSell target="realtime" />
  <!-- Same rule as the cross-network page: read once signed out, folded once
       signed in. The mode comparison is a link to its single copy either way. -->
  {#if session().user}
    <div class="learn">
      <Help summary={t.shell.learnMore}>
        <HowItWorks variant="offline" />
        <p class="compare-link"><a href={compareHref} onclick={goCompare}>{t.compare.link}</a></p>
        <FeatureStrip />
        <UseCases />
        <Faq variant="offline" />
      </Help>
    </div>
  {:else}
    <HowItWorks variant="offline" />
    <p class="compare-link"><a href={compareHref} onclick={goCompare}>{t.compare.link}</a></p>
    <FeatureStrip />
    <UseCases />
    <Faq variant="offline" />
  {/if}

  <PageFooter fineprint={t.offlineFooter} />
</section>

<style>
  /* Layout only — the header is app.css's .ui-page-head, the card is
     `ui/Group.svelte`, the folded explanation is `ui/Help.svelte`. */
  .offlinepage { position: relative; }

  .cards { display: flex; flex-direction: column; gap: var(--space-4); max-inline-size: 720px; margin-inline: auto; }
  .learn { max-inline-size: 720px; margin: var(--space-5) auto 0; }
  .compare-link { margin: var(--space-5) 0 0; font-size: var(--fs-sm); }
  .compare-link a { color: var(--accent-fg); text-decoration: none; }
  .compare-link a:hover { text-decoration: underline; }
  :global(.appshell.shell) .compare-link { font-size: 12px; margin-block-start: var(--space-4); }

  .op { padding: var(--space-3) 14px; }

  .signin { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); }
  .signin .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); }

  /* The two standing limits. Aligned with the rows above them rather than
     centred: they qualify the group, they are not a caption for the page. */
  /* Inside the column now, so no measure or centring of its own: it is the
     footnote of the group directly above it. */
  .cli-note {
    margin-block: -4px 0; padding-inline: 2px;
    font-size: var(--fs-xs); color: var(--text); line-height: 1.55;
  }
  .cli-note.plan-note { margin-block-start: -8px; }
  .cli-note a { color: var(--accent-fg); text-decoration: none; white-space: nowrap; }
  .cli-note a:hover { text-decoration: underline; }
</style>
