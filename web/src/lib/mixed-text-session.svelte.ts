// Reusable text conversations on a long-lived authenticated peer link.
//
// Unlike the legacy text session, ending or rejecting a conversation never
// closes the DataChannel or peer link. The link owns the codecs so reopening a
// conversation cannot reset an AEAD nonce sequence.

import {
  TEXT_BURST,
  TEXT_HISTORY_MAX,
  TEXT_IDLE_MS,
  TEXT_PER_SEC,
  TEXT_SEND_BUFFER_MAX,
  TEXT_SESSION_MAX_BYTES,
  TEXT_SESSION_MAX_MESSAGES,
  type TextErrorKey,
  type TextMessage,
  type TextStatus,
} from "./text-session.svelte";
import {
  TEXT_END,
  TEXT_REQUEST,
  isTextFrame,
  textByteLength,
  textLifecycleKind,
  textPlainLimit,
} from "./text-wire";
import { ACCEPT, REJECT } from "./transfer";
import {
  LinkBusyError,
  UnsupportedLinkError,
  type MixedPeerLink,
} from "./peer-link.svelte";
import { createRateBucket } from "./rate-bucket";

export interface MixedTextSessionDeps {
  ensureLink(peerId: string): Promise<MixedPeerLink>;
  now(): number;
  /** Link owner uses authenticated-lane traffic to refresh its idle lease. */
  onActivity?(): void;
}

export interface MixedTextSession {
  readonly status: TextStatus;
  readonly peerId: string;
  readonly sasCode: string;
  readonly history: TextMessage[];
  readonly errorKey: TextErrorKey;
  readonly link: MixedPeerLink | null;
  attach(link: MixedPeerLink): void;
  detach(): void;
  /** Enter a transport gap. Ends an open conversation visibly, keeps the
   *  transcript, replays nothing, and applies the text lane's stricter poison
   *  rules — a protected frame buffered at close or admitted but never fed
   *  leaves this side unable to prove its sequence, and text has neither a
   *  forward-only nonce nor a sender-announced resume point to repair it with.
   *  Idempotent: the coordinator's call and a real `onclose` are one gap. */
  suspend(): void;
  /** Did this lane have a live conversation when its channel first entered a
   *  gap? Recorded inside `suspend()`, because after it the public status is
   *  already terminal. See MixedFileSession.needsRecovery. */
  needsRecovery(): boolean;
  openWith(peerId: string): Promise<void>;
  accept(): void;
  reject(): void;
  send(body: string): Promise<void>;
  end(): void;
  clearHistory(): void;
  active(): boolean;
}

/** A consent prompt is conversation state, not link activity. It must have a
 * bounded exit even though pending consent keeps the link-level idle timer alive. */
export const MIXED_TEXT_CONSENT_TIMEOUT_MS = TEXT_IDLE_MS;
/** END acknowledgement is an ordering barrier, not an unbounded lease. If it
 * never arrives, the text codecs cannot be reused safely because an old
 * protected frame may still be in flight, so fail this lane while leaving the
 * independent file lane and peer link alone. */
export const MIXED_TEXT_END_ACK_TIMEOUT_MS = 30_000;

interface ConversationBudget {
  bucket: ReturnType<typeof createRateBucket>;
  count: number;
  bytes: number;
}

