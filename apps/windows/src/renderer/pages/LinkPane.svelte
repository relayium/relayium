<!--
  One verified connection, carrying everything, in both directions.

  Reached only after Connect, which is why there is no picker anywhere before
  this component. Text and any number of file/folder batches ride the same
  `link/1`.

  ## Why the inbound half is not optional

  An earlier draft of this pane had send buttons and a composer and nothing
  else. That is not "most of a transfer UI" — it is a client that can talk and
  cannot listen: an incoming batch had no way to be accepted or declined, an
  arriving message went into a history nothing rendered, and a transfer in
  progress could be neither watched nor stopped. Every one of those is a state
  the protocol produces on an ordinary run.

  ## Verification is a preference, not a gate

  `VerificationPreference` defaults OFF and this mirrors it. Commit-reveal and
  AEAD run on every link either way, so the key exchange is authenticated
  regardless.

  Comparing the code is nevertheless a real and separate protection — it is what
  catches an active attacker on the signalling path who completes a handshake
  with each side, which the cryptography alone cannot rule out because both
  halves are individually valid. Leaving it off declines that check.

  When it is ON it gates **both directions**: nothing is sent and no incoming
  batch or message can be accepted until the code is confirmed. Hiding the
  outbound buttons alone would leave the inbound consent reachable, which is the
  direction an attacker actually wants. The confirmation lives on the
  controller, keyed to the link generation, so it survives leaving this page and
  does not carry over to a later link that drew the same six digits.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { t } from "../i18n/index.svelte.js";
  import Card from "../shell/Card.svelte";
  import { pickedFromInput, pickedFromDrop } from "../send/picked-files.js";
  import { MAX_FILES } from "../../../../../web/src/lib/manifest";
  import { sendGate, type Ticket } from "../send/send-gate.svelte.js";
  import { linkEndKey, linkIsTerminal } from "../rooms/link-ending.js";
  import { publishFailureKey, textErrorMessageKey } from "../rooms/lane-copy.js";
  import type { PublishFailureReason } from "../../shared/ipc-contract.js";

  /** An outgoing intent: the quit permission, and the conversation it was for. */
  type Intent = { ticket: Ticket; peerId: string; linkGeneration: number } | null;
  import type { RoomController } from "../rooms/room-controller.svelte.js";
  import type { RevealController } from "../receive/reveal-controller.svelte.js";
  import type { ReceivedController, ReceivedRefusal } from "../receive/received-controller.svelte.js";
  import type { RevealRefusal } from "../../shared/receive-receipt.js";
  import type { PickedFile } from "../../../../../web/src/lib/drag";

  let {
    room,
    reveal,
    received,
    verifyPeers,
    messageDraft = $bindable(""),
  }: {
    room: RoomController;
    /** "Open the folder", for a receive that has already saved. Separate from
     *  `room` on purpose: it is driven by a push from main after the transfer
     *  is over, and a reveal that fails must not land in the transfer's own
     *  state where it would read as "the files did not arrive". */
    reveal: RevealController;
    /** The files that receive wrote, one token each. Pushed by main. */
    received: ReceivedController;
    verifyPeers: boolean;
    messageDraft?: string;
  } = $props();

  const workspace = $derived(room.workspace);
  const peerId = $derived(workspace.linkPeerId);
  /**
   * What the peer called itself, and a short id only when it has not said.
   *
   * A raw peer id is a server-issued hex string. Showing one to a user is
   * showing them an implementation detail and asking them to recognise their
   * own laptop by it.
   */
  const peerLabel = $derived(room.peerName(peerId) || peerId.slice(0, 6));
  const sas = $derived(workspace.sasCode);
  /**
   * The link's REAL state.
   *
   * `linkPeerId` becomes non-empty the moment the workspace owns the screen —
   * which includes a request that is still in flight. Titling that "Connected"
   * claims a transport that does not exist yet, and the send controls under it
   * would be pressable against nothing.
   */
  const status = $derived(workspace.linkStatus);
  const connected = $derived(status === "open");

  /**
   * Why the link ended, when the workspace knows.
   *
   * Published by the shared workspace since Windows started using it and read
   * by nothing here until now. Two of its three values are named endings the
   * user has to act on differently — an expired relay credential means make a
   * new code, a lost signalling socket means this link can never come back —
   * and both used to arrive as the same unexplained "Failed".
   */
  const endReason = $derived(workspace.linkEndReason);
  /** The link is over, whether or not the ending had a name. One rule, in a
   *  module, because three things below ask it. */
  const terminal = $derived(linkIsTerminal(endReason, status));
  /** A WARNING, not a state: both lanes still work while this is true. */
  const relayExpiring = $derived(workspace.relayExpiring);
  /** False means this link cannot be rebuilt if it drops. Said BEFORE it does. */
  const recoveryAvailable = $derived(workspace.recoveryAvailable);

  const STATUS_KEY = {
    idle: "linkStatusIdle",
    requesting: "linkStatusRequesting",
    connecting: "linkStatusConnecting",
    open: "linkStatusOpen",
    interrupted: "linkStatusInterrupted",
    failed: "linkStatusFailed",
  } as const;

  /**
   * Whether content is still gated.
   *
   * ## The bypass this replaces
   *
   * It used to read `verifyPeers && sas !== "" && !confirmed`. The `sas !== ""`
   * term looks like a guard and is the opposite of one: before the verification
   * code has been derived, `sas` IS empty, so the whole expression is false and
   * the gate is open — at exactly the moment there is nothing to have verified.
   * A user who asked to check every peer could therefore send and accept files
   * in the window before authentication produced anything to check.
   *
   * So the preference alone decides whether a gate exists, and the code's
   * absence is a reason to WAIT rather than to proceed.
   */
  const needsConfirmation = $derived(verifyPeers && !room.verificationConfirmed);
  /** Gated, and nothing to show yet: the code has not been derived. */
  const awaitingSas = $derived(needsConfirmation && sas === "");

  let declined = $state(false);
  let dragging = $state(false);

  const incoming = $derived(workspace.incoming);
  const recv = $derived(workspace.recv);
  const send = $derived(workspace.send);
  const text = $derived(workspace.text);

  const receipt = $derived(room.lastReceipt);

  /** One sentence per named reason, over the WHOLE union. See `lane-copy.ts`
   *  for what the chain this replaces got wrong, in both directions. */
  const failureText = (reason: PublishFailureReason): string => t(publishFailureKey(reason));

  /**
   * One sentence per closed refusal, and each one names a different situation.
   *
   * A single "could not open the folder" would cover a folder the user deleted,
   * a quit in progress and a receipt that expired with their account — three
   * things with three different next actions, only one of which is "look again".
   */
  /**
   * One sentence per refusal, each naming a different situation.
   *
   * Separate from `revealText` because these are about ONE file rather than the
   * folder: "that file is gone" and "that folder is gone" have different next
   * actions, and one sentence covering both would be wrong for whichever the
   * user is actually looking at.
   */
  function receivedText(reason: ReceivedRefusal): string {
    if (reason === "missing") return t("recvActionMissing");
    if (reason === "unknown-token") return t("recvActionExpired");
    if (reason === "unavailable") return t("recvActionClosing");
    return t("recvActionFailed");
  }

  function revealText(reason: RevealRefusal): string {
    if (reason === "missing") return t("recvRevealMissing");
    if (reason === "stale" || reason === "unknown") return t("recvRevealExpired");
    if (reason === "fenced") return t("recvRevealClosing");
    return t("recvRevealFailed");
  }

  const percent = (x: { sent: number; total: number }) =>
    x.total > 0 ? Math.min(100, Math.round((x.sent / x.total) * 100)) : 0;

  /**
   * Start an outgoing batch, unless the page is fenced.
   *
   * The gate is checked HERE rather than at the control, because every caller
   * below reaches this after an await — a native picker the user was inside, or
   * a drop being read off the filesystem — and the answer can have changed.
   */
  /**
   * Permission taken when the user OPENED a picker.
   *
   * The native dialog is opened by the click and answered whenever the person
   * gets round to it; `change` can be minutes later. Checking the fence at
   * `change` alone would let a quit begin and be answered in between and still
   * send, and checking a boolean would also let it through after a Stay — the
   * intent belongs to the moment they clicked, so the permission is taken then.
   */
  let pickIntent = $state<Intent>(null);

  /**
   * Everything an outgoing batch was intended FOR, captured when the user asked.
   *
   * Not just the quit ticket. Between the click and the `change` — or between
   * the drop and the directory finishing being read — the connection can be
   * replaced, the peer can change, and verification can be switched on. Each of
   * those makes the files the user chose belong to a different conversation than
   * the one they will be sent into, and checking only at the start is how a
   * batch lands on the wrong peer or past a verification gate the user just
   * asked for.
   *
   * `linkGeneration` is the workspace's own identity for the current link — the
   * same value `RoomController` uses to abandon receives from a replaced
   * connection — so there is no second counter to keep in step.
   */
  function captureIntent(): Intent {
    if (needsConfirmation) return null;
    const ticket = sendGate.ticket();
    if (ticket === null) return null;
    return { ticket, peerId, linkGeneration: workspace.linkGeneration };
  }

  /** Whether that intent still describes what is on screen right now. */
  function intentHolds(intent: Intent): boolean {
    return (
      intent !== null &&
      sendGate.valid(intent.ticket) &&
      !needsConfirmation &&
      connected &&
      intent.peerId === peerId &&
      intent.peerId !== "" &&
      intent.linkGeneration === workspace.linkGeneration
    );
  }

  function beginPick() {
    pickIntent = captureIntent();
  }

  function sendPicked(files: PickedFile[]) {
    const intent = pickIntent;
    pickIntent = null;
    if (intent === null || files.length === 0 || !intentHolds(intent)) return;
    // Cleared before the attempt, like `dropRefused` above: whatever this
    // selection turns out to be, the previous refusal is no longer what the
    // person is looking at.
    room?.clearSendRefusal();
    workspace.sendFiles(intent.peerId, files);
  }

  /** Set when a drop was refused whole; cleared by the next drop that works. */
  let dropRefused = $state(false);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    dropRefused = false;
    // Captured BEFORE the read, which is asynchronous for a dropped directory,
    // and re-checked in full after it.
    const intent = captureIntent();
    if (intent === null) return;
    void pickedFromDrop(event.dataTransfer).then((dropped) => {
      if (!intentHolds(intent)) return;
      // A partial batch is never offered, so this is the only place that can
      // tell the person their folder was not taken. Silence here is what made
      // a truncated folder look like a delivered one.
      if (!dropped.complete) {
        dropRefused = true;
        return;
      }
      dropRefused = false;
      if (dropped.files.length === 0) return;
      // Same clearing as `sendPicked`: the drop path reaches `sendFiles`
      // directly rather than through it.
      room?.clearSendRefusal();
      workspace.sendFiles(intent.peerId, dropped.files);
    });
  }

  /**
   * The message the user pressed Send on, waiting for the lane to open.
   *
   * ## The two failures this shape exists for
   *
   * **The message vanished.** `MixedTextSession.send` RETURNS NORMALLY when the
   * lane is not open (`mixed-text-session.svelte.ts:692`): no throw, no history
   * entry. Awaiting it proves nothing, so the composer cleared the box on a send
   * that had not happened. An outgoing conversation is `waitingAccept` until the
   * peer accepts, which is why sending only ever worked after receiving.
   *
   * **Then it was sent twice.** The first correction drove the retry from an
   * `$effect` that read the transcript — and `sendText` WRITES the transcript,
   * so the effect invalidated itself mid-flight and re-entered while the held
   * message was still marked waiting. One click, two messages, observed on the
   * peer.
   *
   * So: `sending` is set SYNCHRONOUSLY before the first await and is what the
   * effect checks; the effect tracks only the status, the held body and
   * `sending`, and calls out through `untrack`; and acceptance is decided by
   * finding THIS body among entries added after this send, never by "the last
   * outbound entry" — which a repeat of the same text would satisfy for free.
   */
  let awaitingLane = $state<string | null>(null);
  /** What the held message was composed for: the quit permission AND the
   *  connection. A fence, a new peer or a replaced link all release the hold
   *  rather than delivering it somewhere it was not meant to go. */
  let awaitingIntent = $state<Intent>(null);
  /** The body in flight right now. Synchronous; the serialization point. */
  let sending = $state<string | null>(null);
  let sendState = $state<"idle" | "waiting" | "failed">("idle");

  /** Which sentence the lane's own error is. Never a raw key, and now never
   *  silence either: the chain this replaces covered four of six named members
   *  and returned "" for `flooding` and `failed`. */
  const laneError = $derived.by(() => {
    const key = textErrorMessageKey(text.errorKey);
    return key === "" ? "" : t(key);
  });

  /**
   * Send one body, or hold it and ask the lane to open.
   *
   * Deliberately NOT "disable the composer until the lane is open": the lane
   * only opens because somebody asks it to, so a disabled box is a conversation
   * neither side can start. Pressing Send IS the ask.
   */
  async function deliver(body: string, intent: Intent) {
    // Serialization, and it must be the first thing: everything below can yield.
    if (sending !== null) return;
    // Reached from the composer AND from the auto-delivery effect below, which
    // has no button and fires when the PEER accepts — so the whole intent is
    // checked here, at the one place both of them pass through.
    if (!intentHolds(intent)) return;
    sending = body;

    if (text.status !== "open") {
      awaitingLane = body;
      awaitingIntent = intent;
      sendState = "waiting";
      sending = null;
      // A no-op on a lane that is already connecting, so pressing Send twice
      // does not open twice.
      void workspace.openText(peerId);
      return;
    }

    // The transcript's own monotonic id, NOT its length.
    //
    // `record` appends `{ id: nextId++, ... }` and then trims from the FRONT at
    // `TEXT_HISTORY_MAX` (200). So on a full transcript every successful send
    // leaves the length at exactly 200 — and a "did anything get added?" check
    // written as `slice(before)` returns empty for a message that was delivered
    // perfectly. The composer would report failure, keep the text, and the user
    // would send again: a duplicate on the peer, caused by the check rather
    // than by the send.
    //
    // Ids are the model's contract for this and they never repeat within a
    // conversation, so they say what a saturating length cannot.
    //
    // Untracked: the effect below must not gain a dependency on the transcript,
    // which is exactly what `sendText` is about to write to.
    const lastId = untrack(() => text.history.at(-1)?.id ?? 0);
    let threw = false;
    try {
      // Last check before the write. `deliver` has yielded at least once by now
      // if it had to open the lane, and a fence, a verification switch or a
      // replaced link in that window all invalidate the intent.
      if (!intentHolds(intent)) throw new Error("no longer this conversation");
      await workspace.sendText(body);
    } catch {
      threw = true;
    }
    const accepted =
      !threw &&
      untrack(() =>
        text.history.some(
          (entry) =>
            entry.id > lastId && entry.dir === "out" && entry.body === body && !entry.failed,
        ),
      );

    sending = null;
    awaitingLane = null;
    if (!accepted) {
      // Kept in the box, and said out loud. The user presses Send again; this
      // never retries on its own, which is what would turn one refusal into a
      // loop.
      sendState = "failed";
      return;
    }
    sendState = "idle";
    // Only if it is still the same text. Someone who typed a new message while
    // the old one was in flight must not have it deleted by that one landing.
    if (messageDraft.trim() === body) messageDraft = "";
  }

  async function sendMessage() {
    const body = messageDraft.trim();
    if (body === "" || needsConfirmation) return;
    if (awaitingLane !== null || sending !== null) return;
    // Taken here: this press IS the intent, and everything downstream carries it.
    await deliver(body, captureIntent());
  }

  /** Statuses from which this lane will never become `open` for this attempt. */
  const LANE_TERMINAL: readonly string[] = ["refused", "peerBusy", "unsupported", "failed", "ended"];

  /**
   * The held message's two possible endings.
   *
   * ## Opened
   *
   * Depends on exactly the status, the held body and `sending`, and reaches
   * `deliver` through `untrack` — so the transcript write `deliver` performs
   * cannot re-enter it. `sending` is set before `deliver`'s first await, so the
   * re-run this effect's own invalidation causes finds it non-null and stops.
   *
   * ## Never opening
   *
   * The half that was missing, and it stranded the user. A held message was
   * released only by the lane becoming `open`, so a peer that DECLINED the
   * conversation — or was busy, or could not hold one, or simply never answered
   * until the request timed out — left it held forever. `sendMessage` returns
   * early while anything is held, so the composer was dead for the rest of the
   * link with no way to clear it: the same "waits forever" shape the
   * disconnected state was added to remove elsewhere.
   *
   * Every terminal status therefore releases the hold and puts the text back, so
   * the user can read the reason in `laneError` and decide what to do.
   */
  $effect(() => {
    const status = text.status;
    const held = awaitingLane;
    if (held === null) return;

    // A quit fenced this page, verification was switched on, or the link was
    // replaced while the message was held. The lane opening afterwards is the
    // PEER acting, not the user asking again — delivering here would send into a
    // conversation the user never chose.
    if (!intentHolds(awaitingIntent)) {
      untrack(() => {
        awaitingLane = null;
        awaitingIntent = null;
        sendState = "idle";
        if (messageDraft.trim() === "") messageDraft = held;
      });
      return;
    }

    if (status === "open") {
      if (sending !== null) return;
      const intent = awaitingIntent;
      untrack(() => void deliver(held, intent));
      return;
    }
    if (!LANE_TERMINAL.includes(status)) return;
    untrack(() => {
      awaitingLane = null;
      awaitingIntent = null;
      sendState = "failed";
      // Restored only into an empty box: a message typed while this one was
      // held belongs to the user, not to this release.
      if (messageDraft.trim() === "") messageDraft = held;
    });
  });


