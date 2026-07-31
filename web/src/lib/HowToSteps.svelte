<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { reveal } from "./reveal";
  import Icon, { type IconName } from "./Icon.svelte";
  let { maxFiles }: { maxFiles: number } = $props();
  const t = $derived<Messages>(messages[lang()]);
  // Reuses the existing step copy (step1–step4); the icons make the flow scannable.
  const steps = $derived([
    { text: t.step1, icon: "devices" },
    { text: t.step2, icon: "nearby" },
    { text: t.step3(maxFiles), icon: "file-download" },
    { text: t.step4, icon: "shield" },
  ] satisfies { text: string; icon: IconName }[]);
</script>

<section class="how" aria-label={t.guideTitle}>
  <h2>{t.guideTitle}</h2>
  <ol class="flow">
    {#each steps as s, i (i)}
      <li class="step reveal" use:reveal={{ delay: i * 70 }}>
        <span class="badge" aria-hidden="true">
          <span class="num">{i + 1}</span>
          <Icon name={s.icon} size={24} />
        </span>
        <p>{s.text}</p>
      </li>
    {/each}
  </ol>
  <p class="hint">{t.hint}</p>
</section>

<style>
  .how { margin: var(--section-gap) 0 var(--space-2); }
  .how h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-5); }

  .flow {
    list-style: none; margin: 0 0 var(--space-4); padding: 0;
    display: grid; gap: var(--space-4);
    grid-template-columns: repeat(4, 1fr);
  }
  .step {
    position: relative;
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2); padding: var(--space-5) var(--space-4) var(--space-4);
    transition: border-color .15s, box-shadow .15s;
  }
  .step:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
  .step:hover .badge { transform: scale(1.08) rotate(-3deg); }
  /* Direction-neutral connector between steps (desktop only). Logical inset
     follows source order in both LTR and RTL without mirroring a glyph. */
  .step:not(:last-child)::after {
    content: "";
    position: absolute; top: 50%; inset-inline-end: calc(var(--space-4) * -1);
    inline-size: var(--space-4); border-block-start: 1px solid var(--border);
    z-index: 1;
  }
  .badge {
    position: relative;
    width: 46px; height: 46px; flex: none;
    display: grid; place-items: center;
    border-radius: 14px;
    color: var(--accent); background: var(--accent-bg);
    border: 1px solid var(--accent-border);
    transition: transform .2s cubic-bezier(.22, 1, .36, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .step { transition: none; }
    .badge, .step:hover .badge { transition: none; transform: none; }
  }
  .num {
    position: absolute; top: -7px; inset-inline-start: -7px;
    width: 20px; height: 20px; line-height: 19px; text-align: center;
    border-radius: 50%; font-size: 12px; font-weight: 700;
    color: #fff; background: var(--accent);
    border: 2px solid var(--surface-2);
  }
  .step p { margin: 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text); }
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); max-width: 70ch; }

  @media (max-width: 900px) { .flow { grid-template-columns: repeat(2, 1fr); } .step:nth-child(2n)::after { display: none; } }
  @media (max-width: 520px) {
    .flow { grid-template-columns: 1fr; }
    .step::after { display: none; }
  }
</style>
