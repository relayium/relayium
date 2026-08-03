<script lang="ts">
  import { navigate, LAN_PATH, CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import Icon from "./Icon.svelte";
  const t = $derived<Messages>(messages[lang()]);
</script>

<section class="compare" aria-label={t.compare.title}>
  <div class="head">
    <h2>{t.compare.title}</h2>
    <p class="sub">{t.compare.sub}</p>
  </div>

  <!-- Wide: real table. Narrow: the same rows reflow into stacked cards via CSS. -->
  <div class="table" role="table">
    <div class="row header" role="row">
      <span class="cell feat" role="columnheader">{t.compare.colFeature}</span>
      <!-- The columnheader role lives on the cell, and the link lives inside it.
           It used to sit on the <a> itself, which ARIA does not allow: a link
           cannot also be a column header, and browsers resolve that conflict
           differently — some drop the header, some drop the link. Nesting keeps
           both truths intact: the grid still has real column headers, and each
           mode column still contains a working link to that mode's page. -->
      <span class="cell lan is-link" role="columnheader">
        <a class="head-link" href={LAN_PATH}
           onclick={(e) => { e.preventDefault(); navigate("lan"); }}><Icon name="network" /> <span>{t.compare.colLan}</span></a>
      </span>
      <span class="cell rt is-link" role="columnheader">
        <a class="head-link" href={CROSS_PATH}
           onclick={(e) => { e.preventDefault(); navigate("cross"); }}><Icon name="bolt" /> <span>{t.compare.colRealtime}</span></a>
      </span>
      <span class="cell st is-link" role="columnheader">
        <a class="head-link" href={OFFLINE_PATH}
           onclick={(e) => { e.preventDefault(); navigate("offline"); }}><Icon name="package" /> <span>{t.compare.colStored}</span></a>
      </span>
    </div>
    {#each t.compare.rows as r (r.label)}
      <div class="row" role="row">
        <span class="cell feat" role="rowheader">{r.label}</span>
        <!-- The mode name is real text rather than a CSS-generated label,
             because the narrow layout hides the header row: generated content is
             not reliably in the accessibility tree, so a phone reader heard three
             unattributed answers per row. Being an element, it is hidden by
             `display: none` at the widths where the real column headers exist,
             and hidden from assistive tech there too. -->
        <span class="cell lan" role="cell"><span class="tag">{t.compare.colLan}</span>{r.lan}</span>
        <span class="cell rt" role="cell"><span class="tag">{t.compare.colRealtime}</span>{r.realtime}</span>
        <span class="cell st" role="cell"><span class="tag">{t.compare.colStored}</span>{r.stored}</span>
      </div>
    {/each}
  </div>
</section>

<style>
  .compare { margin: var(--section-gap) 0 var(--space-2); }
  .head { margin-bottom: var(--space-5); }
  .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; }

  .table {
    border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
    background: var(--surface-2);
  }
  /* Three mode columns share the width evenly so no mode reads as the default,
     and the aspect column stays narrow because its labels are short. */
  .row {
    display: grid; grid-template-columns: 0.9fr 1fr 1fr 1fr;
    border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: none; }
  .cell {
    padding: var(--space-3) var(--space-4); font-size: var(--fs-xs); line-height: 1.5;
    border-inline-start: 1px solid var(--border);
  }
  .cell.feat { border-inline-start: none; color: var(--text-h); font-weight: 500; }
  .cell.lan, .cell.rt, .cell.st { color: var(--text); }
  /* Wide layout: the column headers already say which mode this is. */
  .tag { display: none; }

  .row.header .cell { font-weight: 600; color: var(--text-h); background: var(--code-bg); font-size: var(--fs-sm); }
  .row:not(.header):hover { background: var(--accent-bg); }

  /* Moving columnheader off the <a> and onto the cell must NOT shrink the target
     to the width of the words: the whole header cell was clickable before, and a
     smaller hit area is a WCAG 2.5.8 (target size) regression that no rule in the
     scan would have caught. The cell hands its padding to the link, and the link
     fills the cell — same pixels, correct semantics. */
  .cell.is-link { padding: 0; }
  .head-link {
    display: flex; align-items: center; gap: var(--space-2);
    block-size: 100%; padding: var(--space-3) var(--space-4);
    text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
  }
  .head-link:hover { color: var(--accent-fg); }

  /* A third mode column costs horizontal room the medium widths do not have:
     four columns of prose wrap to a shred each on a small laptop or a tablet.
     Below 900px the table becomes the same stacked cards the phone gets, which
     is why the breakpoint moved up rather than the type size coming down. */
  @media (max-width: 900px) {
    .table { border: none; background: none; }
    .row.header { display: none; }
    .row {
      grid-template-columns: 1fr; gap: 0;
      border: 1px solid var(--border); border-radius: 14px;
      margin-bottom: 12px; overflow: hidden; background: var(--surface-2);
    }
    .cell { border-inline-start: none; border-top: 1px solid var(--border); }
    .cell.feat { border-top: none; background: var(--code-bg); font-size: 14px; }
    /* The mode name is the card's own column header, so it sits on its own line
       above the value rather than as an inline prefix: with three modes the
       "Realtime · …" run-on made each card read as one paragraph. */
    .tag { display: block; color: var(--text-h); font-weight: 500; margin-block-end: 2px; }
  }
</style>
