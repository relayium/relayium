<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import { session } from "./auth.svelte";
  import Pricing from "./Pricing.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const faqs = $derived([
    { q: t.pricingPage.q1, a: t.pricingPage.a1 },
    { q: t.pricingPage.q2, a: t.pricingPage.a2 },
    { q: t.pricingPage.q3, a: t.pricingPage.a3 },
  ]);
</script>

<main class="pricing-page">
  <button class="back" onclick={() => navigate("lan")}>{t.pricingPage.back}</button>

  <header class="head">
    <h1>{t.pricingPage.title}</h1>
    <p class="sub">{t.pricingPage.subtitle}</p>
    {#if !session().user}
      <p class="signed-out">{t.pricingPage.signedOutCta}</p>
    {/if}
  </header>

  <Pricing />

  <section class="faq">
    <h2>{t.pricingPage.faqTitle}</h2>
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
  .sub { margin: 0; color: var(--text); max-width: 60ch; }
  .signed-out { margin: 0; font-size: var(--fs-xs); color: var(--accent); }
  .faq { display: flex; flex-direction: column; gap: var(--space-4); }
  .faq h2 { margin: 0; font-size: var(--fs-lg, 1.25rem); color: var(--text-h); }
  .qa { display: flex; flex-direction: column; gap: 4px; }
  .qa h3 { margin: 0; font-size: var(--fs-sm); color: var(--text-h); }
  .qa p { margin: 0; font-size: var(--fs-sm); color: var(--text); max-width: 70ch; }
</style>