</script>

{#if declined}
  <Card title={t("linkVerifyTitle")}>
    <p class="dim">{t("linkVerifyDeclined")}</p>
  </Card>
{:else}
  {#if needsConfirmation}
    <!-- Gates both directions. Nothing below is reachable until this is answered. -->
    <Card title={t("linkVerifyTitle")}>
      {#if awaitingSas}
        <!-- No code yet. There is nothing to compare, so there is nothing to
             confirm — and content stays gated rather than flowing through the
             gap. -->
        <p class="dim" data-test="sas-pending">{t("linkVerifyPending")}</p>
        <div class="indeterminate" role="progressbar" aria-label={t("linkVerifyPending")}><span></span></div>
      {:else}
      <p class="dim">{t("linkVerifyBody")}</p>
      <p class="sas" data-test="sas">{sas}</p>
      <button class="primary" data-test="sas-confirm" onclick={() => room.confirmVerification()}>
        {t("linkVerifyConfirm")}
      </button>
      <button
        data-test="sas-decline"
        onclick={() => {
          declined = true;
          room.disconnect();
        }}
      >
        {t("linkVerifyDecline")}
      </button>
      {/if}
    </Card>
  {:else if !connected}
    <!-- Truthful about which state this actually is, and cancellable in every
         one of them: a connection attempt the user cannot stop is one they have
         to quit the app to escape. -->
    <Card
      title={status === "requesting"
        ? t("linkRequesting", { peer: peerLabel })
        : status === "interrupted"
          ? t("linkInterrupted", { peer: peerLabel })
          : status === "failed"
            ? t("linkFailed", { peer: peerLabel })
            : t("linkConnecting", { peer: peerLabel })}
    >
      <!-- A named ending REPLACES the status line rather than sitting beside
           it: "Not connected" is true and useless next to a connection that
           stopped because its relay ran out. A plain failure keeps the status
           word, which is the most this side actually knows. -->
      {#if endReason}
        <p class="dim small" data-test="link-end-reason">{t(linkEndKey(endReason))}</p>
      {:else}
        <!-- Localised. The raw enum is an English identifier and would sit
             under a Chinese title as `requesting`. -->
        <p class="dim small" data-test="link-status">{t(STATUS_KEY[status])}</p>
      {/if}
      <!-- Indeterminate on purpose: there is no percentage to show while ICE is
           gathering, and a fake determinate bar would be inventing one. Under
           reduced motion the animation is off and this is a static track, which
           still reads as "in progress" beside the status line. -->
      {#if status === "requesting" || status === "connecting"}
        <div class="indeterminate" role="progressbar" aria-label={t("linkConnecting", { peer: peerLabel })}>
          <span></span>
        </div>
      {/if}
      <!-- The way out of a terminal state, and it is worded as one: Cancel
           stops something in progress, and there is nothing in progress here.

           `dismissLinkEnd()` ALONE, deliberately. It clears the reason and the
           failed status, which drops `usingMixed()` — the shared rule that
           keeps an unread ending on screen — so `linkPeerId` empties and the
           pairing screen comes back with its Create button. Calling
           `room.disconnect()` as well would ALSO set `userStopped`, and with
           the peer still on the roster that lands on "Disconnected /
           Reconnect": an offer to rebuild the very link whose relay just ran
           out, which is the one thing macOS says not to do here.

           The draft goes with it. It was typed for a conversation that no
           longer exists, and carrying it into the next link would put text
           meant for one peer in the composer for another. The web clears its
           compose field at the same point. -->
      {#if terminal}
        <button
          class="primary"
          data-test="link-restart"
          onclick={() => {
            messageDraft = "";
            workspace.dismissLinkEnd();
          }}
        >
          {t("linkRestart")}
        </button>
      {:else}
        <button data-test="link-cancel" onclick={() => room.disconnect()}>{t("linkCancel")}</button>
      {/if}
    </Card>
  {:else}
    <Card title={t("linkConnected", { peer: peerLabel })}>
      {#if sas}<p class="dim small" data-test="sas">{sas}</p>{/if}

      <!-- Two WARNINGS, not states. The link is fully live under both and every
           control below stays usable; they gate nothing.

           `recoveryAvailable` is worth saying only before anything breaks: once
           the transport is gone, "this cannot be restored" is news too late.

           The `!terminal` guard is belt and braces and is written down as such
           rather than claimed to be load-bearing: both getters already answer
           the safe way once the link is gone — `relayExpiring` is ANDed with
           `manager.current`, and `recoveryAvailable` returns true with no link,
           because a warning on a screen with nothing to lose is noise. The
           guard states the rule at the surface that has to hold it, so a change
           to either getter cannot quietly put a warning under a dead link. -->
      {#if !terminal && relayExpiring}
        <p class="problem small" data-test="link-relay-expiring" role="status">
          {t("linkRelayExpiring")}
        </p>
      {/if}
      {#if !terminal && !recoveryAvailable}
        <p class="problem small" data-test="link-no-recovery" role="status">
          {t("linkRecoveryUnavailable")}
        </p>
      {/if}

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="drop"
        class:over={dragging}
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
      >
        {#if dropRefused}
          <p class="problem small" data-test="drop-refused" role="status">{t("dropUnreadable")}</p>
        {:else if room?.sendRefusal === "too-many-files"}
          <!-- A different refusal from the one above and it says so: one is a
               file that could not be read, this is a selection that is simply
               too large. Telling them apart is the difference between checking
               a disk and sending fewer files. -->
          <p class="problem small" data-test="send-refused-count" role="status">
            {t("sendTooManyFiles", { max: MAX_FILES })}
          </p>
        {/if}
        <!-- The picker is opened by a real user gesture on a real control, so
             Electron shows the native Windows dialog and this app needs no
             arbitrary-path read channel at all. -->
        <label class="button primary">
          {t("linkSendFiles")}
          <input
            type="file"
            multiple
            disabled={sendGate.fenced}
            onclick={beginPick}
            onchange={(e) => sendPicked(pickedFromInput(e.currentTarget))}
          />
        </label>
        <label class="button">
          {t("linkSendFolder")}
          <input
            type="file"
            webkitdirectory
            disabled={sendGate.fenced}
            onclick={beginPick}
            onchange={(e) => sendPicked(pickedFromInput(e.currentTarget))}
          />
        </label>
        <span class="dim small">{t("linkDropHint")}</span>
      </div>

      <!-- The room's own disconnect, which also records the intent. A bare
           `workspace.disconnect()` leaves every rule that rebuilds the link in
           force, and auto-connect re-offered in the same frame. -->
      <button class="quiet" data-test="disconnect" onclick={() => room.disconnect()}>
        {t("lanDisconnect")}
      </button>
    </Card>
  {/if}

  <!-- An offer waiting on the user. Declining is a first-class answer, not a
       missing button, and the retry case says so rather than leaving the card
       looking stuck. -->
  {#if incoming && !needsConfirmation && connected}
    <Card title={t("recvIncoming", { peer: incoming.from.slice(0, 6), count: incoming.files.length })}>
      <ul class="files">
        {#each incoming.files.slice(0, 5) as file (file.path ?? file.name)}
          <li>{file.path ?? file.name}</li>
        {/each}
        {#if incoming.files.length > 5}<li class="dim">…</li>{/if}
      </ul>
      <button class="primary" data-test="recv-accept" onclick={() => workspace.acceptFile()}>
        {t("recvAccept")}
      </button>
      <button data-test="recv-decline" onclick={() => workspace.rejectFile()}>{t("recvDecline")}</button>
    </Card>
  {/if}

  <!-- Progress, in both directions, each cancellable. A transfer the user can
       watch but not stop is a transfer they have to quit the app to escape. -->
  {#each [recv, send].filter((x) => x !== null) as xfer (xfer.dir)}
    <Card title={xfer.dir === "recv" ? t("recvSaving") : t("linkSendFiles")}>
      <p class="dim small" data-test={`xfer-${xfer.dir}`}>
        {xfer.files[xfer.index]?.name ?? ""} · {percent(xfer)}%
      </p>
      <progress max="100" value={percent(xfer)}></progress>
      {#if !xfer.done}
        <button data-test={`abort-${xfer.dir}`} onclick={() => workspace.abortFile(xfer.dir)}>
          {t("recvDecline")}
        </button>
      {:else if xfer.dir === "recv"}
        <!-- The receipt, from the outcome that actually happened. One blanket
             "this build cannot save" sentence used to cover every failure —
             which hid real permission and conflict errors behind a build
             limitation, and erased files that HAD been written. -->
        {#if receipt?.kind === "saved"}
          <p data-test="recv-saved">{t("recvSavedCount", { done: receipt.total, total: receipt.total })}</p>
          <!-- The one thing a person wants once a transfer finishes. The button
               exists only when MAIN has pushed a receipt for a batch of exactly
               this many files: the folder is main's, the page never learned it,
               and what is held here is an opaque token main can resolve. -->
          {#if reveal.receiptFor(receipt.total) !== null}
            <button data-test="recv-reveal" disabled={reveal.busy} onclick={() => void reveal.reveal()}>
              {reveal.busy ? t("recvRevealBusy") : t("recvReveal")}
            </button>
          {/if}
          <!-- Visible, and specific. A reveal that silently did nothing is the
               failure this replaces: the folder may have been moved, deleted or
               unplugged since, and the user is the only one who can tell which.
               Never the operating system's own text, which carries the path. -->
          {#if reveal.refusal !== null}
            <p class="problem small" data-test="recv-reveal-refused">{revealText(reveal.refusal)}</p>
          {/if}
          <!-- The files themselves, each with its own capability token. The
               relative path is safe to show: it is relative to a root this page
               was never given. Dragging is MAIN's — the row asks, and main
               re-checks the file before the OS is told to do anything. -->
          {#if received.items.length > 0}
            <p class="dim small" data-test="recv-files-title">{t("recvFilesTitle")}</p>
            <ul class="entries" data-test="recv-files">
              {#each received.items as item (item.token)}
                <li
                  draggable="true"
                  data-test="recv-file"
                  ondragstart={(event) => {
                    // The browser's own drag is cancelled: Electron starts a
                    // REAL file drag from main, which a synthetic one cannot.
                    event.preventDefault();
                    void received.act("drag", item.token);
                  }}
                >
                  <span class="name">{item.relativePath}</span>
                  <button
                    class="small"
                    data-test="recv-file-show"
                    disabled={received.busy !== null}
                    onclick={() => void received.act("reveal", item.token)}
                  >
                    {t("recvShowFile")}
                  </button>
                </li>
              {/each}
            </ul>
            <p class="dim small" data-test="recv-drag-hint">{t("recvDragHint")}</p>
          {/if}
          {#if received.refusal !== null}
            <p class="problem small" data-test="recv-file-refused">{receivedText(received.refusal)}</p>
          {/if}
        {:else if receipt?.kind === "partial"}
          <p class="problem" data-test="recv-partial">
            {t("recvPartial", { done: receipt.saved, total: receipt.total })}
          </p>
          {#if receipt.residue}<p class="dim small">{t("recvResidue")}</p>{/if}
        {:else if receipt?.kind === "failed"}
          <p class="problem" data-test="recv-failed">{failureText(receipt.reason)}</p>
          <!-- Files that reached their final names are still there, and the
               receipt says so rather than implying nothing was saved. -->
          {#if receipt.saved > 0}
            <p data-test="recv-failed-saved">
              {t("recvSavedCount", { done: receipt.saved, total: receipt.total })}
            </p>
          {/if}
          {#if receipt.residue}<p class="dim small">{t("recvResidue")}</p>{/if}
        {:else if receipt?.kind === "cancelled"}
          <p class="dim" data-test="recv-cancelled">{t("recvCancelled")}</p>
        {/if}
      {/if}
    </Card>
  {/each}

  <!-- The text lane, with its own consent and its transcript. Only once there
       is a transport under it. -->
  {#if connected}
  <Card title={t("linkMessage")}>
    {#if text.status === "incomingRequest" && !needsConfirmation}
      <!-- A conversation, not a file batch and not a verification code. This
           used to read "wants to send 0 file(s)" over a button labelled "It
           matches" — file vocabulary and the SAS answer, on a text prompt. -->
      <p class="dim" data-test="text-incoming">{t("textIncoming", { peer: peerLabel })}</p>
      <button class="primary" data-test="text-accept" onclick={() => workspace.acceptText()}>
        {t("textAccept")}
      </button>
      <button data-test="text-decline" onclick={() => workspace.rejectText()}>{t("textDecline")}</button>
    {:else}
      <ul class="history" data-test="history">
        {#each text.history as entry (entry.id)}
          <li class:out={entry.dir === "out"} class:failed={entry.failed}>{entry.body}</li>
        {/each}
      </ul>
      <form
        class="composer"
        onsubmit={(e) => {
          e.preventDefault();
          void sendMessage();
        }}
      >
        <label class="sr-only" for="message">{t("linkMessage")}</label>
        <input
          id="message"
          data-test="message"
          bind:value={messageDraft}
          placeholder={t("linkMessage")}
          disabled={needsConfirmation}
        />
        <button
          class="primary"
          type="submit"
          data-test="send"
          disabled={needsConfirmation || sending !== null || awaitingLane !== null || sendGate.fenced}
        >
          {t("linkSend")}
        </button>
      </form>
      {#if sendState === "waiting"}
        <p class="dim small" data-test="text-waiting">{t("textWaiting")}</p>
      {:else if sendState === "failed"}
        <p class="problem small" data-test="send-failed">{t("textDropped")}</p>
      {/if}
      {#if laneError}
        <p class="problem small" data-test="text-error">{laneError}</p>
      {/if}
    {/if}
  </Card>
  {/if}
{/if}

<style>
  .dim { color: var(--text-dim); margin: 0 0 var(--space-tight); }
  .small { font-size: 13px; }
  .problem { margin: var(--space-inner) 0 0; }
  .sas {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 28px;
    letter-spacing: 0.18em;
    margin: 0 0 var(--space-section);
  }
  .files { list-style: none; margin: 0 0 var(--space-inner); padding: 0; font-size: 13px; }
  .history { list-style: none; margin: 0 0 var(--space-inner); padding: 0; max-height: 220px; overflow-y: auto; }
  .history li {
    padding: var(--space-tight) var(--space-inner);
    border-radius: var(--corner);
    background: var(--bg);
    margin-bottom: var(--space-hairline);
    max-width: 80%;
    overflow-wrap: anywhere;
  }
  .history li.out { margin-left: auto; background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .history li.failed { opacity: 0.6; text-decoration: line-through; }
  progress { width: 100%; height: 6px; margin-bottom: var(--space-inner); }
  .indeterminate {
    position: relative;
    overflow: hidden;
    width: 100%;
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
  .drop {
    display: flex;
    align-items: center;
    gap: var(--space-inner);
    flex-wrap: wrap;
    border: 1px dashed var(--border);
    border-radius: var(--corner);
    padding: var(--space-section);
    margin-bottom: var(--space-section);
  }
  .drop.over { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .composer { display: flex; gap: var(--space-tight); }
  .composer input { flex: 1; min-height: 32px; padding: 6px var(--space-inner);
    border: 1px solid var(--border); border-radius: var(--corner); background: var(--bg); color: var(--text); font: inherit; }
  button, .button {
    display: inline-block;
    min-height: 32px;
    padding: 6px var(--space-section);
    border-radius: var(--corner);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button, .button {
    transition:
      background-color var(--motion-base) var(--ease),
      border-color var(--motion-base) var(--ease),
      transform var(--motion-fast) var(--ease);
  }
  button:active:not(:disabled), .button:active { transform: scale(0.98); }
  .primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .quiet { border: 0; background: transparent; color: var(--text-dim); padding-left: 0; }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .button:focus-within, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
