<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../i18n/index.svelte.js";
  import type { InboxController } from "./inbox-controller.svelte.js";
  import type { InboxSendController } from "./inbox-send-controller.svelte.js";
  import { conversationRows, deleteConversationSnapshot, snapshotConversation, type ConversationRow, type ConversationSnapshot } from "./conversation.js";
  import { PHASE_KEY } from "./phase-copy.js";
  import { deliveryStateKey } from "./delivery-copy.js";
  import InboxMessageBody from "./InboxMessageBody.svelte";
  let { inbox, send }: { inbox: InboxController; send: InboxSendController } = $props();
  const rows = $derived(conversationRows(inbox.messages, Object.values(inbox.named), send.history).filter((row) => row.peer === send.conversationPeer));
  let deleting = $state<ConversationSnapshot | null>(null);
  let canceling = $state<{ id: string; epoch: number } | null>(null);
  let working = $state(false);
  let failed = $state(false);
  let copied = $state<{ id: string; ok: boolean } | null>(null);
  let dialog: HTMLDialogElement;
  let visible = $state(false);
  const marking = new Set<string>();
  onMount(() => {
    const update = () => visible = !document.hidden;
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  });
  $effect(() => {
    if (!visible) return;
    const epoch = inbox.view.epoch;
    const ids = rows.filter((row) => row.unread).flatMap((row) => row.kind === "message" ? [row.message.taskID] : row.kind === "files" ? [row.delivery.taskID] : []).filter((id) => !marking.has(`${epoch}:${id}`));
    if (!ids.length) return;
    for (const id of ids) marking.add(`${epoch}:${id}`);
    void inbox.markRead(ids).finally(() => { for (const id of ids) marking.delete(`${epoch}:${id}`); });
  });
  $effect(() => { if (deleting && deleting.epoch !== inbox.view.epoch) deleting = null; });
  $effect(() => { if (canceling && canceling.epoch !== inbox.view.epoch) canceling = null; });
  $effect(() => { if (deleting || canceling) dialog?.showModal(); else dialog?.close(); });
  function ask(entries: readonly ConversationRow[]) { deleting = snapshotConversation(inbox.view.epoch, entries); failed = false; }
  async function remove() {
    if (!deleting || working) return;
    const snapshot = deleting; deleting = null; working = true;
    try {
      const ok = await deleteConversationSnapshot(snapshot, {
        epoch: () => inbox.view.epoch, sent: (ids) => send.forgetSent(ids),
        message: (id) => inbox.remove(id), delivery: (id) => inbox.forget(id),
      });
      if (inbox.view.epoch === snapshot.epoch) failed = !ok;
    } finally { working = false; }
  }
  async function copy(row: ConversationRow) {
    const epoch = inbox.view.epoch;
    const ok = row.kind === "message" ? await inbox.copy(row.message.id) : row.kind === "sent" ? await send.copySent(row.sent.id) : false;
    if (epoch === inbox.view.epoch) copied = { id: row.id, ok };
  }
  function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
  async function cancelDelivery() {
    const snapshot = canceling; canceling = null;
    if (snapshot && snapshot.epoch === inbox.view.epoch) await send.cancelDelivery(snapshot.id);
  }
</script>

