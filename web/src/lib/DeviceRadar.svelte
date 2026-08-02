<!-- Presentational only: renders the radar and one focusable blip per peer,
     emitting selection via onSelect. Knows nothing about files/transfers —
     App.svelte renders the selected peer's send card below this. -->
<script lang="ts">
  import type { Peer } from "./protocol";
  import { blipPos } from "./radar-layout";
  import { messages, lang, type Messages } from "./i18n.svelte";

  // `compact` is presentation only: a smaller scope for the "still scanning, no
  // peers yet" signal inside the empty state. Blips, labels, pressed state and
  // callbacks are identical in both sizes.
  let { peers, selfName, selectedId, onSelect, compact = false }:
    { peers: Peer[]; selfName: string; selectedId: string; onSelect: (id: string) => void; compact?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const crowded = $derived(peers.length >= 4);
  const initial = $derived((selfName || "?").slice(0, 1).toUpperCase());
  // In its only compact production use there are no peers: the scope is a
  // decorative scanning signal next to explicit empty-state copy. Do not expose
  // a second empty "Nearby devices" group immediately after the section heading.
  // If a future caller combines compact with peers, it remains an accessible
  // labelled group so focusable blips are never hidden from assistive technology.
  const decorative = $derived(compact && peers.length === 0);
</script>

<div
  class="radar"
  class:compact
  role={decorative ? undefined : "group"}
  aria-label={decorative ? undefined : t.peersTitle}
  aria-hidden={decorative ? "true" : undefined}
>
  <div class="scope" aria-hidden="true">
    <span class="ring r1"></span>
    <span class="ring r2"></span>
    <span class="ring r3"></span>
    <span class="grid gx"></span>
    <span class="grid gy"></span>
    <span class="sweep"></span>
    <span class="center"><span class="cdot">{initial}</span></span>
  </div>
  {#each peers as p (p.id)}
    {@const pos = blipPos(p.id, crowded)}
    <button
      type="button"
      class="blip"
      class:sel={p.id === selectedId}
      style="left:{pos.xPct}%; top:{pos.yPct}%"
      aria-label={t.pickSendTo(p.name)}
      aria-pressed={p.id === selectedId}
      onclick={() => onSelect(p.id)}
    >
      <span class="ping" aria-hidden="true"></span>
      <span class="bavatar">{p.name.slice(0, 1).toUpperCase()}</span>
      <span class="blabel">{p.name}</span>
    </button>
  {/each}
</div>

<style>
  .radar {
    position: relative;
    width: min(300px, 82vw);
    aspect-ratio: 1;
    margin: var(--space-4) auto var(--space-3);
  }
  /* Compact: the same scope at a size that signals "scanning" without spending
     half a phone viewport on a selector with nothing to select. */
  .radar.compact { width: 120px; margin: 0 auto; }
  .radar.compact .cdot {
    width: 24px; height: 24px; font-size: var(--fs-xs);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .scope {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    overflow: hidden;
    background:
      radial-gradient(circle at center,
        color-mix(in srgb, var(--accent) 10%, transparent) 0%,
        transparent 70%),
      var(--surface-2);
    border: 1px solid var(--border);
  }
  .ring {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .r1 { width: 33%; height: 33%; }
  .r2 { width: 66%; height: 66%; }
  .r3 { width: 99%; height: 99%; }
  .grid {
    position: absolute;
    top: 50%; left: 50%;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .gx { width: 100%; height: 1px; transform: translate(-50%, -50%); }
  .gy { width: 1px; height: 100%; transform: translate(-50%, -50%); }
  .sweep {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      from 0deg,
      color-mix(in srgb, var(--accent) 45%, transparent) 0deg,
      transparent 60deg,
      transparent 360deg);
    animation: sweep 4s linear infinite;
  }
  @keyframes sweep { to { transform: rotate(360deg); } }
  .center {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
  }
  .cdot {
    display: grid; place-items: center;
    width: 34px; height: 34px; border-radius: 50%;
    background: var(--accent-action); color: #fff;
    font-size: var(--fs-sm); font-weight: 700;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .blip {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    background: none; border: none; padding: 4px; cursor: pointer;
    color: var(--text-h);
  }
  .bavatar {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 50%;
    background: var(--surface); border: 1px solid var(--accent-border, var(--border));
    font-size: var(--fs-xs); font-weight: 700;
    box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .blip.sel .bavatar {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .blabel {
    font-size: 11px; max-width: 10ch; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ping {
    position: absolute; top: 15px; left: 50%;
    width: 30px; height: 30px; margin: -15px 0 0 -15px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
    animation: ping 1.6s ease-out 2; /* two pulses on appearance, then rest */
    pointer-events: none;
  }
  @keyframes ping {
    0% { opacity: .8; transform: scale(.4); }
    100% { opacity: 0; transform: scale(2.4); }
  }
  .blip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
  @media (prefers-reduced-motion: reduce) {
    .sweep { animation: none; opacity: .5; }
    .scope .ring { animation: breathe 3s ease-in-out infinite; }
    .ping { animation: none; opacity: 0; }
    @keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  }
</style>
