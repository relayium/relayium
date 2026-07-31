<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import Logo from "./Logo.svelte";
  let { connState, unsupported, selfName, selfIP, onRename }:
    { connState: "connecting" | "ready" | "reconnecting"; unsupported: boolean; selfName: string; selfIP: string; onRename: (name: string) => void } = $props();
  const t = $derived<Messages>(messages[lang()]);

  // Inline rename: click the device name to edit it in place. Every locale's
  // t.connected(name) puts the name at the very end of the sentence, so the
  // prefix is just the full string with the name trimmed off — no separate
  // "sentence template" is needed per language.
  let editing = $state(false);
  let draft = $state("");

  function startEdit() {
    draft = selfName;
    editing = true;
  }
  function commit() {
    if (!editing) return;
    editing = false;
    onRename(draft);
  }
  function cancelEdit() {
    editing = false;
  }
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

<header class="hero">
  <div class="logo"><Logo size={64} /></div>
  <h1>Relayium</h1>
  <p class="tagline">{t.tagline}</p>
  <!-- Two deliberate groups: the live connection sentence (with its inline rename
       control) and, separately, the public IP as secondary metadata. On one desktop
       row they read exactly as before; on a phone the block stacks into two honest
       rows instead of letting flex fragment the sentence at arbitrary points. -->
  <div class="statusbar">
    <span class="conn">
      <span class="dot" class:on={connState === "ready"}></span>
      {#if unsupported}
        {t.unavailable}
      {:else if connState === "ready"}
        {@const full = t.connected(selfName)}
        {@const prefix = selfName && full.endsWith(selfName) ? full.slice(0, full.length - selfName.length) : full + " "}
        {prefix}{#if editing}<input
            class="name-edit"
            bind:value={draft}
            use:focusAndSelect
            onkeydown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
            }}
            onblur={commit}
          />{:else}<button type="button" class="name-btn" onclick={startEdit}>{selfName}</button>{/if}
      {:else if connState === "reconnecting"}
        {t.reconnecting}
      {:else}
        {t.connecting}
      {/if}
    </span>
    {#if !unsupported && connState === "ready" && selfIP}
      <span class="meta">
        <span class="sep">·</span>
        <span class="ip">{t.ipLabel} {selfIP}</span>
      </span>
    {/if}
  </div>
</header>

<style>
  .hero { text-align: center; padding-top: var(--space-9); }
  /* Staggered entrance on mount — the hero assembles top-to-bottom on load and
     on each return to the LAN page. */
  .hero > :global(*) { animation: fade-up .5s ease both; }
  .logo { animation-delay: .04s; }
  h1 { animation-delay: .1s; }
  .tagline { animation-delay: .16s; }
  .statusbar { animation-delay: .22s; }
  .logo {
    display: inline-flex;
    margin: 0 auto var(--space-3);
    border-radius: 15px;
    /* Brand-tinted glow instead of a plain drop shadow — the mark floats. */
    box-shadow: 0 12px 36px -10px color-mix(in srgb, var(--accent) 55%, transparent);
    transition: transform .25s cubic-bezier(.22, 1, .36, 1), box-shadow .25s ease;
  }
  .logo:hover {
    transform: translateY(-3px);
    box-shadow: 0 18px 44px -10px color-mix(in srgb, var(--accent) 70%, transparent);
  }
  @media (prefers-reduced-motion: reduce) {
    .hero > :global(*) { animation: none; }
    .logo { transition: none; }
    .logo:hover { transform: none; }
  }
  h1 { font-size: var(--fs-display); margin: 0 0 var(--space-2); letter-spacing: -1.6px; }
  .tagline { color: var(--text); font-size: var(--fs-body); max-width: 44ch; margin: 0 auto; }
  .statusbar {
    display: inline-flex; align-items: center; gap: var(--space-2);
    font-size: var(--fs-sm); margin-top: var(--space-5);
    padding: var(--space-2) var(--space-4); border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface-2);
  }
  /* Nested groups repeat the statusbar's own gap, so a single desktop row lays
     out identically to the previous flat markup. */
  .conn, .meta { display: inline-flex; align-items: center; gap: var(--space-2); }
  .conn { min-width: 0; }
  /* The IP metadata follows the enlarged coarse-pointer rename hit area in DOM
     order. Establish its own hit-test box so an unusually short translated
     prefix or long IPv6 label cannot make that invisible pseudo-element steal
     pointer events from the metadata row. */
  .meta { position: relative; }
  .name-btn {
    font: inherit; color: inherit; background: none; border: none; padding: 0;
    cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px;
  }
  .name-btn:hover { color: var(--accent); }
  /* Touch pointers get a ~44px target without changing the label's metrics or
     the sentence's line height. Mouse/trackpad hit areas are untouched. */
  @media (pointer: coarse) {
    .name-btn { position: relative; }
    .name-btn::after {
      content: "";
      position: absolute;
      inset-inline: -6px;
      inset-block-start: 50%;
      block-size: 44px;
      transform: translateY(-50%);
    }
  }
  .name-edit {
    font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--accent);
    border-radius: 4px; padding: 0 var(--space-1); width: 12ch; max-width: 40vw;
  }
  .sep { color: var(--border); }
  .ip { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  /* Connecting/reconnecting: a soft breathing dot so "working" reads as live.
     Ready: settle on green with a one-shot ring that pops outward. */
  .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--border);
    animation: dot-pulse 1.4s ease-in-out infinite;
  }
  .dot.on {
    background: #2ecc71; box-shadow: 0 0 0 3px rgba(46, 204, 113, .18);
    animation: ready-pop .6s ease-out;
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: .4; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot, .dot.on { animation: none; opacity: 1; }
  }
  @media (max-width: 1024px) { .hero { padding-top: var(--space-7); } h1 { font-size: 36px; } }

  /* Phone: a masthead, not a second marketing hero. Nav already renders the
     brand mark, so only the duplicate 64px mark is dropped — the h1 and tagline
     stay, start-aligned, and the status pill becomes a full-width status block.
     Logical alignment means Arabic mirrors without a separate rule. */
  @media (max-width: 700px) {
    .hero { text-align: start; padding-top: var(--space-3); }
    .logo { display: none; }
    h1 { font-size: 23px; letter-spacing: -0.8px; margin-block-end: var(--space-1); }
    .tagline { font-size: var(--fs-sm); max-width: none; margin-inline: 0; }
    .statusbar {
      display: flex; flex-direction: column; align-items: flex-start;
      gap: var(--space-1); box-sizing: border-box; inline-size: 100%;
      margin-top: var(--space-3);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
    }
    .conn { max-inline-size: 100%; flex-wrap: wrap; overflow-wrap: anywhere; }
    .name-btn { min-width: 0; max-inline-size: 100%; overflow-wrap: anywhere; }
    /* Its own row, indented past the status dot so it reads as metadata about
       the sentence above rather than a fragment of it. */
    .meta { padding-inline-start: calc(8px + var(--space-2)); }
    .meta .sep { display: none; }
    .ip { font-size: var(--fs-xs); }
  }
</style>
