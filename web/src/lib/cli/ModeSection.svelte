<script lang="ts">
  // One anchored mode row. Seven of these, and they are rows rather than cards:
  // a hairline above, the code-native name and its qualifier on one line, a lead
  // sentence, the boundaries as a list, then whatever command blocks belong to
  // it. The command block is the only bordered surface in the row, so the eye
  // goes to the thing you can copy.
  //
  // `data-cli-mode` is the mode's own name, and the tests read it: it is how the
  // page proves it presents seven modes, in the accepted order, with none
  // silently dropped when the layout changes.
  import type { Snippet } from "svelte";
  import type { Messages } from "../i18n.svelte";
  import type { ModeKey } from "../cli-page-data";

  let {
    cli,
    mode,
    featured = false,
    children,
  }: {
    cli: Messages["cliPage"];
    mode: { key: ModeKey; id: string; name: string };
    /** Device Inbox only: it is the one mode whose sending half is elsewhere,
     *  and the one with a call to action into the app. */
    featured?: boolean;
    children?: Snippet;
  } = $props();

  const copy = $derived(cli.modes[mode.key]);
</script>

<section
  class="mode"
  class:featured
  id={mode.id}
  data-cli-mode={mode.name}
  aria-labelledby={`mode-h-${mode.key}`}
>
  <div class="head">
    <h3 id={`mode-h-${mode.key}`}><code dir="ltr">{mode.name}</code></h3>
    <p class="tag">{copy.tag}</p>
  </div>
  <p class="lead">{copy.lead}</p>
  <ul class="notes">
    {#each copy.notes as note (note)}
      <li>{note}</li>
    {/each}
  </ul>
  {@render children?.()}
</section>

<style>
  .mode {
    padding-block-start: var(--space-6);
    margin-block-start: var(--space-6);
    border-block-start: 1px solid var(--border);
  }
  /* Device Inbox keeps a mark, because it is the answer to "get this file onto
     my server" and the only mode whose sender is not the CLI. A rule on the
     inline-start edge rather than a tinted fill: the row holds four command
     blocks, and a background wash behind them fights the code styling in both
     themes. */
  .mode.featured {
    border-inline-start: 3px solid var(--accent);
    padding-inline-start: var(--space-5);
  }

  .head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    margin-block-end: var(--space-3);
  }
  h3 {
    margin: 0;
    font-size: var(--fs-h3);
  }
  h3 code {
    font-family: var(--mono);
    font-size: inherit;
    color: var(--text-h);
  }
  .tag {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text);
  }

  .lead {
    color: var(--text-h);
    line-height: 1.65;
    margin: 0 0 var(--space-4);
    max-inline-size: 68ch;
  }

  .notes {
    margin: 0 0 var(--space-4);
    padding-inline-start: 1.15em;
    max-inline-size: 72ch;
  }
  .notes li {
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.7;
    margin-block-end: var(--space-2);
  }
  .notes li::marker {
    color: var(--border);
  }

  .mode :global(.term + .term) {
    margin-block-start: var(--space-3);
  }
  .mode :global(a) {
    color: var(--accent-fg);
  }
</style>
