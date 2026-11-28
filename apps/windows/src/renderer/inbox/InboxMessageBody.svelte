<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import { collapsedMessagePreview } from "./conversation.js";

  let { text, testID }: { text: string; testID: string } = $props();
  const contentID = $props.id();
  const preview = $derived(collapsedMessagePreview(text));
  let expanded = $state(false);
</script>

<p class="body" id={contentID} data-test={testID}>{expanded ? text : (preview ?? text)}</p>
{#if preview !== null}
  <button type="button" data-test="inbox-message-disclosure" aria-controls={contentID}
    aria-expanded={expanded} onclick={() => expanded = !expanded}>
    {t(expanded ? "inboxMessageCollapse" : "inboxMessageExpand")}
  </button>
{/if}

<style>
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 24rem;
    overflow-y: auto;
  }
</style>
