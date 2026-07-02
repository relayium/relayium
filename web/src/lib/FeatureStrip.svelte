<script lang="ts">
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";
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
  <a class="secure-link" href={legalUrl("security", lang())}>{t.features.secureLink}</a>
</section>

<style>
  .wrap { margin: var(--section-gap) 0 var(--space-2); }
  .head { margin-bottom: var(--space-5); }
  .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; }

  .features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-4);
  }
  .feature {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: var(--space-4) var(--space-5);
    transition: border-color .13s, box-shadow .13s;
  }
  .feature:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
  .feature h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-h);
  }
  .feature p {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text);
  }
  @media (max-width: 760px) {
    .features { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 480px) {
    .features { grid-template-columns: 1fr; }
  }
  .secure-link {
    display: inline-block; margin-top: var(--space-4);
    font-size: var(--fs-sm); font-weight: 600;
    color: var(--accent); text-decoration: none;
  }
  .secure-link:hover { text-decoration: underline; }
</style>
