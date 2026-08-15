<script lang="ts">
  // /device-inbox — the public, first-class entry point for Device Inbox, and
  // the place the feature is actually OPERATED.
  //
  // This is not a marketing stub with a link to the docs, and it is no longer a
  // census with a link to My Devices either. It has to do five things the PRD
  // (§12) names explicitly:
  //
  //  1. Explain the model: browser → a folder on a machine YOU own, encrypted
  //     before it leaves the browser, queued while that machine is offline, and
  //     "saved" only when the machine says it wrote the bytes to disk.
  //  2. State the prerequisites — an account, the SAME account, and receiving
  //     explicitly switched on at the device — and keep a public share link
  //     visibly separate from the permission to write to a disk.
  //  3. Give a signed-out visitor something executable (the real Account modal,
  //     not a paragraph telling them to sign in), and a signed-in one THEIR OWN
  //     DEVICES with a working send control on each one that has an inbox. The
  //     journey ends here; /me is for renaming and revoking credentials.
  //  4. Name six platforms with an honest status each, and show NO command and
  //     NO button for a native product that does not exist.
  //  5. Never invent a device state. "Checking", "we could not find out",
  //     "you have none", "you have some but none can receive" and "here are N
  //     you can send to" are five different answers and get five different
  //     sentences.
  //
  // The rows, the send zone, the crypto, the polling and the cancel are NOT
  // implemented here: they are DeviceSendList → DeviceCard → device-send.ts,
  // the same components My Devices renders, with credential management switched
  // off. This file owns the data and the five states, nothing else.
  //
  // The locale-invariant half — statuses, commands, paths — is in
  // device-inbox-platforms.ts; every sentence around it is in the maintained
  // locale tables. Nothing here composes English at runtime.
  import { onMount } from "svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, ME_PATH, CLI_PATH } from "./router.svelte";
  import { session, refreshSession } from "./auth.svelte";
  import { setLoginOpen } from "./login.svelte";
  import { DEVICE_REFRESH_MS } from "./device-inbox";
  import { censusOf, supportedDevices, type DeviceRow } from "./device-list";
  import {
    INBOX_PLATFORMS,
    SERVER_GUIDE_SLUG,
    platformStatus,
    startState,
    type DeviceCensus,
    type InboxPlatform,
    type PlatformStatus,
  } from "./device-inbox-platforms";
  import CommandBlock from "./CommandBlock.svelte";
  import Icon from "./Icon.svelte";
  import DeviceSendList from "./DeviceSendList.svelte";
  import releases from "../../native-releases.json";

  type MacRelease = { available: boolean; downloadUrl: string | null };

  // The manifest and the fetcher are props so the two branches that matter —
  // "a Mac build exists" and "/api/devices did not answer" — are reachable from
  // a test without a second production truth source. App.svelte passes neither.
  let {
    macRelease = releases.macos as MacRelease,
    fetchDevices = defaultFetchDevices,
  }: {
    macRelease?: MacRelease;
    /** Resolves to the raw device rows, or null when the account's devices
     *  could not be determined. Null is NOT an empty list — see `startState`. */
    fetchDevices?: () => Promise<unknown[] | null>;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);

  async function defaultFetchDevices(): Promise<unknown[] | null> {
    try {
      const res = await fetch("/api/devices", { credentials: "include" });
      if (!res.ok) return null;
      const body = (await res.json()) as { devices?: unknown[] };
      return body.devices ?? [];
    } catch {
      return null; // offline / DNS / CORS — an absence of knowledge, not an empty account
    }
  }

  // ── Account-aware state ──────────────────────────────────────────────────
  //
  // Separate flags rather than one nullable list, because "not asked yet",
  // "asked and failed" and "asked and got an answer" have to stay apart. A
  // failed request rendered as "no devices" (or as "ready") is the false
  // device-ready claim this page is not allowed to make.
  let devices = $state<DeviceRow[]>([]);
  let devicesLoaded = $state(false);
  let devicesFailed = $state(false);
  /** A REFRESH failed while a trustworthy list was already on screen. Its own
   *  flag, not `devicesFailed`: the rows are still the last thing the server
   *  actually said, and throwing them away would unmount a card mid-upload. */
  let refreshFailed = $state(false);
  const census = $derived<DeviceCensus>(censusOf(devices));
  /** Which sign-in the in-flight request belongs to; a late answer from a
   *  previous account must not repaint the current one. */
  let deviceGen = 0;
  let loadedFor = $state("");

  async function loadDevices(gen: number) {
    // The catch is not belt-and-braces over the default fetcher's own guard: it
    // is what stops a rejecting lookup from leaving the block on "checking…"
    // forever — a spinner that never resolves is a claim about nothing, and the
    // effect that called this would reject unhandled. A throw means the same
    // thing a non-ok response means: we do not know.
    let rows: unknown[] | null = null;
    try {
      rows = await fetchDevices();
    } catch {
      rows = null;
    }
    if (gen !== deviceGen) return;
    if (rows === null || !Array.isArray(rows)) {
      // Two different failures, and conflating them is what this branch exists
      // to prevent. With nothing loaded yet the honest answer is "we do not
      // know" — never "you have none". With a list already on screen, the last
      // successful answer is still the best available truth: the rows stay,
      // presence may be briefly stale, and a note says so. Clearing them would
      // destroy every card, and with it any send running inside one.
      if (devicesLoaded) refreshFailed = true;
      else devicesFailed = true;
      return;
    }
    // `supportedDevices` is what /me lists too, so both pages agree on which
    // rows exist, in which order, before either says anything about them.
    devices = supportedDevices(rows);
    devicesLoaded = true;
    devicesFailed = false;
    refreshFailed = false;
  }

  /** Everything this account could see, dropped. Called on sign-out and on an
   *  account switch, BEFORE any request for the new account can land. */
  function clearDevices() {
    devices = [];
    devicesLoaded = false;
    devicesFailed = false;
    refreshFailed = false;
  }

  // Load once per signed-in account, and re-load if a sign-in happens while the
  // page is open — which is the normal path here, since the page's own button
  // is what opens the modal.
  $effect(() => {
    const uid = session().user?.id ?? "";
    if (uid && uid !== loadedFor) {
      loadedFor = uid;
      const gen = ++deviceGen;
      clearDevices();
      void loadDevices(gen);
    }
    if (!uid && loadedFor) {
      loadedFor = "";
      deviceGen++;
      clearDevices();
    }
  });

  // NOT named `state`: `$state` is then read as a store subscription of it, and
  // every rune in this file stops compiling.
  const step = $derived(startState(devicesLoaded, devicesFailed, census));

  /** Retry after a failed lookup. The one state whose remedy is a request, so
   *  it is the one state that gets a button instead of a sentence alone. */
  function retryDevices() {
    if (!session().user) return;
    const gen = ++deviceGen;
    devicesFailed = false;
    void loadDevices(gen);
  }

  // Presence expires (90s TTL against a 30s heartbeat), so a list fetched once
  // and never refreshed would keep claiming a device is online long after it
  // stopped being. Bounded, and only while the tab is actually visible.
  let presenceTick: ReturnType<typeof setInterval> | undefined;

  function refreshIfVisible() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!session().user) return;
    void loadDevices(deviceGen);
  }

  /** Coming back to the tab refreshes immediately rather than waiting out the
   *  rest of an interval that did not run while it was hidden. */
  function onVisibility() {
    if (typeof document !== "undefined" && !document.hidden) refreshIfVisible();
  }

  onMount(() => {
    // A page whose whole point is an account has to know whether it has one.
    // refreshSession() itself can reject (its fetch is unguarded), and an
    // unhandled rejection here would leave the page stuck on "checking".
    void refreshSession().catch(() => {});

    presenceTick = setInterval(refreshIfVisible, DEVICE_REFRESH_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

    // Land on the section the link named. The SPA shell's <body> is empty when
    // the document loads, so the browser's own fragment handling has already
    // given up by the time #platform-server exists (WORKFLOW-LEARNINGS,
    // 2026-08-09: "A real browser is where link and layout defects live").
    revealAnchor(location.hash.slice(1));
    // A hash arriving after mount — the browser Back button, or a link in
    // another component — has to open the same section the click path opens.
    if (typeof window !== "undefined") window.addEventListener("hashchange", onHashChange);

    return () => {
      if (presenceTick !== undefined) clearInterval(presenceTick);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange);
      deviceGen++;
    };
  });

  /**
   * Scroll to `#id`, and OPEN it first if it is one of the collapsed platform
   * sections. Without the open, "Set up a receiver" scrolls a reader to a
   * closed row and leaves them looking at a summary line — the anchor resolves
   * and the content it named is still not on screen, which is the same dead end
   * as a broken link with none of the evidence that it broke.
   *
   * Focus moves with the scroll, or a keyboard user is left at the document
   * start while the sighted view has jumped.
   */
  function revealAnchor(id: string) {
    if (!id || typeof document === "undefined") return false;
    const target = document.getElementById(id);
    if (!target) return false;
    const box = target.closest("details");
    if (box) box.open = true;
    target.setAttribute("tabindex", "-1");
    // Optional call, as in Nav.svelte: this now runs from a click handler as
    // well as from mount, and an environment without scrollIntoView (jsdom)
    // must not take the OPEN with it — the disclosure is the load-bearing half.
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
    return true;
  }

  function onHashChange() {
    revealAnchor(location.hash.slice(1));
  }

  /**
   * In-page anchors get a hand, not a replacement: the native jump cannot open
   * a closed <details>, so this opens it first and then lets the browser do
   * everything it already did. Deliberately NOT `preventDefault()` — that would
   * also cancel the fragment write, and these links would stop producing a URL
   * worth copying or a Back step, which they did before this batch.
   */
  function goAnchor(_e: MouseEvent, id: string) {
    revealAnchor(id);
  }

  // ── Platform presentation ────────────────────────────────────────────────

  // A half-filled manifest must fail closed, exactly as /apps does: the macOS
  // download only appears when the flag AND the URL are both present. While it
  // is absent, the section says why instead of showing a dead control.
  const macDownloadable = $derived(macRelease?.available === true && !!macRelease?.downloadUrl);

  function statusText(s: PlatformStatus): string {
    return s === "available"
      ? t.deviceInboxPage.statusAvailable
      : s === "testing"
        ? t.deviceInboxPage.statusTesting
        : t.deviceInboxPage.statusPlanned;
  }

  const copy = (p: InboxPlatform) => t.deviceInboxPage.platforms[p.id];

  /** The badge and the download button now answer to ONE input. Reading
   *  `p.status` directly here is what let a released Mac app sit under an
   *  "In testing" badge on this very page. */
  const statusOf = (p: InboxPlatform) => platformStatus(p, macDownloadable);

  /** /guides/device-inbox-server/ exists in all nine languages as a static
   *  page, so this one IS language-prefixed — unlike the SPA routes, whose
   *  localized paths do not exist and would 404 in eight of nine locales. */
  const serverGuideHref = $derived(lang() === "en" ? `/${SERVER_GUIDE_SLUG}` : `/${lang()}/${SERVER_GUIDE_SLUG}`);

  function goMyDevices(e: MouseEvent) {
    e.preventDefault();
    navigate("me");
  }
  function goCli(e: MouseEvent) {
    e.preventDefault();
    navigate("cli");
  }
