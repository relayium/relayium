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

  <header class="head">
    <h1>{p.title}</h1>
    <p class="sub">{p.subtitle}</p>
    {#if !session().user}
      <p class="signed-out">{p.signedOutCta}</p>
    {/if}
  </header>

  <!-- What's free vs. what you pay for -->
  <section class="explainer">
    <div class="card free">
      <h2>{p.freeTitle}</h2>
      <p class="lead">{p.freeLead}</p>
      <ul>
        <li>{p.free1}</li>
        <li>{p.free2}</li>
        <li>{p.free3}</li>
      </ul>
      <p class="why">{p.freeWhy}</p>
    </div>
    <div class="card paid">
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

  <Pricing />

  <!-- Self-host to stay 100% free -->
  <section class="selfhost">
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
  .pricing-page {
    max-width: 900px;
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
  .head { display: flex; flex-direction: column; gap: var(--space-2); }
  .head h1 { margin: 0; font-size: var(--fs-xl, 1.6rem); color: var(--text-h); }
  .sub { margin: 0; color: var(--text); max-width: 65ch; }
  .signed-out { margin: 0; font-size: var(--fs-xs); color: var(--accent); }

  .explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2);
  }
  .card.free { border-inline-start: 3px solid var(--accent); }
  .card h2 { margin: 0; font-size: var(--fs-md, 1.05rem); color: var(--text-h); }
  .card .lead { margin: 0; font-size: var(--fs-sm); color: var(--text); }
  .card ul { margin: 0; padding-inline-start: 1.1em; display: flex; flex-direction: column; gap: var(--space-1); }
  .card li { font-size: var(--fs-sm); color: var(--text); }
  .card .why { margin: var(--space-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted, var(--text)); font-style: italic; }

  .selfhost {
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3);
    background: var(--social-bg);
  }
  .selfhost h2 { margin: 0; font-size: var(--fs-lg, 1.25rem); color: var(--text-h); }
  .selfhost p { margin: 0; font-size: var(--fs-sm); color: var(--text); max-width: 70ch; }
  .selfhost .btn { align-self: flex-start; }

  .faq { display: flex; flex-direction: column; gap: var(--space-4); }
  .faq h2 { margin: 0; font-size: var(--fs-lg, 1.25rem); color: var(--text-h); }
  .qa { display: flex; flex-direction: column; gap: 4px; }
  .qa h3 { margin: 0; font-size: var(--fs-sm); color: var(--text-h); }
  .qa p { margin: 0; font-size: var(--fs-sm); color: var(--text); max-width: 72ch; }
</style>
