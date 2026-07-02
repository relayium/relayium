<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  let { maxFiles }: { maxFiles: number } = $props();
  const t = $derived<Messages>(messages[lang()]);
  // Reuses the existing step copy (step1–step4); the icons make the flow scannable.
  const steps = $derived([
    { text: t.step1, icon: "devices" },
    { text: t.step2, icon: "nearby" },
    { text: t.step3(maxFiles), icon: "file" },
    { text: t.step4, icon: "shield" },
  ] as const);
</script>

<section class="how" aria-label={t.guideTitle}>
  <h2>{t.guideTitle}</h2>
  <ol class="flow">
    {#each steps as s, i (i)}
      <li class="step">
        <span class="badge" aria-hidden="true">
          <span class="num">{i + 1}</span>
          {#if s.icon === "devices"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="12" height="8.5" rx="1" /><path d="M6.5 17h5M9 13.5V17" />
              <rect x="15.5" y="8" width="6.5" height="11.5" rx="1.5" /><path d="M18 17.5h1.5" />
            </svg>
          {:else if s.icon === "nearby"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="17" r="1.4" fill="currentColor" stroke="none" />
              <path d="M8.4 14a5 5 0 0 1 7.2 0" /><path d="M5.6 11a9 9 0 0 1 12.8 0" />
            </svg>
          {:else if s.icon === "file"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 3.5h6l4 4v12a.8.8 0 0 1-.8.8H7a.8.8 0 0 1-.8-.8V4.3A.8.8 0 0 1 7 3.5z" />
              <path d="M13 3.5v4h4" /><path d="M11.5 11v5.5m0 0l-2-2m2 2l2-2" />
            </svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l7 3v5c0 4.4-3 7.9-7 9.8-4-1.9-7-5.4-7-9.8V6z" /><path d="M9 12l2 2 4-4" />
            </svg>
          {/if}
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
  }
  /* Connector chevron between steps (desktop only). */
  .step:not(:last-child)::after {
    content: "›";
    position: absolute; top: 50%; right: calc(var(--space-4) * -1);
    transform: translate(50%, -50%);
    font-size: 22px; line-height: 1; color: var(--border);
    z-index: 1;
  }
  .badge {
    position: relative;
    width: 46px; height: 46px; flex: none;
    display: grid; place-items: center;
    border-radius: 14px;
    color: var(--accent); background: var(--accent-bg);
    border: 1px solid var(--accent-border);
  }
  .badge svg { width: 24px; height: 24px; }
  .num {
    position: absolute; top: -7px; left: -7px;
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
