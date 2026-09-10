<!--
  A content card. The Mac's 10pt corner and 16pt section rhythm.

  `title` is optional and most callers now omit it: a card whose heading repeats
  the page heading immediately above it is a large empty box with the same words
  twice, which is what the first pass looked like on a real desktop.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, children }: { title?: string; children: Snippet } = $props();
</script>

<section class="card">
  {#if title}<h2>{title}</h2>{/if}
  {@render children()}
</section>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--corner);
    padding: var(--space-section);
    margin-bottom: var(--space-section);
    /* Arrives, rather than appearing. One short rise, never on a re-render:
       the card is keyed by content, not remounted per roster tick. */
    animation: rise var(--motion-enter) var(--ease) both;
  }
  h2 { margin: 0 0 var(--space-inner); font-size: 15px; font-weight: 600; }
</style>
