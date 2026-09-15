<!-- Presentational only: renders the radar and one focusable blip per peer,
     emitting selection via onSelect. Knows nothing about files/transfers —
     App.svelte renders the selected peer's send card below this. -->
<script lang="ts">
  import type { Peer } from "./protocol";
  import { messages, lang, type Messages } from "./i18n.svelte";
  import Icon from "./Icon.svelte";

  // `compact` is presentation only: a smaller scope for the "still scanning, no
  // peers yet" signal inside the empty state. Blips, labels, pressed state and
  // callbacks are identical in both sizes.
  //
  // `scanning` is a CLAIM, and that is why it is a prop rather than an
  // assumption. The sweep is a picture of a device looking for neighbours; with
  // no signalling connection there is nothing to look over, and an animation
  // that keeps turning through a failed connection tells the reader the product
  // is working on their problem when it is not. The caller knows the connection
  // state, so the caller says.
  let { peers, selfName, selectedId, onSelect, compact = false, scanning = true }:
    { peers: Peer[]; selfName: string; selectedId: string; onSelect: (id: string) => void; compact?: boolean; scanning?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const initial = $derived((selfName || "?").slice(0, 1).toUpperCase());
  // In its only compact production use there are no peers: the scope is a
  // decorative scanning signal next to explicit empty-state copy. Do not expose
  // a second empty "Nearby devices" group immediately after the section heading.
  // If a future caller combines compact with peers, it remains an accessible
  // labelled group so focusable blips are never hidden from assistive technology.
  const decorative = $derived(compact && peers.length === 0);
</script>

<!-- Two states, never both. With no peers this is the scanning scope — a
     decorative signal, and only while `scanning` is true. With peers it is the
     selector, and the selector is a LIST: the blips used to be absolutely
     positioned from a hash of the peer id, so two peers could land on top of
     each other and axe reported overlapping, partly obscured targets. A grid
     cannot do that. Selection, `selectedId` and `onSelect` are unchanged. -->
<div
  class="radar"
  class:compact
  role={decorative ? undefined : "group"}
  aria-label={decorative ? undefined : t.peersTitle}
  aria-hidden={decorative ? "true" : undefined}
>
  {#if peers.length === 0}
    <div class="scope" class:idle={!scanning} aria-hidden="true">
      <span class="ring r1"></span>
      <span class="ring r2"></span>
      <span class="ring r3"></span>
      <span class="grid gx"></span>
      <span class="grid gy"></span>
      {#if scanning}<span class="sweep"></span>{/if}
      <span class="center"><span class="cdot">{initial}</span></span>
    </div>
  {:else}
    <ul class="picks">
      {#each peers as p (p.id)}
        <li>
          <!-- The device name is the whole visible label. The mark beside it is
               an <svg>, not a letter: axe compares the accessible name against
               VISIBLE TEXT, and `aria-hidden` on a text node does not take it
               out of that comparison — an initial made every button read as
               "M Mac-408" against "Select Mac-408". The action says what it
               does; sending happens after, from the card below. -->
          <button
            type="button"
            class="blip"
            class:sel={p.id === selectedId}
            aria-label={t.shell.selectDevice(p.name)}
            aria-pressed={p.id === selectedId}
            onclick={() => onSelect(p.id)}
          >
            <span class="bavatar" aria-hidden="true"><Icon name="laptop" size={15} /></span>
            <span class="blabel">{p.name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
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
  /* Not scanning: no sweep element at all, and the scope itself recedes so it
     reads as the diagram it still is rather than as a live instrument. */
  .scope.idle { opacity: .55; }
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
  /* One column per selector, wrapping — never absolute positions, which is what
     made two peers able to overlap. */
  .picks {
    list-style: none; margin: 0; padding: 0;
    display: grid; gap: var(--space-2);
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .blip {
    display: flex; align-items: center; gap: var(--space-2);
    inline-size: 100%; box-sizing: border-box;
    min-block-size: 44px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--shell-card-border, var(--border));
    border-radius: var(--radius-card, var(--radius-sm));
    background: var(--shell-card, var(--surface));
    color: var(--text-h); font: inherit; font-size: 13px; text-align: start;
    cursor: pointer;
    transition: border-color .13s, background-color .13s;
  }
  .blip:hover { border-color: var(--accent-border); }
  .bavatar {
    display: grid; place-items: center; flex: none;
    inline-size: 28px; block-size: 28px; border-radius: 50%;
    background: var(--accent-bg); border: 1px solid var(--accent-border);
    color: var(--accent-fg);
  }
  .blip.sel { border-color: var(--accent); background: var(--accent-bg); }
  .blip.sel .bavatar { background: var(--accent-action); border-color: transparent; color: #fff; }
  .blabel {
    min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .blip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) {
    .blip { transition: none; }
    .sweep { animation: none; opacity: .5; }
    .scope .ring { animation: breathe 3s ease-in-out infinite; }
    @keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  }
</style>
