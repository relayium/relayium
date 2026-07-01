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
  .cases { margin: var(--section-gap) 0 var(--space-2); }
  .head { margin-bottom: var(--space-5); }
  .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; }

  .grid {
    display: grid; gap: var(--space-4);
    grid-template-columns: repeat(2, 1fr);
  }
  .case {
    display: flex; gap: var(--space-4); align-items: flex-start;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2); padding: var(--space-5);
    transition: border-color .13s, box-shadow .13s;
  }
  .case:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
  .icon {
    flex: none; width: 44px; height: 44px; line-height: 44px; text-align: center;
    font-size: 24px; border-radius: var(--radius-sm); background: var(--accent-bg);
  }
  .body { min-width: 0; }
  .case h3 { margin: 2px 0 var(--space-2); font-size: var(--fs-body); color: var(--text-h); font-weight: 600; }
  .case p { margin: 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text); }

  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
