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
  import { hasFiles, filesFromDataTransfer, pickedFromInput, type PickedFile } from "./drag";
  import { confirmDialog } from "./confirm-dialog.svelte";
  import { DEVICE_NAME_MAX, normalizeDeviceName } from "./device-identity";
  import {
    canSendText,
    parseDeviceInbox,
    sendAvailability,
    isSaved,
    isServerTaskState,
    isTaskErrorCode,
    pollDelay,
    textDraftSize,
    type DeviceInboxView,
    type InboxTaskView,
    type LocalPhase,
    type SendBlock,
    type SendCaveat,
    type SendErrorCode,
  } from "./device-inbox";
  import { INBOX_MANIFEST_MAX_TEXT_BYTES } from "./inbox-manifest";
  import {
    CANCELLABLE_STATES,
    SendFailure,
    cancelInboxTask,
    fetchInboxTask,
    newIdempotencyKey,
    sendFilesToDevice,
    sendTextToDevice,
  } from "./device-send";

  interface DeviceRow {
    ID: string;
    Name: string;
    CreatedAt: number;
    LastSeenAt: number;
    LastIP?: string;
    Kind: string;
    Inbox?: unknown;
  }

  interface Props {
    device: DeviceRow;
    /** Localized "App"/"CLI" badge, resolved by the page that owns the kind list. */
    kind: string;
    /** Localized "last used …" line for the bearer credential (not the inbox). */
    lastUsed: string;
    /** Localized "signed in …" — when this credential was approved. */
    signedIn: string;
    /** Localized short id fragment ("ID ends 3f21a9"), "" when the id is too
     *  short to shorten. It is what tells two identically named rows apart. */
    deviceRef: string;
    /** Whether this row manages the CREDENTIAL as well as presenting it.
     *
     *  `false` is not a cosmetic trim. /device-inbox renders the same row to
     *  answer one question — "can I send a file to this machine, and what will
     *  happen to it" — and revoke is an irreversible action about a different
     *  question, sitting one mis-aimed click from a drop target. Off there, on
     *  in My Devices, which is the page that exists to manage credentials.
     *
     *  Rename goes with it: an editor that persists a label is credential
     *  management too, and leaving it behind would put "Rename"/"Revoke"
     *  vocabulary on a surface whose own copy says to manage devices elsewhere. */
    manage?: boolean;
    /** Required when `manage` is true; ignored otherwise. */
    onRevoke?: () => void;
    /** Persist a new label. Resolves with what happened, so the row can say
     *  "that name can't be used" and "the request failed" differently — the
     *  first is the user's to fix, the second is worth retrying.
     *
     *  Required when `manage` is true; ignored otherwise. */
    onRename?: (name: string) => Promise<RenameOutcome>;
  }

  export type RenameOutcome = "ok" | "rejected" | "failed";

  const { device, kind, lastUsed, signedIn, deviceRef, manage = true, onRevoke, onRename }: Props = $props();

  // Each control is gated on its own handler as well as on `manage`: a caller
  // that asks for management without supplying one would otherwise render a
  // button that does nothing, which is worse than the missing button.
  const canRevoke = $derived(manage && !!onRevoke);
  const canRename = $derived(manage && !!onRename);
  const t = $derived<Messages>(messages[lang()]);

  // ── rename ───────────────────────────────────────────────────────────────
  // Inline, on the row, using the account-scoped PATCH the API has always had.
  // Duplicate labels stay legal: two machines really can both be "backup", and
  // `deviceRef` is what distinguishes them.
  let renaming = $state(false);
  let renameDraft = $state("");
  let renameError = $state<RenameOutcome | null>(null);
  let renameBusy = $state(false);

  function startRename() {
    renameDraft = device.Name;
    renameError = null;
    renaming = true;
  }

  function cancelRename() {
    renaming = false;
    renameBusy = false;
    renameError = null;
  }

  /** Autofocus + select the draft when the field appears. Selecting matters:
   *  the common rename is replacing a generic "CLI", not editing it. */
  function focusRename(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  async function submitRename(e: Event) {
    e.preventDefault();
    if (renameBusy) return;
    const next = normalizeDeviceName(renameDraft);
    // Unchanged or empty is a cancel, not a request. Sending the same name
    // would spend a round trip to achieve nothing; sending an empty one would
    // be refused by central anyway, and reporting that as an error would blame
    // the user for closing an editor.
    if (next === "" || next === device.Name) {
      cancelRename();
      return;
    }
    renameBusy = true;
    renameError = null;
    const outcome = onRename ? await onRename(next) : "failed";
    renameBusy = false;
    if (outcome === "ok") {
      renaming = false;
      return;
    }
    // The editor STAYS OPEN with the draft intact. Closing it on failure would
    // throw away what the user typed and leave them looking at the old name
    // with no explanation.
    renameError = outcome;
  }

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
  /** Which kind the delivery on screen is. One send is one kind, so this is
   *  what keeps a file summary from being left standing beside a message — and
   *  the message's own summary is a byte count, never its text. */
  let sendKind = $state<"files" | "text" | null>(null);
  let messageBytes = $state(0);

  // ── the message draft ────────────────────────────────────────────────────
  // The body lives HERE and nowhere else: never in a log, never in a request
  // field central can read, never in storage, and never in any state the status
  // line or the summary below renders. Everything downstream of this variable
  // sees a byte count.
  let draft = $state("");
  let composerOpen = $state(false);

  /** Whether offering a message to this device would be truthful. Separate from
   *  `avail.sendable` in both directions: a receiver without `inbox.text.v1` is
   *  still a perfectly good FILE target, and a `directory_not_ready` caveat says
   *  nothing about a message, which is never written to that folder. */
  const canText = $derived(canSendText(device.ID, inbox));
  const draftSize = $derived(textDraftSize(draft));
  // A `<label for>` and an `aria-controls` both need one. Derived from the
  // device id, which `sendAvailability` has already established is an inert
  // token before any of this renders, so two cards in one list never collide.
  const composerId = $derived(`inbox-composer-${device.ID}`);
  const fieldId = $derived(`${composerId}-field`);
  const countId = $derived(`${composerId}-count`);

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
    sendKind = null;
    messageBytes = 0;
    // The draft goes with them, for exactly the reason the rename editor below
    // does and more sharply: a half-typed message addressed to somebody else's
    // device, left in a field after an account switch, is the plainest possible
    // form of the leak this watcher exists to prevent.
    draft = "";
    composerOpen = false;
    // The rename editor goes too. The page clears `devices` on an account
    // switch, which unmounts every card — but this component owns the guard
    // precisely because it must not depend on the page remembering to. A
    // half-typed name for somebody else's device, left in an open field, is
    // exactly the leak the account watcher exists to prevent.
    renaming = false;
    renameBusy = false;
    renameError = null;
    renameDraft = "";
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

  /** `picked` carries each file's relative path as well as its bytes, so a
   *  dropped folder keeps its shape inside the encrypted manifest. Dropping the
   *  path here would flatten a folder into a pile of files on the other device. */
  async function startSend(picked: PickedFile[]) {
    if (!avail.sendable || busy) return;
    const key = inbox?.Key;
    if (!key) return;
    if (!picked.length) {
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
    sendKind = "files";
    messageBytes = 0;
    fileCount = picked.length;
    fileBytes = picked.reduce((n, p) => n + p.file.size, 0);
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
          // Carried even though a file send never reads it, so the target this
          // card builds describes the device rather than describing one action.
          capabilities: inbox?.Capabilities,
        },
        picked,
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

  /** Queue the draft as a MESSAGE.
   *
   *  Deliberately the same state machine as `startSend`: one `gen`, one
   *  `AbortController`, one `local` phase, one `task`, one poll. A parallel
   *  tracker for messages would give this card two sources of truth about what
   *  it is doing, and the first thing that would break is cancel.
   *
   *  `busy` is the double-send guard, exactly as it is for files — and because
   *  both kinds share it, a message cannot start beside a running file send
   *  either. One send is one kind, and one card runs one send. */
  async function startTextSend() {
    if (!canText || busy) return;
    const key = inbox?.Key;
    if (!key) return;
    // Snapshot the exact string that was measured. The field stays editable
    // while the send runs, so re-reading `draft` afterwards could queue a
    // different message than the one whose length was sealed — and could
    // measure sendable while the current text is not.
    const message = draft;
    const size = textDraftSize(message);
    if (!size.sendable) return;
    const mine = ++gen;
    clearPoll();
    task = null;
    error = null;
    cancelFailed = false;
    dropRejected = false;
    pollAttempt = 0;
    // A message carries no attachments, so any file summary from a previous
    // delivery is retired here rather than left standing beside it.
    sendKind = "text";
    fileCount = 0;
    fileBytes = 0;
    messageBytes = size.bytes;
    local = "encrypting";
    sent = 0;
    total = size.bytes;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const created = await sendTextToDevice(
        {
          deviceID: device.ID,
          keyID: key.ID,
          keyGeneration: key.Generation,
          algorithm: key.Algorithm,
          publicKey: key.PublicKey,
          // Read for real by this send: it is what makes the offer truthful,
          // and `sendTextToDevice` fails closed without it.
          capabilities: inbox?.Capabilities,
        },
        message,
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
      // Emptied ONLY here, and only when central actually holds the task:
      // retyping a message that was already queued would deliver it twice, and
      // clearing it any earlier would destroy the user's words on a failure
      // they can retry from. An edit made mid-send is theirs and is kept.
      if (draft === message) draft = "";
      armPoll();
    } catch (e) {
      // Every failure path — refused, cancelled, network — leaves the draft
      // exactly as it is, so Send can be pressed again without retyping it.
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
    // Through the shared normalizer, which reads `webkitRelativePath` — empty
    // for the plain multi-file pick this input offers, and the folder's own path
    // for anything that arrives carrying one.
    const picked = input.files ? pickedFromInput(input.files) : [];
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
    // The walker keeps each file's relative path, and it is carried through to
    // the manifest rather than flattened away here.
    const picked = await filesFromDataTransfer(e.dataTransfer);
    if (!picked.length) {
      dropRejected = true;
      return;
    }
    void startSend(picked);
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
      case "text_unsupported": return d.sendErrTextUnsupported;
      case "empty_message": return d.sendErrEmptyMessage;
      case "message_too_long": return d.sendErrMessageTooLong;
      case "unsendable_content": return d.sendErrUnsendableContent;
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
  {#if renaming && canRename}
    <form class="renameform" onsubmit={submitRename}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="renameinput"
        type="text"
        bind:value={renameDraft}
        maxlength={DEVICE_NAME_MAX}
        disabled={renameBusy}
        aria-label={t.me.deviceRenameField(device.Name)}
        aria-invalid={renameError !== null}
        onkeydown={(e) => { if (e.key === "Escape") cancelRename(); }}
        use:focusRename
      />
      <button class="chk" type="submit" disabled={renameBusy}>{t.me.deviceRenameSave}</button>
      <button class="chk" type="button" disabled={renameBusy} onclick={cancelRename}>{t.me.deviceRenameCancel}</button>
    </form>
  {:else}
    <span class="devicename">{device.Name}</span>
  {/if}
  <span class="devicekind">{kind}</span>
  <!-- A fragment of the opaque id, never the whole thing. It is the only part
       of the row that stays distinct when two machines share a label. -->
  {#if deviceRef}<span class="deviceref">{deviceRef}</span>{/if}

  <!-- The whole group is absent, not disabled, when this row does not manage the
       credential: an empty action strip would still take its layout slot and
       still read as "there are controls here". -->
  {#if canRevoke || canRename}
    <div class="rowactions">
      <!-- Hidden while the editor is open: pressing it again would call
           startRename and silently reset the draft the user is in the middle of
           typing. The editor has its own Save and Cancel. -->
      {#if canRename && !renaming}
        <button class="chk" aria-label={t.me.deviceRenameLabel(device.Name)} onclick={startRename}>
          {t.me.deviceRename}
        </button>
      {/if}
      <!-- Sibling of the send zone, never inside it. -->
      {#if canRevoke}
        <button
          class="del"
          aria-label={t.me.deviceRevokeLabel(device.Name, kind, deviceRef, signedIn)}
          onclick={onRevoke}
        >{t.me.deviceRevoke}</button>
      {/if}
    </div>
  {/if}

  <!-- Second line: when this credential was approved, and whether it has been
       used since. Both are here for the rows that predate device labels —
       they have no hostname to recover, and these two facts plus the id
       fragment are what make them tellable apart without a backfill. -->
  <p class="devicemeta">
    <span class="devicesigned">{signedIn}</span>
    <span class="dot" aria-hidden="true">·</span>
    <span class="deviceseen">{lastUsed}</span>
    {#if device.Kind === "cli" && device.LastIP}
      <span class="dot" aria-hidden="true">·</span>
      <span class="deviceip">{t.me.deviceIP(device.LastIP)}</span>
    {/if}
  </p>

  {#if renameError && canRename}
    <p class="renameerr" role="status" aria-live="polite">
      {renameError === "rejected" ? t.me.deviceRenameRejected : t.me.deviceRenameFailed}
    </p>
  {/if}

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
          <!-- A second kind, not a second mode: it opens its own composer and
               leaves the file controls exactly where they were. Disabled rather
               than removed when the target announces no message surface — the
               sentence under the zone is what says why.
               Not disabled by `busy`, unlike the file picker beside it: this
               opens a panel, it does not start a delivery. Writing the next
               message while an upload finishes is exactly what someone would
               want to do, and the composer's own Send button is what says a
               send cannot start yet. -->
          <button
            class="msgbtn"
            type="button"
            disabled={!canText}
            aria-expanded={canText ? composerOpen : undefined}
            aria-controls={canText && composerOpen ? composerId : undefined}
            aria-label={t.deviceInbox.sendMessageButtonLabel(device.Name)}
            onclick={() => { if (canText) composerOpen = !composerOpen; }}
          >
            {t.deviceInbox.sendMessageButton}
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
        <!-- Why the message control is disabled. Always present when it is, and
             never allowed to touch the file half above it: a receiver without
             `inbox.text.v1` takes files perfectly well.
             Deliberately NOT an `.inboxcaveat`: a caveat qualifies the send that
             IS on offer, and this qualifies nothing about dropping a file
             here. -->
        {#if !canText}
          <p class="inboxtextoff">{t.deviceInbox.textUnavailable}</p>
        {/if}

        <!-- The composer is a SIBLING of the drop zone, never inside it: a
             textarea within a file drop target would swallow a drag aimed at the
             zone, and a file dropped on it would start a delivery the user was
             in the middle of writing an alternative to. -->
        {#if canText && composerOpen}
          <div class="composer" id={composerId}>
            <!-- The heading is the field's own label and carries the target, so
                 the composer never reads as "a message" detached from a device. -->
            <label class="composerhead" for={fieldId}>{t.deviceInbox.composerHeading(device.Name)}</label>
            <textarea
              id={fieldId}
              class="composerfield"
              rows="3"
              bind:value={draft}
              placeholder={t.deviceInbox.messagePlaceholder}
              aria-describedby={countId}
              aria-invalid={draftSize.tooLong}
            ></textarea>
            <!-- The count is beside the field at all times rather than a refusal
                 afterwards, and it is the whole explanation of a disabled Send —
                 which is why the empty and over-the-bound sentences sit in it. -->
            <p class="composercount" class:bad={draftSize.tooLong} id={countId}>
              <span class="composerbytes">{t.deviceInbox.messageCount(draftSize.bytes, INBOX_MANIFEST_MAX_TEXT_BYTES)}</span>
              {#if draftSize.tooLong}
                <span class="composerwhy">{t.deviceInbox.messageTooLongHint(draftSize.overflow)}</span>
              {:else if draftSize.empty}
                <span class="composerwhy">{t.deviceInbox.messageEmptyHint}</span>
              {/if}
            </p>
            <div class="composeractions">
              <button
                class="sendbtn"
                type="button"
                disabled={busy || !draftSize.sendable}
                aria-label={t.deviceInbox.messageSendLabel(device.Name)}
                onclick={startTextSend}
              >
                {t.deviceInbox.messageSend}
              </button>
              <!-- Collapse, not discard: the draft survives so reopening the
                   composer is not a punishment for closing it. -->
              <button class="linkish" type="button" onclick={() => (composerOpen = false)}>
                {t.deviceInbox.composerClose}
              </button>
            </div>
            <p class="composernote">{t.deviceInbox.messagePrivacyNote}</p>
          </div>
        {/if}
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

      <!-- What this delivery carries, and only ever as a measurement: a count
           and a size for files, a byte count for a message. The body itself is
           never rendered here or anywhere else on this card. -->
      {#if sendKind === "text" && (local || task)}
        <p class="sendfiles">{t.deviceInbox.messageSummary(messageBytes)}</p>
      {:else if sendKind === "files" && fileCount > 0 && (local || task)}
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
  /* 类型标签跟在设备名后面，做成一枚安静的徽章：它是分类，不是状态。不收缩，免得
     窄屏上被挤成竖排的单字。 */
  .devicekind, .deviceref {
    flex: 0 0 auto; font-size: var(--fs-xs); color: var(--text);
    padding: 2px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  /* ID 尾号用等宽：它是一小截标识符，用户会拿它和另一行逐字比对。 */
  .deviceref { font-family: var(--mono); }
  /* 第二行：登录时间 + 自登录以来用没用过。整行占满，所以名字、徽章和两个按钮不会
     被挤成窄条——这也是窄屏上唯一需要的布局规则。 */
  .devicemeta {
    flex: 1 0 100%; margin: 0;
    display: flex; flex-wrap: wrap; gap: var(--space-2);
    font-size: var(--fs-xs); color: var(--text);
  }
  .devicemeta .dot { opacity: .6; }
  /* 按钮成组，推到行尾。用 margin-inline-start 而不是网格：这一行的元素数量随
     "有没有 ID 尾号"变化，固定列数的网格会在某些行上错位。 */
  .rowactions {
    flex: 0 0 auto; margin-inline-start: auto;
    display: flex; gap: var(--space-2); flex-wrap: wrap;
  }
  .chk, .del {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .chk:hover:not(:disabled) { border-color: var(--accent-border); color: var(--accent-fg); }
  .chk:disabled { opacity: .6; cursor: default; }
  .del:hover { border-color: var(--danger); color: var(--danger); }
  .chk:focus-visible, .del:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* 改名：就地替换设备名那一格，宽度跟着它走。 */
  .renameform {
    flex: 1 1 260px; min-width: 0;
    display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center;
  }
  .renameinput {
    flex: 1 1 140px; min-width: 0;
    font: inherit; font-size: var(--fs-sm); color: var(--text-h);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 2px 8px;
  }
  .renameinput:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .renameinput[aria-invalid="true"] { border-color: var(--danger); }
  .renameerr {
    flex: 1 0 100%; margin: 0;
    font-size: var(--fs-xs); line-height: 1.6; max-width: 68ch; color: var(--danger);
  }

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
  /* …except the message control, which stays live during a send. Dimming it
     with the rest of the zone would make the one control that still works look
     like the ones that don't. */
  .sendzone.busy .msgbtn { opacity: 1; }

  .sendbtn {
    font: inherit; font-size: var(--fs-xs); cursor: pointer;
    background: none; color: var(--accent-fg);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    transition: background-color .13s;
  }
  /* The message control is the quieter sibling of Send files: same size and
     rhythm, an outline rather than the accent, so the zone still has one
     primary action while both kinds are equally reachable. */
  .msgbtn {
    font: inherit; font-size: var(--fs-xs); cursor: pointer;
    background: none; color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    transition: border-color .13s, color .13s;
  }
  .msgbtn:hover:not(:disabled) { border-color: var(--accent-border); color: var(--accent-fg); }
  .msgbtn:disabled { opacity: .6; cursor: default; }
  .msgbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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

  /* The composer: a quiet panel under the drop zone rather than a second boxed
     surface beside it, so an enrolled row does not grow two competing frames. */
  .composer {
    display: flex; flex-direction: column; gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .composerhead { font-size: var(--fs-xs); color: var(--text-h); }
  .composerfield {
    /* `width: 100%` with the default content-box would overflow its padding out
       of the panel at the narrowest widths. */
    box-sizing: border-box; width: 100%; min-height: 5.5rem; resize: vertical;
    font: inherit; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-h);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: var(--space-2);
    /* Logical, so the field and its text read the same in a right-to-left UI. */
    text-align: start;
  }
  .composerfield:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .composerfield[aria-invalid="true"] { border-color: var(--danger); }
  .composercount {
    margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-2);
    font-size: var(--fs-xs); color: var(--text);
  }
  /* Tabular digits: the count changes on every keystroke and a proportional
     font makes the whole line jitter while typing. */
  .composerbytes { font-variant-numeric: tabular-nums; }
  .composercount.bad { color: var(--danger); }
  .composeractions { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
  .composernote { margin: 0; font-size: var(--fs-xs); line-height: 1.6; max-width: 68ch; color: var(--text); }

  .inboxcaveat, .inboxtextoff, .inboxblocked, .sendfiles, .senderr, .sendstatus {
    margin: 0; font-size: var(--fs-xs); line-height: 1.6; max-width: 68ch;
  }
  .inboxcaveat, .inboxtextoff, .sendfiles { color: var(--text); }
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
    .sendzone, .sendbtn, .msgbtn { transition: none; }
  }

  @media (max-width: 520px) {
    /* The row stays a wrapping flex line at every width — it used to become a
       two-column grid here, which only worked while the row had exactly a
       name, a badge and one button in it. The actions now take a full line of
       their own rather than being squeezed beside a wrapped device name. */
    .rowactions { flex: 1 0 100%; margin-inline-start: 0; }
    .sendzone { flex-direction: column; align-items: stretch; }
    /* Covers the composer's Send too, which is a `.sendbtn` as well. */
    .sendbtn, .msgbtn { width: 100%; }
    .composeractions { flex-direction: column; align-items: stretch; }
  }
</style>