export function createMixedTextSession(deps: MixedTextSessionDeps): MixedTextSession {
  let status = $state<TextStatus>("idle");
  let peerId = $state("");
  let sasCode = $state("");
  let history = $state<TextMessage[]>([]);
  let errorKey = $state<TextErrorKey>("");
  let link = $state.raw<MixedPeerLink | null>(null);

  let nextId = 1;
  let historyPeerId = "";
  let attempt = 0;
  let generation = 0;
  let transportInterrupted = false;
  // A local END cannot identify the peer's last already-in-flight message.
  // Keep consuming the old conversation's authenticated sequence, without
  // exposing its plaintext, until an inbound lifecycle marker provides an
  // ordered barrier for the next conversation.
  let inboundDrain: ConversationBudget | null = null;
  let lateAcceptBudget: ConversationBudget | null = null;
  let awaitingEndAck = false;
  // Remote END cancels protected sends that have not started encryption yet.
  // A frame already inside Web Crypto must still be put on the ordered channel
  // to preserve the link-owned sender nonce, but is recorded as failed.
  let outboundEpoch = 0;
  let protectedTransportPending = false;
  let suspended = false;
  let recoveryIntent = false;
  const poisonedCodecs = new WeakSet<object>();
  let sendChainOwner: object | null = null;
  let recvChainOwner: object | null = null;
  let sendChain: Promise<void> = Promise.resolve();
  let recvChain: Promise<void> = Promise.resolve();
  let budget = newBudget();
  let lifecycleBucket = createRateBucket(TEXT_BURST, TEXT_PER_SEC, deps.now);
  let consentTimer: ReturnType<typeof setTimeout> | undefined;
  let endAckTimer: ReturnType<typeof setTimeout> | undefined;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  function poisoned(candidate = link): boolean {
    return !!candidate && (poisonedCodecs.has(candidate.textSender)
      || poisonedCodecs.has(candidate.textReceiver));
  }

  function newBudget(): ConversationBudget {
    return {
      bucket: createRateBucket(TEXT_BURST, TEXT_PER_SEC, deps.now),
      count: 0,
      bytes: 0,
    };
  }

  function beginConversation() {
    clearTimeout(consentTimer);
    consentTimer = setTimeout(() => {
      if (status !== "waitingAccept" && status !== "incomingRequest") return;
      startLocalEnd();
    }, MIXED_TEXT_CONSENT_TIMEOUT_MS);
    budget = newBudget();
    errorKey = "";
  }

  function finishConsent() {
    clearTimeout(consentTimer);
    consentTimer = undefined;
  }

  function finishEndAck() {
    clearTimeout(endAckTimer);
    endAckTimer = undefined;
  }

  function awaitEndAck(expectedLink: MixedPeerLink) {
    finishEndAck();
    endAckTimer = setTimeout(() => {
      if (link !== expectedLink || !awaitingEndAck) return;
      // Reopening with an unknown number of unobserved old frames would reuse
      // a receiver sequence unsafely. Poison only the text codecs/channel.
      markFailed("failed", expectedLink);
    }, MIXED_TEXT_END_ACK_TIMEOUT_MS);
  }

  function record(message: Omit<TextMessage, "id">) {
    const next = [...history, { id: nextId++, ...message }];
    history = next.length > TEXT_HISTORY_MAX
      ? next.slice(next.length - TEXT_HISTORY_MAX)
      : next;
  }

  function poisonCodecs(candidate: MixedPeerLink) {
    poisonedCodecs.add(candidate.textSender);
    poisonedCodecs.add(candidate.textReceiver);
  }

  /**
   * Enter the lane's terminal state, and withdraw its claim on the link.
   *
   * `suspend()` records `recoveryIntent` from a conversation that was live when
   * the channel entered a gap, and the coordinator holds the whole link for up
   * to LINK_RECOVERY_WINDOW_MS on the strength of that answer. Once this lane is
   * terminal there is nothing a replacement transport could restore — poisoned
   * codecs make `attach()` refuse one outright — so continuing to claim recovery
   * would spend that window, and the initiator's ICE/TURN allocations with it,
   * on a lane that is over. The file lane has withdrawn the same way since
   * markLaneFailed; this is that rule, for text.
   *
   * Deliberately NOT reachable from `suspend()` or `markTransportInterrupted()`
   * directly: an ordinary transport gap — including the one a DataChannel
   * `onclose` reports before the PeerConnection's own terminal callback — must
   * keep the intent it just recorded. Only a lane that has additionally proven
   * itself unrecoverable passes through here.
   *
   * Callers are already responsible for reaching this only for the live lane
   * (see the link/generation guards on every async path), which is the same
   * discipline the status assignment below has always relied on.
   */
  function markTerminal(key: TextErrorKey) {
    status = "failed";
    errorKey = key;
    recoveryIntent = false;
  }

  function markFailed(
    key: TextErrorKey = "failed",
    expectedLink = link,
    poison = true,
  ) {
    finishConsent();
    finishEndAck();
    awaitingEndAck = false;
    inboundDrain = null;
    lateAcceptBudget = null;
    if (expectedLink && poison) poisonCodecs(expectedLink);
    markTerminal(key);
    try { expectedLink?.textChannel.close(); } catch { /* lane already terminal */ }
  }

  function markTransportInterrupted(expectedLink = link) {
    if (expectedLink !== link || poisoned(expectedLink)) return;
    finishConsent();
    if (active()) {
      transportInterrupted = true;
      finishEndAck();
      awaitingEndAck = false;
      inboundDrain = null;
      lateAcceptBudget = null;
      status = "ended";
      errorKey = "";
    }
  }

  function detachHandlers() {
    if (!link) return;
    if (link.textChannel.onmessage === messageHandler) link.textChannel.onmessage = null;
    if (link.textChannel.onclose === closeHandler) link.textChannel.onclose = null;
    messageHandler = null;
    closeHandler = null;
  }

  /** See MixedTextSession.suspend. */
  function suspend() {
    const expectedLink = link;
    if (!expectedLink || suspended) return;
    suspended = true;
    // Sampled before anything below moves status to `ended` or `failed`.
    recoveryIntent = recoveryIntent || active();
    if (protectedTransportPending && expectedLink.textChannel.bufferedAmount > 0) {
      // DataChannel.send() only enqueues. If bytes remain buffered at close,
      // the sender nonce may have advanced without the peer seeing the frame.
      markFailed(status === "failed" && errorKey ? errorKey : "failed", expectedLink);
    }
    attempt++;
    generation++;
    if (!poisoned(expectedLink)) markTransportInterrupted(expectedLink);
    detachHandlers();
  }

  function enqueueControl(
    frame: Uint8Array<ArrayBuffer>,
    expectedLink = link,
    expectedGeneration = generation,
    onSent?: () => void,
  ) {
    if (!expectedLink) return;
    const task = sendChain.then(() => {
      if (link !== expectedLink || generation !== expectedGeneration || poisoned(expectedLink)) return;
      if (expectedLink.textChannel.readyState !== "open") {
        markTransportInterrupted(expectedLink);
        return;
      }
      if (expectedLink.textChannel.bufferedAmount === 0) protectedTransportPending = false;
      expectedLink.textChannel.send(frame);
      deps.onActivity?.();
      onSent?.();
    });
    sendChain = task.catch((err) => {
      console.error("relayium mixed text control error", err);
      if (generation === expectedGeneration) markTransportInterrupted(expectedLink);
    });
  }

  function queueProtected(
    data: ArrayBuffer,
    acceptedBudget: ConversationBudget,
    discard = false,
  ) {
    const expectedLink = link;
    if (!expectedLink) return;
    const expectedGeneration = generation;
    const task = recvChain.then(async () => {
      if (link !== expectedLink || generation !== expectedGeneration) {
        // This protected frame was already admitted in wire order. Skipping it
        // before feed() would leave the receiver expecting a sequence the peer
        // has already spent, so every resumed generation sharing this codec is
        // unusable even though a fresh link remains possible.
        poisonCodecs(expectedLink);
        if (link && (link.textSender === expectedLink.textSender
          || link.textReceiver === expectedLink.textReceiver)) {
          markFailed("failed", link);
        }
        return;
      }
      if (poisoned(expectedLink)) return;
      if (!acceptedBudget.bucket.take()) return markFailed("flooding", expectedLink);
      if (acceptedBudget.count + 1 > TEXT_SESSION_MAX_MESSAGES
          || acceptedBudget.bytes + data.byteLength > TEXT_SESSION_MAX_BYTES) {
        return markFailed("failed", expectedLink);
      }
      try {
        const body = await expectedLink.textReceiver.feed(
          new Uint8Array(data) as Uint8Array<ArrayBuffer>,
          expectedLink.keys.textRecv,
        );
        if (link !== expectedLink || generation !== expectedGeneration) return;
        acceptedBudget.count += 1;
        acceptedBudget.bytes += data.byteLength;
        if (!discard) record({ dir: "in", body, at: deps.now(), failed: false });
      } catch (err) {
        console.error("relayium mixed text receive error", err);
        if (link === expectedLink && generation === expectedGeneration) markFailed("failed", expectedLink);
      }
    });
    recvChain = task.catch((err) => {
      console.error("relayium mixed text dispatch error", err);
      if (link === expectedLink && generation === expectedGeneration) markFailed("failed", expectedLink);
    });
  }

  function receiveRequest() {
    if (!link || poisoned()) return;
    // REQUEST is ordered after every protected frame the peer sent for its
    // previous conversation, so it closes any local-END drain window.
    inboundDrain = null;
    lateAcceptBudget = null;
    awaitingEndAck = false;
    finishEndAck();
    if (status === "waitingAccept") {
      // Both users asked at once. The smaller peer keeps its outbound request;
      // the larger peer converts its own intent into the one incoming consent
      // prompt. This converges without a second link or duplicate conversation.
      if (link.role === "initiator") {
        enqueueControl(REJECT);
      } else {
        beginConversation();
        status = "incomingRequest";
      }
      return;
    }
    if (status === "incomingRequest") return; // duplicate REQUEST
    if (status === "open") {
      enqueueControl(REJECT);
      return;
    }
    beginConversation();
    status = "incomingRequest";
  }

  function onLifecycle(kind: ReturnType<typeof textLifecycleKind>) {
    // Lifecycle controls do not consume an AEAD sequence. Flooding closes this
    // channel generation, but a replacement channel may safely reuse codecs.
    if (!lifecycleBucket.take()) return markFailed("flooding", link, false);
    if (kind === "request") return receiveRequest();
    if (kind === "accept") {
      if (status === "waitingAccept") {
        finishConsent();
        inboundDrain = null;
        lateAcceptBudget = null;
        status = "open";
      } else if (status === "ended" && lateAcceptBudget) {
        // ACCEPT was sent before the peer observed our timeout or a crossing
        // END from an older attempt. It is an ordered barrier: authenticate
        // later frames only to drain that attempt until the following END.
        inboundDrain = lateAcceptBudget;
        lateAcceptBudget = null;
      }
      return;
    }
    if (kind === "reject") {
      if (awaitingEndAck) {
        // REJECT was emitted before the peer observed our END. On an ordered
        // channel it is still a complete barrier for that conversation, so it
        // can acknowledge END without waiting for another control frame.
        finishConsent();
        finishEndAck();
        awaitingEndAck = false;
        inboundDrain = null;
        lateAcceptBudget = null;
        status = "ended";
        errorKey = "";
        return;
      }
      if (status === "waitingAccept") {
        finishConsent();
        inboundDrain = null;
        lateAcceptBudget = null;
        status = "refused";
        errorKey = "refused";
      }
      return;
    }
    if (kind === "end") {
      if (awaitingEndAck) {
        finishConsent();
        finishEndAck();
        awaitingEndAck = false;
        inboundDrain = null;
        lateAcceptBudget = null;
        status = "ended";
        errorKey = "";
        return;
      }
      if (status === "ended" && (inboundDrain || lateAcceptBudget)) {
        // A late ACCEPT may have crossed the END that closed our outbound
        // request. This later ordered END is the safe drain barrier. Frames
        // already admitted to recvChain retain their captured discard budget.
        inboundDrain = null;
        lateAcceptBudget = null;
        return;
      }
      // `connecting` is link establishment before this side has emitted a
      // REQUEST. An END ordered before that REQUEST belongs to an earlier
      // conversation and must not transiently cancel or revive local intent.
      if (status === "waitingAccept" || status === "incomingRequest" || status === "open") {
        finishConsent();
        inboundDrain = null;
        // An END can belong to the peer's immediately preceding request while
        // our new REQUEST is already in flight. Preserve a discard-only budget
        // so a crossing ACCEPT/protected frame cannot poison or leak into a
        // later conversation before our symmetric END reaches the peer.
        lateAcceptBudget = status === "waitingAccept" ? budget : null;
        outboundEpoch++;
        status = "ended";
        errorKey = "";
        // Symmetric END is the ordered drain barrier for the side that ended
        // first. `awaitingEndAck` prevents an acknowledgement loop.
        enqueueControl(TEXT_END);
      }
    }
  }

  function onData(data: unknown) {
    if (!(data instanceof ArrayBuffer)) return;
    deps.onActivity?.();
    if (poisoned()) return;
    const lifecycle = textLifecycleKind(data);
    if (lifecycle) {
      onLifecycle(lifecycle);
      return;
    }
    if (!isTextFrame(data)) {
      if (data.byteLength > 0 && new Uint8Array(data)[0] === 9) markFailed();
      return;
    }
    if (status === "open") queueProtected(data, budget);
    else if (inboundDrain && status === "ended") {
      // The peer may have sent this before observing our local END. Feed it to
      // keep the link-scoped receive sequence continuous, but never render it
      // or carry it into a later consent decision.
      queueProtected(data, inboundDrain, true);
    }
    // A later conversation's acceptance cannot authorize content sent before
    // it. Dropping the frame would desynchronise the link-scoped nonce, so this
    // is a hard text-lane failure; the independent file lane remains open.
    else markFailed();
  }

  function attach(next: MixedPeerLink) {
    if (link === next) {
      // Coordinators may idempotently re-attach. Do not let that hide a closed
      // channel or leave handlers displaced by another consumer. This is also
      // how a reopen lands while the manager still holds this exact link — its
      // PeerConnection never died — so the answer is terminal, not a gap: the
      // same object cannot be the replacement transport its own marker asks for.
      if (next.textChannel.readyState !== "open") {
        markTerminal("failed");
        return;
      }
      if (messageHandler) next.textChannel.onmessage = messageHandler;
      if (closeHandler) next.textChannel.onclose = closeHandler;
      return;
    }
    const previousStatus = status;
    const previousSender = sendChainOwner;
    const previousReceiver = recvChainOwner;
    detachHandlers();
    generation++;
    const preservesOpening = status === "connecting" && peerId === next.peerId;
    if (!preservesOpening) attempt++;
    const samePeer = historyPeerId !== "" && historyPeerId === next.peerId;
    const changedPeer = historyPeerId !== "" && historyPeerId !== next.peerId;
    link = next;
    peerId = next.peerId;
    historyPeerId = next.peerId;
    sasCode = next.sas;
    // A resumed transport is a new channel object but the same authenticated
    // link identity. Text is deliberately not replayed across that gap: retain
    // the transcript and surface the interrupted conversation as ended.
    status = preservesOpening
      ? "connecting"
      : samePeer && (transportInterrupted
        || previousStatus === "connecting" || previousStatus === "waitingAccept"
        || previousStatus === "incomingRequest" || previousStatus === "open")
      ? "ended"
      : "idle";
    errorKey = "";
    transportInterrupted = false;
    suspended = false;
    // A replacement transport answers the question the marker recorded.
    recoveryIntent = false;
    if (previousSender !== next.textSender) sendChain = Promise.resolve();
    if (previousReceiver !== next.textReceiver) recvChain = Promise.resolve();
    sendChainOwner = next.textSender;
    recvChainOwner = next.textReceiver;
    budget = newBudget();
    inboundDrain = null;
    lateAcceptBudget = null;
    awaitingEndAck = false;
    protectedTransportPending = false;
    lifecycleBucket = createRateBucket(TEXT_BURST, TEXT_PER_SEC, deps.now);
    finishConsent();
    finishEndAck();
    if (changedPeer) {
      history = [];
      nextId = 1;
    }
    if (poisoned(next)) {
      markTerminal("failed");
      try { next.textChannel.close(); } catch { /* already terminal */ }
      return;
    }
    if (next.textChannel.readyState !== "open") {
      markTerminal("failed");
      return;
    }
    next.textChannel.binaryType = "arraybuffer";
    const attachedGeneration = generation;
    messageHandler = (event) => {
      if (link !== next || generation !== attachedGeneration) return;
      onData(event.data);
    };
    closeHandler = () => {
      if (link !== next || generation !== attachedGeneration) return;
      // Either callback order reaches the same idempotent gap entry.
      suspend();
    };
    next.textChannel.onmessage = messageHandler;
    next.textChannel.onclose = closeHandler;
  }

  async function openWith(id: string): Promise<void> {
    if (active()) return;
    if (link && link.peerId !== id) {
      status = "peerBusy";
      errorKey = "peerBusy";
      return;
    }
    peerId = id;
    if (poisoned()) {
      markTerminal("failed");
      return;
    }
    const mine = ++attempt;
    status = "connecting";
    errorKey = "";
    try {
      const opened = await deps.ensureLink(id);
      if (mine !== attempt) return;
      attach(opened);
      if (poisoned(opened) || opened.textChannel.readyState !== "open") {
        markTerminal("failed");
        return;
      }
      if ((status as TextStatus) === "incomingRequest") {
        if (opened.role === "responder") return;
        beginConversation();
        status = "waitingAccept";
        enqueueControl(TEXT_REQUEST, opened);
        enqueueControl(REJECT, opened);
        return;
      }
      beginConversation();
      status = "waitingAccept";
      enqueueControl(TEXT_REQUEST, opened);
    } catch (err) {
      if (mine !== attempt) return;
      if (err instanceof LinkBusyError) {
        status = "peerBusy";
        errorKey = "peerBusy";
        return;
      }
      if (err instanceof UnsupportedLinkError) {
        status = "unsupported";
        errorKey = "unsupported";
        return;
      }
      console.error("relayium mixed text link error", err);
      // `mine !== attempt` above already stopped a stale attempt from writing
      // here at all, and the only rejection that can reach this line while a
      // link is still held is the recovery promise — which settles together with
      // the teardown that has already detached this lane.
      markTerminal("failed");
    }
  }

  function active(): boolean {
    return awaitingEndAck || status === "connecting" || status === "waitingAccept"
      || status === "incomingRequest" || status === "open";
  }

  function startLocalEnd() {
    if (!link || (status !== "open" && status !== "waitingAccept"
      && status !== "incomingRequest")) return;
    finishConsent();
    if (status === "incomingRequest") {
      // No ACCEPT was sent, so the peer could never enter its protected send
      // state. REJECT is the complete ordered barrier and, unlike END, cannot
      // produce a stale acknowledgement that cancels an immediately reopened
      // outbound request.
      status = "ended";
      errorKey = "";
      enqueueControl(REJECT);
      return;
    }
    if (status === "open") inboundDrain = budget;
    else if (status === "waitingAccept") lateAcceptBudget = budget;
    awaitingEndAck = true;
    status = "ended";
    errorKey = "";
    const expectedLink = link;
    const expectedGeneration = generation;
    enqueueControl(TEXT_END, expectedLink, expectedGeneration, () => {
      // Start the lease when END actually enters the ordered channel, not while
      // it is queued behind an in-flight encryption operation.
      if (link === expectedLink && generation === expectedGeneration && awaitingEndAck) {
        awaitEndAck(expectedLink);
      }
    });
  }

  return {
    get status() { return status; },
    get peerId() { return peerId; },
    get sasCode() { return sasCode; },
    get history() { return history; },
    get errorKey() { return errorKey; },
    get link() { return link; },
    attach,
    suspend,
    needsRecovery() { return recoveryIntent; },
    detach() {
      attempt++;
      generation++;
      finishConsent();
      finishEndAck();
      detachHandlers();
      awaitingEndAck = false;
      inboundDrain = null;
      lateAcceptBudget = null;
      link = null;
      sasCode = "";
      suspended = false;
      recoveryIntent = false;
      if (active()) status = "ended";
    },
    openWith,

    accept() {
      if (status !== "incomingRequest" || !link || poisoned()) return;
      inboundDrain = null;
      status = "open";
      errorKey = "";
      finishConsent();
      // The protected-frame path becomes active before ACCEPT reaches the peer.
      enqueueControl(ACCEPT);
    },

    reject() {
      if (status !== "incomingRequest" || !link) return;
      finishConsent();
      status = "refused";
      errorKey = "refused";
      enqueueControl(REJECT);
    },

    async send(body: string): Promise<void> {
      const expectedLink = link;
      if (status !== "open" || !expectedLink || poisoned(expectedLink)) return;
      const expectedGeneration = generation;
      const expectedOutboundEpoch = outboundEpoch;
      // Against the CONNECTION's limit, not just the product cap: a sealed
      // 64 KiB message is 65 557 B and does not fit a peer that negotiated
      // 65 536. Checked here, before TextSender consumes a nonce, so refusing
      // one message never costs the link its reusable text codecs.
      if (textByteLength(body) > textPlainLimit(expectedLink.conn.maxFrameBytes())) {
        errorKey = "tooLong";
        return;
      }
      if (expectedLink.textChannel.bufferedAmount > TEXT_SEND_BUFFER_MAX) {
        record({ dir: "out", body, at: deps.now(), failed: true });
        return;
      }
      errorKey = "";
      // Once accepted into this queue the message stays ahead of a later END.
      // Dropping it after TextSender consumes a nonce would desynchronise every
      // reopened conversation on this link.
      const task = sendChain.then(async () => {
        if (link !== expectedLink || generation !== expectedGeneration || poisoned(expectedLink)) return;
        if (outboundEpoch !== expectedOutboundEpoch) {
          record({ dir: "out", body, at: deps.now(), failed: true });
          return;
        }
        try {
          const frame = await expectedLink.textSender.frame(body, expectedLink.keys.textSend);
          if (link !== expectedLink || generation !== expectedGeneration) {
            // frame() has consumed a nonce. If this codec survives transport
            // replacement, silently dropping that sequence would desynchronise
            // the peer, so this text lane can no longer be resumed.
            poisonCodecs(expectedLink);
            if (link && (link.textSender === expectedLink.textSender
              || link.textReceiver === expectedLink.textReceiver)) {
              markFailed("failed", link);
            }
            return;
          }
          if (expectedLink.textChannel.bufferedAmount === 0) protectedTransportPending = false;
          expectedLink.textChannel.send(frame);
          deps.onActivity?.();
          protectedTransportPending = true;
          record({
            dir: "out",
            body,
            at: deps.now(),
            failed: outboundEpoch !== expectedOutboundEpoch,
          });
        } catch (err) {
          console.error("relayium mixed text send error", err);
          if (link === expectedLink && generation === expectedGeneration) {
            record({ dir: "out", body, at: deps.now(), failed: true });
            markFailed("failed", expectedLink);
          }
        }
      });
      sendChain = task.catch(() => {});
      await task;
    },

    end() {
      if (status === "connecting") {
        attempt++;
        status = "ended";
        errorKey = "";
        return;
      }
      if (!link || (status !== "open" && status !== "waitingAccept"
        && status !== "incomingRequest")) return;
      startLocalEnd();
    },

    clearHistory() { history = []; },
    active,
  };
}
