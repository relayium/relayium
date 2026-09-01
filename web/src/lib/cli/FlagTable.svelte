<script lang="ts">
  // The flag reference. `flag` and `who` are code; only the meaning is prose,
  // and it is keyed by flag rather than positional — see cli-page-data.ts for
  // why, and for the three scopes this table used to state incorrectly.
  import { FLAG_ROWS } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let { cli }: { cli: Messages["cliPage"] } = $props();
</script>

<p class="lead">{cli.referenceIntro}</p>

<!-- Scrollable and containing nothing focusable, so it has to be a keyboard stop
     for the same reason the comparison table is. See ModeComparison.svelte for
     the full reasoning and the WCAG reference. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="wrap" tabindex="0" role="group" aria-labelledby="cli-flags-caption">
  <table>
    <!-- The section's own heading, not a second sentence: the paragraph above is
         already on screen, and repeating it here would make a screen reader read
         it twice before the first cell. -->
    <caption id="cli-flags-caption">{cli.sections.reference}</caption>
    <thead>
      <tr>
        <th scope="col">{cli.thFlag}</th>
        <th scope="col">{cli.thApplies}</th>
        <th scope="col">{cli.thMeaning}</th>
      </tr>
    </thead>
    <tbody>
      {#each FLAG_ROWS as row (row.key)}
        <tr>
          <th scope="row"><code dir="ltr">{row.flag}</code></th>
          <td><code dir="ltr">{row.who}</code></td>
          <td>{cli.flags[row.key]}</td>
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
    white-space: nowrap;
    font-weight: 400;
  }
  td {
    color: var(--text);
  }
  td:first-of-type {
    min-inline-size: 14ch;
  }
  code {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--text-h);
  }
  tbody td:first-of-type code {
    color: var(--text);
    white-space: nowrap;
  }
  tbody tr:last-child th,
  tbody tr:last-child td {
    border-block-end: none;
  }
</style>
