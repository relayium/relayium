<script lang="ts">
  // The seven modes against the four things they genuinely differ on.
  //
  // Cells come from a keyed table (t.cliPage.compare[mode][column]), not from a
  // positional array. On a page whose cells are product claims — "does this need
  // an account", "can the far end be offline" — a one-row shift is not a layout
  // bug, it is the page telling a reader that push/pull needs an account.
  import { CLI_MODES, COMPARE_COLUMNS } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let { cli }: { cli: Messages["cliPage"] } = $props();
</script>

<p class="lead">{cli.compareIntro}</p>

<!-- The wrapper scrolls sideways and contains no focusable element of its own,
     so it has to be a tab stop: without one, the right-hand columns of a
     four-column table are readable with a mouse and unreachable without one.
     That is WCAG 2.1.1, and precisely what axe's scrollable-region-focusable
     rule asks for. It is named by the table's <caption>, which is on screen —
     no invented, untranslated string that could drift from the visible one.
     svelte-ignore fires because a <div> is non-interactive; that rule guards
     against fake buttons, and this is the opposite case. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="wrap" tabindex="0" role="group" aria-labelledby="cli-compare-caption">
  <table>
    <caption id="cli-compare-caption">{cli.compareCaption}</caption>
    <thead>
      <tr>
        <th scope="col">{cli.compareModeHeader}</th>
        {#each COMPARE_COLUMNS as col (col)}
          <th scope="col">{cli.compareColumns[col]}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each CLI_MODES as mode (mode.key)}
        <tr>
          <th scope="row"><code dir="ltr">{mode.name}</code></th>
          {#each COMPARE_COLUMNS as col (col)}
            <td>{cli.compare[mode.key][col]}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .lead {
    color: var(--text);
    line-height: 1.65;
    margin: 0 0 var(--space-4);
    max-inline-size: 62ch;
  }

  .wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    /* The table can be wider than the column; the page must never be. */
    max-inline-size: 100%;
  }
  .wrap:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: var(--focus-offset);
  }

  table {
    border-collapse: collapse;
    inline-size: 100%;
    font-size: var(--fs-sm);
  }
  caption {
    /* Visually hidden, not display:none — it is the accessible name of both the
       table and the scroll region, and the visible <h2> already says "Modes at
       a glance" one line above it. */
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  th,
  td {
    text-align: start;
    padding: var(--space-3);
    border-block-end: 1px solid var(--border);
    vertical-align: top;
    line-height: 1.55;
  }
  thead th {
    color: var(--text-h);
    background: var(--surface-2);
    white-space: nowrap;
    font-size: var(--fs-xs);
  }
  tbody th {
    color: var(--text-h);
    white-space: nowrap;
    font-weight: 600;
  }
  tbody th code {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }
  td {
    color: var(--text);
    min-inline-size: 16ch;
  }
  tbody tr:last-child th,
  tbody tr:last-child td {
    border-block-end: none;
  }
</style>
