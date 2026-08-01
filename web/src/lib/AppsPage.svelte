<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, CLI_PATH } from "./router.svelte";
  import { detectPlatform, type Platform } from "./platform";
  import releases from "../../native-releases.json";

  type MacRelease = { available: boolean; downloadUrl: string | null };
  type AppId = "web" | "cli" | "mac" | "ios";
  type AppCard = {
    id: AppId;
    name: string;
    desc: string;
    available: boolean;
    href?: string;
    cta?: string;
    onclick?: (event: MouseEvent) => void;
  };

  // The optional inputs make both release halves and UA edge cases testable
  // without introducing a second production truth source. App.svelte passes
  // neither, so the shipped page still reads the build-time manifest and UA.
  let {
    macRelease = releases.macos,
    platformOverride,
  }: { macRelease?: MacRelease; platformOverride?: Platform } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";

  // Detect once per component instance. Browser builds use the real navigator;
  // component tests can override the result without changing this production path.
  const browserPlatform: Platform =
    typeof navigator !== "undefined" ? detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0) : "unknown";
  const platform = $derived(platformOverride ?? browserPlatform);

  // UA matching marks a platform; it never recommends an alternative or grants
  // an action. In particular, unavailable macOS/iOS cards remain neutral future
  // status even when the browser belongs to that platform.
  const highlightId = $derived(
    platform === "mac" ? "mac"
    : platform === "ios" ? "ios"
    : platform === "windows" || platform === "linux" ? "cli"
    : "web",
  );
  // Human OS name for the "looks like you're on X" caption; empty when unknown/android.
  const osName = $derived(
    platform === "mac" ? "macOS"
    : platform === "ios" ? "iOS"
    : platform === "windows" ? "Windows"
    : platform === "linux" ? "Linux"
    : "",
  );

  function openWeb(e: MouseEvent) { e.preventDefault(); navigate("lan"); }
  function openCli(e: MouseEvent) { e.preventDefault(); navigate("cli"); }

  // A half-filled manifest must fail closed: the card only becomes executable
  // when both the release flag and its exact download URL are present. The JSON
  // import is replaced atomically by stage-macos-release and bundled at build.
  const macAvailable = $derived(macRelease.available === true && !!macRelease.downloadUrl);
  const cards = $derived<AppCard[]>([
    {
      id: "web", name: t.appsPage.cards.web.name, desc: t.appsPage.cards.web.desc,
      available: true, href: "/", cta: t.appsPage.cards.web.cta, onclick: openWeb,
    },
    {
      id: "cli", name: t.appsPage.cards.cli.name, desc: t.appsPage.cards.cli.desc,
      available: true, href: CLI_PATH, cta: t.appsPage.cards.cli.cta, onclick: openCli,
    },
    {
      id: "mac", name: t.appsPage.cards.mac.name, desc: t.appsPage.cards.mac.desc,
      available: macAvailable, href: macAvailable ? macRelease.downloadUrl! : undefined,
      cta: macAvailable ? t.appsPage.cards.mac.cta : undefined,
    },
    {
      id: "ios", name: t.appsPage.cards.ios.name, desc: t.appsPage.cards.ios.desc,
      available: false,
    },
  ]);
  const availableCards = $derived(cards.filter((card) => card.available));
  const futureCards = $derived(cards.filter((card) => !card.available));
</script>

