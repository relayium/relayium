<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import { session } from "./auth.svelte";
  import Pricing from "./Pricing.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const p = $derived(t.pricingPage);
  const faqs = $derived([
    { q: p.q1, a: p.a1 },
    { q: p.q2, a: p.a2 },
    { q: p.q3, a: p.a3 },
    { q: p.q4, a: p.a4 },
    { q: p.q5, a: p.a5 },
    { q: p.q6, a: p.a6 },
  ]);
</script>

<!-- A <section>, not a <main>: every SPA route renders inside App.svelte's single
     <main>, so a second one here nested two "main" landmarks inside each other —
     which leaves a screen reader with no unambiguous "skip to the content". -->
<!-- No "Back to Relayium" control: this page renders inside the same shell as
     every other route, and the sidebar (or the compact header) is the way
     back — a second, page-specific one was the tell that /pricing was a
     different product from the page it was reached from. -->
<section class="pricing-page page-enter">
  <header class="head ui-page-head">
    <h1>{p.title}</h1>
    <p class="sub">{p.subtitle}</p>
    {#if !session().user}
      <p class="signed-out">{p.signedOutCta}</p>
    {/if}
  </header>

  <!-- The decision first: cycle control and real tiers sit above the fold, with
       the subtitle carrying the honest-pricing proposition. The full
       free-vs-paid explanation follows immediately below, unabridged. -->
  <Pricing />

  <!-- What's free vs. what you pay for -->
  <section class="explainer">
    <div class="card free ui-card ui-stack">
      <h2>{p.freeTitle}</h2>
      <p class="lead">{p.freeLead}</p>
      <ul>
        <li>{p.free1}</li>
        <li>{p.free2}</li>
        <li>{p.free3}</li>
      </ul>
      <p class="why">{p.freeWhy}</p>
    </div>
    <div class="card paid ui-card ui-stack">
      <h2>{p.paidTitle}</h2>
      <p class="lead">{p.paidLead}</p>
      <ul>
        <li>{p.paid1}</li>
        <li>{p.paid2}</li>
        <li>{p.paid3}</li>
      </ul>
      <p class="why">{p.paidWhy}</p>
    </div>
  </section>

  <!-- Self-hosting -->
  <section class="selfhost ui-card ui-stack">
    <h2>{p.selfhostTitle}</h2>
    <p>{p.selfhostBody}</p>
    <button class="btn btn-ghost" onclick={() => navigate("me")}>{p.selfhostCta}</button>
  </section>

  <section class="faq">
    <h2>{p.faqTitle}</h2>
    {#each faqs as f (f.q)}
      <div class="qa">
        <h3>{f.q}</h3>
        <p>{f.a}</p>
      </div>
    {/each}
  </section>
</section>

<style>
  /* Layout only. The header, the card surfaces and their headings come from the
     shared primitives in app.css (.ui-page-head, .ui-card, .ui-stack). Every
     font-size and colour here now names a token app.css actually defines: the
     four this file used to reference were never declared anywhere, so each one
     silently rendered its local fallback instead. See PricingPage.test.ts. */
  .pricing-page {
    /* 1040px, not 900: four desktop tiers need an honest decision width. */
    max-inline-size: 1040px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  /* .ui-page-head owns the centering, padding and h1 size; the subtitle is
     longer than the 44ch .tagline primitive is meant for, so it keeps its own
     measure. */
  .head { display: flex; flex-direction: column; gap: var(--space-2); }
  .head .sub { margin: 0; color: var(--text); max-inline-size: 68ch; margin-inline: auto; }
  .head .signed-out { margin: 0; font-size: var(--fs-xs); color: var(--accent-fg); }

  .explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); }
  /* No accent rim on the free card: the same left-border treatment is a
     WARNING on Device Inbox, and here it decorated the good news. Purple is
     for selection, the primary action and status (设计规范 §3). */
  .card .lead { margin: 0; font-size: var(--fs-sm); color: var(--text); }
  .card ul { margin: 0; padding-inline-start: 1.1em; display: flex; flex-direction: column; gap: var(--space-1); }
  .card li { font-size: var(--fs-sm); color: var(--text); }
  .card .why { margin: var(--space-1) 0 0; font-size: var(--fs-xs); color: var(--text); font-style: italic; }

  .selfhost { background: var(--social-bg); }
  .selfhost p { margin: 0; font-size: var(--fs-sm); color: var(--text); max-inline-size: 70ch; }
  .selfhost .btn { align-self: flex-start; }

  .faq { display: flex; flex-direction: column; gap: var(--space-4); }
  .faq h2 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  .qa { display: flex; flex-direction: column; gap: 4px; }
  .qa h3 { margin: 0; font-size: var(--fs-sm); color: var(--text-h); }
  .qa p { margin: 0; font-size: var(--fs-sm); color: var(--text); max-inline-size: 72ch; }

  /* ── Settings-shell form ──────────────────────────────────────────────────
     The column already carries the track's top padding and the header is
     left-aligned by app.css; only the page's own top gap and inline padding
     go. The inline gutter is the shell's — <main>'s 20px, the column's
     22px from the sidebar breakpoint up — and --space-4 on top of it set this
     page 16px further in than /apps and /cli on both sides (measured: 334–1322
     against their 318–1338 at 1440px, 36–354 against 20–370 at 390px). The base
     rule keeps its padding for any mount outside the shell. */
  :global(.appshell.shell) .pricing-page { padding-block-start: 0; padding-inline: 0; gap: var(--space-5); }
  :global(.appshell.shell) .head .sub { margin-inline: 0; font-size: 13px; }
</style>
