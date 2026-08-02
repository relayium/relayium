<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { reveal } from "./reveal";

  // Each page shows the shared questions plus its own page-specific set, so the
  // FAQ is tailored to what a visitor on that page is likely asking.
  let { variant = "home" }: { variant?: "home" | "cross" | "offline" } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const items = $derived([...t.faq.items, ...t.faq[variant]]);
</script>

<section class="faq" aria-label={t.faq.title}>
  <div class="head">
    <h2>{t.faq.title}</h2>
    <p class="sub">{t.faq.sub}</p>
  </div>
  <div class="list">
    {#each items as item, i (item.q)}
      <details class="qa reveal" use:reveal={{ delay: (i % 2) * 50 }}>
        <summary>
          <span class="q">{item.q}</span>
          <span class="chev" aria-hidden="true">+</span>
        </summary>
        <p class="a">{item.a}</p>
      </details>
    {/each}
  </div>
</section>

<style>
  .faq { margin: var(--section-gap) 0 var(--space-2); }
  .head { margin-bottom: var(--space-5); }
  .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; }

  /* Two columns on wider viewports; collapses to one on narrow screens. Grid
     places items in row order and lets each row size to its tallest open item. */
  .list { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); align-items: start; }
  @media (max-width: 720px) { .list { grid-template-columns: 1fr; } }
  .qa {
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2); overflow: hidden;
  }
  summary {
    display: flex; align-items: center; gap: var(--space-3); justify-content: space-between;
    padding: var(--space-4) var(--space-5); cursor: pointer; list-style: none;
    font-size: var(--fs-sm); color: var(--text-h); font-weight: 500;
  }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--accent-fg); }
  .q { min-width: 0; }
  .chev {
    flex: none; width: 22px; height: 22px; line-height: 20px; text-align: center;
    border-radius: 50%; font-size: 18px; color: var(--accent-fg);
    background: var(--accent-bg); transition: transform .2s ease;
  }
  .qa[open] .chev { transform: rotate(45deg); }
  .a {
    margin: 0; padding: 0 var(--space-5) var(--space-4); font-size: var(--fs-xs); line-height: 1.6; color: var(--text);
  }
  /* Native <details> pops open instantly; fade+lift the answer so the reveal
     reads as motion rather than a jump. */
  .qa[open] .a { animation: fade-up .28s ease both; }
  @media (prefers-reduced-motion: reduce) { .qa[open] .a { animation: none; } }
</style>
