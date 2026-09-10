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
</script>

<div class="frame">
  <!-- Permanent and non-dismissible, above everything, exactly as macOS does. -->
  {#if banner}
    <p class="banner" data-test="engineering-banner">{banner}</p>
  {/if}
  <div class="shell">
    <Sidebar {current} />
    <main>
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
  .measure { max-width: var(--reading-measure); }
</style>
