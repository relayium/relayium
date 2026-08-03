<script lang="ts">
  import { confirmState, resolveConfirm } from "./confirm-dialog.svelte";
  import { trapFocus } from "./focus-trap";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let confirmBtn: HTMLButtonElement | undefined = $state();

  $effect(() => {
    if (confirmState.open) confirmBtn?.focus();
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape" && confirmState.open) resolveConfirm(false); }} />

{#if confirmState.open}
  <button type="button" class="backdrop" aria-label={t.dialogCancel} onclick={() => resolveConfirm(false)}></button>
  <!-- Named by the question it is asking. The message is the only content that
       identifies this dialog, and it is already localized by whoever opened it,
       so aria-labelledby beats inventing a generic "Confirm" string. -->
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-msg" use:trapFocus>
    <p class="msg" id="confirm-modal-msg">{confirmState.message}</p>
    <div class="actions">
      <button type="button" class="btn btn-ghost" onclick={() => resolveConfirm(false)}>{t.dialogCancel}</button>
      <button type="button" class="btn btn-primary" bind:this={confirmBtn} onclick={() => resolveConfirm(true)}>
        {confirmState.confirmLabel || t.dialogConfirm}
      </button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 60; border: 0; padding: 0; cursor: default;
    background: rgba(0, 0, 0, .45); backdrop-filter: blur(1px);
  }
  .modal {
    position: fixed; z-index: 61; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(340px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
    padding: var(--space-5); border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--bg); box-shadow: var(--shadow);
    text-align: start;
  }
  .msg { margin: 0 0 var(--space-4); color: var(--text-h); font-size: var(--fs-xs); }
  .actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
</style>
