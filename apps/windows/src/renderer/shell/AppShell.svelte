<!--
  Sidebar plus content, under the REAL Windows titlebar.

  There is no custom frame and no painted traffic lights. Drawing macOS chrome
  onto Windows breaks snap layouts, high-contrast themes and every assistive tool
  that reads a real caption bar — and it is the "website in a window" failure the
  launch definition names by name. The Mac's LAYOUT is what parity means here;
  its window chrome is not.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Sidebar from "./Sidebar.svelte";
  import type { Page } from "./navigation.svelte.js";

  let {
    current,
    banner = null,
    children,
  }: { current: Page; banner?: string | null; children: Snippet } = $props();

  /**
   * The scrolling element. This component owns it, so it resets it.
   *
   * ## Why a page change has to move the scroll
   *
   * `main` is the only thing that scrolls, and it is NOT replaced when the
   * page changes — the content inside it is. So a scroll position belongs to
   * the shell rather than to the page that produced it, and switching rows
   * inherits it: leaving a tall page half-read and choosing another one put the
   * new page's heading 637px above the top of the viewport, with the user
   * looking at whatever happened to be at 661.
   *
   * Only on an actual CHANGE. Scrolling within a page is the user's, and
   * resetting on every render would fight them as the page updated underneath.
   */
  let scroller = $state<HTMLElement | null>(null);
  let shown = $state<Page | null>(null);
  $effect(() => {
    const next = current;
    if (next === shown) return;
    shown = next;
    const element = scroller;
    if (element === null) return;
    element.scrollTop = 0;
    // ## And the keyboard goes with the eyes
    //
    // A sighted user gets the new page at the top; without this, tab focus
    // stays wherever the previous page left it — often on a control that is no
    // longer rendered, which drops focus to the document — and a screen reader
    // is never told the content region changed. `preventScroll` because the
    // line above has already decided where this is looking.
    element.focus({ preventScroll: true });
  });
</script>

<div class="frame">
  <!-- Permanent and non-dismissible, above everything, exactly as macOS does. -->
  {#if banner}
    <p class="banner" data-test="engineering-banner">{banner}</p>
  {/if}
  <div class="shell">
    <Sidebar {current} />
    <!--
      `tabindex="-1"` makes this focusable by SCRIPT only — it is not added to
      the tab order, so nobody tabs into a container. It exists so navigation
      can put focus at the start of the new page, which is the same reason a
      skip-link target carries one.
    -->
    <main bind:this={scroller} tabindex="-1" data-test="page-scroller">
      <div class="measure">{@render children()}</div>
    </main>
  </div>
</div>

<style>
  .frame { display: flex; flex-direction: column; height: 100vh; }
  .banner {
    margin: 0;
    padding: 6px var(--space-section);
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-align: center;
  }
  .shell { display: flex; flex: 1; min-height: 0; }
  main { flex: 1; overflow-y: auto; padding: var(--space-page); }
  /* Focused by navigation, never by tabbing. A ring around the whole content
     region on every page change is noise; the page's own controls keep theirs. */
  main:focus { outline: none; }
  main:focus-visible { outline: none; }
  .measure { max-width: var(--reading-measure); }
</style>
