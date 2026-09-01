<script lang="ts">
  // Four questions, as real headings with real paragraphs.
  //
  // Deliberately not an accordion. A disclosure widget here would hide four
  // answers that a reader has come to compare, cost a click each, and put the
  // page's most load-bearing product claims behind an interaction. Headings are
  // already in the document outline, are already navigable by heading in every
  // screen reader, and are already found by in-page search.
  import { FAQ_KEYS } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let { cli }: { cli: Messages["cliPage"] } = $props();
</script>

<div class="faq">
  {#each FAQ_KEYS as key (key)}
    <div class="qa">
      <h3>{cli.faq[key].q}</h3>
      <p>{cli.faq[key].a}</p>
    </div>
  {/each}
</div>

<style>
  .faq {
    display: grid;
    gap: 0;
  }
  .qa {
    padding-block: var(--space-5);
    border-block-start: 1px solid var(--border);
  }
  .qa:last-child {
    border-block-end: 1px solid var(--border);
  }
  h3 {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: 0 0 var(--space-2);
    text-wrap: balance;
  }
  p {
    color: var(--text);
    line-height: 1.7;
    margin: 0;
    max-inline-size: 72ch;
  }
</style>
