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
  .faq { margin: 40px 0 8px; }
  .head { margin-bottom: 18px; }
  .head h2 { font-size: 22px; margin: 0 0 6px; }
  .head .sub { color: var(--text); font-size: 14px; max-width: 60ch; }

  .list { display: flex; flex-direction: column; gap: 10px; }
  .qa {
    border: 1px solid var(--border); border-radius: 14px;
    background: var(--surface-2); overflow: hidden;
  }
  summary {
    display: flex; align-items: center; gap: 12px; justify-content: space-between;
    padding: 15px 18px; cursor: pointer; list-style: none;
    font-size: 15px; color: var(--text-h); font-weight: 500;
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
    margin: 0; padding: 0 18px 16px; font-size: 13.5px; line-height: 1.6; color: var(--text);
  }
</style>
