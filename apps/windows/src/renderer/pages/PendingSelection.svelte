<!--
  What the operating system handed Relayium, waiting for a person to decide.

  It says plainly that nothing has been sent. An activation that looked like a
  send would be the worst outcome here: somebody right-clicks a file, sees a
  window, and assumes it has gone.

  No path is rendered anywhere, because none is available — the contract carries
  names and relative paths only.
-->
<script lang="ts">
  import { lang } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import { ot } from "../os-entry/messages.js";
  import { formatBytes } from "../account/format.js";
  import type { OsEntryController } from "../os-entry/os-entry-controller.svelte.js";
  import type { SelectionRefusal } from "../../shared/os-entry.js";

  let { controller }: { controller: OsEntryController } = $props();

  const view = $derived(controller.view);
  const locale = $derived(lang());

  /** Every refusal is its own sentence with its own next action. */
  function refusalText(refusal: SelectionRefusal): string {
    switch (refusal) {
      case "too-many":
        return ot("refusedTooMany");
      case "unsupported-kind":
        return ot("refusedUnsupported");
      case "escapes-root":
        return ot("refusedEscapes");
      case "collision":
        return ot("refusedCollision");
      case "unreadable":
        return ot("refusedUnreadable");
      case "unavailable":
        return ot("refusedUnavailable");
      case "no-selection":
        // Empty, not unreadable. This used to reach the default below and tell
        // somebody who right-clicked an empty folder that Relayium could not
        // READ it, which sends them to check permissions for nothing.
        return ot("refusedEmpty");
      default: {
        // An explicit `never`, not merely the absence of a default: with no
        // default this function would return `undefined` for an unhandled
        // member and the paragraph would render blank, which is not an
        // improvement on the wrong sentence. Checked, not assumed.
        const unhandled: never = refusal;
        void unhandled;
        // Reachable only if main sends a refusal this build does not know.
        return ot("refusedUnavailable");
      }
    }
  }
</script>

{#if view.kind === "staged"}
  <Card title={ot("stagedTitle")}>
    {@const roots = view.rootNames.join(", ")}
    <div data-test="pending-selection" data-selection={view.selectionId} data-lang={locale}>
      <p data-test="pending-count">
        {view.entries.length === 1
          ? ot("stagedOne", { roots })
          : ot("stagedMany", { count: view.entries.length, roots })}
      </p>
      <p class="dim small" data-test="pending-size">
        {ot("stagedSize", { size: formatBytes(view.totalBytes, locale) })}
      </p>

      <!-- Relative paths only. There is no absolute path in this contract. -->
      <ul class="entries" data-test="pending-entries">
        {#each view.entries.slice(0, 8) as entry (entry.token)}
          <li>
            <span class="path" data-test="pending-entry">{entry.relativePath}</span>
            <span class="dim small">{formatBytes(entry.size, locale)}</span>
          </li>
        {/each}
        {#if view.entries.length > 8}
          <li class="dim small" data-test="pending-more">+{view.entries.length - 8}</li>
        {/if}
      </ul>

      <!-- A refused activation is SHOWN. One that is only logged is a silent
           replacement wearing a different name. -->
      {#if view.refusedSince > 0}
        <p class="problem small" data-test="pending-refused-held" data-count={view.refusedSince} role="status" aria-live="polite">
          {view.refusedSince === 1
            ? ot("refusedHeldOne")
            : ot("refusedHeldMany", { count: view.refusedSince })}
        </p>
      {/if}

      <!-- The whole point of this pane. -->
      <p class="dim small" data-test="pending-note">{ot("stagedNote")}</p>
      <button data-test="pending-clear" disabled={controller.busy} onclick={() => void controller.clear()}>
        {ot("clear")}
      </button>
    </div>
  </Card>
{:else if view.refusal !== null}
  <Card title={ot("stagedTitle")}>
    <div data-test="pending-refused" data-refusal={view.refusal} data-lang={locale}>
      <p class="problem" data-test="pending-refusal">{refusalText(view.refusal)}</p>
      <!-- All of it, never part. A partial stage would send a folder that is
           not the folder on disk. -->
      <p class="dim small" data-test="pending-nothing">{ot("refusedNothingTaken")}</p>
    </div>
  </Card>
{/if}

<style>
  .dim { color: var(--text-dim); }
  .small { font-size: 13px; }
  .problem { margin: 0 0 var(--space-tight); }
  p { margin: 0 0 var(--space-tight); }
  .entries { list-style: none; margin: var(--space-tight) 0 var(--space-inner); padding: 0; }
  .entries li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-inner);
    padding: 2px 0;
  }
  .path {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  @media (max-width: 680px) {
    .entries li { flex-direction: column; gap: 0; }
  }
</style>
