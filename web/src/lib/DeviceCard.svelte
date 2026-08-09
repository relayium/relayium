<script lang="ts">
  // One row of My Devices: the revocable sign-in it always was, plus — for a
  // device that enrolled a Device Inbox — an honest send target.
  //
  // The security-relevant layout decision is that the send zone and the revoke
  // button are SIBLINGS, never nested. Revoke is destructive and irreversible
  // from here; a stray drop or a mis-aimed click that reached it would be the
  // worst possible outcome of a feature whose whole point is dragging files
  // around. So the drop handlers live on `.sendzone` alone, the drop stops
  // propagating there, and nothing about the row as a whole is clickable.
  import { onDestroy } from "svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session } from "./auth.svelte";
  import { formatSize } from "./format";
  import { hasFiles, filesFromDataTransfer } from "./drag";
  import { confirmDialog } from "./confirm-dialog.svelte";
  import {
    parseDeviceInbox,
    sendAvailability,
    isSaved,
    isServerTaskState,
    isTaskErrorCode,
    pollDelay,
    type DeviceInboxView,
    type InboxTaskView,
    type LocalPhase,
    type SendBlock,
    type SendCaveat,
    type SendErrorCode,
  } from "./device-inbox";
  import {
    CANCELLABLE_STATES,
    SendFailure,
    cancelInboxTask,
    fetchInboxTask,
    newIdempotencyKey,
    sendFilesToDevice,
  } from "./device-send";

  interface DeviceRow {
    ID: string;
    Name: string;
    CreatedAt: number;
    LastSeenAt: number;
    Kind: string;
    Inbox?: unknown;
  }

  interface Props {
    device: DeviceRow;
    /** Localized "App"/"CLI" badge, resolved by the page that owns the kind list. */
    kind: string;
    /** Localized "last used …" line for the bearer credential (not the inbox). */
    lastUsed: string;
    onRevoke: () => void;
  }

  const { device, kind, lastUsed, onRevoke }: Props = $props();
  const t = $derived<Messages>(messages[lang()]);

  // Read straight from the session rather than taken as a prop. Two accounts can
  // hold a device with the same id, and the list is keyed by id — so a sign-out
  // or an account switch can leave THIS component instance mounted while
  // everything on it now belongs to somebody else. Owning the check here means
  // it cannot be lost by a caller that forgets to pass it.
  const accountId = $derived(session().user?.id ?? "");

  // Requested ciphertext retention. A queued delivery has to outlive a machine
  // that is off for the weekend, so this is deliberately generous rather than
  // the upload page's one-day default; central clamps it to the account's plan
  // retention cap either way, and the task cannot outlive it (protocol §12).
  const DELIVERY_TTL_SECONDS = 604_800; // 7 days

  const inbox = $derived<DeviceInboxView | null>(parseDeviceInbox(device.Inbox));
  const avail = $derived(sendAvailability(device.ID, inbox));

  // ── send state ───────────────────────────────────────────────────────────
  // `local` is the sender-local phase (PRD §10 items 1-2): it exists only in
  // this browser and central stores none of it. `task` is what central actually
  // holds. They are separate fields, never one merged "status", because
  // collapsing them is exactly how "uploaded" turns into "sent".
  let local = $state<LocalPhase | null>(null);
  let sent = $state(0);
  let total = $state(0);
  let task = $state<InboxTaskView | null>(null);
  let error = $state<SendErrorCode | null>(null);
  let cancelFailed = $state(false);
  let fileCount = $state(0);
  let fileBytes = $state(0);
  let dragOver = $state(false);
  let dropRejected = $state(false);

  // Generation counter shared by the send and the poll. Anything async compares
  // against it before writing state, so a superseded send, a late poll, a
  // cancelled attempt and an account switch all become no-ops rather than
  // painting stale truth onto a card that has moved on.
  let gen = 0;
  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollAttempt = 0;
  let fileInput = $state<HTMLInputElement | null>(null);

  const busy = $derived(local !== null);
  const pct = $derived(total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0);

  function clearPoll() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /** Drop everything in flight and everything shown. Called when the account
   *  changes and on unmount.
   *
   *  The in-flight send is ABORTED rather than left to finish. Letting it run on
   *  would leave an upload nobody can see, cancel, or learn the outcome of — and
   *  on an account switch it would be finishing under credentials that now
   *  belong to somebody else. `sendFilesToDevice` releases whatever ciphertext
   *  it had already uploaded, so aborting costs quota rather than leaking it. */
  function reset() {
    gen++;
    clearPoll();
    controller?.abort();
    controller = null;
    local = null;
    task = null;
    error = null;
    cancelFailed = false;
    dragOver = false;
    dropRejected = false;
    fileCount = 0;
    fileBytes = 0;
  }

  // Plain `let`, not `$state`: it is only ever read and written inside the
  // effect below, and `null` marks "this card has not bound an account yet" so
  // the first run adopts the current one instead of counting as a change.
  let boundAccount: string | null = null;
  $effect(() => {
    const uid = accountId;
    if (boundAccount === null) {
      boundAccount = uid;
      return;
    }
    if (uid !== boundAccount) {
      boundAccount = uid;
      reset();
    }
  });

  onDestroy(reset);

  // ── polling ──────────────────────────────────────────────────────────────

  /** Arm the next status poll, or make sure none is armed.
   *
   *  Nothing is polled while the tab is hidden: a backgrounded phone throttles
   *  timers anyway, and a delivery that lands while the user is elsewhere is
   *  still there when they come back. `visibilitychange` re-arms with a reset
   *  backoff so returning to the tab refreshes immediately. */
  function armPoll() {
    clearPoll();
    if (!task || task.Terminal) return;
    if (typeof document !== "undefined" && document.hidden) return;
    pollTimer = setTimeout(runPoll, pollDelay(pollAttempt));
  }

  async function runPoll() {
    pollTimer = null;
    const mine = gen;
    const current = task;
    if (!current) return;
    const next = await fetchInboxTask(device.ID, current.ID);
    if (mine !== gen || task?.ID !== current.ID) return; // superseded or reset mid-flight
    if (next === null) {
      // Central says the task is gone: cancelled elsewhere, or swept past its
      // terminal retention. Stop rather than poll a 404 forever.
      clearPoll();
      task = null;
      return;
    }
    if (next) {
      // A state change is the only thing that resets the backoff, so a queued
      // task waiting on an offline device decays to one poll every 30s while an
      // active delivery stays responsive.
      pollAttempt = next.State === current.State && next.ErrorCode === current.ErrorCode ? pollAttempt + 1 : 0;
      task = next;
    } else {
      pollAttempt += 1; // transient failure: keep what we have, back off
    }
    armPoll();
  }

  function onVisibility() {
    if (typeof document !== "undefined" && !document.hidden) pollAttempt = 0;
    armPoll();
  }

  $effect(() => {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  });

  // ── sending ──────────────────────────────────────────────────────────────

  async function startSend(files: File[]) {
    if (!avail.sendable || busy) return;
    const key = inbox?.Key;
    if (!key) return;
    if (!files.length) {
      dropRejected = true;
      return;
    }
    const mine = ++gen;
    clearPoll();
    task = null;
    error = null;
    cancelFailed = false;
    dropRejected = false;
    pollAttempt = 0;
    fileCount = files.length;
    fileBytes = files.reduce((n, f) => n + f.size, 0);
    local = "encrypting";
    sent = 0;
    total = fileBytes;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const created = await sendFilesToDevice(
        {
          deviceID: device.ID,
          keyID: key.ID,
          keyGeneration: key.Generation,
          algorithm: key.Algorithm,
          publicKey: key.PublicKey,
        },
        files,
        {
          ttl: DELIVERY_TTL_SECONDS,
          idempotencyKey: newIdempotencyKey(),
          signal,
          onProgress: (p) => {
            if (mine !== gen) return;
            local = p.phase;
            sent = p.sent;
            total = p.total;
          },
        },
      );
      if (mine !== gen) return;
      task = created;
      local = null;
      armPoll();
    } catch (e) {
      if (mine !== gen) return;
      error = e instanceof SendFailure ? e.code : "unknown";
      local = null;
    } finally {
      if (mine === gen) controller = null;
    }
  }

  function cancelSend() {
    // Abort only; the send path itself decides what to clean up, because only it
    // knows whether an unbound ciphertext object exists yet.
    controller?.abort();
  }

  async function cancelDelivery() {
    const current = task;
    if (!current || !CANCELLABLE_STATES.has(current.State)) return;
    const mine = gen;
    if (!(await confirmDialog(t.deviceInbox.cancelTaskConfirm(device.Name)))) return;
    if (mine !== gen || task?.ID !== current.ID) return;
    const okDone = await cancelInboxTask(device.ID, current.ID);
    if (mine !== gen || task?.ID !== current.ID) return;
    if (!okDone) {
      cancelFailed = true;
      return;
    }
    clearPoll();
    task = null;
    error = "cancelled";
  }

  function dismiss() {
    gen++;
    clearPoll();
    task = null;
    error = null;
    cancelFailed = false;
    dropRejected = false;
  }

  // ── input events ─────────────────────────────────────────────────────────

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = ""; // so choosing the same file twice still fires a change
    void startSend(picked);
  }

  /** Claim a file drag for this card.
   *
   *  `preventDefault` happens for ANY file drag over this zone, including one
   *  arriving mid-send. Letting the default through there is not "ignoring the
   *  drop": the browser's default action for a dropped file is to NAVIGATE to
   *  it, which would tear down the page — and with it the upload that was the
   *  reason the card was busy in the first place. */
  function claimDrag(e: DragEvent): boolean {
    if (!hasFiles(e.dataTransfer?.types)) return false;
    e.preventDefault();
    e.stopPropagation(); // this card owns the drop; the page-wide handler must not also act
    return !busy;
  }

  function onDragOver(e: DragEvent) {
    if (!claimDrag(e)) return;
    dropRejected = false; // a fresh attempt clears the previous refusal
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  async function onDrop(e: DragEvent) {
    // A drag that never claimed to carry files is not aimed at this card — a
    // text selection, a dragged link. Left entirely alone, including its default
    // action, rather than answered with a refusal the user did not ask for.
    if (!claimDrag(e) || !e.dataTransfer) {
      dragOver = false;
      return;
    }
    dragOver = false;
    // Folders are flattened by the same walker the share upload uses. A drag
    // that announced `Files` and then produced none — an empty folder, an item
    // the browser would not hand over — IS refused out loud: it was aimed here
    // and nothing happened, which is the one case silence would be misread as
    // a send.
    const picked = await filesFromDataTransfer(e.dataTransfer);
    const files = picked.map((p) => p.file);
    if (!files.length) {
      dropRejected = true;
      return;
    }
    void startSend(files);
  }

  // ── copy ─────────────────────────────────────────────────────────────────

  function blockText(block: SendBlock): string {
    const d = t.deviceInbox;
    switch (block) {
      case "not_enrolled": return d.blockNotEnrolled;
      case "revoked": return d.blockRevoked;
      case "cannot_receive": return d.blockCannotReceive;
      case "unsupported_key": return d.blockUnsupportedKey;
      case "unsupported_capability": return d.blockUnsupportedCapability;
      case "receive_off": return d.blockReceiveOff;
      // `unknown_policy` and `unusable_id` both describe a device this build
      // cannot reason about, and neither has a user action distinct from the
      // other. Named rather than left to the default, so a NEW block reason
      // added later is a visible omission here instead of silently inheriting
      // a sentence that does not describe it.
      case "unknown_policy":
      case "unusable_id": return d.blockUnsupported;
      default: return d.blockUnsupported;
    }
  }

  function caveatText(c: SendCaveat): string {
    const d = t.deviceInbox;
    if (c === "queued_until_online") return d.caveatQueued;
    if (c === "needs_approval") return d.caveatApproval;
    return d.caveatDirNotReady;
  }

  function policyText(): string {
    const d = t.deviceInbox;
    if (avail.policy === "auto") return d.policyAuto;
    if (avail.policy === "ask") return d.policyAsk;
    if (avail.policy === "off") return d.policyOff;
    return "";
  }

  function localText(phase: LocalPhase): string {
    const d = t.deviceInbox;
    if (phase === "encrypting") return d.phaseEncrypting(pct);
    if (phase === "uploading") return d.phaseUploading(pct);
    return d.phaseRegistering;
  }

  /** The server state, mapped through the closed set. A state this build does
   *  not know renders `stateUnknown` — never the raw token. */
  function stateText(state: string): string {
    const d = t.deviceInbox;
    if (!isServerTaskState(state)) return d.stateUnknown;
    switch (state) {
      case "queued": return d.stateQueued;
      case "notified": return d.stateNotified;
      case "downloading": return d.stateDownloading;
      case "verifying": return d.stateVerifying;
      case "saved": return d.stateSaved;
      case "attention_required": return d.stateAttention;
      case "expired": return d.stateExpired;
      case "revoked": return d.stateRevoked;
      case "failed_retryable": return d.stateFailedRetryable;
      default: return d.stateFailedTerminal;
    }
  }

  /** The task's error token, mapped through the closed set (protocol §16). */
  function taskErrorText(code: string): string {
    const d = t.deviceInbox;
    if (!code) return "";
    if (!isTaskErrorCode(code)) return d.errUnknown;
    switch (code) {
      case "download_failed": return d.errDownloadFailed;
      case "decrypt_failed": return d.errDecryptFailed;
      case "verify_failed": return d.errVerifyFailed;
      case "disk_full": return d.errDiskFull;
      case "permission_denied": return d.errPermissionDenied;
      case "directory_unavailable": return d.errDirectoryUnavailable;
      case "name_conflict": return d.errNameConflict;
      case "user_declined": return d.errUserDeclined;
      case "unsupported": return d.errUnsupported;
      case "internal": return d.errInternal;
      case "lease_expired": return d.errLeaseExpired;
      case "attempts_exhausted": return d.errAttemptsExhausted;
      case "key_revoked": return d.errKeyRevoked;
      default: return d.errStoredObjectUnavailable;
    }
  }

  function sendErrorText(code: SendErrorCode): string {
    const d = t.deviceInbox;
    switch (code) {
      case "auto_receive_disabled": return d.sendErrAutoReceiveDisabled;
      case "device_cannot_receive": return d.sendErrDeviceCannotReceive;
      case "device_inbox_revoked": return d.sendErrDeviceInboxRevoked;
      case "stale_target_key": return d.sendErrStaleTargetKey;
      case "idempotency_key_conflict": return d.sendErrIdempotencyConflict;
      case "stored_object_unavailable": return d.sendErrStoredObjectUnavailable;
      case "stored_object_already_bound": return d.sendErrStoredObjectAlreadyBound;
      case "inbox_queue_full": return d.sendErrQueueFull;
      case "unsupported_key_algorithm": return d.sendErrUnsupportedKeyAlgorithm;
      case "unsupported_auto_accept_capability": return d.sendErrUnsupportedAutoAcceptCapability;
      case "malformed_wrapped_key": return d.sendErrMalformedWrappedKey;
      case "invalid_idempotency_key": return d.sendErrInvalidIdempotencyKey;
      case "upload_too_large": return d.sendErrTooLarge;
      case "quota_exceeded": return d.sendErrQuota;
      case "signed_out": return d.sendErrSignedOut;
      case "network": return d.sendErrNetwork;
      case "cancelled": return d.sendErrCancelled;
      case "unsupported_key": return d.sendErrUnsupportedKey;
      case "no_files": return d.sendErrNoFiles;
      default: return d.sendErrUnknown;
    }
  }

  /** When it was last heard from. Shown only while OFFLINE: for an online device
   *  the heartbeat is seconds old and the word "Online" is the whole answer. */
  function lastSeenText(): string {
    const d = t.deviceInbox;
    if (!inbox?.LastHeartbeatAt) return d.neverSeen;
    return d.lastSeen(new Date(inbox.LastHeartbeatAt * 1000).toLocaleString(lang()));
  }

  /** The single sentence the persistent live region announces.
   *
   *  Composed rather than assembled from several regions on purpose: a screen
   *  reader user needs "what is happening to my file" as one utterance, and the
   *  server state alone ("Waiting for the device") would not say whether the
   *  upload had even finished. */
  const liveStatus = $derived.by(() => {
    const d = t.deviceInbox;
    if (local) return localText(local);
    if (error) return sendErrorText(error);
    if (!task) return "";
    const detail = taskErrorText(task.ErrorCode);
    if (isSaved(task)) {
      return task.SavedAt > 0
        ? d.stateSavedAt(new Date(task.SavedAt * 1000).toLocaleString(lang()))
        : d.stateSaved;
    }
    // `saved` without the server-stamped commit time is an invalid partial
    // state. It must not flow through `stateText("saved")`, which would append
    // "Saved on the device" to the truthful "not saved" prefix and create a
    // contradictory delivery claim.
    const state = task.State === "saved" ? d.stateUnknown : stateText(task.State);
    // Everything short of `saved` says, explicitly, that Relayium holds the
    // ciphertext and the device does not have the file.
    const head = `${d.uploadedNotSaved} ${state}`;
    return detail ? `${head} — ${detail}` : head;
  });

  const showCancelDelivery = $derived(!!task && CANCELLABLE_STATES.has(task.State));
  const showDismiss = $derived(!local && (!!error || (!!task && task.Terminal)));
</script>

<li class:sendable={avail.sendable} class:has-inbox={!!inbox}>
  <span class="devicename">{device.Name}</span>
  <span class="devicekind">{kind}</span>
  <span class="deviceseen" class:never={!device.LastSeenAt}>{lastUsed}</span>

  {#if inbox}
    <!-- Presence is shown next to the policy, never instead of it: "online" and
         "will accept a file" are different questions (protocol §6). -->
    <!-- The word first, the detail after: "Last online 3pm" alone leaves the
         reader to infer the state, and this state drives a send decision. -->
    <span class="inboxpresence" class:on={avail.online}>
      <span class="pdot" aria-hidden="true"></span>{avail.online ? t.deviceInbox.online : t.deviceInbox.offline}
    </span>
    {#if !avail.online}<span class="inboxseen">{lastSeenText()}</span>{/if}
    {#if policyText()}
      <span class="inboxpolicy">{t.deviceInbox.policyLabel}: {policyText()}</span>
    {/if}
    {#if avail.policy === "auto"}
      <span class="inboxdir" class:bad={!inbox.ReceiveDirReady}>
        {inbox.ReceiveDirReady ? t.deviceInbox.dirReady : t.deviceInbox.dirNotReady}
      </span>
    {/if}
    {#if inbox.Platform || inbox.AppVersion}
      <span class="inboxmeta">{t.deviceInbox.platformLine(inbox.Platform || "—", inbox.AppVersion || "—")}</span>
    {/if}
  {/if}

  <!-- Sibling of the send zone, never inside it. -->
  <button class="del" aria-label={t.me.deviceRevokeLabel(device.Name, kind)} onclick={onRevoke}>
    {t.me.deviceRevoke}
  </button>

  {#if inbox}
    <div class="inboxblock">
      {#if avail.sendable}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="sendzone"
          class:dragover={dragOver}
          class:busy
          ondragover={onDragOver}
          ondragenter={onDragOver}
          ondragleave={onDragLeave}
          ondrop={onDrop}
        >
          <button
            class="sendbtn"
            type="button"
            disabled={busy}
            aria-label={t.deviceInbox.sendButtonLabel(device.Name)}
            onclick={() => fileInput?.click()}
          >
            {t.deviceInbox.sendButton}
          </button>
          <span class="drophint" aria-hidden="true">
            {dragOver ? t.deviceInbox.dropActive : t.deviceInbox.dropHint}
          </span>
          <input
            bind:this={fileInput}
            class="filepick"
            type="file"
            multiple
            tabindex="-1"
            aria-hidden="true"
            onchange={onPick}
          />
        </div>
        {#each avail.caveats as c (c)}
          <p class="inboxcaveat">{caveatText(c)}</p>
        {/each}
      {:else}
        <p class="inboxblocked">{blockText(avail.block ?? "not_enrolled")}</p>
      {/if}

      {#if local}
        <div class="sendprogress">
          <progress max="100" value={pct} aria-label={t.deviceInbox.progressLabel(device.Name)}></progress>
          <button class="linkish" type="button" onclick={cancelSend} aria-label={t.deviceInbox.cancelLabel(device.Name)}>
            {t.deviceInbox.cancel}
          </button>
        </div>
      {/if}

      {#if fileCount > 0 && (local || task)}
        <p class="sendfiles">{t.deviceInbox.fileSummary(fileCount, formatSize(fileBytes))}</p>
      {/if}

      {#if dropRejected}
        <p class="senderr">{t.deviceInbox.dropRejected}</p>
      {/if}
      {#if cancelFailed}
        <p class="senderr">{t.deviceInbox.cancelTaskFailed}</p>
      {/if}

      <!-- The live region is PERSISTENT: a screen reader only announces changes
           inside a region that already existed, so this element is always in the
           DOM and only its text changes. Empty when there is nothing true to
           say, and zero-height in that state. -->
      <p
        class="sendstatus"
        class:ok={isSaved(task)}
        class:bad={!!error || (!!task && task.Terminal && !isSaved(task))}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{liveStatus}</p>

      {#if showCancelDelivery || showDismiss}
        <div class="sendactions">
          {#if showCancelDelivery}
            <button
              class="linkish"
              type="button"
              aria-label={t.deviceInbox.cancelTaskLabel(device.Name)}
              onclick={cancelDelivery}
            >{t.deviceInbox.cancelTask}</button>
          {/if}
          {#if showDismiss}
            <button class="linkish" type="button" onclick={dismiss}>{t.deviceInbox.dismiss}</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</li>

<style>
  /* The row's own styling lives here rather than in MePage: Svelte scopes CSS
     per component, so a `.devicelist li` rule written in the page would no
     longer reach this element. Unchanged from what the page had, so an enrolled
     and an unenrolled device still look like the same list. */
  li {
    display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .devicename { flex: 1 1 auto; min-width: 0; color: var(--text-h); font-weight: 500; word-break: break-word; }
  /* 类型标签跟在设备名后面，做成一枚安静的徽章：它是分类，不是状态，颜色上抢不过
     "从未使用"那一条。不收缩，免得窄屏上被挤成竖排的单字。 */
  .devicekind {
    flex: 0 0 auto; font-size: var(--fs-xs); color: var(--text);
    padding: 2px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .deviceseen { font-size: var(--fs-xs); color: var(--text); }
  /* 从未使用过的设备最值得吊销——给它一点视觉重量，别和其他行糊在一起。 */
  .deviceseen.never { color: var(--danger); }
  .del {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .del:hover { border-color: var(--danger); color: var(--danger); }
  .del:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* The row keeps the layout it always had; the inbox block is a full-width
     second line under it, so an enrolled device does not squeeze the name,
     badge and revoke button into a narrower strip than an ordinary one. */
  .inboxblock {
    flex: 1 0 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-1);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  .inboxpresence, .inboxseen, .inboxpolicy, .inboxdir, .inboxmeta {
    flex: 0 0 auto;
    font-size: var(--fs-xs);
    color: var(--text);
  }
  .inboxpresence { display: inline-flex; align-items: center; gap: 6px; }
  .pdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text); opacity: .4; }
  .inboxpresence.on .pdot { background: var(--accent); opacity: 1; }
  .inboxdir.bad { color: var(--danger); }
  .inboxmeta { font-family: ui-monospace, monospace; }

  .sendzone {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-3);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    /* Logical property, so the dashed zone reads the same in Arabic. */
    text-align: start;
    transition: border-color .13s, background-color .13s;
  }
  .sendzone.dragover { border-color: var(--accent); border-style: solid; background: var(--code-bg); }
  .sendzone.busy { opacity: .75; }

  .sendbtn {
    font: inherit; font-size: var(--fs-xs); cursor: pointer;
    background: none; color: var(--accent-fg);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    transition: background-color .13s;
  }
  .sendbtn:hover:not(:disabled) { background: var(--social-bg); }
  .sendbtn:disabled { opacity: .6; cursor: default; }
  /* Visible focus is a requirement, not a default: the button is the keyboard
     path to a feature whose other path is a mouse drag. */
  .sendbtn:focus-visible, .linkish:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .drophint { font-size: var(--fs-xs); color: var(--text); }
  /* Kept in the layout but out of the a11y tree and the tab order: the button
     beside it is the accessible control. `display: none` would stop .click()
     working in some engines. */
  .filepick { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

  .inboxcaveat, .inboxblocked, .sendfiles, .senderr, .sendstatus {
    margin: 0; font-size: var(--fs-xs); line-height: 1.6; max-width: 68ch;
  }
  .inboxcaveat, .sendfiles { color: var(--text); }
  .inboxblocked { color: var(--text); }
  .senderr { color: var(--danger); }

  .sendprogress { display: flex; align-items: center; gap: var(--space-3); }
  .sendprogress progress { flex: 1 1 auto; max-width: 22rem; height: 6px; }

  .sendactions { display: flex; gap: var(--space-3); flex-wrap: wrap; }
  .linkish {
    font: inherit; font-size: var(--fs-xs); cursor: pointer;
    background: none; border: 0; padding: 0; color: var(--accent-fg);
    text-decoration: underline; text-underline-offset: 2px;
  }

  /* Empty by default and therefore invisible; the box only appears once there
     is a sentence in it. */
  .sendstatus.ok, .sendstatus.bad {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .sendstatus.ok { color: var(--text-h); background: var(--social-bg); border-color: var(--accent-border); }
  .sendstatus.bad { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }

  @media (prefers-reduced-motion: reduce) {
    .sendzone, .sendbtn { transition: none; }
  }

  @media (max-width: 520px) {
    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
    }
    .del { justify-self: end; }
    /* The row is a two-column grid at this width; the inbox block has to span
       both or it lands beside the revoke button. */
    .inboxblock { grid-column: 1 / -1; }
    .sendzone { flex-direction: column; align-items: stretch; }
    .sendbtn { width: 100%; }
  }
</style>
