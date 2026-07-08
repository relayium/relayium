<script lang="ts">
  import { currentRoute, navigate, CROSS_PATH, OFFLINE_PATH, CLI_PATH, type Route } from "./router.svelte";
  import { lang, setLang, LANGS, messages, type Lang, type Messages } from "./i18n.svelte";
  import ThemeSelect from "./ThemeSelect.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const tabs: { id: Route; label: () => string }[] = [
    { id: "lan", label: () => t.nav.lanTab },
    { id: "cross", label: () => t.nav.crossTab },
    { id: "offline", label: () => t.nav.offlineTab },
    { id: "cli", label: () => t.nav.cliTab },
  ];
</script>

<nav class="topnav">
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <span class="mark">⇌</span><span class="word">Relayium</span>
  </a>

  <!-- These switch pages, not tab panels, so they're navigation links with
       aria-current — not role="tab" (which would promise a tabpanel that
       doesn't exist). Real hrefs keep right-click/open-in-new-tab working. -->
  <div class="tabs">
    {#each tabs as tab (tab.id)}
      <a
        href={tab.id === "cross" ? CROSS_PATH : tab.id === "offline" ? OFFLINE_PATH : tab.id === "cli" ? CLI_PATH : "/"}
        class="tab"
        class:active={currentRoute() === tab.id}
        aria-current={currentRoute() === tab.id ? "page" : undefined}
        onclick={(e) => { e.preventDefault(); navigate(tab.id); }}
      >{tab.label()}</a>
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

  <ThemeSelect />
</nav>

<style>
  .topnav {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-4) 0 var(--space-3); margin-bottom: var(--space-1);
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
    display: inline-flex; align-items: center; justify-content: center;
    font: inherit; font-size: var(--fs-sm); padding: var(--space-2) var(--space-4); border-radius: 999px; cursor: pointer;
    white-space: nowrap;
    border: 1px solid var(--border); background: var(--social-bg); color: var(--text); text-decoration: none;
    transition: border-color .13s, color .13s, background .13s;
  }
  .tab:hover { border-color: var(--accent-border); }
  .tab.active { color: #fff; background: var(--accent); border-color: var(--accent); }

  .lang {
    font: inherit; font-size: var(--fs-xs); padding: 5px 28px 5px 10px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
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
