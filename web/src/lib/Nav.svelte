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

  // Mobile mode rail. The five tabs keep their natural width and the row scrolls
  // instead of compressing every label into an unreadable sliver (zh/ko labels
  // used to paint over each other at 320–390px).
  let rail = $state<HTMLDivElement | undefined>(undefined);
  // Only fade the rail's edges while it actually overflows — an unconditional
  // mask dims the first/last pill in locales whose labels fit (e.g. en at 390px),
  // which reads as a rendering bug rather than an affordance. Deliberately a
  // direction-free `scrollWidth > clientWidth` test: no scrollLeft arithmetic,
  // so it behaves identically under RTL.
  let railOverflows = $state(false);

  function measureRail() {
    if (!rail) return;
    railOverflows = rail.scrollWidth - rail.clientWidth > 1;
  }

  // Labels change width with the locale, and the rail's own box does not resize
  // when they do — so re-measure on locale change as well as on element resize.
  $effect(() => {
    void lang();
    void rail;
    measureRail();
  });

  $effect(() => {
    if (!rail || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureRail);
    ro.observe(rail);
    return () => ro.disconnect();
  });

  // Reveal the current destination after a route change. scrollIntoView is used
  // rather than hand-computed offsets because browsers disagree about the sign
  // and origin of scrollLeft in RTL documents; `nearest` on both axes keeps the
  // movement minimal (and is a no-op when the link is already visible).
  $effect(() => {
    void currentRoute();
    if (!rail || rail.scrollWidth - rail.clientWidth <= 1) return;
    const active = rail?.querySelector<HTMLAnchorElement>("a.tab.active");
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
</script>

<nav class="topnav" class:has-account={showAccount}>
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <Logo size={26} /><span class="word">Relayium</span>
  </a>

  <!-- These switch pages, not tab panels, so they're navigation links with
       aria-current — not role="tab" (which would promise a tabpanel that
       doesn't exist). Real hrefs keep right-click/open-in-new-tab working. -->
  <div class="tabs" class:overflowing={railOverflows} bind:this={rail}>
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

  @media (max-width: 1099px) {
    /* Row 1: brand on the left, the utility group (lang · theme · account)
       pushed to the right. Row 2: the mode tabs, full width. No lonely rows.
       Five destinations, two selects and nine languages do not honestly fit one
       320px row — the defect was equal-width compression, not the second row. */
    .topnav { flex-wrap: wrap; gap: 8px; row-gap: 10px; }
    .brand .word { display: none; }
    /* A zero flex basis lets this group share the first row's remaining space
       with the brand. Without it flex-wrap uses the selects' max-content width
       when deciding the line, so several locales wrapped at 320px even though
       both selects could safely shrink into the available 231px. */
    .util {
      margin-inline-start: auto; gap: var(--space-2); min-width: 0;
      flex: 1 1 0; justify-content: flex-end;
    }
    /* Account is conditional and may be an email up to 200px wide. Keep the
       two selects readable, then let the account control take an honest second
       line *inside* the utility group on very narrow auth routes. */
    .topnav.has-account .util { flex-wrap: wrap; row-gap: 6px; }
    .tabs {
      margin: 0; order: 3; width: 100%;
      flex-wrap: nowrap;
      overflow-x: auto; overflow-y: hidden;
      scroll-snap-type: inline proximity;
      /* Keep a snapped/focused chip clear of the faded edge. */
      scroll-padding-inline: var(--space-4);
      /* overflow-x also clips the block axis, and the global focus ring extends
         --focus-width + --focus-offset (4px) past the chip. Pad for it on both
         axes, then pull the box back with equal negative margins so the row keeps
         its height and the chips stay aligned with the brand above them.
         The inline padding matters at the two scroll extremes specifically: there
         the first/last chip is flush with the edge and scroll-padding has no room
         left to work with, so without it that chip's ring would be cut off. */
      padding-block: 5px; margin-block: -5px;
      padding-inline: 5px; margin-inline: -5px;
      /* Overflow is signalled by the fade alone; a scrollbar here would eat the
         row and, on desktop-class pointers, sit on top of the chips. */
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    /* Symmetric, so it needs no direction handling in RTL. */
    .tabs.overflowing {
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
      mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
    }
    /* Natural width — never truncate one of five primary destinations. */
    .tab { flex: none; padding-inline: var(--space-3); scroll-snap-align: center; }
    /* Native selects size themselves from their longest option, not just the
       selected label. Japanese's longest theme label used to make the utility
       group 302px wide and push it onto a third row even at 390px. Bound both
       selects (ThemeSelect is a child component, hence :global) so the normal
       no-account LAN header stays two rows down to 320px. Auth routes retain the
       topnav's wrap safety valve when their extra Account control needs it. */
    .lang,
    .util :global(.theme) {
      flex: 0 1 auto;
      min-width: 0;
      max-inline-size: 36vw;
    }
    .topnav.has-account .lang,
    .topnav.has-account .util :global(.theme) {
      min-inline-size: min(28vw, 96px);
    }
    .util :global(.acct-btn) { max-inline-size: min(32vw, 200px); }
    .lang { padding-inline: 8px 24px; }
  }
</style>
