<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  let { connState, unsupported, selfName, selfIP }:
    { connState: "connecting" | "ready"; unsupported: boolean; selfName: string; selfIP: string } = $props();
  const t = $derived<Messages>(messages[lang()]);
</script>

<header class="hero">
  <div class="logo">⇌</div>
  <h1>Relayium</h1>
  <p class="tagline">{t.tagline}</p>
  <div class="statusbar">
    <span class="dot" class:on={connState === "ready"}></span>
    {#if unsupported}
      {t.unavailable}
    {:else if connState === "ready"}
      {t.connected(selfName)}
      {#if selfIP}
        <span class="sep">·</span>
        <span class="ip">{t.ipLabel} {selfIP}</span>
      {/if}
    {:else}
      {t.connecting}
    {/if}
  </div>
</header>

<style>
  .hero { text-align: center; padding-top: 44px; }
  .logo {
    width: 60px; height: 60px; line-height: 60px;
    margin: 0 auto 12px;
    font-size: 32px; color: #fff;
    border-radius: 18px;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
    box-shadow: var(--shadow);
  }
  h1 { font-size: 46px; margin: 0 0 8px; letter-spacing: -1.4px; }
  .tagline { color: var(--text); font-size: 15.5px; max-width: 44ch; margin: 0 auto; }
  .statusbar {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 14px; margin-top: 18px;
    padding: 6px 14px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface-2);
  }
  .sep { color: var(--border); }
  .ip { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .dot.on { background: #2ecc71; box-shadow: 0 0 0 3px rgba(46, 204, 113, .18); }
  @media (max-width: 1024px) { .hero { padding-top: 30px; } h1 { font-size: 36px; } }
</style>