<section data-test="inbox-conversation-history" aria-label={t("conversationHistory")}>
  <div class="heading"><h3>{t("conversationHistory")}</h3>
    <button type="button" disabled={working || rows.length === 0} data-test="conversation-delete-all" onclick={() => ask(rows)}>{t("conversationDeleteAll")}</button>
  </div>
  <p class="dim small">{t("conversationLocalOnly")}</p>
  {#if failed || send.historyUnavailable || inbox.namesUnavailable}<p class="problem" role="status">{t("conversationUnavailable")}</p>{/if}
  {#if send.cancelNotice}<p role="status">{t(send.cancelNotice === "cancelled" ? "inboxSendCancelled" : send.cancelNotice === "already-finished" ? "inboxCancelDeliveryFinished" : send.cancelNotice === "in-progress" ? "inboxCancelDeliveryInProgress" : "inboxCancelDeliveryUnknown")}</p>{/if}
  {#if rows.length === 0}<p class="dim" data-test="conversation-empty">{t("conversationEmpty")}</p>{/if}
  <ol class="timeline">
    {#each rows as row (row.id)}
      <li class:outgoing={row.kind === "sent"} data-test="conversation-row" data-direction={row.kind === "sent" ? "sent" : "received"}>
        <div class="heading"><strong>{t(row.kind === "sent" ? "conversationSent" : "conversationReceived")}{#if row.unread}<span aria-label={t("conversationUnread", { count: 1 })}> ·</span>{/if}</strong><time>{new Date(row.at * 1000).toLocaleString()}</time></div>
        {#if row.kind === "sent"}
          <p class="dim small">{row.sent.state === "preparing" ? t("conversationPreparing") : row.sent.state === "unconfirmed" ? t("conversationUnconfirmed") : row.sent.state === "cancelled" ? t("inboxSendCancelled") : row.sent.state === "removed" ? t("inboxDeliveryRemoved") : row.sent.state === "refused" ? t("inboxSendRefusedGeneric") : t(deliveryStateKey(row.sent.state))}</p>
          {#if row.sent.kind === "text"}
            <div class="actions"><button type="button" data-test="conversation-open-sent" onclick={() => void send.openSent(row.sent.id)}>{t(send.openSentID === row.sent.id ? "inboxClose" : "inboxOpen")}</button>
              <button type="button" onclick={() => void copy(row)}>{t(copied?.id === row.id ? copied.ok ? "inboxCopied" : "inboxCopyFailed" : "inboxCopy")}</button></div>
            {#if send.openSentID === row.sent.id}<InboxMessageBody text={send.openSentText || t("conversationBodyUnavailable")} testID="conversation-sent-body" />{/if}
          {:else}<ul class="items">{#each row.sent.items as item}<li><span>{item.name}</span><small>{size(item.size)}</small></li>{/each}</ul>{/if}
          {#if ["queued", "notified", "downloading", "verifying", "attention_required", "failed_retryable"].includes(row.sent.state)}
            <button type="button" data-test="conversation-cancel-delivery" disabled={send.cancellingDelivery !== null}
              onclick={() => canceling = { id: row.sent.id, epoch: inbox.view.epoch }}>{t("inboxCancelDelivery")}</button>
          {/if}
        {:else if row.kind === "message"}
          <div class="actions"><button type="button" data-test="inbox-open" onclick={() => void inbox.open(row.message.id)}>{t(inbox.openId === row.message.id ? "inboxClose" : "inboxOpen")}</button>
            <button type="button" data-test="inbox-copy-top" onclick={() => void copy(row)}>{t(copied?.id === row.id ? copied.ok ? "inboxCopied" : "inboxCopyFailed" : "inboxCopy")}</button></div>
          {#if inbox.openId === row.message.id}<div data-test="inbox-message-body"><InboxMessageBody text={inbox.openText} testID="conversation-received-body" />
            <button type="button" data-test="inbox-copy" onclick={() => void copy(row)}>{t(copied?.id === row.id ? copied.ok ? "inboxCopied" : "inboxCopyFailed" : "inboxCopy")}</button></div>{/if}
        {:else}
          {@const receipt = inbox.receipts.find((entry) => entry.taskID === row.delivery.taskID)}
          {#if receipt}<p class="dim small">{t(PHASE_KEY[receipt.phase])}</p>{/if}
          <ul class="items">{#each row.delivery.items as item}<li><span data-test="inbox-history-name">{item.name}</span><small>{size(item.size)}</small></li>{/each}</ul>
          {#if row.delivery.items.length < row.delivery.declared}<p class="dim small">{t("inboxHistoryPartial", { saved: row.delivery.items.length, declared: row.delivery.declared })}</p>{/if}
          {#if inbox.view.hasDestination}<button type="button" onclick={() => void inbox.reveal()}>{t("inboxRevealFolder")}</button>{/if}
        {/if}
        {#if copied?.id === row.id && !copied.ok}<p class="problem" role="status">{t("inboxCopyFailedBody")}</p>{/if}
        <button class="forget" type="button" data-test="conversation-delete-row" disabled={working} onclick={() => ask([row])}>{t("conversationDeleteRow")}</button>
      </li>
    {/each}
  </ol>
</section>
<dialog bind:this={dialog} oncancel={(event) => { event.preventDefault(); deleting = null; canceling = null; }}>
  <h3>{t(canceling ? "inboxCancelDelivery" : "conversationDeleteTitle")}</h3>
  {#if canceling}<p>{t("inboxCancelDeliveryBody")}</p>{:else}<p>{t("conversationLocalOnly")}</p><p>{t("conversationDeletionKeepsTransfers")}</p>{/if}
  <div class="actions"><button type="button" onclick={() => { deleting = null; canceling = null; }}>{t("sendCancel")}</button><button class="danger" type="button" data-test={canceling ? "conversation-confirm-cancel" : "conversation-confirm-delete"} onclick={() => canceling ? void cancelDelivery() : void remove()}>{t(canceling ? "inboxCancelDelivery" : "conversationDeleteRow")}</button></div>
</dialog>
<style>
  section { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
  .heading, .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .heading { justify-content: space-between; } h3 { margin: 0; font-size: 1rem; }
  time, small { font-size: .8rem; color: var(--text-dim); }
  .dim { color: var(--text-dim); } .small { font-size: .8rem; }
  .timeline { padding: 0; list-style: none; display: grid; gap: 12px; }
  .timeline > li { border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-right: 24px; }
  .timeline > li.outgoing { margin-left: 24px; margin-right: 0; }
  .items { padding: 0; list-style: none; } .items li { display: flex; justify-content: space-between; gap: 12px; overflow-wrap: anywhere; }
  .forget { margin-top: 12px; } dialog { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); max-width: 420px; padding: 24px; }
  dialog::backdrop { background: #0006; }
</style>
