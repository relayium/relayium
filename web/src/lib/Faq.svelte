<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="faq" aria-label={t.faq.title}>
  <div class="head">
    <h2>{t.faq.title}</h2>
    <p class="sub">{t.faq.sub}</p>
  </div>
  <div class="list">
    {#each t.faq.items as item (item.q)}
      <details class="qa">
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

  .list { display: flex; flex-direction: column; gap: var(--space-3); }
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
  summary:hover { color: var(--accent); }
  .q { min-width: 0; }
  .chev {
    flex: none; width: 22px; height: 22px; line-height: 20px; text-align: center;
    border-radius: 50%; font-size: 18px; color: var(--accent);
    background: var(--accent-bg); transition: transform .2s ease;
  }
  .qa[open] .chev { transform: rotate(45deg); }
  .a {
    margin: 0; padding: 0 var(--space-5) var(--space-4); font-size: var(--fs-xs); line-height: 1.6; color: var(--text);
  }
</style>