<section class="apps page-enter">
  <header class="head ui-page-head">
    <h1>{t.appsPage.heading}</h1>
    <p class="tagline">{t.appsPage.subhead}</p>
    {#if osName}
      <p class="detected pitch" id="platform-note">{t.appsPage.yourPlatformNote(osName)}</p>
    {/if}
  </header>

  <div class="groups">
    <section aria-labelledby="available-apps-heading">
      <h2 class="group-title" id="available-apps-heading">{t.appsPage.availableBadge}</h2>
      <div class="grid available-grid">
        {#each availableCards as card (card.id)}
          <article
            id={`app-${card.id}`}
            class="app-card ui-card ui-stack"
            class:is-platform={highlightId === card.id}
            aria-describedby={highlightId === card.id && osName ? "platform-note" : undefined}
          >
            <h3>{card.name}</h3>
            <p class="ui-card-sub card-desc">{card.desc}</p>
            {#if card.id === "cli"}
              <p class="cli-install" id="cli-install-label">{t.appsPage.cliInstallLabel}</p>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (the named
                   horizontal scroll region must be keyboard-scrollable) -->
              <div
                class="cmd"
                role="region"
                dir="ltr"
                tabindex="0"
                aria-labelledby="cli-install-label"
              ><code>{installCmd}</code></div>
            {/if}
            <a class="btn btn-primary cta" href={card.href} onclick={card.onclick}>{card.cta}</a>
          </article>
        {/each}
      </div>
    </section>

    {#if futureCards.length}
      <section aria-labelledby="future-apps-heading">
        <h2 class="group-title" id="future-apps-heading">{t.appsPage.comingSoonBadge}</h2>
        <div class="grid future-grid">
          {#each futureCards as card (card.id)}
            <article
              id={`app-${card.id}`}
              class="app-card future-card ui-card ui-stack"
              class:is-platform={highlightId === card.id}
              aria-describedby={highlightId === card.id && osName ? "platform-note" : undefined}
            >
              <h3>{card.name}</h3>
              <p class="ui-card-sub card-desc">{card.desc}</p>
              <p class="future-status">{t.appsPage.comingSoonBadge}</p>
            </article>
          {/each}
        </div>
      </section>
    {/if}
  </div>

  <p class="android">{t.appsPage.androidNote}</p>
</section>

<style>
  .apps { max-width: 960px; margin: 0 auto; padding-bottom: var(--space-8); }
  .head { margin-block: var(--space-3) var(--space-2); }
  .head .tagline { max-inline-size: 58ch; }

  .groups { display: flex; flex-direction: column; gap: var(--space-6); }
  .group-title {
    margin: 0 0 var(--space-3); font-size: var(--fs-sm); color: var(--text-h);
    font-weight: 600;
  }
  .grid { display: grid; gap: var(--space-4); }
  /* The current two cards stay roomy; when macOS ships, auto-fit gives all
     three available choices an equal row instead of a half-width orphan. */
  .available-grid { grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); }
  .future-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .app-card { min-inline-size: 0; }
  .app-card h3 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  .card-desc { flex: 1 1 auto; font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .future-card { background: var(--surface-2); }
  /* UA detection is identification, never recommendation. Keep it visible and
     associated with the header note, but reserve brand accent for real CTAs. */
  .app-card.is-platform {
    border-color: var(--control-border);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--control-border) 45%, transparent);
  }

  .cli-install { margin: 0; font-size: var(--fs-xs); color: var(--text); }
  .cmd {
    display: block; min-inline-size: 0; max-inline-size: 100%;
    font-family: var(--mono, ui-monospace, monospace); font-size: var(--fs-xs);
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--code-bg);
    overflow-x: auto; white-space: nowrap; text-align: start; unicode-bidi: isolate;
  }
  .cmd code { font: inherit; color: inherit; }
  .cmd:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: var(--focus-offset);
  }
  /* .btn-block is intentionally not used here: its flex-grow contract is for
     horizontal action rows and would stretch the shorter card's button tall. */
  .cta { flex: none; inline-size: 100%; margin-block-start: auto; text-decoration: none; }
  .future-status {
    margin: auto 0 0; font-size: var(--fs-xs); color: var(--text); font-weight: 600;
  }

  .android { text-align: center; color: var(--text); font-size: var(--fs-sm); margin-top: var(--space-6); }

  @media (max-width: 620px) {
    .grid { grid-template-columns: minmax(0, 1fr); }
    .groups { gap: var(--space-5); }
  }
  @media (min-width: 621px) {
    /* A single remaining future product should read as one card, not stretch
       into a page-wide banner after another native app ships. */
    .future-grid:has(> :only-child) {
      grid-template-columns: minmax(0, 472px);
      justify-content: center;
    }
  }
</style>