</script>

<section class="dinbox page-enter">
  <header class="hero">
    <!-- Decorative, and deliberately so: the localized <h1> right below names
         this page. An emoji here was neither: it rendered as a different
         picture (or as a tofu box) per platform and font, and it was the one
         product glyph on this page that no design token could reach. -->
    <div class="logo" aria-hidden="true"><Icon name="inbox" /></div>
    <h1>{t.deviceInboxPage.heading}</h1>
    <p class="sub">{t.deviceInboxPage.subhead}</p>
    <ul class="badges">
      {#each t.deviceInboxPage.badges as b (b)}<li>{b}</li>{/each}
    </ul>
  </header>

  <!-- Start: the operational half of the page, and the whole journey for a
       signed-in owner. Signed out it opens the real Account modal; signed in it
       renders this account's own devices, each with the send control that
       actually works, and says which of the five states it is in.

       It is FIRST, directly under the hero, and that placement is the product
       decision this page had wrong: the explanatory blocks used to push it
       2,774px down at 390px — three and a third phone screens of reading before
       a returning owner could reach the control they came for. Explanation that
       has to be scrolled past on every visit is a cost paid per visit; the
       people who need it read it once. It now follows the tool. -->
  <div class="block start" id="start" data-di="start" data-state={session().user ? step : "signed-out"}>
    <h2>{t.deviceInboxPage.startH2}</h2>

    {#if session().user}
      <p class="lead">{t.deviceInboxPage.signedInLead(session().user!.email)}</p>
      <p class="next" data-di="next-step">
        {#if step === "unknown"}{t.deviceInboxPage.stateUnknown}
        {:else if step === "checking"}{t.deviceInboxPage.startChecking}
        {:else if step === "none"}{t.deviceInboxPage.stateNone}
        {:else if step === "no-inbox"}{t.deviceInboxPage.stateNoInbox(census.total)}
        {:else}{t.deviceInboxPage.stateReady(census.withInbox)}{/if}
      </p>

      <!-- The rows. Rendered whenever the account HAS devices, sendable or not:
           a machine that cannot receive is not missing, it is a machine with a
           reason, and the card carries that reason. Hiding it would leave the
           owner comparing a count against a list that does not include it. -->
      {#if devices.length > 0}
        <div class="devices" data-di="devices">
          <h3 class="devicesh">{t.deviceInboxPage.devicesH3}</h3>
          <DeviceSendList {devices} label={t.deviceInboxPage.devicesH3} />
        </div>
      {/if}

      <!-- A refresh that failed while the rows above are still on screen. They
           are the last thing the server actually said, so they stay; this says
           what may now be stale about them rather than pretending otherwise.
           Only with rows: on an empty account there is no presence to have gone
           stale, and the sentence would describe devices that are not there. -->
      {#if refreshFailed && devices.length > 0}
        <p class="stale" data-di="stale" role="status" aria-live="polite">{t.deviceInboxPage.refreshFailed}</p>
      {/if}

      <p class="actions">
        {#if step === "unknown"}
          <button class="cta" type="button" data-di="retry" onclick={retryDevices}>
            {t.deviceInboxPage.retryCta}
          </button>
        {/if}
        {#if step !== "ready"}
          <a
            class="cta ghost"
            href="#platform-server"
            data-di="setup-server"
            onclick={(e) => goAnchor(e, "platform-server")}>{t.deviceInboxPage.setUpServerCta}</a>
        {/if}
        <!-- Secondary, and deliberately not a send path: renaming and revoking
             are credential management, and this page's rows do not offer them. -->
        <a class="manage" href={ME_PATH} data-di="my-devices" onclick={goMyDevices}>
          {t.deviceInboxPage.manageDevicesCta}
        </a>
      </p>
    {:else}
      <p class="lead">{t.deviceInboxPage.signedOutLead}</p>
      <p class="actions">
        <button class="cta" type="button" data-di="sign-in" onclick={() => setLoginOpen(true, "login")}>
          {t.deviceInboxPage.signInCta}
        </button>
        <button class="cta ghost" type="button" data-di="create-account" onclick={() => setLoginOpen(true, "register")}>
          {t.deviceInboxPage.createAccountCta}
        </button>
      </p>
    {/if}
  </div>

  <!-- What it is -->
  <div class="block">
    <h2>{t.deviceInboxPage.howH2}</h2>
    <p>{t.deviceInboxPage.howLead}</p>
    <ol class="steps">
      {#each t.deviceInboxPage.howSteps as s (s)}<li>{s}</li>{/each}
    </ol>
    <div class="callout" data-di="not-saved">
      <h3>{t.deviceInboxPage.notSavedH3}</h3>
      <p>{t.deviceInboxPage.notSavedBody}</p>
    </div>
  </div>

  <!-- Prerequisites + the permission boundary -->
  <div class="block">
    <h2>{t.deviceInboxPage.prereqH2}</h2>
    <ul class="prereq">
      <li>{t.deviceInboxPage.prereqAccount}</li>
      <li>{t.deviceInboxPage.prereqSameAccount}</li>
      <li>{t.deviceInboxPage.prereqEnable}</li>
      <li>{t.deviceInboxPage.prereqOffline}</li>
    </ul>
    <div class="callout" data-di="link-boundary">
      <h3>{t.deviceInboxPage.linkBoundaryH3}</h3>
      <p>{t.deviceInboxPage.linkBoundary}</p>
    </div>
  </div>

  <!-- Six platforms.
       Each one is a disclosure rather than a wall. Expanded, the six sections
       were 8,000px of the 12,400px this page occupied at 390px: a reference
       matrix nobody reads six of, in the position where a reader is looking for
       exactly one. Collapsed, the six statuses are one screen and still all
       true — the name and the honest status stay on the summary, so nothing
       that this page promises to state is behind a click. Only the detail of a
       platform the reader has not asked about is. -->
  <div class="block">
    <h2 id="platforms">{t.deviceInboxPage.platformsH2}</h2>
    <p>{t.deviceInboxPage.platformsLead}</p>

    {#each INBOX_PLATFORMS as p (p.id)}
      <!-- <summary> takes phrasing content OR heading content, so the h3 stays:
           the page's outline is unchanged and the row is still the disclosure
           button a screen reader announces as expanded/collapsed. -->
      <details class="plat" id={`platform-${p.id}`} data-platform={p.id} data-status={statusOf(p)}>
        <summary>
          <h3>
            <span class="g" aria-hidden="true">{p.glyph}</span>
            <span class="pname">{copy(p).name}</span>
            <span class="badge" data-badge={statusOf(p)}>
              <span class="vh">{t.deviceInboxPage.statusLabel(statusText(statusOf(p)))}</span>
              <span aria-hidden="true">{statusText(statusOf(p))}</span>
            </span>
          </h3>
        </summary>

        <dl>
          <dt>{t.deviceInboxPage.labelUse}</dt>
          <dd>{copy(p).use}</dd>

          <dt>{t.deviceInboxPage.labelSetup}</dt>
          <dd>
            <p>{copy(p).setup}</p>
            <!-- No invented native command. A testing/planned platform may
                 enter this branch only for a separately shipped CLI fallback
                 whose limit is stated in the same section. -->
            {#if p.setup && p.setupTitle}
              <CommandBlock
                code={p.setup}
                title={p.setupTitle}
                copyLabel={t.stored.cliCopy}
                copiedLabel={t.stored.copied}
                copyAria={`${t.stored.cliCopy}: ${p.setupTitle}`}
              />
            {/if}
            {#if p.id === "macos"}
              {#if macDownloadable}
                <p class="alt">
                  <a href={macRelease.downloadUrl!} data-di="mac-download">{t.deviceInboxPage.macDownloadCta}</a>
                </p>
              {:else}
                <p class="alt" data-di="mac-no-download">{t.deviceInboxPage.macNoDownload}</p>
              {/if}
            {/if}
            {#if p.id === "server"}
              <p class="alt">
                <a href={serverGuideHref} data-di="server-guide">{t.deviceInboxPage.docsServerGuide}</a>
              </p>
            {/if}
          </dd>

          <dt>{t.deviceInboxPage.labelFiles}</dt>
          <dd>{copy(p).files}</dd>

          <dt>{t.deviceInboxPage.labelResidency}</dt>
          <dd>{copy(p).residency}</dd>

          <dt>{t.deviceInboxPage.labelSend}</dt>
          <dd>
            <p>{copy(p).send}</p>
            <!-- Back UP this page to the block that does it, not off to another
                 route. The send target for this platform is the card in the
                 start block, once this account has such a device. -->
            <p class="alt">
              <a href="#start" data-di={`send-${p.id}`} onclick={(e) => goAnchor(e, "start")}>
                {t.deviceInboxPage.sendHereCta}
              </a>
            </p>
          </dd>

          <dt>{t.deviceInboxPage.labelRecovery}</dt>
          <dd>{copy(p).recovery}</dd>

          <dt>{t.deviceInboxPage.labelStop}</dt>
          <dd>
            <p>{copy(p).stop}</p>
            {#if p.control && p.controlTitle}
              <CommandBlock
                code={p.control}
                title={p.controlTitle}
                copyLabel={t.stored.cliCopy}
                copiedLabel={t.stored.copied}
                copyAria={`${t.stored.cliCopy}: ${p.controlTitle}`}
              />
            {/if}
          </dd>
        </dl>
      </details>
    {/each}
  </div>

  <!-- Boundaries -->
  <div class="block">
    <h2>{t.deviceInboxPage.safetyH2}</h2>
    <ul class="safety">
      {#each t.deviceInboxPage.safetyPoints as s (s)}<li>{s}</li>{/each}
    </ul>
  </div>

  <!-- Further reading -->
  <div class="block">
    <h2>{t.deviceInboxPage.docsH2}</h2>
    <ul class="docs">
      <li><a href={serverGuideHref}>{t.deviceInboxPage.docsServerGuide}</a></li>
      <li><a href={CLI_PATH} onclick={goCli}>{t.deviceInboxPage.docsCli}</a></li>
      <li><a href={ME_PATH} onclick={goMyDevices}>{t.deviceInboxPage.docsMyDevices}</a></li>
    </ul>
  </div>
</section>

<style>
  .dinbox {
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--space-4) 0 var(--space-9);
  }

  /* Hero */
  .hero {
    text-align: center;
    padding: var(--space-6) 0 var(--space-4);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 60px;
    height: 60px;
    margin: 0 auto var(--space-3);
    border-radius: 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    /* The text-contrast accent, not the decorative one: this badge is 60px of
       flat surface and the glyph inside it is the only thing on it. */
    color: var(--accent-fg);
  }
  /* Sized here rather than through the component's `size` prop so the
     narrow-viewport rule further down can shrink it with its badge. */
  .logo :global(svg) { width: 28px; height: 28px; }
  .hero h1 {
    font-size: var(--fs-display);
    letter-spacing: -1.2px;
    margin: 0 0 var(--space-2);
  }
  .hero .sub {
    color: var(--text);
    font-size: var(--fs-body);
    max-width: 60ch;
    margin: 0 auto;
    line-height: 1.6;
  }
  .badges {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    padding: 0;
    margin: var(--space-4) 0 0;
  }
  .badges li {
    font-size: var(--fs-xs);
    color: var(--text);
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
  }

  .block {
    margin-top: var(--space-8);
  }
  .block > h2 {
    font-size: var(--fs-h2);
    color: var(--text-h);
    margin: 0 0 var(--space-2);
    letter-spacing: -0.4px;
  }
  .block p,
  .steps li,
  .prereq li,
  .safety li {
    color: var(--text);
    line-height: 1.65;
  }
  .steps,
  .prereq,
  .safety,
  .docs {
    padding-inline-start: 1.3em;
  }
  .steps li,
  .prereq li,
  .safety li,
  .docs li {
    margin-bottom: var(--space-3);
  }
  .alt {
    font-size: var(--fs-sm);
    margin-top: var(--space-3);
  }

  /* The two statements this page exists to keep true get a visual home of their
     own so they cannot be skimmed past as body copy. */
  .callout {
    margin-top: var(--space-5);
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--accent-border);
    border-inline-start: 3px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .callout h3 {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: 0 0 var(--space-2);
  }
  .callout p {
    margin: 0;
  }

  /* Start block */
  .start {
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .start .lead {
    margin-bottom: var(--space-2);
  }
  .start .next {
    color: var(--text-h);
    margin-bottom: var(--space-4);
  }
  /* The operational block sits between the state sentence and the actions, and
     gets room of its own: it contains drop targets, and a drop target crowded
     against a paragraph reads as decoration. */
  .devices {
    margin: 0 0 var(--space-5);
  }
  .devicesh {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: 0;
  }
  .stale {
    margin: 0 0 var(--space-4);
    font-size: var(--fs-sm);
    color: var(--danger);
    max-width: 68ch;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: 0;
  }
  /* One affordance for both the <a> and the <button>: the sign-in control has
     to be a button (it opens a dialog, it does not navigate) and My Devices has
     to be a link (it has a URL worth copying), but they read as one row. */
  .cta {
    display: inline-block;
    font: inherit;
    font-size: var(--fs-sm);
    color: #fff;
    background: var(--grad-action);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    text-decoration: none;
    cursor: pointer;
  }
  .cta.ghost {
    color: var(--accent-fg);
    background: var(--social-bg);
    border-color: var(--accent-border);
  }
  .cta:focus-visible,
  .manage:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Secondary by construction: a plain link beside the filled actions, so it
     cannot be mistaken for the way to send something. */
  .manage {
    align-self: center;
    font-size: var(--fs-sm);
    color: var(--accent-fg);
  }

  /* Platform sections */
  .plat {
    margin-top: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  /* The row is a flex container, which drops the UA marker on its own — so the
     chevron below is not decoration, it is the ONLY remaining "this opens"
     affordance and has to be drawn, not merely allowed. Safari keeps its marker
     through `display: flex` and needs the -webkit rule as well; without it that
     browser gets two triangles. */
  .plat > summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    cursor: pointer;
    border-radius: var(--radius);
    /* A tap target the thumb can actually hit, at every width. */
    min-height: 44px;
  }
  .plat > summary::-webkit-details-marker {
    display: none;
  }
  .plat > summary::after {
    content: "";
    flex: none;
    margin-inline-start: auto;
    width: 8px;
    height: 8px;
    /* Physical borders on purpose: a chevron pointing DOWN points down in
       Arabic too. The logical pair flips it sideways under `dir="rtl"`. */
    border-right: 2px solid var(--text);
    border-bottom: 2px solid var(--text);
    transform: rotate(45deg);
    transform-origin: center;
    transition: transform 0.15s ease;
  }
  .plat[open] > summary::after {
    transform: rotate(-135deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .plat > summary::after {
      transition: none;
    }
  }
  .plat > summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .plat[open] > summary {
    border-bottom: 1px solid var(--border);
    border-end-start-radius: 0;
    border-end-end-radius: 0;
  }
  .plat > dl {
    padding: var(--space-5);
  }
  .plat h3 {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: 0;
    /* A flex item's floor is its content, not zero: without this a long
       localized platform name refuses to wrap and pushes the chevron out. */
    flex: 1 1 auto;
    min-width: 0;
  }
  .plat h3 .g {
    font-size: 22px;
  }
  .badge {
    font-size: var(--fs-xs);
    font-weight: 400;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
  }
  /* Three statuses, three token sets. "Planned" deliberately stays neutral: a
     coloured promise is still a promise. */
  .badge[data-badge="available"] {
    color: var(--ok);
    border-color: var(--ok-border);
    background: var(--ok-bg);
  }
  .badge[data-badge="testing"] {
    color: var(--accent-fg);
    border-color: var(--accent-border);
    background: var(--social-bg);
  }

  dl {
    display: grid;
    grid-template-columns: minmax(9rem, 12rem) 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--text-h);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  /* min-width: 0 is the whole horizontal-overflow fix, and it is not cosmetic.
     A grid item's automatic minimum size is its MIN-CONTENT size, and a
     CommandBlock's <pre> is `white-space: pre` — its min-content width is the
     longest command in the file. So the dd refused to be narrower than
     `sudo sh inbox-server-install.sh --dir /srv/relayium-inbox`, the dl grew
     with it, and the whole document went to 795px inside a 390px viewport:
     every screen of this page scrolled sideways, and the <pre>'s own
     `overflow-x: auto` never engaged because it was never the thing being
     squeezed. Floor the item at zero and the scroll happens where it was
     designed to, inside the terminal block. */
  dt,
  dd {
    min-width: 0;
  }
  dd {
    margin: 0 0 var(--space-3);
    color: var(--text);
    line-height: 1.65;
  }
  dd p {
    margin: 0 0 var(--space-2);
  }
  dd p:last-child {
    margin-bottom: 0;
  }
  dd :global(.term) {
    margin-top: var(--space-2);
  }
  /* Below this the two-column definition list stops being a table and starts
     being a squeeze: at 390px a 9rem label column leaves ~7rem for a sentence. */
  @media (max-width: 720px) {
    dl {
      grid-template-columns: 1fr;
      gap: 0;
    }
    dt {
      margin-top: var(--space-3);
    }

    /* A phone is not a small desktop. The hero used to occupy most of the
       first screen on its own — a 60px badge, a display-size heading and a
       three-line subhead, all centred — before a returning owner reached
       anything they could operate. It keeps the heading and the promise and
       gives up the ceremony. */
    .dinbox {
      padding-top: 0;
    }
    .hero {
      padding: var(--space-3) 0 var(--space-2);
      text-align: start;
    }
    .logo {
      width: 40px;
      height: 40px;
      margin: 0 0 var(--space-2);
      border-radius: 10px;
    }
    .logo :global(svg) { width: 20px; height: 20px; }
    .hero h1 {
      /* The token that already means "page header, not marketing hero". */
      font-size: var(--fs-page-title);
      letter-spacing: -0.6px;
    }
    .hero .sub {
      font-size: var(--fs-sm);
      margin: 0;
    }
    .badges {
      justify-content: flex-start;
      margin-top: var(--space-3);
    }

    .block {
      margin-top: var(--space-6);
    }
    /* The operational block is the exception: it follows the hero directly and
       should read as part of the same first screen, not as the next chapter. */
    .block.start {
      margin-top: var(--space-4);
    }
    .start,
    .plat > summary,
    .plat > dl {
      padding-inline: var(--space-4);
    }

    /* Full-width actions. Side-by-side CTAs at 390px are two ~150px buttons
       with a wrap that puts the second one somewhere unpredictable; stacked,
       each is a thumb-sized target in a fixed place. */
    .actions {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
    }
    .cta {
      text-align: center;
      padding: var(--space-3) var(--space-4);
    }
    .manage {
      align-self: start;
    }
  }

  a {
    color: var(--accent-fg);
  }

  /* A standalone action link is not prose: at 17px tall it fails WCAG 2.5.8's
     24px minimum target, and on a phone it is a coin-toss for a thumb. Inside a
     sentence a link keeps the line's rhythm, so only these are enlarged. */
  .alt a,
  .manage {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
  }
  @media (max-width: 720px) {
    .alt a,
    .manage {
      min-height: 44px;
    }
  }

  /* Hidden from sight, not from the accessibility tree: the badge's visible
     text is "Available now", and this is what makes a screen reader say what
     that value IS a value of. */
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
