<!-- web/src/lib/ui/Row.svelte
     One settings row: minimum 40px tall, 8/14px inset, label at the start and
     value or control at the end, hairline underneath (the parent `Group` drops
     it on the last row). Reference `Relayium 设计规范` §4.

     `interactive` is what turns the hover tint on. It is opt-in rather than
     automatic because a hover response is an affordance: a row that lights up
     and answers nothing reads as a control the reader has failed to operate. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  let { label = "", interactive = false, block = false, children }: {
    /** Start-aligned label. Omit for a row whose whole content is a block. */
    label?: string;
    /** This row is, or contains, the thing you press. */
    interactive?: boolean;
    /** The content is a block (a list, a drop target, a panel), not a value. */
    block?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="r" class:interactive class:block>
  {#if label}<span class="r-label">{label}</span>{/if}
  {@render children()}
</div>

<style>
  .r {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: var(--row-min-h);
    padding-block: var(--space-2);
    padding-inline: 14px;
    border-block-end: 1px solid var(--shell-sep, var(--border));
  }
  .r.block { display: block; padding-block: var(--space-3); }
  .r.interactive:hover { background: var(--shell-row-hover, transparent); }
  .r-label { color: var(--text); min-inline-size: 0; }
  /* Everything after the label is the value side. Logical `margin-inline-start`
     rather than `justify-content: space-between`, so a row with two trailing
     elements (a value and its button) keeps them together at the end instead of
     spreading them across the row. */
  .r-label ~ :global(*) { margin-inline-start: auto; }
  .r-label ~ :global(* ~ *) { margin-inline-start: var(--space-2); }
  @media (pointer: coarse) {
    .r { min-block-size: 44px; }
  }
</style>
