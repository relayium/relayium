<script lang="ts">
  // The page's contents. One component renders both forms, because they are one
  // list: a desktop sticky rail beside the body, and — under 1024px, where there
  // is no gutter to put a rail in — a horizontally scrollable row of the same
  // anchors pinned under the header.
  //
  // Two components would be two lists to keep in step, and the failure mode is
  // silent: a section reachable on a laptop and unreachable on a phone.
  import { SECTIONS, type SectionKey } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let {
    labels,
    ariaLabel,
    onNavigate,
  }: {
    labels: Messages["cliPage"]["sections"];
    ariaLabel: string;
    /** Scroll to the section AND move focus there; see CliPage's focusSection. */
    onNavigate: (event: MouseEvent, id: string) => void;
  } = $props();

  const key = (k: SectionKey) => labels[k];
</script>

<!-- A <nav> full of links needs no tabindex of its own: every child is already a
     tab stop, so the scrollable row on mobile is reachable by keyboard and
     scrolls to follow focus. That is exactly the condition axe's
     scrollable-region-focusable rule exempts, and adding tabindex="0" here would
     insert a stop that does nothing. -->
<nav class="rail" aria-label={ariaLabel}>
  <ul>
    {#each SECTIONS as s (s.key)}
      <li><a href={`#${s.id}`} onclick={(e) => onNavigate(e, s.id)}>{key(s.key)}</a></li>
    {/each}
  </ul>
</nav>

<style>
  .rail ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rail a {
    display: block;
    color: var(--text);
    text-decoration: none;
    font-size: var(--fs-sm);
    line-height: 1.4;
  }
  .rail a:hover {
    color: var(--accent-fg);
  }
  .rail a:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: var(--focus-offset);
    border-radius: 4px;
  }

  /* ── Mobile: a scrollable anchor row ─────────────────────────────────────
     Sticky under the site header so it stays available while reading. The
     scrollbar is left visible rather than hidden — a row that scrolls with no
     sign that it scrolls is a row whose last three entries do not exist. */
  @media (max-width: 1023px) {
    .rail {
      position: sticky;
      inset-block-start: 0;
      z-index: 2;
      margin-block: var(--space-4) var(--space-6);
      background: var(--bg);
      border-block-end: 1px solid var(--border);
    }
    .rail ul {
      display: flex;
      gap: var(--space-1);
      overflow-x: auto;
      overscroll-behavior-inline: contain;
      /* The row itself scrolls; the page must not. */
      max-inline-size: 100%;
    }
    .rail li {
      flex: 0 0 auto;
    }
    .rail a {
      /* 44px is the touch target, not a decoration: these are the page's
         primary navigation on a phone. */
      min-block-size: 44px;
      display: flex;
      align-items: center;
      padding-inline: var(--space-3);
      white-space: nowrap;
      border-block-end: 2px solid transparent;
    }
    .rail a:hover {
      border-block-end-color: var(--accent-border);
    }
  }

  /* ── Desktop: a quiet sticky rail in the page body ───────────────────────
     A hairline on the inline-start edge and nothing else. It is a wayfinding
     aid, so it must not compete with the prose it sits beside. */
  @media (min-width: 1024px) {
    .rail {
      position: sticky;
      inset-block-start: var(--space-5);
      align-self: start;
    }
    .rail ul {
      border-inline-start: 1px solid var(--border);
    }
    .rail a {
      padding: var(--space-2) var(--space-3);
      margin-inline-start: -1px;
      border-inline-start: 1px solid transparent;
    }
    .rail a:hover {
      border-inline-start-color: var(--accent);
    }
  }
</style>
