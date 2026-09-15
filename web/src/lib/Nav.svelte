<script lang="ts">
  import {
    currentRoute, navigate,
    LAN_PATH, CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH, DEVICE_INBOX_PATH,
    type Route,
  } from "./router.svelte";
  import { lang, setLang, LANGS, messages, dir, type Lang, type Messages } from "./i18n.svelte";
  import { loginOpen, setLoginOpen } from "./login.svelte";
  import ThemeSelect from "./ThemeSelect.svelte";
  import Account from "./Account.svelte";
  import Logo from "./Logo.svelte";

  const t = $derived<Messages>(messages[lang()]);
  type NavLink = { id: Route; href: string; label: () => string; short: () => string };

  // **Four destinations, in three named groups.** The groups are the reference's
  // own hierarchy (`Relayium 设计规范` §1), not one generic "Main" heading over
  // everything — the point of a group label is to say what a destination IS.
  //
  // `short` is the compact header's visible label and `label` is its accessible
  // name. Every `short` is a SUBSTRING of its `label` in both languages: WCAG
  // 2.5.3 requires the visible text to be part of the accessible name, or speech
  // input cannot address a control by what it says. See i18n/types.ts.
  const groups: { label: () => string; items: NavLink[] }[] = $derived([
    {
      label: () => t.shell.groupDirect,
      items: [
        { id: "lan", href: LAN_PATH, label: () => t.nav.lanTab, short: () => t.shell.lanShort },
        { id: "cross", href: CROSS_PATH, label: () => t.nav.crossTab, short: () => t.shell.crossShort },
      ],
    },
    {
      label: () => t.shell.groupLinks,
      items: [
        { id: "offline", href: OFFLINE_PATH, label: () => t.nav.offlineTab, short: () => t.shell.offlineShort },
      ],
    },
    {
      label: () => t.shell.groupThisDevice,
      items: [
        { id: "device-inbox", href: DEVICE_INBOX_PATH, label: () => t.nav.deviceInboxTab, short: () => t.shell.deviceInboxShort },
      ],
    },
  ]);

  // Downloads and tools: reachable, named, and deliberately not a transfer
  // destination. Both labels are already single words.
  const tools: NavLink[] = $derived([
    { id: "cli", href: CLI_PATH, label: () => t.nav.cliTab, short: () => t.nav.cliTab },
    { id: "apps", href: APPS_PATH, label: () => t.nav.appsTab, short: () => t.nav.appsTab },
  ]);

  // The account control only appears on the login-gated flows (async storage,
  // realtime pairing, pricing, personal center, Device Inbox) — the same set
  // that needs an account for its primary action.
  const showAccount = $derived(
    currentRoute() === "cross" || currentRoute() === "offline" || currentRoute() === "pricing"
    || currentRoute() === "me" || currentRoute() === "device-inbox",
  );

  // The four transfer destinations render inside the settings shell (App's
  // `.appshell.shell`), so on a wide viewport this header IS that shell's 216px
  // rail. Everywhere else it stays the horizontal header it has always been.
  const SHELL_ROUTES = new Set<Route>(["lan", "cross", "offline", "device-inbox"]);
  const inShell = $derived(SHELL_ROUTES.has(currentRoute()));
  const activeTool = $derived(tools.find((tool) => tool.id === currentRoute()));

  // ── The utility disclosure, and what is deliberately NOT in it ─────────────
  //
  // `<Account>` lives in `.util-slot`, OUTSIDE this <details>. It used to be
  // inside, and that was a functional regression, not a layout nuance: Account
  // owns the sign-in dialog, the dialog is a `position: fixed` child of this
  // component's tree, and a closed <details> hides ALL of its non-summary
  // subtree — fixed positioning does not escape that. So `setLoginOpen(true)`
  // from a page's own "Sign in" button opened a dialog nobody could see
  // (root's login-menu-red.json: dialogCount 1, dialogVisible false,
  // moreOpen false). Keeping the node mounted was never the property that
  // mattered; being RENDERED is. A stable slot removes the cause outright,
  // rather than coupling the modal's lifetime to a menu's open state.
  //
  // What stays in the menu is what has no such caller: language, theme, and the
  // two tools links. Nothing else in the product opens those programmatically.
  //
  // It is one DOM structure at every width. `open` is forced true above the
  // breakpoint and the summary is hidden there; rendering two different trees
  // would remount the controls on a rotation.
  // Initialised at component init rather than in the effect below: an effect
  // runs after the first paint, so a phone would lay out four FULL labels in
  // four narrow columns for one frame before swapping. The effect keeps it in
  // sync afterwards; this is what makes the first frame right.
  let narrow = $state(typeof matchMedia !== "undefined" && matchMedia("(max-width: 1099px)").matches);
  let moreOpen = $state(false);
  let moreEl = $state<HTMLDetailsElement | undefined>(undefined);
  $effect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(max-width: 1099px)");
    const sync = () => (narrow = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });
  // A menu that survives the navigation it just performed is a menu covering the
  // page you asked for.
  $effect(() => {
    void currentRoute();
    moreOpen = false;
  });
  // Escape and a click elsewhere close it, and Escape returns focus to the
  // control that opened it — the two behaviours <details> does not bring along.
  $effect(() => {
    if (!moreOpen || !narrow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      moreOpen = false;
      moreEl?.querySelector("summary")?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (moreEl && !moreEl.contains(e.target as Node)) moreOpen = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  });

  // The narrow header is TWO rows: a toolbar, then four equal columns of
  // destinations. Nothing scrolls, so nothing can be hidden off an edge — the
  // scroll rail, its edge fade and the reveal that scrolled the active chip into
  // view are all gone with the single row that needed them.
  //
  // `dir()` is still read so the component names the direction it lays out in;
  // every box below is a logical property, so RTL needs no second rule.
  const rtl = $derived(dir(lang()) === "rtl");

  // A dialog whose opener has unmounted cannot be closed by anything but this.
  // Account renders only on the gated routes, so navigating away with the modal
  // open would leave the shared open state true — re-opening it on the next
  // gated route, and leaving the background marked inert with nothing to return
  // focus to.
  $effect(() => {
    if (!showAccount && loginOpen()) setLoginOpen(false);
  });

  // ── Focus return across the inert background ──────────────────────────────
  //
  // The dialog's own trap restores focus while it is being torn down, and at
  // that moment the background it wants to focus is still `inert` — so the
  // restore is a no-op and focus lands on <body>. This restores it once the
  // background is usable again, which is what the open state flipping back
  // means. It never takes focus from a newer target.
  let opener: HTMLElement | null = null;
  let dialogWasOpen = false;

  // Only while the dialog is CLOSED. The backdrop is a <button> outside
  // `[role="dialog"]`, so a backdrop click would otherwise overwrite the opener
  // with an element that is detached a moment later — and focus would have
  // nowhere to return to.
  function rememberOpener(target: EventTarget | null) {
    if (loginOpen()) return;
    const el = target instanceof Element ? target.closest<HTMLElement>("a[href], button, [tabindex]") : null;
    if (el && !el.closest('[role="dialog"]')) opener = el;
  }

  $effect(() => {
    const onFocusIn = (e: FocusEvent) => rememberOpener(e.target);
    // Pointer as well as focus: a click does not focus a <button> on every
    // platform, and that button is still what opened the dialog.
    const onPointerDown = (e: PointerEvent) => rememberOpener(e.target);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  });

  function restoreOpenerFocus(): boolean {
    const el = opener;
    // Gone with its route, or still covered: nothing to restore to yet.
    if (!el?.isConnected || el.closest("[inert]")) return false;
    const active = document.activeElement;
    // A newer dialog, an explicit user focus or a route's own target keeps it.
    if (active && active !== document.body && active !== el) return true;
    el.focus();
    return document.activeElement === el;
  }

  $effect(() => {
    const open = loginOpen();
    if (open === dialogWasOpen) return;
    dialogWasOpen = open;
    if (open) return;
    // One retry on the next microtask covers the case where this flush has not
    // yet dropped `inert` from the opener's own subtree.
    if (!restoreOpenerFocus()) queueMicrotask(restoreOpenerFocus);
  });
</script>

<nav
  class="topnav"
  class:has-account={showAccount}
  class:shell={inShell}
  class:rtl
  aria-label={t.nav.primaryLabel}
>
  <!-- The header's background halves. `.util-slot` is deliberately NOT inert:
       it holds the dialog and the control focus returns to. -->
  <a class="brand" href="/" inert={loginOpen() ? true : undefined} onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <Logo size={26} /><span class="word">Relayium</span>
  </a>

  <!-- The current tools page, marked where it cannot cost a destination its
       place. On a narrow viewport the tools links are inside the closed menu, so
       without this /cli and /apps would have no visible current-page marker at
       all; it rides the toolbar row rather than the destination row, which stays
       exactly four equal columns. It is a SECOND link to the same page — the
       `nav.tools` landmark below keeps both of its entries and its own
       aria-current at every width. -->
  {#if narrow && activeTool}
    <a
      class="tool-now"
      href={activeTool.href}
      aria-current="page"
      onclick={(e) => { e.preventDefault(); navigate(activeTool!.id); }}
    >{activeTool.label()}</a>
  {/if}

  <!-- The account control. Outside the disclosure on purpose — see the comment
       on `moreOpen` above; this is the slot that keeps the sign-in dialog
       reachable when a page's own button opens it. -->
  <div class="util-slot">
    {#if showAccount}
      <Account bind:open={() => loginOpen(), (v) => setLoginOpen(v)} />
    {/if}

    <details
      class="more"
      inert={loginOpen() ? true : undefined}
      bind:this={moreEl}
      open={!narrow || moreOpen}
      ontoggle={(e) => { if (narrow) moreOpen = (e.currentTarget as HTMLDetailsElement).open; }}
    >
      <summary aria-label={t.shell.more}><span class="dots" aria-hidden="true"></span></summary>
      <div class="more-panel">
        <!-- Downloads and tools: a second, NAMED landmark. These are not ways to
             move a file, and dressing them as siblings of the four that are was
             the original defect. Real hrefs and real aria-current. -->
        <span class="side-group side-group-tools" aria-hidden="true">{t.nav.toolsLabel}</span>
        <nav class="tools" aria-label={t.nav.toolsLabel}>
          {#each tools as tool (tool.id)}
            <a
              href={tool.href}
              data-nav={tool.id}
              class="tool"
              class:active={currentRoute() === tool.id}
              aria-current={currentRoute() === tool.id ? "page" : undefined}
              onclick={(e) => { e.preventDefault(); navigate(tool.id); }}
            >{tool.label()}</a>
          {/each}
        </nav>

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
        </div>
      </div>
    </details>
  </div>

  <!-- These switch pages, not tab panels, so they're navigation links with
       aria-current — not role="tab" (which would promise a tabpanel that
       doesn't exist). Real hrefs keep right-click/open-in-new-tab working. -->
  <div class="tabs" inert={loginOpen() ? true : undefined}>
    {#each groups as group (group.label())}
      <!-- Painted only in the sidebar form. aria-hidden because these are visual
           groupings of links that already say what they are. -->
      <span class="side-group" aria-hidden="true">{group.label()}</span>
      {#each group.items as tab (tab.id)}
        <a
          href={tab.href}
          data-nav={tab.id}
          class="tab"
          class:active={currentRoute() === tab.id}
          aria-current={currentRoute() === tab.id ? "page" : undefined}
          aria-label={tab.label()}
          onclick={(e) => { e.preventDefault(); navigate(tab.id); }}
        >{narrow ? tab.short() : tab.label()}</a>
      {/each}
    {/each}
  </div>
</nav>

<style>
  .topnav {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-4) 0 var(--space-3); margin-bottom: var(--space-1);
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text-h); font-weight: 600; flex: none; }
  .brand .word { font-size: 16px; letter-spacing: -0.4px; }
  /* Playful nudge on the mark when hovering the wordmark. */
  .brand :global(svg) { transition: transform .25s cubic-bezier(.22, 1, .36, 1); }
  .brand:hover :global(svg) { transform: rotate(-8deg) scale(1.08); }
  @media (prefers-reduced-motion: reduce) {
    .brand :global(svg), .brand:hover :global(svg) { transition: none; transform: none; }
  }

  /* The stable slot. Account and the disclosure are siblings here, never
     ancestor and descendant. */
  .util-slot { display: flex; align-items: center; gap: var(--space-2); flex: none; }
  /* Wide default: the disclosure is a plain container. `open` is forced true and
     the summary is hidden, so tools and utilities sit in the header row exactly
     as they did — one DOM structure, two presentations. */
  .more { display: flex; align-items: center; }
  .more > summary { display: none; }
  .more-panel { display: flex; align-items: center; gap: var(--space-3); }
  .util { display: flex; align-items: center; gap: var(--space-3); }

  /* Group labels are painted in the sidebar form only. The destination LABEL is
     switched in the markup rather than by hiding one of two spans: two spans
     would both be in `textContent`, so the LAN chip would read "LANLAN" to
     every consumer that does not use `innerText` — including this repo's own
     auth-landing browser step, which finds that link by its text. One element,
     one string, and `aria-label` carries the full name at both widths. */
  .side-group { display: none; }

  .tabs { display: flex; gap: 6px; margin: 0 auto 0 8px; min-inline-size: 0; }
  .tab {
    display: inline-flex; align-items: center; justify-content: center;
    /* Border box, at every width. In the narrow grid each destination is
       `inline-size: 100%` of its column, and in the default content box that
       100% is the CONTENT width — so 8px of padding and a 1px border each side
       made every chip 10px wider than the column it was given. Measured at
       320px: columns 67px apart, boxes 77px wide, every pair of neighbours
       overlapping by 6px, with the last one ending 10px past the row. Each
       chip still reported itself on screen and the document still did not
       overflow, which is why only a per-box measurement could see it. */
    box-sizing: border-box;
    font: inherit; font-size: var(--fs-sm); padding: var(--space-2) var(--space-4); border-radius: 999px; cursor: pointer;
    white-space: nowrap;
    border: 1px solid var(--border); background: var(--social-bg); color: var(--text); text-decoration: none;
    transition: border-color .13s, color .13s, background .13s;
  }
  .tab:hover { border-color: var(--accent-border); }
  .tab.active { color: #fff; background: var(--grad-action); border-color: transparent; }

  /* Secondary by DESIGN, not by accident of order: the destinations are pills,
     these are text links, so the header shows two ranks. Underline on the
     current page, not a filled pill — current-page state has to survive a colour
     filter, and `--accent-fg` is the accessible text weight of the brand. */
  .tools { display: flex; align-items: center; gap: var(--space-3); flex: none; }
  .tool {
    font: inherit; font-size: var(--fs-xs); color: var(--text);
    white-space: nowrap;
    text-decoration: underline 1px transparent; text-underline-offset: 4px;
    padding-block: 2px;
    transition: color .13s, text-decoration-color .13s;
  }
  .tool:hover { color: var(--text-h); text-decoration-color: var(--accent-border); }
  .tool.active { color: var(--accent-fg); text-decoration-color: currentColor; }
  /* The toolbar-row marker for the current tools page. Never rendered wide,
     where the `nav.tools` link itself is visible and marked. */
  .tool-now {
    display: none;
    font: inherit; font-size: var(--fs-xs); font-weight: 600;
    color: var(--accent-fg); text-decoration: underline; text-underline-offset: 4px;
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .tool { transition: none; }
  }

  .lang {
    font: inherit; font-size: var(--fs-xs); padding-block: 5px; padding-inline: 10px 28px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  /* One touch floor for every primary control in this header, stated once. The
     account control and the theme select belong to components this file does not
     own; a container is allowed to size the slot it puts a control in, which is
     why neither of those files needed a change. */
  @media (pointer: coarse) {
    .tab, .lang, .more > summary, .tool-now { min-block-size: 44px; }
    .util-slot :global(.acct-btn),
    .util :global(.theme),
    .util :global(.theme select) { min-block-size: 44px; }
    .tool {
      display: inline-flex; align-items: center; justify-content: center;
      min-inline-size: 44px; min-block-size: 44px;
      padding-block: 0;
    }
  }

  /* ── Sidebar form ────────────────────────────────────────────────────────
     The owner reference's left rail. Gated on BOTH `.shell` (one of the four
     transfer destinations) and the 1180px breakpoint App's shell grid uses.

     Reference numbers as written: 216px fixed rail, 28px rows with a 7px radius
     and 10px inline padding, 11px/600 group titles. The surface is the
     reference's neutral grey; purple appears on the selected row and nowhere
     else. */
  @media (min-width: 1180px) {
    .topnav.shell {
      position: sticky;
      inset-block-start: 0;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      inline-size: var(--shell-side-w);
      /* Full height, not max-height: the rail's surface is what separates the
         navigation from the content pane. */
      block-size: 100svh;
      overflow-y: auto;
      margin: 0;
      padding: var(--space-4) var(--space-3);
      border-inline-end: 1px solid var(--shell-sep);
      background: var(--shell-side);
    }
    .topnav.shell .brand {
      gap: 9px;
      padding-inline: 10px;
      margin-block-end: var(--space-2);
      min-block-size: 28px;
    }
    /* Destinations first in the rail, utilities at its foot: `order` rather than
       a second markup order, because the toolbar row needs the account control
       before the destination row and the rail needs it after. */
    .topnav.shell .tabs { order: 1; }
    .topnav.shell .util-slot { order: 2; }
    .topnav.shell .side-group {
      display: block;
      margin-block: var(--space-3) 4px;
      padding-inline: 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--text);
    }
    .topnav.shell .tabs > .side-group:first-child { margin-block-start: var(--space-2); }

    .topnav.shell .tabs {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0;
      inline-size: 100%;
    }
    .topnav.shell .tab,
    .topnav.shell .tool {
      justify-content: flex-start;
      box-sizing: border-box;
      inline-size: 100%;
      min-block-size: 28px;
      padding-block: 4px;
      padding-inline: 10px;
      border: 1px solid transparent;
      border-radius: 7px;
      background: none;
      font-size: 13px;
      text-align: start;
      white-space: normal;
      transition: background-color .12s ease, color .12s ease;
    }
    .topnav.shell .tab:hover,
    .topnav.shell .tool:hover { background: var(--shell-row-hover); border-color: transparent; }
    /* The selected row's fill is restated, not inherited: the rule above resets
       `background` on every row and would otherwise win on specificity, leaving
       the current destination marked by weight alone. --grad-action is flat
       inside the shell (app.css) and carries white at 5.53:1. */
    .topnav.shell .tab.active {
      font-weight: 600;
      color: #fff;
      background: var(--grad-action);
      border-color: transparent;
    }

    .topnav.shell .util-slot {
      display: block;
      inline-size: 100%;
      margin-block-start: auto;
      padding-block-start: var(--space-4);
    }
    .topnav.shell .more { display: block; inline-size: 100%; }
    .topnav.shell .more-panel {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      inline-size: 100%;
    }
    .topnav.shell .tools {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      inline-size: 100%;
    }
    .topnav.shell .tool {
      display: flex;
      align-items: center;
      color: var(--text);
      text-decoration: none;
    }
    .topnav.shell .tool.active {
      color: var(--text-h);
      background: var(--shell-row-hover);
      text-decoration: none;
    }
    .topnav.shell .util {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
      inline-size: 100%;
      padding-block-start: var(--space-3);
    }
    .topnav.shell .lang,
    .topnav.shell .util :global(.theme) { inline-size: 100%; }
    .topnav.shell .util-slot :global(.acct-btn) {
      inline-size: 100%;
      max-inline-size: 100%;
      margin-block-end: var(--space-2);
    }
  }
  @media (min-width: 1180px) and (prefers-reduced-motion: reduce) {
    .topnav.shell .tab, .topnav.shell .tool { transition: none; }
  }
  /* A wide viewport can still be a touch screen, and the sidebar's own 28px row
     height outranks the shared coarse floor on specificity — measured 29.5px at
     1440px with `pointer: coarse`. The reference's compact rows stay compact for
     a fine pointer; a thumb gets the floor at every width. */
  @media (min-width: 1180px) and (pointer: coarse) {
    .topnav.shell .tab,
    .topnav.shell .tool { min-block-size: 44px; }
  }

  /* ── Compact form ────────────────────────────────────────────────────────
     TWO rows, and the second one is the point. Row 1 is the toolbar: the mark,
     the current tools page when there is one, the account control and the
     utility disclosure. Row 2 is four EQUAL columns, one per destination, all
     of them on screen at 320px.

     The single-row version this replaces put the fourth destination off the
     right edge behind the More button — measured at 320px, where only
     LAN/Pairing/Share were reachable without a horizontal swipe nobody is told
     about. Four equal columns cannot hide one; there is no scroll container
     left to hide it in. */
  @media (max-width: 1099px) {
    .topnav { flex-wrap: wrap; gap: var(--space-2); row-gap: var(--space-2); }
    /* The toolbar carries the WINDOW surface and the page under it carries the
       content surface (app.css paints body). Without this the two-row header
       and the page it sits on are one flat colour, which is the palette gap
       root measured: tokens declared, nothing painted. Full-bleed via the
       negative gutter so the surface reaches the edge of the frame, with the
       padding put back so the rows stay aligned with the content. */
    :global(:root.shell-route) .topnav {
      margin-inline: -20px;
      padding-inline: 20px;
      border-block-end: 1px solid var(--shell-sep);
      background: var(--shell-win);
    }
    /* Hidden from sight, NOT from the accessibility tree: `display: none` took
       the word out of both, and the brand link's only remaining content was an
       aria-hidden logo — so the link had no accessible name at all. */
    .brand .word {
      position: absolute; width: 1px; height: 1px; margin: -1px;
      padding: 0; border: 0; overflow: hidden; white-space: nowrap;
      clip-path: inset(50%);
    }
    .brand { order: 1; }
    .tool-now { display: inline-flex; align-items: center; order: 2; min-inline-size: 0; }
    .util-slot { order: 3; margin-inline-start: auto; }
    .tabs { order: 4; }

    .tabs {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 4px;
      margin: 0;
      inline-size: 100%;
      /* No scrolling, no mask, no edge fade: with four equal columns there is
         nothing off-screen for any of them to signal. */
      overflow: visible;
    }
    .tab {
      inline-size: 100%;
      min-inline-size: 0;
      padding-inline: 4px;
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      /* A destination label may wrap, but it may never be cut: an ellipsis on
         one of four primary destinations is the same defect as hiding it. */
      white-space: normal;
      overflow-wrap: anywhere;
      text-align: center;
      line-height: 1.2;
    }

    /* The disclosure. Anchored rather than in flow, so opening it does not shove
       the page down under the reader's thumb. */
    .more { position: relative; flex: none; }
    .more > summary {
      display: grid; place-items: center;
      inline-size: 38px; min-block-size: 38px;
      border: 1px solid var(--border); border-radius: 999px;
      background: var(--social-bg); color: var(--text-h);
      cursor: pointer; list-style: none;
    }
    .more > summary::-webkit-details-marker { display: none; }
    .more[open] > summary { border-color: var(--accent-border); }
    /* Stated here as well as in the shared coarse block above, which this rule
       would otherwise override by source order at equal specificity. */
    @media (pointer: coarse) {
      .more > summary { min-block-size: 44px; }
    }
    /* Three dots: one element, two shadows. Purely decorative — the control's
       name is its localized aria-label. */
    .dots {
      inline-size: 3px; block-size: 3px; border-radius: 50%;
      background: currentColor;
      box-shadow: -6px 0 0 currentColor, 6px 0 0 currentColor;
    }
    .more-panel {
      position: absolute;
      inset-inline-end: 0;
      inset-block-start: calc(100% + 8px);
      z-index: 40;
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-3);
      min-inline-size: 190px;
      max-inline-size: min(280px, calc(100vw - 32px));
      padding: var(--space-3);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      /* The window surface, not --surface: this panel floats OVER the page, so
         it has to be opaque under every palette this header renders in. */
      background: var(--shell-win);
      box-shadow: var(--shadow);
    }
    .more-panel .side-group {
      display: block;
      margin: 0;
      font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
      color: var(--text);
    }
    .tools { flex-direction: column; align-items: stretch; gap: var(--space-1); }
    .tool { justify-content: flex-start; }
    .util { flex-direction: column; align-items: stretch; gap: var(--space-2); }
    .lang { inline-size: 100%; }
    .util :global(.theme), .util :global(.theme select) { inline-size: 100%; }
    /* The account control shares the toolbar row with the disclosure, so it may
       not grow to fill it — it caps instead, and the email inside it truncates
       the way it already did. */
    .util-slot :global(.acct-btn) { max-inline-size: min(42vw, 180px); }

    /* The sign-in dialog, sized from the slot that owns it.
       `Account.svelte` asks for `width: min(340px, calc(100vw - 32px))` in the
       default CONTENT box, then adds 24px of padding on each side and a 1px
       border — so at 320px the border box is 338 wide, centred on 160, and the
       dialog is laid out at x=-9..329. It renders, it takes focus, and 9px of
       it hangs off each edge of the screen: the close control and the first
       field are partly unreachable at exactly the width where a thumb has the
       least room.

       Fixed here rather than in `Account.svelte`, which stays read-only: the
       component owns the dialog's behaviour — its focus trap, its escape, its
       auth state — and this is its container deciding how much room it gets.
       `border-box` makes the 32px gutter the component already asks for mean
       what it says. Only the narrow form is touched; above the breakpoint the
       original sizing has no viewport to overflow. */
    .util-slot :global(.modal) {
      box-sizing: border-box;
      inline-size: min(340px, calc(100vw - 32px));
      max-inline-size: calc(100vw - 32px);
    }
    /* Below ~380px, 24px of padding on each side is a quarter of the dialog. */
    @media (max-width: 380px) {
      .util-slot :global(.modal) { padding: var(--space-4); }
    }
  }
</style>
