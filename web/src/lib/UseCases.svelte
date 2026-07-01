<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="cases" aria-label={t.useCases.title}>
  <div class="head">
    <h2>{t.useCases.title}</h2>
    <p class="sub">{t.useCases.sub}</p>
  </div>
  <div class="grid">
    {#each t.useCases.items as c (c.title)}
      <div class="case">
        <span class="icon" aria-hidden="true">{c.icon}</span>
        <div class="body">
          <h3>{c.title}</h3>
          <p>{c.desc}</p>
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .cases { margin: 40px 0 8px; }
  .head { margin-bottom: 18px; }
  .head h2 { font-size: 22px; margin: 0 0 6px; }
  .head .sub { color: var(--text); font-size: 14px; max-width: 60ch; }

  .grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(2, 1fr);
  }
  .case {
    display: flex; gap: 14px; align-items: flex-start;
    border: 1px solid var(--border); border-radius: 16px;
    background: var(--surface-2); padding: 18px;
    transition: border-color .15s, box-shadow .15s;
  }
  .case:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
  .icon {
    flex: none; width: 44px; height: 44px; line-height: 44px; text-align: center;
    font-size: 24px; border-radius: 12px; background: var(--accent-bg);
  }
  .body { min-width: 0; }
  .case h3 { margin: 2px 0 6px; font-size: 16px; color: var(--text-h); font-weight: 600; }
  .case p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text); }

  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
