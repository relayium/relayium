<!--
  The five rows, grouped the way the Mac groups them.

  Keyboard behaviour is the part worth writing down: this is a `listbox`, so
  arrow keys move between rows and Tab moves past the whole list rather than
  through five stops. A sidebar that costs five Tab presses to step over is the
  ordinary way a desktop app becomes unusable without a mouse.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Icon from "./Icon.svelte";
  import { PAGES, goTo, type Page } from "./navigation.svelte.js";

  let { current }: { current: Page } = $props();

  const LABELS: Record<Page, "navLan" | "navPair" | "navStored" | "navInbox" | "navAccount"> = {
    lan: "navLan",
    pair: "navPair",
    stored: "navStored",
    inbox: "navInbox",
    account: "navAccount",
  };

  const ICONS: Record<Page, "lan" | "pair" | "link" | "inbox" | "account"> = {
    lan: "lan",
    pair: "pair",
    stored: "link",
    inbox: "inbox",
    account: "account",
  };

  /** One id per row, so the listbox can name which option is focused. */
  const optionId = (p: Page) => `nav-option-${p}`;

  function onKey(event: KeyboardEvent) {
    // Home and End are part of the listbox pattern, not extras: with five rows
    // a user who is at the bottom should not have to arrow back up through all
    // of them.
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      goTo(PAGES[event.key === "Home" ? 0 : PAGES.length - 1]!);
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = PAGES[(PAGES.indexOf(current) + delta + PAGES.length) % PAGES.length]!;
    goTo(next);
  }
</script>

<nav class="sidebar" aria-label={t("appName")}>
  <!-- The product's own mark, so the sidebar has a top rather than starting
       abruptly with a group heading. -->
  <p class="brand"><Icon name="brand" size={20} /><span>{t("appName")}</span></p>
  <p class="group" id="group-realtime">{t("navRealtime")}</p>
  <!-- The listbox itself holds focus, so it must SAY which option that focus is
       on: without `aria-activedescendant` a screen reader announces the list
       once and then nothing as the arrows move the selection. -->
  <ul
    role="listbox"
    aria-labelledby="group-realtime"
    aria-activedescendant={optionId(current)}
    tabindex="0"
    onkeydown={onKey}
  >
    {#each PAGES as p (p)}
      {#if p === "stored"}
        <li class="spacer" role="presentation"></li>
      {/if}
      <li
        id={optionId(p)}
        role="option"
        aria-selected={current === p}
        data-test={`nav-${p}`}
        class:selected={current === p}
      >
        <button type="button" onclick={() => goTo(p)} tabindex="-1">
          <Icon name={ICONS[p]} />
          <span>{t(LABELS[p])}</span>
        </button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .sidebar {
    width: 230px;
    flex: 0 0 230px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: var(--space-section) var(--space-tight);
    overflow-y: auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-tight);
    margin: 0 0 var(--space-section) var(--space-inner);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .brand :global(svg) { color: var(--accent); }
  .group {
    margin: 0 0 var(--space-hairline) var(--space-inner);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  ul { list-style: none; margin: 0; padding: 0; }
  ul:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--corner); }
  .spacer { height: var(--space-section); }
  li button {
    display: flex;
    align-items: center;
    gap: var(--space-tight);
    width: 100%;
    min-height: 34px;
    padding: 6px var(--space-inner);
    border: 0;
    border-radius: var(--corner);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  li button {
    transition:
      background-color var(--motion-base) var(--ease),
      transform var(--motion-fast) var(--ease);
  }
  li button:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  /* Press feedback: the control acknowledges the click before the page does. */
  li button:active { transform: scale(0.985); }
  li button :global(svg) { color: var(--text-dim); }
  .selected button { background: color-mix(in srgb, var(--accent) 16%, transparent); font-weight: 600; }
  .selected button :global(svg) { color: var(--accent); }
</style>
