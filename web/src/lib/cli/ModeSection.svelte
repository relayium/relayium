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
  //
  // The row ends with exactly one guide link, and the row renders it rather than
  // the page: MODE_GUIDE pairs every mode with its walkthrough, so a row cannot
  // end at its last command block with no way forward. Its text is the guide's
  // own localized title (`cli.guides[key]`) — the same string the guide list
  // below uses — so a second translation of the same title never has to exist,
  // and the seven links have seven distinct accessible names. Its arrow is
  // decorative (aria-hidden) and mirrors under a right-to-left `lang`.
  import type { Snippet } from "svelte";
  import { dir, type Messages } from "../i18n.svelte";
  import { GUIDE_SLUG, MODE_GUIDE, guidePath, type ModeKey } from "../cli-page-data";

  let {
    cli,
    lang,
    mode,
    featured = false,
    children,
  }: {
    cli: Messages["cliPage"];
    /** Current language code — the guide href is localized, /zh/guides/… */
    lang: string;
    mode: { key: ModeKey; id: string; name: string };
    /** Device Inbox only: it is the one mode whose sending half is elsewhere,
     *  and the one with a call to action into the app. */
    featured?: boolean;
    children?: Snippet;
  } = $props();

  const copy = $derived(cli.modes[mode.key]);
  const guide = $derived(MODE_GUIDE[mode.key]);
  // A plain <a href>, with no click handler: the guides are static article pages
  // rather than SPA routes, so the browser's own navigation is the correct one —
  // and it is what makes middle-click, "open in new tab" and Enter work without
  // this component reimplementing any of them. The trailing slash comes from
  // guidePath: these pages are directories, and a link without it costs a
  // redirect.
  const guideHref = $derived(guidePath(GUIDE_SLUG[guide], lang));

  // The arrow points at the link's destination, which in a right-to-left script
  // is to the reader's left. `dir()` answers for any tag, not only the two
  // maintained ones — this component takes `lang: string`, the static /cli
  // shells and the archived Arabic pages still render dir="rtl", and a locale
  // coming back is a product decision rather than a rewrite of this row. So the
  // flip is derived here rather than assumed away, the same way Nav does it.
  const flip = $derived(dir(lang) === "rtl");
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
  <p class="guide">
    <a href={guideHref} data-mode-guide={guide}>
      <span>{cli.guides[guide]}</span>
      <span class="arrow" class:flip aria-hidden="true">→</span>
    </a>
  </p>
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

  /* The way out of the row, in the same place in all seven of them. Sized like
     the guide list's rows (44px, so it is not a mis-tap target at the end of a
     long scroll) and marked with the same arrow, because it goes to the same
     place. */
  .guide {
    margin: var(--space-4) 0 0;
  }
  .guide a {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 44px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--accent-fg);
    text-decoration: none;
  }
  .guide a:hover span:first-child {
    text-decoration: underline;
  }
  .guide a:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: var(--focus-offset);
  }
  .guide .arrow {
    flex: 0 0 auto;
  }
  /* Mirrored rather than swapped for "←": one glyph keeps the two directions
     visually identical in weight and width, and a font that renders U+2192 but
     not U+2190 cannot produce a row with no arrow at all. */
  .guide .arrow.flip {
    transform: scaleX(-1);
  }
</style>
