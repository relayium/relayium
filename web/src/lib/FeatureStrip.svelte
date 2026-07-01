<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="wrap" aria-label={t.features.title}>
  <div class="head">
    <h2>{t.features.title}</h2>
    <p class="sub">{t.features.sub}</p>
  </div>
  <div class="features">
    {#each t.features.items as f (f.title)}
      <div class="feature">
        <h3>{f.title}</h3>
        <p>{f.desc}</p>
      </div>
    {/each}
  </div>
</section>

<style>
  .wrap { margin: 40px 0 8px; }
  .head { margin-bottom: 18px; }
  .head h2 { font-size: 22px; margin: 0 0 6px; }
  .head .sub { color: var(--text); font-size: 14px; max-width: 60ch; }

  .features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  .feature {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: 16px 18px;
    transition: border-color .15s, box-shadow .15s;
  }
  .feature:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
  .feature h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-h);
  }
  .feature p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text);
  }
  @media (max-width: 760px) {
    .features { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 480px) {
    .features { grid-template-columns: 1fr; }
  }
</style>
