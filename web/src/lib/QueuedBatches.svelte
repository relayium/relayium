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
  import PendingFiles from "./PendingFiles.svelte";

  let { batches, onCancel }: {
    batches: readonly QueuedFileBatch[];
    onCancel: (id: number) => void;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);

</script>

<section class="ui-card queued">
  <h2>{t.workspace.queuedTitle(batches.length)}</h2>
  <p class="queued-hint">{t.workspace.queuedHint}</p>
  <ul class="batch-list">
    {#each batches as batch (batch.id)}
      <li class="batch">
        <PendingFiles
          files={batch.files}
          summary={`${t.workspace.queuedFiles(batch.files.length)} · ${formatSize(batch.total)}`}
          compact
        />
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
  .batch-list { list-style: none; margin: 0; padding: 0; }
  .batch {
    padding-block: var(--space-3);
    border-block-end: 1px dashed var(--border);
  }
  .batch:last-child { border-block-end: none; }
  .queued-cancel { margin-block-start: var(--space-2); }
</style>
