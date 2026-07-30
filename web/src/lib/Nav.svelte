<script lang="ts">
  import { currentRoute, navigate, CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH, type Route } from "./router.svelte";
  import { lang, setLang, LANGS, messages, type Lang, type Messages } from "./i18n.svelte";
  import { loginOpen, setLoginOpen } from "./login.svelte";
  import ThemeSelect from "./ThemeSelect.svelte";
  import Account from "./Account.svelte";
  import Logo from "./Logo.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const tabs: { id: Route; label: () => string }[] = [
    { id: "lan", label: () => t.nav.lanTab },
    { id: "cross", label: () => t.nav.crossTab },
    { id: "offline", label: () => t.nav.offlineTab },
    { id: "cli", label: () => t.nav.cliTab },
    { id: "apps", label: () => t.nav.appsTab },
  ];

  // The account control only appears on the login-gated flows (async storage,
  // realtime pairing, personal center) — the same set that used to render their
  // own top-right Account row. Rendering it here folds it into the nav bar so it
  // no longer sits on a lonely row of its own.
  const showAccount = $derived(
    currentRoute() === "cross" || currentRoute() === "offline" || currentRoute() === "me",
  );
</script>

<nav class="topnav">
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <Logo size={26} /><span class="word">Relayium</span>
  </a>

  <!-- These switch pages, not tab panels, so they're navigation links with
       aria-current — not role="tab" (which would promise a tabpanel that
       doesn't exist). Real hrefs keep right-click/open-in-new-tab working. -->
  <div class="tabs">
    {#each tabs as tab (tab.id)}
      <a
        href={tab.id === "cross" ? CROSS_PATH : tab.id === "offline" ? OFFLINE_PATH : tab.id === "cli" ? CLI_PATH : tab.id === "apps" ? APPS_PATH : "/"}
        class="tab"
        class:active={currentRoute() === tab.id}
        aria-current={currentRoute() === tab.id ? "page" : undefined}
        onclick={(e) => { e.preventDefault(); navigate(tab.id); }}
      >{tab.label()}</a>
    {/each}
  </div>

  <div class="util">
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

    {#if showAccount}
      <Account bind:open={() => loginOpen(), (v) => setLoginOpen(v)} />
    {/if}
  </div>
</nav>

<style>
  .topnav {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-4) 0 var(--space-3); margin-bottom: var(--space-1);
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text-h); font-weight: 600; }
  .brand .word { font-size: 16px; letter-spacing: -0.4px; }
  /* Playful nudge on the mark when hovering the wordmark. */
  .brand :global(svg) { transition: transform .25s cubic-bezier(.22, 1, .36, 1); }
  .brand:hover :global(svg) { transform: rotate(-8deg) scale(1.08); }
  @media (prefers-reduced-motion: reduce) {
    .brand :global(svg), .brand:hover :global(svg) { transition: none; transform: none; }
  }

  .util { display: flex; align-items: center; gap: var(--space-3); }

  .tabs { display: flex; gap: 6px; margin: 0 auto 0 8px; }
  .tab {
    display: inline-flex; align-items: center; justify-content: center;
    font: inherit; font-size: var(--fs-sm); padding: var(--space-2) var(--space-4); border-radius: 999px; cursor: pointer;
    white-space: nowrap;
    border: 1px solid var(--border); background: var(--social-bg); color: var(--text); text-decoration: none;
    transition: border-color .13s, color .13s, background .13s;
  }
  .tab:hover { border-color: var(--accent-border); }
  .tab.active { color: #fff; background: var(--grad-accent); border-color: transparent; }

  .lang {
    font: inherit; font-size: var(--fs-xs); padding-block: 5px; padding-inline: 10px 28px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  @media (max-width: 560px) {
    /* Row 1: brand on the left, the utility group (lang · theme · account)
       pushed to the right. Row 2: the mode tabs, full width. No lonely rows. */
    .topnav { flex-wrap: wrap; gap: 8px; row-gap: 10px; }
    .brand .word { display: none; }
    .util { margin-inline-start: auto; gap: var(--space-2); }
    .tabs { margin: 0; order: 3; width: 100%; }
    .tab { flex: 1; min-width: 0; padding-inline: var(--space-2); }
    /* Trim the selects so brand + all three controls fit one row on small phones. */
    .lang { padding-inline: 8px 24px; max-width: 40vw; }
  }
</style>
