<script lang="ts">
  // Explicit queue for a mixed link's file lane.
  //
  // One batch may be active on a link at a time, but picking more files during a
  // transfer must never disable the file control — it queues. That queued state is
  // rendered here rather than being invisible, and every entry keeps a cancel
  // control so a user can undo a selection before it ever reaches the peer.
  //
  // Pure presentation + callbacks: the queue itself lives in mixed-file-session.
  import { formatSize } from "./format";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import type { QueuedFileBatch } from "./mixed-file-session.svelte";

  let { batches, onCancel }: {
    batches: readonly QueuedFileBatch[];
    onCancel: (id: number) => void;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);

  // Same shape as the history label: the first name, plus a count for the rest.
  const label = (batch: QueuedFileBatch) =>
    batch.files.length === 1
      ? batch.files[0].name
      : `${batch.files[0]?.name ?? "?"} +${batch.files.length - 1}`;
</script>

<section class="ui-card queued">
  <h2>{t.workspace.queuedTitle(batches.length)}</h2>
  <p class="queued-hint">{t.workspace.queuedHint}</p>
  <ul class="filelist">
    {#each batches as batch (batch.id)}
      <li>
        <span class="fname">{label(batch)}</span>
        <span class="fsize">{t.workspace.queuedFiles(batch.files.length)} · {formatSize(batch.total)}</span>
        <button
          type="button"
          class="btn btn-sm queued-cancel"
          onclick={() => onCancel(batch.id)}
        >{t.workspace.queuedRemove}</button>
      </li>
    {/each}
  </ul>
</section>

<style>
  .queued { margin-block-end: var(--space-4); }
  .queued h2 { margin-block-end: var(--space-2); }
  .queued-hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text); line-height: 1.5; }
  /* .filelist itself is App-local, so the few rules this list needs are repeated
     here rather than reaching across a component boundary. */
  .filelist { list-style: none; margin: 0; padding: 0; max-block-size: 200px; overflow: auto; }
  .filelist li {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2);
    padding-block: var(--space-2);
    border-block-end: 1px dashed var(--border);
    font-size: var(--fs-sm);
  }
  .filelist li:last-child { border-block-end: none; }
  .fname { color: var(--text-h); overflow-wrap: anywhere; min-inline-size: 0; flex: 1 1 auto; }
  .fsize { color: var(--text); white-space: nowrap; font-size: var(--fs-xs); }
  .queued-cancel { margin-inline-start: auto; }
</style>
