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
  // The href moved into the tab record. It used to be a five-branch ternary in
  // the template, which is exactly the shape that quietly gains a wrong branch
  // when a sixth destination is added: one list, one place to be wrong.
  const tabs: { id: Route; href: string; label: () => string }[] = [
    { id: "lan", href: LAN_PATH, label: () => t.nav.lanTab },
    { id: "cross", href: CROSS_PATH, label: () => t.nav.crossTab },
    { id: "offline", href: OFFLINE_PATH, label: () => t.nav.offlineTab },
    { id: "device-inbox", href: DEVICE_INBOX_PATH, label: () => t.nav.deviceInboxTab },
    { id: "cli", href: CLI_PATH, label: () => t.nav.cliTab },
    { id: "apps", href: APPS_PATH, label: () => t.nav.appsTab },
  ];

  // The account control only appears on the login-gated flows (async storage,
  // realtime pairing, pricing, personal center, Device Inbox) — the same set
  // that needs an account for its primary action. Rendering it here folds it
  // into the nav bar so it no longer sits on a lonely row of its own.
  //
  // /device-inbox belongs here for the same reason /pricing does: its own
  // "Sign in" / "Create an account" buttons open THIS control's modal, so
  // without it those buttons would have nothing to open.
  const showAccount = $derived(
    currentRoute() === "cross" || currentRoute() === "offline" || currentRoute() === "pricing"
    || currentRoute() === "me" || currentRoute() === "device-inbox",
  );

  // Mobile mode rail. The six tabs keep their natural width and the row scrolls
  // instead of compressing every label into an unreadable sliver (zh/ko labels
  // used to paint over each other at 320–390px). Device Inbox made the row wider
  // in every locale, which is what the scroll and the edge fade are for.
  let rail = $state<HTMLDivElement | undefined>(undefined);
  // Only fade the rail's edges while it actually overflows — an unconditional
  // mask dims the first/last pill in locales whose labels fit (e.g. en at 390px),
  // which reads as a rendering bug rather than an affordance. Deliberately a
  // direction-free `scrollWidth > clientWidth` test: no scrollLeft arithmetic,
  // so it behaves identically under RTL.
  let railOverflows = $state(false);
  // Whether a destination is hidden BEFORE / AFTER the visible run, in reading
  // order. Not "scrolled to the left/right edge": those are different edges in
  // Arabic, and every scrollLeft-based version of this question has a different
  // answer per engine under RTL.
  let hiddenBefore = $state(false);
  let hiddenAfter = $state(false);
  // Whether a destination is actually clipped at the PHYSICAL left / right edge,
  // which is the only question the mask can answer: a CSS gradient runs in
  // physical coordinates, so `hiddenBefore` (reading order) is the wrong input
  // for it — in Arabic "before" is the right-hand edge. Both flags come from the
  // same rect comparison as everything else here, so RTL still needs no branch:
  // getBoundingClientRect is already physical in both directions.
  //
  // They exist because a fade is a promise that there is more this way. At either
  // end of the row that promise is false, and the flush first/last chip was being
  // dimmed to make it — at 320px `/apps` ended 5.4px inside a 16px fade with the
  // rail already at its maximum scroll, so no gesture could ever undim it.
  let clippedLeft = $state(false);
  let clippedRight = $state(false);

  const rtl = $derived(dir(lang()) === "rtl");

  function tabLinks(): HTMLAnchorElement[] {
    return rail ? [...rail.querySelectorAll<HTMLAnchorElement>("a.tab")] : [];
  }

  /** The rail's box and every destination's, measured in ONE pass.
   *
   *  Every positional question below is answered from a single call: reading a
   *  rect flushes layout, and this runs on each scroll event, so asking twice
   *  per frame is two synchronous layouts where one will do. */
  type RailBoxes = { box: DOMRect; boxes: DOMRect[] };
  function railBoxes(): RailBoxes | null {
    if (!rail) return null;
    return { box: rail.getBoundingClientRect(), boxes: tabLinks().map((a) => a.getBoundingClientRect()) };
  }

  /** Indices of the links fully inside the rail's own box, as a [first, last]
   *  pair (`[-1, -1]` when none is). Deliberately geometric rather than
   *  arithmetic on scrollLeft: an intersection test means the same thing in
   *  both directions, and DOM order is the reading order in both. */
  function visibleRun({ box, boxes }: RailBoxes): [number, number] {
    if (boxes.length === 0) return [-1, -1];
    const inside = boxes.map((r) => r.left >= box.left - 1 && r.right <= box.right + 1);
    const first = inside.indexOf(true);
    if (first >= 0) return [first, inside.lastIndexOf(true)];
    // Nothing fits entirely — one chip is wider than the rail. Fall back to
    // whatever overlaps it, so the controls still page instead of locking into
    // a pair that is permanently disabled over a row that does scroll.
    const touching = boxes.map((r) => r.right > box.left + 1 && r.left < box.right - 1);
    return [touching.indexOf(true), touching.lastIndexOf(true)];
  }

  function measureRail() {
    if (!rail) return;
    railOverflows = rail.scrollWidth - rail.clientWidth > 1;
    if (!railOverflows) {
      hiddenBefore = false;
      hiddenAfter = false;
      clippedLeft = false;
      clippedRight = false;
      return;
    }
    const m = railBoxes();
    if (!m) return;
    const [first, last] = visibleRun(m);
    hiddenBefore = first > 0;
    hiddenAfter = last >= 0 && last < m.boxes.length - 1;
    clippedLeft = m.boxes.some((r) => r.left < m.box.left - 1);
    clippedRight = m.boxes.some((r) => r.right > m.box.right + 1);
  }

  /** Bring the first destination hidden on the given side into view. Same
   *  `scrollIntoView` the route reveal uses, and for the same reason: it is the
   *  one scroll API that needs no direction handling.
   *
   *  `inline: "center"`, never `"nearest"`. The rail snaps, and its chips snap
   *  on their CENTRES (`scroll-snap-align: center`). A minimal "nearest" scroll
   *  lands between two snap points, proximity snapping pulls it back to the chip
   *  it started on, and the control then pages exactly once and freezes —
   *  measured in Chrome at 320px, where every click after the first returned the
   *  rail to scrollLeft 87. Asking for the same alignment the snap engine is
   *  going to impose anyway makes the step land where it was aimed.
   *
   *  The route reveal used to be the exception here, on "it should move the page
   *  as little as possible". It is not an exception any more: the same snapping
   *  was silently undoing the reveal too, just without a repeat press to make it
   *  obvious. Both operations now name the alignment they actually want. */
  function stepRail(back: boolean) {
    const links = tabLinks();
    const m = railBoxes();
    if (!m) return;
    const [first, last] = visibleRun(m);
    const target = back
      ? links[(first < 0 ? links.length : first) - 1]
      : links[(last < 0 ? -1 : last) + 1];
    target?.scrollIntoView?.({ block: "nearest", inline: "center" });
    measureRail();
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

  // Reveal the current destination — on the first mount as much as on a later
  // route change, because a direct load of /cli is exactly the case that arrives
  // with the rail at scroll 0 and the active chip off the end of it.
  //
  // scrollIntoView rather than hand-computed offsets because browsers disagree
  // about the sign and origin of scrollLeft in RTL documents.
  //
  // `inline: "center"`, NOT "nearest". This used to ask for the minimal scroll,
  // on the reasoning that a route change should move the rail as little as
  // possible. That reasoning is wrong here, and the browser is what says so: the
  // chips snap on their CENTRES, so a minimal scroll lands between two snap
  // points and proximity snapping then pulls the rail onto whichever chip is
  // nearest the middle — which is not the one being revealed. Measured in Chrome
  // on a direct load, that left the active chip at 390px/CLI 20px PAST the rail's
  // end edge and at 320px/Device Inbox 2px past it, with an unrelated
  // destination sitting perfectly centred in both. Asking for the alignment the
  // snap engine is going to impose anyway is what makes the reveal land where it
  // was aimed; it is the same correction the paging control already carries.
  //
  // `block: "nearest"` is load-bearing and stays: the inline axis is the only one
  // this is allowed to touch, and "nearest" is a no-op vertically while the
  // header is on screen. Anything else would scroll the document out from under
  // the reader on every route change.
  $effect(() => {
    void currentRoute();
    if (!rail || rail.scrollWidth - rail.clientWidth <= 1) return;
    const active = rail?.querySelector<HTMLAnchorElement>("a.tab.active");
    active?.scrollIntoView?.({ block: "nearest", inline: "center" });
    // The reveal moves the rail, so the controls' boundary state and both fade
    // flags are stale the instant it lands.
    measureRail();
  });
</script>

<nav class="topnav" class:has-account={showAccount} aria-label={t.nav.primaryLabel}>
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); navigate("lan"); }}>
    <Logo size={26} /><span class="word">Relayium</span>
  </a>

  <!-- These switch pages, not tab panels, so they're navigation links with
       aria-current — not role="tab" (which would promise a tabpanel that
       doesn't exist). Real hrefs keep right-click/open-in-new-tab working. -->
  <div
    class="tabs"
    class:overflowing={railOverflows}
    class:fade-left={clippedLeft}
    class:fade-right={clippedRight}
    bind:this={rail}
    onscroll={measureRail}
  >
    {#each tabs as tab (tab.id)}
      <a
        href={tab.href}
        data-nav={tab.id}
        class="tab"
        class:active={currentRoute() === tab.id}
        aria-current={currentRoute() === tab.id ? "page" : undefined}
        onclick={(e) => { e.preventDefault(); navigate(tab.id); }}
      >{tab.label()}</a>
    {/each}
  </div>

  <!-- Explicit paging for the scrolling rail. A fade at the edges says
       "there is more" to someone who can see it and swipe it; these say the
       same thing to a keyboard, a trackpad without horizontal scroll, and to a
       reader who never saw the fade. They exist ONLY while the row actually
       overflows: six destinations that already fit need no controls at all, and
       a pair of dead buttons under them would read as a rendering bug.
       They add no visible copy to a row that is already the tightest thing on
       the screen: a localized aria-label is their whole name. Each chevron
       points along the reading direction, so both glyphs flip in Arabic while
       "previous" keeps meaning the same destination it does in English. -->
  {#if railOverflows}
    <div class="rail-nav">
      <button
        type="button" class="rail-btn rail-prev" class:flip={!rtl}
        aria-label={t.nav.railPrev} disabled={!hiddenBefore}
        onclick={() => stepRail(true)}
      ><span class="chev" aria-hidden="true"></span></button>
      <button
        type="button" class="rail-btn rail-next" class:flip={rtl}
        aria-label={t.nav.railNext} disabled={!hiddenAfter}
        onclick={() => stepRail(false)}
      ><span class="chev" aria-hidden="true"></span></button>
    </div>
  {/if}

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
  .tab.active { color: #fff; background: var(--grad-action); border-color: transparent; }

  /* The rail controls belong to the scrolling rail, and the rail only scrolls
     below the desktop breakpoint. Hidden here rather than only by the
     `railOverflows` guard so a desktop row that is briefly measured as
     overflowing (mid-resize, mid-font-swap) can never paint two controls that
     have nothing to scroll. */
  .rail-nav { display: none; }
  .rail-btn {
    display: inline-grid; place-items: center;
    inline-size: 30px; block-size: 30px; padding: 0;
    border: 1px solid var(--border); border-radius: 999px;
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
    transition: border-color .13s, opacity .13s;
  }
  .rail-btn:hover:not(:disabled) { border-color: var(--accent-border); }
  /* Disabled, not removed: the control keeps its place, so reaching the end of
     the row does not shuffle the other one sideways under the finger. */
  .rail-btn:disabled { opacity: .38; cursor: default; }
  /* Mirrors the whole control. Which of the two is mirrored depends on the
     document direction, so "previous" always points back along the reading
     order — see the `flip` class in the markup. */
  .rail-btn.flip { transform: scaleX(-1); }
  /* Physical borders on purpose: the mirroring above is what handles RTL, and a
     logical pair would flip the glyph a second time and cancel it out. */
  .chev {
    inline-size: 7px; block-size: 7px;
    border-top: 2px solid currentColor; border-right: 2px solid currentColor;
    transform: rotate(45deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .rail-btn { transition: none; }
  }
  /* A 30px circle is the right visual weight next to the chips and too small to
     hit. Grow only the hit area on touch, exactly as the inline rename control
     does, so the row's height and rhythm are unchanged. */
  @media (pointer: coarse) {
    .rail-btn { position: relative; }
    .rail-btn::after { content: ""; position: absolute; inset: -7px; }
  }

  .lang {
    font: inherit; font-size: var(--fs-xs); padding-block: 5px; padding-inline: 10px 28px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  @media (max-width: 1099px) {
    /* Row 1: brand on the left, the utility group (lang · theme · account)
       pushed to the right. Row 2: the mode tabs, full width. No lonely rows.
       Six destinations, two selects and two languages do not honestly fit one
       320px row — the defect was equal-width compression, not the second row. */
    .topnav { flex-wrap: wrap; gap: 8px; row-gap: 10px; }
    /* Hidden from sight, NOT from the accessibility tree. `display: none` took
       the word out of both, and the brand link's only remaining content was an
       aria-hidden logo — so at ≤ this width the link had no accessible name at
       all and a screen reader announced a bare "link". Clipping it keeps the
       existing "Relayium" text as the name without adding a second copy of it
       in an aria-label that could drift from what's on screen. */
    .brand .word {
      position: absolute; width: 1px; height: 1px; margin: -1px;
      padding: 0; border: 0; overflow: hidden; white-space: nowrap;
      clip-path: inset(50%);
    }
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
    /* One gradient, two switches. Each end stop is opaque by default, so the
       edge is only faded when the component has measured a chip actually clipped
       there — a fade means "there is more this way", and at either end of the
       row there is not. Without this the last destination is dimmed at the
       rail's maximum scroll, where no gesture can reveal anything further and
       the fade is simply untrue.
       The two classes are PHYSICAL (left/right) because a gradient is, and they
       are set from physical rects, so RTL still needs no second rule here. */
    .tabs.overflowing {
      --edge-l: #000;
      --edge-r: #000;
      -webkit-mask-image: linear-gradient(to right, var(--edge-l) 0, #000 16px, #000 calc(100% - 16px), var(--edge-r) 100%);
      mask-image: linear-gradient(to right, var(--edge-l) 0, #000 16px, #000 calc(100% - 16px), var(--edge-r) 100%);
    }
    .tabs.overflowing.fade-left { --edge-l: transparent; }
    .tabs.overflowing.fade-right { --edge-r: transparent; }
    /* Natural width — never truncate one of six primary destinations. */
    .tab { flex: none; padding-inline: var(--space-3); scroll-snap-align: center; }
    /* Its own line under the rail, one control at each end of the row it pages.
       `space-between` and the logical box mean Arabic mirrors with no second
       rule: the button that sits at the start of the row is the one that pages
       back in both directions. */
    .rail-nav {
      display: flex; order: 4; inline-size: 100%;
      align-items: center; justify-content: space-between;
      margin-block-start: 2px;
    }
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
