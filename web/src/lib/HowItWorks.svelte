<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="how" aria-label={t.howItWorks.title}>
  <div class="head">
    <h2>{t.howItWorks.title}</h2>
    <p class="sub">{t.howItWorks.sub}</p>
  </div>
  <ol class="ways">
    {#each t.howItWorks.ways as w, i (w.name)}
      <li class="way">
        <span class="step">{i + 1}</span>
        <span class="icon" aria-hidden="true">{w.icon}</span>
        <h3>{w.name}</h3>
        <p>{w.how}</p>
        <span class="tag">{w.tag}</span>
      </li>
    {/each}
  </ol>
</section>

<style>
  .how { margin: var(--section-gap) 0 var(--space-2); }
  .head { margin-bottom: var(--space-5); }
  .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; }

  .ways {
    list-style: none; margin: 0; padding: 0;
    display: grid; gap: var(--space-4);
    grid-template-columns: repeat(3, 1fr);
  }
  .way {
    position: relative;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2); padding: var(--space-5) var(--space-5) var(--space-4);
    display: flex; flex-direction: column; gap: var(--space-2);
  }
  .step {
    position: absolute; top: 16px; right: 16px;
    width: 24px; height: 24px; line-height: 24px; text-align: center;
    border-radius: 50%; font-size: 13px; font-weight: 600;
    color: var(--accent); background: var(--accent-bg);
  }
  .icon { font-size: 28px; line-height: 1; }
  .way h3 { margin: 2px 0 0; font-size: var(--fs-body); color: var(--text-h); font-weight: 600; }
  .way p { margin: 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text); }
  .tag {
    align-self: flex-start; margin-top: auto;
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    color: var(--accent); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  @media (max-width: 720px) { .ways { grid-template-columns: 1fr; } }
</style>
