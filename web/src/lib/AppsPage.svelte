<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, CLI_PATH } from "./router.svelte";
  import { detectPlatform, type Platform } from "./platform";
  import releases from "../../native-releases.json";

  const t = $derived<Messages>(messages[lang()]);
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";

  // Which OS the visitor is on (browser-only; SSR/tests never run this effect).
  const platform: Platform =
    typeof navigator !== "undefined" ? detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0) : "unknown";
  // Map the OS to the card it should highlight. windows/linux → CLI; android/unknown → web.
  const highlightId = $derived(
    platform === "mac" ? "mac"
    : platform === "ios" ? "ios"
    : platform === "windows" || platform === "linux" ? "cli"
    : "web",
  );
  // Human OS name for the "looks like you're on X" caption; empty when unknown/android.
  const osName =
    platform === "mac" ? "macOS"
    : platform === "ios" ? "iOS"
    : platform === "windows" ? "Windows"
    : platform === "linux" ? "Linux"
    : "";

  function openWeb(e: MouseEvent) { e.preventDefault(); navigate("lan"); }
  function openCli(e: MouseEvent) { e.preventDefault(); navigate("cli"); }
</script>

<section class="apps page-enter">
  <header class="head">
    <h1>{t.appsPage.heading}</h1>
    <p class="sub">{t.appsPage.subhead}</p>
    {#if osName}
      <p class="detected">{t.appsPage.yourPlatformNote(osName)}</p>
    {/if}
  </header>

  <div class="grid">
    <!-- Web -->
    <article class="card" class:me={highlightId === "web"}>
      <div class="badge on">{t.appsPage.availableBadge}</div>
      <h2>{t.appsPage.cards.web.name}</h2>
      <p>{t.appsPage.cards.web.desc}</p>
      <a class="cta" href="/" onclick={openWeb}>{t.appsPage.cards.web.cta}</a>
    </article>

    <!-- CLI -->
    <article class="card" class:me={highlightId === "cli"}>
      <div class="badge on">{t.appsPage.availableBadge}</div>
      <h2>{t.appsPage.cards.cli.name}</h2>
      <p>{t.appsPage.cards.cli.desc}</p>
      <p class="cli-install">{t.appsPage.cliInstallLabel}</p>
      <code class="cmd">{installCmd}</code>
      <a class="cta" href={CLI_PATH} onclick={openCli}>{t.appsPage.cards.cli.cta}</a>
    </article>

    <!-- macOS: the release manifest flips this atomically with the appcast. -->
    <article class="card" class:soon={!releases.macos.available} class:me={highlightId === "mac"}>
      <div class="badge" class:on={releases.macos.available}>
        {releases.macos.available ? t.appsPage.availableBadge : t.appsPage.comingSoonBadge}
      </div>
      <h2>{t.appsPage.cards.mac.name}</h2>
      <p>{t.appsPage.cards.mac.desc}</p>
      {#if releases.macos.available && releases.macos.downloadUrl}
        <a class="cta" href={releases.macos.downloadUrl}>{t.appsPage.cards.mac.cta}</a>
      {:else}
        <button class="cta" type="button" disabled>{t.appsPage.comingSoonBadge}</button>
      {/if}
    </article>

    <!-- iOS (coming soon) -->
    <article class="card soon" class:me={highlightId === "ios"}>
      <div class="badge">{t.appsPage.comingSoonBadge}</div>
      <h2>{t.appsPage.cards.ios.name}</h2>
      <p>{t.appsPage.cards.ios.desc}</p>
      <button class="cta" type="button" disabled>{t.appsPage.comingSoonBadge}</button>
    </article>
  </div>

  <p class="android">{t.appsPage.androidNote}</p>
</section>

<style>
  .apps { max-width: 960px; margin: 0 auto; padding-bottom: var(--space-8); }
  .head { text-align: center; margin: var(--space-6) 0 var(--space-6); }
  .head h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); letter-spacing: -0.4px; color: var(--text-h); }
  .head .sub { color: var(--text); max-width: 52ch; margin: var(--space-3) auto 0; }
  .head .detected { color: var(--accent); font-size: var(--fs-sm); margin-top: var(--space-2); }

  .grid { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .card {
    display: flex; flex-direction: column; gap: var(--space-2);
    padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--social-bg);
  }
  .card h2 { font-size: var(--fs-h3); color: var(--text-h); }
  .card p { color: var(--text); font-size: var(--fs-sm); }
  .card .cta { margin-top: auto; }
  .card.soon { opacity: 0.82; }
  /* The visitor's own platform, softly highlighted. */
  .card.me { border-color: var(--accent-border); box-shadow: 0 0 0 1px var(--accent-border); }

  .badge {
    align-self: flex-start; font-size: var(--fs-xs); padding: 2px 10px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text); background: var(--bg);
  }
  .badge.on { color: #fff; background: var(--grad-accent); border-color: transparent; }

  .cli-install { margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text); }
  .cmd {
    display: block; font-family: var(--mono, ui-monospace, monospace); font-size: var(--fs-xs);
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--bg); overflow-x: auto; white-space: nowrap;
  }

  a.cta, button.cta {
    display: inline-flex; align-items: center; justify-content: center;
    font: inherit; font-size: var(--fs-sm); padding: var(--space-2) var(--space-4);
    border-radius: 999px; text-decoration: none; cursor: pointer;
    color: #fff; background: var(--grad-accent); border: 1px solid transparent;
  }
  a.cta:hover { filter: brightness(1.05); }
  button.cta:disabled { cursor: default; color: var(--text); background: var(--bg); border-color: var(--border); }

  .android { text-align: center; color: var(--text); font-size: var(--fs-sm); margin-top: var(--space-6); }
</style>
