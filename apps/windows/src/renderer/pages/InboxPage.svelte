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
  import { sendGate } from "../send/send-gate.svelte.js";
  import { deliveryStateKey } from "../inbox/delivery-copy.js";
  import type { InboxController } from "../inbox/inbox-controller.svelte.js";
  import type { InboxSendController, TargetStatus } from "../inbox/inbox-send-controller.svelte.js";
  import type { InboxAcceptOutcome, ResidueState, TaskPhase } from "../../shared/ipc-contract.js";
  import { pickedFromDrop } from "../send/picked-files.js";
  import { PHASE_KEY } from "../inbox/phase-copy.js";
  import { BLOCKED_KEY } from "../inbox/blocked-copy.js";

  /**
   * A residue state to the sentence that says it.
   *
   * Total, so a state added to the contract without copy is a compile error
   * here rather than a blank row on the Inbox.
   */
  const RESIDUE_KEY = {
    present: "inboxRetainedResiduePresent",
    none: "inboxRetainedResidueNone",
    unknown: "inboxRetainedResidueUnknown",
  } as const satisfies Record<ResidueState, string>;

  /**
   * Drag feedback for the composer's drop zone, and its one refusal.
   *
   * The only state this page owns; everything else it renders belongs to a
   * controller. These two are presentation of a gesture that starts and ends
   * here, so putting them in the send controller would give it a field about
   * the mouse.
   */
  let dragging = $state(false);
  let dropRefused = $state(false);

  let {
    inbox,
    send,
    onSignIn,
  }: { inbox: InboxController; send: InboxSendController; onSignIn?: () => void } = $props();

  const status = $derived(inbox.view.status);
  /**
   * Whether this PC is actually going to receive anything.
   *
   * Enrolment and receiving are different facts. `off` is enrolled — that is
   * how the refusal reaches senders — so the page asks the policy, not the
   * enrolment, before it promises anything about deliveries arriving.
   */
  const receiving = $derived(inbox.view.enabled && inbox.view.policy !== "off");

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
      case "policy":
        // The sentence follows the choice. Reporting a successful
        // `setPolicy("off")` as "Receiving is on" said the opposite of what the
        // user had just asked for.
        return notice.policy === "off"
          ? t("inboxPolicySetOff")
          : notice.policy === "auto"
            ? t("inboxPolicySetAuto")
            : t("inboxPolicySetAsk");
      case "accepted":
        return acceptedText(notice.receipt);
      case "failed":
        // The `reason` this carries is a code from main and stays there. The
        // page says the one true thing it can: the act did not happen.
        return t("inboxFailed");
      default: {
        // An explicit `never`, and not merely the absence of a `default`.
        //
        // Removing the default alone gives NOTHING here, which was checked
        // rather than assumed: with no default, an unhandled kind makes this
        // function return `undefined`, `noticeText` becomes
        // `string | null | undefined`, and `{#if noticeText}` renders nothing.
        // A blank notice row is not better than the wrong sentence it replaced.
        //
        // This way a kind added to `InboxNotice` fails to compile HERE, at the
        // one place that has to describe it.
        const unhandled: never = notice;
        void unhandled;
        // Runs only if the TYPE is wrong. The least this page can honestly say
        // beats putting an object on screen.
        return t("inboxFailed");
      }
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
  /** The three answers, in the order a person weighs them. */
  const POLICIES = [
    { value: "off", label: "inboxPolicyOff", body: "inboxPolicyOffBody" },
    { value: "ask", label: "inboxPolicyAsk", body: "inboxPolicyAskBody" },
    { value: "auto", label: "inboxPolicyAuto", body: "inboxPolicyAutoBody" },
  ] as const;

  /** One sentence per journal phase. Closed codes in, product copy out. */
  function phaseOf(phase: TaskPhase): string {
    return t(PHASE_KEY[phase]);
  }

  /**
   * A target's refusal, as a sentence.
   *
   * The tokens are central's own — `writeInboxTaskError`'s vocabulary — and
   * each means something different to the person reading it: one is fixed by
   * turning receiving on over there, one cannot be fixed at all, and one will
   * fix itself when that device next enrols a key.
   */
  function refusalText(refusal: string | null): string {
    if (refusal === "auto_receive_disabled") return t("inboxSendTargetOff");
    if (refusal === "device_inbox_revoked") return t("inboxSendTargetRevoked");
    if (refusal === "no_active_key") return t("inboxSendTargetNoKey");
    if (refusal === "unsupported_content_kind") return t("inboxSendTargetNoText");
    return t("inboxSendTargetCannotReceive");
  }

  /**
   * One target's line, in the user's words.
   *
   * `delivered` reports the SERVER's state rather than `created`: a converged
   * retry reports `created: false` and is just as delivered, and a page that
   * showed the creation flag as the delivery state would call it a failure.
   */
  function statusText(state: TargetStatus): string {
    if (state.phase === "queued") return t("inboxSendQueued");
    if (state.phase === "sending") {
      const percent = state.total > 0 ? Math.min(100, Math.round((state.committed / state.total) * 100)) : 0;
      return t("inboxSendSending", { percent });
    }
    if (state.refusal !== null) return startRefusalText(state.refusal);
    const view = state.view;
    if (view === null) return t("inboxSendRefusedGeneric");
    // What the other device is doing with it, over the WHOLE server union. See
    // `delivery-copy.ts` for what the two-branch version claimed.
    if (view.kind === "delivered") return t(deliveryStateKey(view.state));
    if (view.kind === "cancelled") return t("inboxSendCancelled");
    if (view.kind === "unknown") return t("inboxSendUnknown");
    return t("inboxSendRefused");
  }

  /** A refusal that happened before a delivery existed. */
  function startRefusalText(refusal: string): string {
    if (refusal === "unresolved-full") return t("inboxSendRefusedUnresolvedFull");
    if (refusal === "at-capacity") return t("inboxSendRefusedCapacity");
    if (refusal === "signed-out") return t("inboxSendSignedOut");
    if (refusal === "nothing-picked") return t("inboxSendRefusedNothing");
    if (refusal === "no-target") return t("inboxSendRefusedNoTarget");
    if (refusal === "refused") return t("inboxSendRefusedManifest");
    if (refusal === "unavailable") return t("inboxSendRefusedUnavailable");
    return t("inboxSendRefusedGeneric");
  }

  /**
   * Read what this page renders, when it is actually put on screen.
   *
   * The controller is app-lived and survives navigation, which is what keeps a
   * delivery's outcome and an open message across a row change. It is NOT a
   * substitute for reading on mount: main pushes when its STATE changes, and a
   * record written just after the last push — the names of a delivery that has
   * just landed — would otherwise not appear until something else happened.
   */
  $effect(() => {
    void inbox.refreshLists();
    void send.refreshTargets();
  });

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
    <!-- Hooked like every other status branch, so the harness can prove this
         one renders. It was the only one a test could not name. -->
    <p class="dim" data-test="inbox-unavailable">{t("inboxUnavailableBody")}</p>
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
  <!--
    ## The title follows the POLICY, not the enrolment
    //
    Choosing "Don't send to this PC" keeps the device ENROLLED — that is what
    makes the refusal reach senders — so `view.enabled` is true for it. Reading
    the title off that said "Receiving is on" and promised "deliveries keep
    arriving" directly beside the Off radio the user had just chosen. What the
    user asked for is the policy, so that is what the page says.
  -->
  <Card title={receiving ? t("inboxOnTitle") : t("inboxOffTitle")}>
    {#if receiving}
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
          <!-- The REASON, not a sentence that fits every reason. The status has
               always carried it and this rendered `inboxBlockedBody` over the
               top, so a full disk, a folder that went away and a delivery the
               person declined themselves all read the same. Two of those three
               they could have fixed in a minute. Wording is macOS's; see
               `inbox/blocked-copy.ts`. -->
          <strong>{t("inboxBlockedTitle")}</strong><br />{t(BLOCKED_KEY[status.reason])}
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

      <!--
        The policy, as three plain answers to one question.

        Radio inputs rather than a toggle: this is a choice between three, and
        `auto` is the one that writes files without asking, so it has to be
        selected deliberately and its consequence stated next to it.
      -->
      <fieldset class="policy" data-test="inbox-policy">
        <legend>{t("inboxPolicyHeading")}</legend>
        {#each POLICIES as option (option.value)}
          <label class="choice">
            <input
              type="radio"
              name="inbox-policy"
              value={option.value}
              checked={inbox.view.policy === option.value}
              disabled={inbox.busy}
              data-test={`inbox-policy-${option.value}`}
              onchange={() => void inbox.setPolicy(option.value)}
            />
            <span>
              <strong>{t(option.label)}</strong><br />
              <span class="dim small">{t(option.body)}</span>
            </span>
          </label>
        {/each}
      </fieldset>

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
        <button type="button" data-test="inbox-reveal" onclick={() => void inbox.reveal()}>
          {t("inboxRevealFolder")}
        </button>
        {#if inbox.revealFailed}
          <p class="problem" data-test="inbox-reveal-failed">{t("inboxRevealFailed")}</p>
        {/if}
        <!-- THAT a folder is chosen, never which one: no channel in this app
             carries a path to the page, and this line is the whole of what the
             renderer is told about it. -->
        <p class="dim small" data-test="inbox-has-folder">{t("inboxFolderChosen")}</p>
      {/if}
    {:else if inbox.view.enabled}
      <!-- Enrolled and told to refuse: a real state with its own sentence,
           and NOT the same as never having turned the feature on. -->
      <p class="dim" data-test="inbox-policy-off-state">{t("inboxPolicyOffBody")}</p>
      <fieldset class="policy" data-test="inbox-policy">
        <legend>{t("inboxPolicyHeading")}</legend>
        {#each POLICIES as option (option.value)}
          <label class="choice">
            <input
              type="radio"
              name="inbox-policy"
              value={option.value}
              checked={inbox.view.policy === option.value}
              disabled={inbox.busy}
              data-test={`inbox-policy-${option.value}`}
              onchange={() => void inbox.setPolicy(option.value)}
            />
            <span>
              <strong>{t(option.label)}</strong><br />
              <span class="dim small">{t(option.body)}</span>
            </span>
          </label>
        {/each}
      </fieldset>
      <div class="row">
        <button type="button" data-test="inbox-disable" disabled={inbox.busy} onclick={() => void inbox.disable()}>
          {t("inboxTurnOff")}
        </button>
      </div>
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

  <!--
    Sending to your own devices.

    The mirror of everything above: this PC is a target for other devices, and
    they are targets for it. The files are encrypted HERE — the page holds them
    and runs the shared `encryptFiles` — and sealed to the DEVICE the user
    picked, so the server carries ciphertext it cannot open and cannot address
    anywhere else.

    Each target is its own delivery with its own key, so each has its own line
    and its own outcome. One device refusing is not a reason to abandon another.
  -->
  <Card title={t("inboxSendHeading")}>
    <p class="dim">{t("inboxSendBody")}</p>

    <!-- Files or a message: one delivery is one kind, because the manifest
         says so. The message is encrypted here too; main is told a LENGTH. -->
    <div class="row" role="group" aria-label={t("inboxSendHeading")}>
      <button
        type="button"
        data-test="inbox-send-mode-files"
        aria-pressed={send.mode === "files"}
        disabled={send.busy}
        onclick={() => (send.mode = "files")}
      >
        {t("inboxSendModeFiles")}
      </button>
      <button
        type="button"
        data-test="inbox-send-mode-text"
        aria-pressed={send.mode === "text"}
        disabled={send.busy}
        onclick={() => (send.mode = "text")}
      >
        {t("inboxSendModeText")}
      </button>
    </div>

    {#if send.mode === "files"}
      <!-- The native pickers. `webkitdirectory` opens the Windows folder
           dialog; neither gives this page a path it can name to main. -->
      <div class="row">
        <input
          id="inbox-send-files"
          class="sr-only"
          type="file"
          multiple
          data-test="inbox-send-files"
          onchange={(e) => send.pick([...((e.currentTarget as HTMLInputElement).files ?? [])])}
        />
        <label class="button" for="inbox-send-files">{t("inboxSendPickFiles")}</label>
        <input
          id="inbox-send-folder"
          class="sr-only"
          type="file"
          webkitdirectory
          data-test="inbox-send-folder"
          onchange={(e) => send.pick([...((e.currentTarget as HTMLInputElement).files ?? [])])}
        />
        <label class="button" for="inbox-send-folder">{t("inboxSendPickFolder")}</label>
        <!-- NOT asserted on screen by any harness, and the reason is worth
             stating: this composer renders only when signed in, and every
             renderer harness in this repository runs signed out — the Device
             Inbox shows `inbox-sign-in` and nothing else there. What IS covered
             is the part that decides what gets sent: `pickEntries` carrying the
             dropped path into the manifest, in inbox-send-controller.test.ts.

             The same choice without the dialog, which is what a drop is on this
             product's other two send surfaces. It REPLACES, as the two pickers
             beside it do: a drop that appended while they replaced would make
             the surface disagree with itself about what dropping means.

             Gated on there being somewhere to send: a revoked, switched-off or
             removed device leaves no target, and a zone that accepts a drop it
             cannot act on is worse than one that is not there. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="dropzone"
          class:over={dragging}
          data-test="inbox-send-drop"
          ondragover={(event) => {
            if (send.busy || send.targetsUnavailable) return;
            event.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          ondrop={(event) => {
            event.preventDefault();
            dragging = false;
            if (send.busy || send.targetsUnavailable) return;
            dropRefused = false;
            const transfer = event.dataTransfer;
            void pickedFromDrop(transfer).then((dropped) => {
              // Never a partial batch: `pickedFromDrop` refuses a tree it could
              // not read whole, and saying so is the only way a person learns
              // their folder was not taken.
              if (!dropped.complete) {
                dropRefused = true;
                return;
              }
              if (dropped.files.length === 0) return;
              send.pickEntries(dropped.files);
            });
          }}
        >{t("inboxSendDropHint")}</span>
      </div>
      {#if dropRefused}
        <p class="problem" data-test="inbox-drop-refused" role="status">{t("dropUnreadable")}</p>
      {/if}
      {#if send.files.length > 0}
        <p class="dim" data-test="inbox-send-picked">
          {t("inboxSendPicked", { count: send.files.length, size: size(send.totalBytes) })}
        </p>
        <!-- The actual names, because "3 files" is not what a person checks
             before pressing send. Relative names only: the page never holds a
             path, and these are what the manifest will declare. -->
        <ul class="names" data-test="inbox-send-names">
          {#each send.files.slice(0, 6) as file (send.pathOf(file))}
            <li>
              <span>{send.pathOf(file)}</span>
              <span class="dim small">{size(file.size)}</span>
            </li>
          {/each}
        </ul>
        {#if send.files.length > 6}
          <p class="dim small" data-test="inbox-send-more">
            {t("inboxHistoryMore", { count: send.files.length - 6 })}
          </p>
        {/if}
      {/if}
    {:else}
      <textarea
        class="message"
        data-test="inbox-send-message"
        bind:value={send.message}
        disabled={send.busy}
        placeholder={t("inboxSendMessagePlaceholder")}
      ></textarea>
    {/if}

    <!-- Your devices. A refusal is central's own verdict, said as a sentence:
         a greyed row with no reason is how a person ends up waiting for a
         delivery that was never going to be accepted. -->
    <fieldset class="policy">
      <legend>{t("inboxSendTargetsHeading")}</legend>
      {#if send.targetsUnavailable}
        <p class="problem" data-test="inbox-send-targets-unavailable">
          {send.targetsRefusal === "signed-out"
            ? t("inboxSendSignedOut")
            : t("inboxSendTargetsUnavailable")}
        </p>
        <!-- The action has to be the one that RESOLVES what was just said.
             This branch is reachable when the account goes away mid-session,
             while the page is already open, and Refresh cannot end being
             signed out however many times it is pressed. -->
        {#if send.targetsRefusal === "signed-out" && onSignIn}
          <button class="primary" type="button" data-test="inbox-send-sign-in" onclick={onSignIn}>
            {t("gateSignIn")}
          </button>
        {:else}
          <button type="button" data-test="inbox-send-refresh" onclick={() => void send.refreshTargets()}>
            {t("inboxSendRefresh")}
          </button>
        {/if}
      {:else if send.targets.length === 0}
        <p class="dim" data-test="inbox-send-no-targets">{t("inboxSendNoTargets")}</p>
        <button type="button" data-test="inbox-send-refresh" onclick={() => void send.refreshTargets()}>
          {t("inboxSendRefresh")}
        </button>
      {:else}
        {#each send.targets as target (target.deviceID)}
          {@const state = send.status[target.deviceID] ?? null}
          <div class="choice">
            <input
              type="checkbox"
              id={`inbox-target-${target.deviceID}`}
              data-test="inbox-send-target"
              data-device={target.deviceID}
              checked={send.selected.includes(target.deviceID)}
              disabled={send.busy || !target.eligible}
              onchange={() => send.toggle(target.deviceID)}
            />
            <div>
              <label for={`inbox-target-${target.deviceID}`}>
                {target.name === "" ? target.deviceID : target.name}
              </label>
              {#if !target.eligible}
                <p class="dim small" data-test="inbox-send-target-refusal">{refusalText(target.refusal)}</p>
              {/if}
              {#if state !== null && state.phase !== "idle"}
                <!-- The PHASE is carried as data, not inferred from the
                     sentence. A fixture that waited on the text alone matched
                     "Waiting" as readily as an outcome, which is a barrier that
                     passes before the thing it is waiting for. -->
                <p
                  class="dim small"
                  data-test="inbox-send-status"
                  data-device={target.deviceID}
                  data-phase={state.phase}
                  {...state.view?.kind === "delivered" ? { "data-delivery": state.view.state } : {}}
                >
                  {statusText(state)}
                </p>
                {#if state.view?.kind === "unknown"}
                  <p class="dim small" data-test="inbox-send-unknown-body">{t("inboxSendUnknownBody")}</p>
                  <button
                    type="button"
                    data-test="inbox-send-converge"
                    disabled={send.checking(target.deviceID)}
                    onclick={() => void send.converge(target.deviceID)}
                  >
                    {t("inboxSendCheckAgain")}
                  </button>
                {/if}
                {#if state.view?.kind === "refused" && state.view.orphanedObject}
                  <p class="dim small" data-test="inbox-send-orphan">{t("inboxSendOrphan")}</p>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </fieldset>

    <!--
      Deliveries nobody can account for.

      Their own section, outside the device rows, because they are not part of
      the current selection: they are things that may have happened. Keeping
      them inside the rows meant picking or sending again took the only handle
      on them away, and the user was left unable to ask.
    -->
    {#if send.unresolved.length > 0}
      <div class="policy" data-test="inbox-send-unresolved">
        <p class="dim">{t("inboxSendUnresolvedHeading")}</p>
        <p class="dim small">{t("inboxSendUnresolvedBody")}</p>
        <ul class="list">
          {#each send.unresolved as held (held.jobId)}
            <li>
              <div class="who">
                <span data-test="inbox-send-unresolved-target">
                  {t("inboxSendUnresolvedTo", { device: held.name === "" ? held.deviceID : held.name })}
                </span>
              </div>
              <button
                type="button"
                data-test="inbox-send-unresolved-check"
                disabled={send.checking(held.jobId)}
                onclick={() => void send.convergeJob(held.jobId)}
              >
                {t("inboxSendCheckAgain")}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="row">
      {#if send.busy}
        <button type="button" data-test="inbox-send-cancel" onclick={() => void send.cancel()}>
          {t("inboxSendCancel")}
        </button>
      {:else}
        <!--
          The page's own admission, not just main's.

          Main refuses a new delivery while a quit is being decided, but the
          control has to say so too: a button that looks live and then answers
          "not right now" is a worse quit than one that is visibly held. The
          TICKET is what makes it correct rather than cosmetic — permission is
          taken when the person presses, and a fence between the press and the
          delivery actually starting invalidates it, so an intent formed before
          a question they have since answered cannot go out afterwards.
        -->
        <button
          type="button"
          data-test="inbox-send-start"
          disabled={!send.ready || sendGate.fenced}
          onclick={() => sendGate.start(() => void send.send())}
        >
          {t("inboxSendStart")}
        </button>
        <button type="button" data-test="inbox-send-clear" onclick={() => send.clear()}>
          {t("inboxSendClear")}
        </button>
      {/if}
    </div>
  </Card>

  <!--
    What has arrived.

    Counts and outcomes from the delivery journal, and the NAMES beside them
    when this delivery has them — captured while it was received, from the
    manifest, because the journal carries no names by design and re-reading the
    folder would report whatever is in it now rather than what arrived.

    A delivery with no names says so. An empty row would read as an empty
    delivery, which is the one thing it must never be mistaken for.
  -->
  <Card title={t("inboxReceiptsHeading")}>
    {#if inbox.receiptsUnavailable}
      <p class="problem" data-test="inbox-receipts-unavailable">{t("inboxReceiptsUnavailable")}</p>
    {:else if inbox.receipts.length === 0}
      <p class="dim" data-test="inbox-receipts-empty">{t("inboxReceiptsEmpty")}</p>
    {:else}
      {#if inbox.namesUnavailable}
        <!-- The counts below are still exact. Only the names are missing, and
             saying which is missing is the difference between "we lost your
             deliveries" and "we could not read one file". -->
        <p class="problem" data-test="inbox-names-unavailable">{t("inboxHistoryNamesUnavailable")}</p>
      {/if}
      <ul class="list" data-test="inbox-receipts">
        {#each inbox.receipts as receipt (receipt.taskID)}
          {@const named = inbox.named[receipt.taskID] ?? null}
          <li>
            <div class="who">
              <span>
                {receipt.text
                  ? t("inboxReceiptMessage")
                  : t("inboxReceiptFiles", { published: receipt.published, total: receipt.total })}
              </span>
              <span class="dim small">{when(receipt.updatedAt)}</span>
            </div>
            <p class="dim small" data-test="inbox-receipt-phase">{phaseOf(receipt.phase)}</p>
            <!--
              The names, when this delivery has them.

              Only what was CONFIRMED PUBLISHED is listed, and `declared` is
              shown beside it when they differ — "3 of 7 saved" is the truth
              about a partial, and a list of three shown alone is not.
            -->
            {#if named !== null && named.items.length > 0}
              <ul class="names" data-test="inbox-history-items">
                {#each named.items.slice(0, 8) as item (item.name)}
                  <li>
                    <span data-test="inbox-history-name">{item.name}</span>
                    <span class="dim small">{size(item.size)}</span>
                  </li>
                {/each}
              </ul>
              {#if named.items.length > 8}
                <p class="dim small" data-test="inbox-history-more">
                  {t("inboxHistoryMore", { count: named.items.length - 8 })}
                </p>
              {/if}
              {#if named.items.length < named.declared}
                <p class="dim small" data-test="inbox-history-partial">
                  {t("inboxHistoryPartial", { saved: named.items.length, declared: named.declared })}
                </p>
              {/if}
              <button
                type="button"
                data-test="inbox-history-forget"
                disabled={inbox.working.includes(receipt.taskID)}
                onclick={() => void inbox.forget(receipt.taskID)}
                title={t("inboxHistoryForgetHint")}
              >
                {t("inboxHistoryForget")}
              </button>
            {:else if !receipt.text && !inbox.namesUnavailable}
              <!-- A real delivery with nothing to name. Said out loud, because
                   an empty row otherwise reads as an empty delivery. -->
              <p class="dim small" data-test="inbox-receipt-unnamed">{t("inboxReceiptUnnamed")}</p>
            {/if}
          </li>
        {/each}
      </ul>
      {#if inbox.view.hasDestination}
        <button type="button" data-test="inbox-receipts-reveal" onclick={() => void inbox.reveal()}>
          {t("inboxRevealFolder")}
        </button>
      {/if}
    {/if}
  </Card>

  <!-- Retained cleanups: destinations this process could not confirm it closed.
       A key and a code, never a path. -->
  {#if inbox.view.retained.length > 0}
    <Card title={t("inboxRetainedHeading")}>
      <p class="dim">{t("inboxRetainedBody")}</p>
      <ul class="list" data-test="inbox-retained">
        {#each inbox.view.retained as handle (handle.key)}
          <li>
            <div class="who">
              <span class="dim small" data-test="inbox-retained-residue">
                {t(RESIDUE_KEY[handle.residue])}
              </span>
            </div>
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
  .policy { border: 1px solid var(--border); border-radius: var(--corner); padding: var(--space-inner); margin: var(--space-inner) 0; }
  .policy legend { padding: 0 var(--space-tight); font-weight: 600; }
  .choice { display: flex; gap: var(--space-tight); align-items: flex-start; padding: var(--space-tight) 0; }
  .choice input { margin-top: 3px; }
  /* The user's own file names. They wrap rather than overflowing: a long
     relative path is ordinary, and a row that clipped it would hide which file
     the size beside it belongs to. */
  .names { list-style: none; margin: var(--space-tight) 0 0; padding: 0; }
  .names li {
    display: flex;
    gap: var(--space-inner);
    justify-content: space-between;
    align-items: baseline;
    padding: 2px 0;
  }
  .names li span:first-child { overflow-wrap: anywhere; }
  .message {
    width: 100%;
    min-height: 96px;
    margin-top: var(--space-tight);
    padding: var(--space-inner);
    border: 1px solid var(--border);
    border-radius: var(--corner);
    background: var(--surface);
    color: inherit;
    font: inherit;
    resize: vertical;
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
