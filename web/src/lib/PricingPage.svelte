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

<main class="pricing-page page-enter">
  <button class="back" onclick={() => navigate("lan")}>{p.back}</button>

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

  <!-- Self-host to stay 100% free -->
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
</main>

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
  .back {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
    padding: 0;
  }
  .back:hover { color: var(--accent); }
  /* .ui-page-head owns the centering, padding and h1 size; the subtitle is
     longer than the 44ch .tagline primitive is meant for, so it keeps its own
     measure. */
  .head { display: flex; flex-direction: column; gap: var(--space-2); }
  .head .sub { margin: 0; color: var(--text); max-inline-size: 68ch; margin-inline: auto; }
  .head .signed-out { margin: 0; font-size: var(--fs-xs); color: var(--accent); }

  .explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); }
  .card.free { border-inline-start: 3px solid var(--accent); }
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
</style>
