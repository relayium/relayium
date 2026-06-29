<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="features" aria-label="Why Relayium">
  {#each t.features.items as f (f.title)}
    <div class="feature">
      <h3>{f.title}</h3>
      <p>{f.desc}</p>
    </div>
  {/each}
</section>

<style>
  .features {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin: 28px 0 8px;
  }
  .feature {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: 16px 18px;
  }
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
  @media (max-width: 560px) {
    .features { grid-template-columns: 1fr; }
  }
</style>
