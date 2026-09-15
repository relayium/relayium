<!-- web/src/lib/ui/Group.svelte
     The reference's core unit (`Relayium 设计规范` §1 and §4): an 11px/600 group
     label in the gutter, an 11px-radius / 1px card under it whose rows are told
     apart by hairlines rather than gaps, and at most one 11px footnote beneath.

     It is a COMPONENT rather than a `.ui-group` class because the alternative
     was a second global layer of `.row`/`.card`/`.list` rules reaching into four
     pages' existing markup — which is what the first pass did and what the
     review asked to stop doing. Here the structure and its styles travel
     together, and the only thing that crosses the scope boundary is the single
     `:global(:last-child)` rule that drops the last row's separator.

     `title` names a CONCEPT — never the page. The page already has an <h1> and
     the toolbar already echoes the destination; a group label repeating either
     is the duplicate-title defect this component exists to make hard to write.
     It is deliberately not a heading element: these label one card each inside a
     page that already has its single title, and promoting them to <h2> would
     invent an outline level per card. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  let { title = "", note = "", foot = "", flush = false, icon, children }: {
    /** 11px/600 concept label above the card. Omit for an untitled group. */
    title?: string;
    /** Right-aligned qualifier on the label row — the reference's "Names come
     *  from the device, not proof of identity". Used for facts that must stay
     *  visible next to the group they qualify (recipient/account/limit). */
    note?: string;
    /** The one standing 11px footnote under the card. */
    foot?: string;
    /** Drop the card's own padding: the content brings its own rows. */
    flush?: boolean;
    /** Optional mark before the label. A glyph belongs in CODE rather than in
     *  nine translations — see content-icons.test.ts — so callers pass an
     *  <Icon>, never a character inside `title`. */
    icon?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section class="g">
  {#if title}
    <p class="g-title">
      {#if icon}<span class="g-icon" aria-hidden="true">{@render icon()}</span>{/if}
      <span>{title}</span>
      {#if note}<span class="g-note">{note}</span>{/if}
    </p>
  {/if}
  <div class="g-card" class:flush>
    {@render children()}
  </div>
  {#if foot}<p class="g-foot">{foot}</p>{/if}
</section>

<style>
  .g { display: block; }
  .g + :global(.g) { margin-block-start: var(--space-4); }
  .g-title {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0 0 6px;
    padding-inline: 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text);
  }
  /* The one place the decorative accent is allowed on this element: an <svg>
     carries no text, so it answers to the 3:1 non-text threshold. */
  .g-icon { display: inline-flex; align-self: center; flex: none; color: var(--accent); }
  /* The qualifier is a fact, not a label: no tracking, no uppercase, and it
     keeps the dim tier so it reads as an aside to the group rather than as a
     second title. */
  .g-note {
    margin-inline-start: auto;
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    text-align: end;
  }
  .g-card {
    border: 1px solid var(--shell-card-border, var(--border));
    border-radius: var(--radius-card);
    background: var(--shell-card, var(--surface));
    /* `clip`, not `hidden`: a row's hover must not paint outside the rim, and a
       clipped box still establishes no scroll container of its own. */
    overflow: clip;
  }
  .g-card:not(.flush) { padding: var(--space-3) 14px; }
  /* The one rule that reaches across the scope boundary, and the reason it has
     to: rows are separate components, so the card is the only place that knows
     which of them is last. Without it the card draws a hairline against its own
     bottom rim. */
  .g-card > :global(:last-child) { border-block-end: 0; }
  .g-foot {
    margin: 6px 0 0;
    padding-inline: 2px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text);
  }
</style>
