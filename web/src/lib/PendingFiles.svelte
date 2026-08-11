<script lang="ts">
  import { formatSize } from "./format";
  import { safeDisplayName } from "./filename";

  interface FileIdentity {
    readonly name: string;
    readonly size: number;
  }

  type FileItem = FileIdentity | { readonly file: FileIdentity };

  let { files, summary, compact = false, onRemove, removeLabel = "" }: {
    files: readonly FileItem[];
    summary: string;
    compact?: boolean;
    /** Optional per-row removal. Only the staging surfaces pass it: everywhere
     *  else this list reports a batch that is already committed or in flight,
     *  where a remove control would offer to cancel something it cannot. */
    onRemove?: (index: number) => void;
    /** Verb for the remove control. Required in practice whenever onRemove is
     *  passed — the accessible name is this plus the file it acts on, because
     *  a column of identical "Remove" buttons names nothing. */
    removeLabel?: string;
  } = $props();

  const identity = (item: FileItem): FileIdentity =>
    "file" in item ? item.file : item;
  const displayName = (item: FileItem): string =>
    safeDisplayName(identity(item).name) || "download";
</script>

<div class="pending-files" class:compact role="group" aria-label={summary}>
  <p class="summary">{summary}</p>
  <!-- A bounded list needs to be keyboard-focusable: otherwise keyboard users
       can see the first rows but cannot scroll a large batch. The visible,
       localized summary is also its accessible name. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (the bounded overflow region must be keyboard-scrollable) -->
  <div class="file-scroll" tabindex="0" role="region" aria-label={summary}>
    <ul class="file-list">
      {#each files as item, index (`${identity(item).name}:${identity(item).size}:${index}`)}
        <li>
          <!-- bdi contains a legitimate RTL name without letting it reorder the
               adjacent size. Trojan-source controls are removed separately. -->
          <bdi class="file-name" dir="auto">{displayName(item)}</bdi>
          <!-- No whitespace between the size and the {#if}: a newline there is a
               text node, and it lands in this row's textContent for EVERY caller
               including the ones that pass no onRemove. Named with the sanitized
               display name, not the raw one — this string reaches a screen
               reader, and safeDisplayName is what strips the bidi/control
               characters that would otherwise reorder the label around it. -->
          <span class="file-size" dir="ltr">{formatSize(identity(item).size)}</span>{#if onRemove}<button
              class="btn btn-sm file-remove"
              aria-label={`${removeLabel} ${displayName(item)}`}
              onclick={() => onRemove?.(index)}
            >{removeLabel}</button>{/if}
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .pending-files {
    margin-block: 0 var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .pending-files.compact {
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .summary {
    margin: 0 0 var(--space-2);
    color: var(--text-h);
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .file-scroll {
    max-block-size: 200px;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .file-scroll:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  .file-list { list-style: none; margin: 0; padding: 0; }
  .file-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    padding-block: var(--space-2);
    border-block-end: 1px dashed var(--border);
    font-size: var(--fs-sm);
  }
  .file-list li:last-child { border-block-end: 0; }
  .file-name {
    min-inline-size: 0;
    flex: 1 1 14rem;
    color: var(--text-h);
    overflow-wrap: anywhere;
    unicode-bidi: isolate;
  }
  .file-size {
    flex: 0 0 auto;
    margin-inline-start: auto;
    color: var(--text);
    font-size: var(--fs-xs);
    white-space: nowrap;
    unicode-bidi: isolate;
  }
  /* Never margin-inline-start:auto — the size already claims that, and two
     auto-margins in one flex row split the free space instead of pinning both
     to the end. */
  .file-remove { flex: 0 0 auto; }
</style>
