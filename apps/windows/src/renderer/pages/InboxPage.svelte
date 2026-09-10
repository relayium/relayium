<!--
  Device Inbox — receive.

  ## This page does not receive anything

  It renders a scheduler that lives in the main process and keeps running when
  this page is not mounted, when the window is hidden, and when the user is
  looking at another row. Everything here is a view or a request; nothing here
  paces, starts or stops the work.

  That is why the page says so out loud. A resident feature the user cannot
  verify is one they have to trust, and the way people check "is it still
  receiving?" is by closing the window and seeing whether anything arrived. The
  line under the switch is the promise; the scheduler is what keeps it.

  ## The consent order is the product, not a nicety

  Turning receiving on opens a NATIVE folder dialog — main's, not this page's —
  and only a folder actually chosen enrols this PC as a target. A page that
  showed an on switch and enrolled first would be advertising a device with
  nowhere to put what arrives.

  ## Four ways to be off, four different sentences

  Signed out, storage unreadable, not enabled, and folder missing are separate
  states with separate remedies. Collapsing them into one greyed switch is how a
  person ends up waiting for a delivery that was never going to come, with
  nothing on screen telling them which of the four to fix.
-->
<script lang="ts">
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import type { InboxController } from "../inbox/inbox-controller.svelte.js";
  import type { InboxAcceptOutcome } from "../../shared/ipc-contract.js";

  let { inbox, onSignIn }: { inbox: InboxController; onSignIn?: () => void } = $props();

  const status = $derived(inbox.view.status);

  /** Bytes as a person reads them. Counts only; never a file name. */
  function size(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function when(seconds: number): string {
    if (seconds <= 0) return "";
    return new Date(seconds * 1000).toLocaleString();
  }

  /**
   * What an accepted delivery actually did.
   *
   * `ackPending` is reported as saved, because it is: the files are on disk and
   * only the acknowledgement is missing. Calling that a failure would be false
   * in the direction that matters most.
   */
  function acceptedText(outcome: InboxAcceptOutcome): string {
    if (outcome.kind === "received") {
      const receipt = outcome.receipt;
      if (receipt.kind === "saved") {
        return receipt.ackPending ? t("inboxAckPending") : t("inboxAcceptedSaved");
      }
      if (receipt.kind === "saved-message") {
        return receipt.ackPending ? t("inboxAckPending") : t("inboxAcceptedSavedMessage");
      }
      if (receipt.kind === "partial") {
        return t("inboxAcceptedPartial", {
          saved: receipt.savedCount,
          total: receipt.total,
        });
      }
      return t("inboxFailed");
    }
    if (outcome.kind === "queued") return t("inboxAcceptedQueued");
    if (outcome.kind === "blocked") return t("inboxAcceptedBlocked");
    if (outcome.kind === "already-settled") return t("inboxAcceptedSettled");
    if (outcome.kind === "busy") return t("inboxAcceptedBusy");
    if (outcome.kind === "refused") return t("inboxAcceptedRefused");
    return t("inboxFailed");
  }

  /** One sentence per notice. Closed codes in, product copy out. */
  const noticeText = $derived.by(() => {
    const notice = inbox.notice;
    if (notice === null) return null;
    switch (notice.kind) {
      case "declined":
        return t("inboxDeclined");
      case "enabled":
        return t("inboxEnabledNotice");
      case "disabled":
        return t("inboxDisabledNotice");
      case "still-enrolled":
        return t("inboxWithdrawalPending");
      case "needs-account":
        return t("inboxNeedsAccountBody");
      case "refused":
        return t("inboxRefused");
      case "superseded":
        return t("inboxSuperseded");
      case "renamed":
        return t("inboxRenamed");
      case "accepted":
        return acceptedText(notice.receipt);
      default:
        return t("inboxFailed");
    }
  });

  /** What this build tells the server it can take, said in the user's words. */
  const canReceive = $derived.by(() => {
    const caps = inbox.view.capabilities;
    const files = caps.some((cap) => cap.includes("receive"));
    const text = caps.some((cap) => cap.includes("text"));
    if (files && text) return t("inboxCanReceive");
    if (files) return t("inboxCanReceiveFiles");
    if (text) return t("inboxCanReceiveText");
    return null;
  });

  /**
   * What the Copy control last did — and it always did SOMETHING.
   *
   * The copy itself happens in MAIN. `window.ts` denies every renderer
   * permission on purpose, and `navigator.clipboard.writeText` is subject to
   * that guard, so a button built on the browser API here would not fail
   * occasionally — it would never work at all. The page names the message; main
   * reads it under the live account and writes it.
   *
   * A failure is still possible — the account can change while the record is
   * being opened — so it is rendered rather than swallowed, and the user is
   * told what to do instead.
   */
  let copyState = $state<{ id: string; ok: boolean } | null>(null);
  async function copyOpen(): Promise<void> {
    const id = inbox.openId;
    if (id === null) return;
    const ok = await inbox.copy(id);
    copyState = { id, ok };
    // A success fades; a failure stays, because the user has to act on it.
    if (!ok) return;
    setTimeout(() => {
      if (copyState?.id === id) copyState = null;
    }, 1500);
  }
</script>

<h1>{t("inboxTitle")}</h1>
<p class="lede">{t("inboxSubtitle")}</p>

{#if noticeText}
  <p class="notice" data-test="inbox-notice" role="status">
    {noticeText}
    <button type="button" data-test="inbox-notice-dismiss" onclick={() => inbox.dismiss()}>
      {t("inboxClose")}
    </button>
  </p>
{/if}

<!-- ## State first, because every control below depends on which one it is. -->
{#if status.kind === "unavailable"}
  <Card title={t("inboxUnavailableTitle")}>
    <p class="dim">{t("inboxUnavailableBody")}</p>
  </Card>
{:else if status.kind === "needs-account"}
  <Card title={t("inboxNeedsAccountTitle")}>
    <p class="dim">{t("inboxNeedsAccountBody")}</p>
    {#if onSignIn}
      <button class="primary" type="button" data-test="inbox-sign-in" onclick={onSignIn}>
        {t("navAccount")}
      </button>
    {/if}
  </Card>
{:else if status.kind === "account-unreadable"}
  <Card title={t("inboxAccountUnreadableTitle")}>
    <p class="dim" data-test="inbox-store-unreadable">{t("inboxAccountUnreadableBody")}</p>
  </Card>
{:else}
  <Card title={inbox.view.enabled ? t("inboxOnTitle") : t("inboxOffTitle")}>
    {#if inbox.view.enabled}
      <p class="dim" data-test="inbox-resident-note">{t("inboxBackgroundNote")}</p>
      {#if canReceive}<p class="dim small" data-test="inbox-capabilities">{canReceive}</p>{/if}

      <!-- The live state, under the switch that produced it. -->
      {#if status.kind === "folder-missing"}
        <p class="problem" data-test="inbox-folder-missing">
          <strong>{t("inboxFolderMissingTitle")}</strong><br />{t("inboxFolderMissingBody")}
        </p>
      {:else if status.kind === "starting"}
        <p class="dim" data-test="inbox-starting">{t("inboxStartingBody")}</p>
      {:else if status.kind === "receiving"}
        <p class="dim" data-test="inbox-receiving">{t("inboxReceivingBody")}</p>
        <div class="indeterminate" role="progressbar" aria-label={t("inboxReceivingTitle")}>
          <span></span>
        </div>
      {:else if status.kind === "blocked"}
        <p class="problem" data-test="inbox-blocked">
          <strong>{t("inboxBlockedTitle")}</strong><br />{t("inboxBlockedBody")}
        </p>
      {:else if status.kind === "offline"}
        <p class="problem" data-test="inbox-offline">
          <strong>{t("inboxOfflineTitle")}</strong><br />
          {t("inboxOfflineBody", { seconds: status.retryInSeconds })}
        </p>
        <button type="button" data-test="inbox-retry" onclick={() => void inbox.retryNow()}>
          {t("inboxRetryNow")}
        </button>
      {:else if status.kind === "idle"}
        <p class="dim" data-test="inbox-idle">{t("inboxIdleBody")}</p>
      {/if}

      {#if inbox.view.withdrawalPending}
        <p class="problem" data-test="inbox-withdrawal-pending">{t("inboxWithdrawalPending")}</p>
      {/if}

      <div class="row">
        <button type="button" data-test="inbox-disable" disabled={inbox.busy} onclick={() => void inbox.disable()}>
          {t("inboxTurnOff")}
        </button>
        <button
          type="button"
          data-test="inbox-change-folder"
          disabled={inbox.busy}
          onclick={() => void inbox.chooseFolder()}
        >
          {status.kind === "folder-missing" ? t("inboxChooseFolder") : t("inboxChangeFolder")}
        </button>
      </div>
      {#if inbox.view.hasDestination}
        <!-- THAT a folder is chosen, never which one: no channel in this app
             carries a path to the page, and this line is the whole of what the
             renderer is told about it. -->
        <p class="dim small" data-test="inbox-has-folder">{t("inboxFolderChosen")}</p>
      {/if}
    {:else}
      <p class="dim">{t("inboxOffBody")}</p>
      <button class="primary" type="button" data-test="inbox-enable" disabled={inbox.busy} onclick={() => void inbox.enable()}>
        {t("inboxTurnOn")}
      </button>
      {#if inbox.view.withdrawalPending}
        <p class="problem" data-test="inbox-withdrawal-pending">{t("inboxWithdrawalPending")}</p>
      {/if}
    {/if}
  </Card>

  <!-- Pending deliveries. Shown whenever central is holding something, even
       while receiving is off: they are still addressed to this device, and
       hiding them would make declining impossible. -->
  {#if inbox.pending.length > 0 || inbox.view.enabled}
    <Card title={t("inboxPendingHeading")}>
      {#if inbox.pending.length === 0}
        <p class="dim" data-test="inbox-pending-empty">{t("inboxPendingEmpty")}</p>
      {:else}
        <ul class="list" data-test="inbox-pending">
          {#each inbox.pending as task (task.taskID)}
            <li>
              <div class="who">
                <span>{t("inboxPendingItem", { bytes: size(task.bytes) })}</span>
                <span class="dim small">{when(task.createdAt)}</span>
              </div>
              <div class="row">
                <button
                  class="primary"
                  type="button"
                  data-test="inbox-accept"
                  disabled={inbox.working.includes(task.taskID)}
                  onclick={() => void inbox.accept(task.taskID)}
                >
                  {t("inboxAccept")}
                </button>
                <button
                  type="button"
                  data-test="inbox-reject"
                  disabled={inbox.working.includes(task.taskID)}
                  onclick={() => void inbox.reject(task.taskID)}
                >
                  {t("inboxReject")}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  {/if}

  <!-- Messages. Kept until the user deletes them: turning receiving off, or
       signing out, never removes one. -->
  <Card title={t("inboxMessagesHeading")}>
    {#if inbox.messages.length === 0}
      <p class="dim" data-test="inbox-messages-empty">{t("inboxMessagesEmpty")}</p>
    {:else}
      <ul class="list" data-test="inbox-messages">
        {#each inbox.messages as message (message.id)}
          <li>
            <div class="who">
              <span>{t("inboxMessageItem")}</span>
              <span class="dim small">{when(message.receivedAt)}</span>
            </div>
            <div class="row">
              <button type="button" data-test="inbox-open" onclick={() => void inbox.open(message.id)}>
                {inbox.openId === message.id ? t("inboxClose") : t("inboxOpen")}
              </button>
              <button class="danger" type="button" data-test="inbox-delete" onclick={() => void inbox.remove(message.id)}>
                {t("inboxDelete")}
              </button>
            </div>
            {#if inbox.openId === message.id}
              <div class="body" data-test="inbox-message-body">
                <p>{inbox.openText}</p>
                <button type="button" data-test="inbox-copy" onclick={() => void copyOpen()}>
                  {copyState?.id === message.id
                    ? copyState.ok
                      ? t("inboxCopied")
                      : t("inboxCopyFailed")
                    : t("inboxCopy")}
                </button>
                {#if copyState?.id === message.id && !copyState.ok}
                  <p class="dim small" data-test="inbox-copy-failed">{t("inboxCopyFailedBody")}</p>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <p class="dim small">{t("inboxMessageKept")}</p>
  </Card>

  <!-- Retained cleanups: destinations this process could not confirm it closed.
       A key and a code, never a path. -->
  {#if inbox.view.retained.length > 0}
    <Card title={t("inboxRetainedHeading")}>
      <p class="dim">{t("inboxRetainedBody")}</p>
      <ul class="list" data-test="inbox-retained">
        {#each inbox.view.retained as handle (handle.key)}
          <li>
            <div class="who"><span class="dim small">{handle.reason}</span></div>
            <button type="button" data-test="inbox-release" onclick={() => void inbox.release(handle.key)}>
              {t("inboxRetainedRetry")}
            </button>
          </li>
        {/each}
      </ul>
    </Card>
  {/if}

  <Card title={t("inboxDeviceHeading")}>
    <p class="dim" data-test="inbox-device-name">
      {inbox.view.deviceName === "" ? t("inboxDeviceUnnamed") : inbox.view.deviceName}
    </p>
    <form
      class="row"
      onsubmit={(e) => {
        e.preventDefault();
        void inbox.rename();
      }}
    >
      <label class="sr-only" for="inbox-name">{t("inboxRenameLabel")}</label>
      <input
        id="inbox-name"
        data-test="inbox-name"
        bind:value={inbox.nameDraft}
        placeholder={t("inboxRenameLabel")}
        maxlength="64"
        disabled={inbox.busy}
      />
      <button type="submit" data-test="inbox-rename" disabled={inbox.busy || inbox.nameDraft.trim() === ""}>
        {t("inboxRename")}
      </button>
    </form>
  </Card>
{/if}

<style>
  h1 { margin: 0 0 var(--space-hairline); font-size: 20px; font-weight: 600; }
  .lede { margin: 0 0 var(--space-section); color: var(--text-dim); }
  .dim { color: var(--text-dim); margin: 0 0 var(--space-tight); }
  .small { font-size: 13px; }
  .problem { margin: 0 0 var(--space-inner); }
  .notice {
    display: flex;
    gap: var(--space-inner);
    align-items: center;
    justify-content: space-between;
    margin: 0 0 var(--space-section);
    padding: var(--space-tight) var(--space-inner);
    border: 1px solid var(--border);
    border-radius: var(--corner);
    background: var(--surface);
  }
  .row { display: flex; gap: var(--space-tight); margin-top: var(--space-tight); }
  .row input { flex: 1; }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li {
    padding: var(--space-inner) 0;
    border-top: 1px solid var(--border);
  }
  .list li:first-child { border-top: none; }
  .who { display: flex; gap: var(--space-inner); justify-content: space-between; align-items: baseline; }
  .body {
    margin-top: var(--space-tight);
    padding: var(--space-inner);
    border-radius: var(--corner);
    background: var(--surface);
  }
  /* A received message is the sender's text: it keeps their line breaks, and it
     wraps rather than overflowing on a long unbroken string. */
  .body p { margin: 0 0 var(--space-tight); white-space: pre-wrap; overflow-wrap: anywhere; }
  .indeterminate {
    position: relative;
    overflow: hidden;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    margin-bottom: var(--space-inner);
  }
  .indeterminate span {
    position: absolute;
    inset: 0 auto 0 0;
    width: 35%;
    border-radius: 2px;
    background: var(--accent);
    animation: indeterminate 1.4s var(--ease) infinite;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
