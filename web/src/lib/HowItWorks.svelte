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
  .how { margin: 40px 0 8px; }
  .head { margin-bottom: 18px; }
  .head h2 { font-size: 22px; margin: 0 0 6px; }
  .head .sub { color: var(--text); font-size: 14px; max-width: 60ch; }

  .ways {
    list-style: none; margin: 0; padding: 0;
    display: grid; gap: 14px;
    grid-template-columns: repeat(3, 1fr);
  }
  .way {
    position: relative;
    border: 1px solid var(--border); border-radius: 16px;
    background: var(--surface-2); padding: 20px 18px 18px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .step {
    position: absolute; top: 16px; right: 16px;
    width: 24px; height: 24px; line-height: 24px; text-align: center;
    border-radius: 50%; font-size: 13px; font-weight: 600;
    color: var(--accent); background: var(--accent-bg);
  }
  .icon { font-size: 28px; line-height: 1; }
  .way h3 { margin: 2px 0 0; font-size: 16px; color: var(--text-h); font-weight: 600; }
  .way p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text); }
  .tag {
    align-self: flex-start; margin-top: auto;
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    color: var(--accent); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  @media (max-width: 720px) { .ways { grid-template-columns: 1fr; } }
</style>
