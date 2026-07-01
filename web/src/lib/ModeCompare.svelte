<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
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
      <span class="cell rt" role="columnheader">{t.compare.colRealtime}</span>
      <span class="cell st" role="columnheader">{t.compare.colStored}</span>
    </div>
    {#each t.compare.rows as r (r.label)}
      <div class="row" role="row">
        <span class="cell feat" role="rowheader">{r.label}</span>
        <span class="cell rt" role="cell" data-label={t.compare.colRealtime}>{r.realtime}</span>
        <span class="cell st" role="cell" data-label={t.compare.colStored}>{r.stored}</span>
      </div>
    {/each}
  </div>
</section>

<style>
  .compare { margin: 40px 0 8px; }
  .head { margin-bottom: 18px; }
  .head h2 { font-size: 22px; margin: 0 0 6px; }
  .head .sub { color: var(--text); font-size: 14px; max-width: 60ch; }

  .table {
    border: 1px solid var(--border); border-radius: 16px; overflow: hidden;
    background: var(--surface-2);
  }
  .row {
    display: grid; grid-template-columns: 1.1fr 1.5fr 1.5fr;
    border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: none; }
  .cell {
    padding: 13px 16px; font-size: 13.5px; line-height: 1.5;
    border-left: 1px solid var(--border);
  }
  .cell.feat { border-left: none; color: var(--text-h); font-weight: 500; }
  .cell.rt, .cell.st { color: var(--text); }

  .row.header .cell { font-weight: 600; color: var(--text-h); background: var(--code-bg); font-size: 14px; }
  .row:not(.header):hover { background: var(--accent-bg); }

  @media (max-width: 640px) {
    .table { border: none; background: none; }
    .row.header { display: none; }
    .row {
      grid-template-columns: 1fr; gap: 0;
      border: 1px solid var(--border); border-radius: 14px;
      margin-bottom: 12px; overflow: hidden; background: var(--surface-2);
    }
    .cell { border-left: none; border-top: 1px solid var(--border); }
    .cell.feat { border-top: none; background: var(--code-bg); font-size: 14px; }
    .cell.rt::before, .cell.st::before {
      content: attr(data-label) " · "; color: var(--text-h); font-weight: 500;
    }
  }
</style>
