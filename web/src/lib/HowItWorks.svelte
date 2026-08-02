<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { reveal } from "./reveal";
  import Icon, { type IconName } from "./Icon.svelte";
  let { variant }: { variant: "realtime" | "offline" } = $props();
  const t = $derived<Messages>(messages[lang()]);
  const sec = $derived(t.howItWorks[variant]);
  const icons: Record<"realtime" | "offline", readonly [IconName, IconName, IconName]> = {
    realtime: ["link", "pairing-code", "bolt"],
    offline: ["lock", "link", "download"],
  };
</script>

<section class="how" aria-label={sec.title}>
  <div class="head">
    <h2>{sec.title}</h2>
    <p class="sub">{sec.sub}</p>
  </div>
  <ol class="ways">
    {#each sec.ways as w, i (w.name)}
      <li class="way reveal" use:reveal={{ delay: i * 70 }}>
        <span class="step">{i + 1}</span>
        <span class="icon" aria-hidden="true"><Icon name={icons[variant][i]} size={24} /></span>
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
    position: absolute; top: 16px; inset-inline-end: 16px;
    width: 24px; height: 24px; line-height: 24px; text-align: center;
    border-radius: 50%; font-size: 13px; font-weight: 600;
    color: var(--accent-fg); background: var(--accent-bg);
  }
  .icon { color: var(--accent); }
  .way h3 { margin: 2px 0 0; font-size: var(--fs-body); color: var(--text-h); font-weight: 600; }
  .way p { margin: 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text); }
  .tag {
    align-self: flex-start; margin-top: auto;
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    color: var(--accent-fg); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  @media (max-width: 720px) { .ways { grid-template-columns: 1fr; } }
</style>
