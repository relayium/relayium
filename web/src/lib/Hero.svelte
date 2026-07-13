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
  <div class="statusbar">
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
      {#if selfIP}
        <span class="sep">·</span>
        <span class="ip">{t.ipLabel} {selfIP}</span>
      {/if}
    {:else if connState === "reconnecting"}
      {t.reconnecting}
    {:else}
      {t.connecting}
    {/if}
  </div>
</header>

<style>
  .hero { text-align: center; padding-top: var(--space-9); }
  .logo {
    display: inline-flex;
    margin: 0 auto var(--space-3);
    border-radius: 15px;
    /* Brand-tinted glow instead of a plain drop shadow — the mark floats. */
    box-shadow: 0 12px 36px -10px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  h1 { font-size: var(--fs-display); margin: 0 0 var(--space-2); letter-spacing: -1.6px; }
  .tagline { color: var(--text); font-size: var(--fs-body); max-width: 44ch; margin: 0 auto; }
  .statusbar {
    display: inline-flex; align-items: center; gap: var(--space-2);
    font-size: var(--fs-sm); margin-top: var(--space-5);
    padding: var(--space-2) var(--space-4); border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface-2);
  }
  .name-btn {
    font: inherit; color: inherit; background: none; border: none; padding: 0;
    cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px;
  }
  .name-btn:hover { color: var(--accent); }
  .name-edit {
    font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--accent);
    border-radius: 4px; padding: 0 var(--space-1); width: 12ch; max-width: 40vw;
  }
  .sep { color: var(--border); }
  .ip { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .dot.on { background: #2ecc71; box-shadow: 0 0 0 3px rgba(46, 204, 113, .18); }
  @media (max-width: 1024px) { .hero { padding-top: var(--space-7); } h1 { font-size: 36px; } }
</style>
