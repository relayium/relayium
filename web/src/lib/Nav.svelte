<script lang="ts">
  import { currentRoute, navigate, type Route } from "./router.svelte";
  import { lang, setLang, LANGS, messages, type Lang, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const tabs: { id: Route; label: () => string }[] = [
    { id: "lan", label: () => t.nav.lanTab },
    { id: "cross", label: () => t.nav.crossTab },
  ];
</script>

<nav class="topnav">
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <span class="mark">⇌</span><span class="word">Relayium</span>
  </a>

  <div class="tabs" role="tablist">
    {#each tabs as tab (tab.id)}
      <button
        role="tab"
        class="tab"
        class:active={currentRoute() === tab.id}
        aria-selected={currentRoute() === tab.id}
        onclick={() => navigate(tab.id)}
      >{tab.label()}</button>
    {/each}
  </div>

  <select
    class="lang"
    aria-label={t.langLabel}
    value={lang()}
    onchange={(e) => setLang((e.currentTarget as HTMLSelectElement).value as Lang)}
  >
    {#each LANGS as l (l.code)}
      <option value={l.code}>{l.label}</option>
    {/each}
  </select>
</nav>

<style>
  .topnav {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 0 10px; margin-bottom: 4px;
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text-h); font-weight: 600; }
  .brand .mark {
    width: 28px; height: 28px; line-height: 28px; text-align: center;
    border-radius: 9px; color: #fff; font-size: 16px;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
  }
  .brand .word { font-size: 16px; letter-spacing: -0.4px; }

  .tabs { display: flex; gap: 6px; margin: 0 auto 0 8px; }
  .tab {
    font: inherit; font-size: 14px; padding: 7px 14px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border); background: var(--social-bg); color: var(--text);
    transition: border-color .15s, color .15s, background .15s;
  }
  .tab:hover { border-color: var(--accent-border); }
  .tab.active { color: #fff; background: var(--accent); border-color: var(--accent); }

  .lang {
    font: inherit; font-size: 13px; padding: 5px 28px 5px 10px;
    border-radius: 8px; border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  @media (max-width: 560px) {
    .topnav { flex-wrap: wrap; gap: 8px; }
    .brand .word { display: none; }
    .tabs { margin: 0; order: 3; width: 100%; }
    .tab { flex: 1; }
  }
</style>
