<!-- web/src/lib/ui/Help.svelte
     "An explanation that does not fit on one line folds into a disclosure and
     starts closed" (`Relayium 设计规范` §5). A real <details>, so it is keyboard
     operable, announces its own expanded state, survives in-page find, and
     keeps its content in the DOM — nothing here may hide a fact from a reader
     who searches for it.

     What must NOT go in here: anything the reader has to know before acting —
     whether an account is needed, who can receive, what is stored and for how
     long, what a quota refuses. Those stay visible next to the control. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  let { summary, heading = false, children }: {
    summary: string;
    /** Render the summary as the section's own <h2>. `<summary>` accepts
     *  heading content, so a folded section keeps its place in the page outline
     *  instead of the caller printing the same words twice — once as a heading
     *  above and once on the control that opens it. */
    heading?: boolean;
    children: Snippet;
  } = $props();
</script>

<details class="h">
  <summary>{#if heading}<h2 class="h-heading">{summary}</h2>{:else}{summary}{/if}</summary>
  <div class="h-body">{@render children()}</div>
</details>

<style>
  .h {
    border: 1px solid var(--shell-card-border, var(--border));
    border-radius: var(--radius-card);
    background: var(--shell-card, var(--surface));
    overflow: clip;
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: var(--row-min-h);
    padding-block: var(--space-2);
    padding-inline: 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-h);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker { display: none; }
  /* The heading inherits the row, so a folded section reads as one control
     rather than as a title with a button stuck to it. */
  .h-heading { font: inherit; margin: 0; letter-spacing: 0; color: inherit; }
  summary::after {
    content: "";
    flex: none;
    margin-inline-start: auto;
    inline-size: 7px;
    block-size: 7px;
    /* Physical borders on purpose: a chevron that points down points down in
       every writing direction; the logical pair turns it sideways under RTL. */
    border-right: 2px solid var(--text);
    border-bottom: 2px solid var(--text);
    transform: rotate(45deg);
    transition: transform .15s ease;
  }
  .h[open] summary::after { transform: rotate(-135deg); }
  summary:hover { background: var(--shell-row-hover, transparent); }
  summary:focus-visible { outline-offset: -2px; }
  .h-body {
    padding: 0 14px var(--space-3);
    border-block-start: 1px solid var(--shell-sep, var(--border));
    padding-block-start: var(--space-3);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text);
    animation: help-open .18s ease-out both;
  }
  .h-body > :global(* + *) { margin-block-start: var(--space-2); }
  @keyframes help-open {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  @media (pointer: coarse) { summary { min-block-size: 44px; } }
  @media (prefers-reduced-motion: reduce) {
    summary::after { transition: none; }
    .h-body { animation: none; }
  }
</style>
