// Reusable file batches on a long-lived authenticated peer link.
//
// The link owns Sender/Receiver for its whole lifetime. This module therefore
// never reconstructs a codec between batches: manifests, chunks and DONE frames
// all consume one monotonically increasing nonce sequence in each direction.

import type { PickedFile } from "./drag";
import type { StatusKey } from "./i18n.svelte";
import { pickSaveTarget as defaultPickSaveTarget, type FileSink, type SaveTarget } from "./filesink";
import type { Incoming, Xfer } from "./transfer-session.svelte";
import type { MixedPeerLink } from "./peer-link.svelte";
import {
  ACCEPT,
  BATCH_ABORT,
  CHUNK_OVERHEAD,
  COMPLETE,
  FILE_BUSY,
  FLOW_ACK_INTERVAL,
  FLOW_WINDOW,
  FRAME,
  MAX_FILES,
  REJECT,
  ackFrame,
  advanceAck,
  controlKind,
  isBatchAbort,
  isChunkFrame,
  isResumeReq,
  parseAck,
  parseResumeReq,
  resumePointAligned,
  resumePointInRange,
  resumeReqFrame,
  type FileMeta,
  type ResumePoint,
} from "./transfer";
import { wouldExceedDeclared } from "./transfer-session.svelte";

export const MIXED_FILE_CONSENT_TIMEOUT_MS = 10 * 60_000;
export const MIXED_FILE_DRAIN_TIMEOUT_MS = 30_000;
export const MIXED_FILE_REPLAY_DELAY_MS = 250;
export const MIXED_FILE_RECEIVE_STALL_MS = 60_000;
/** How long this lane will sit in a transport gap with no replacement channel.
 *  Deliberately longer than the link-level recovery window so link teardown wins
 *  that race and a lane-only channel close still has a bounded, fail-closed end. */
export const MIXED_FILE_GAP_TIMEOUT_MS = 120_000;

/** A protected frame could not enter the channel because the transport is gone,
 *  not because this codec did anything wrong. Distinct from a lane failure: the
 *  burned nonce is repaired by the next generation's RESUME_START (I2), so the
 *  caller unwinds into the gap instead of poisoning a reusable codec pair. */
class TransportGapError extends Error {
  constructor() {
    super("relayium: mixed file lane transport gap");
    this.name = "TransportGapError";
  }
}

const UI_TICK_MS = 150;
const SEND_STALL_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 60_000;

export type FileLaneErrorKey = "" | "failed" | "unsupported";

export interface QueuedFileBatch {
  readonly id: number;
  readonly peerId: string;
  readonly files: FileMeta[];
  readonly total: number;
  readonly replayed: boolean;
}

interface LocalBatch extends QueuedFileBatch {
  readonly picked: PickedFile[];
}

type OutboundPhase = "offering" | "waitingAccept" | "sending" | "finishing" | "resuming";
type Decision = "accept" | "reject" | "busy" | "yield" | "timeout";

interface Outbound {
  batch: LocalBatch;
  link: MixedPeerLink;
  generation: number;
  phase: OutboundPhase;
  yieldRequested: boolean;
  cancelRequested: boolean;
  remoteStop: boolean;
  sentBytes: number;
  acked: number;
  creditWake: (() => void) | null;
  decide: (decision: Decision) => void;
  complete: () => void;
  completed: Promise<void>;
  gotComplete: boolean;
  terminal: boolean;
  resumeRequest: ResumePoint | null;
  resumeStarted: boolean;
  /** Furthest logical point that entered an authenticated transport. A resume
   *  request beyond it can only have been forged or corrupted. */
  produced: ResumePoint;
}

type InboundPhase = "prompt" | "picking" | "receiving" | "resuming" | "draining";

interface ReceiveCheckpoint extends ResumePoint {
  chain: Uint8Array;
}

interface Inbound {
  link: MixedPeerLink;
  generation: number;
  readonly files: FileMeta[];
  readonly total: number;
  phase: InboundPhase;
  target?: SaveTarget;
  sink?: FileSink;
  fileIndex: number;
  fileOffset: number;
  got: number;
  allOk: boolean;
  startedAt: number;
  lastUiAt: number;
  lastAckSent: number;
  speedBase: number;
  checkpoint: ReceiveCheckpoint;
  targetFinalized: boolean;
  cancelRequested: boolean;
  drainLimit: number;
  drained: number;
  drainTimer?: ReturnType<typeof setTimeout>;
  receiveTimer?: ReturnType<typeof setTimeout>;
}

export interface MixedFileSessionDeps {
  ensureLink(peerId: string): Promise<MixedPeerLink>;
  pickSaveTarget?(files: FileMeta[]): Promise<SaveTarget>;
  requestNotify?(): void;
  now?(): number;
  consentTimeoutMs?: number;
  receiveStallMs?: number;
  drainTimeoutMs?: number;
  gapTimeoutMs?: number;
  /** Link owner uses lane traffic to refresh its idle lease. */
  onActivity?(): void;
}

export interface MixedFileSession {
  readonly link: MixedPeerLink | null;
  readonly incoming: Incoming | null;
  readonly recv: Xfer | null;
  readonly send: Xfer | null;
  readonly queued: readonly QueuedFileBatch[];
  readonly errorKey: FileLaneErrorKey;
  attach(link: MixedPeerLink): void;
  detach(): void;
  /** Enter a transport gap: pause a consented transfer at its durable checkpoint,
   *  stop the pump and arm
   *  per-generation sequence realignment WITHOUT poisoning the link-owned codecs.
   *  Idempotent, so lane and coordinator close callbacks cannot double-fire. */
  suspend(): void;
  /** Did this lane have work in flight when its channel first entered a gap?
   *
   *  Sampled inside `suspend()` — never read off `active()` afterwards. By the
   *  time a coordinator observes a dead PeerConnection, `RTCDataChannel.onclose`
   *  may already have run `suspend()` and cleared exactly the state the
   *  coordinator would have inspected. Cleared only by a successful replacement
   *  or final teardown. */
  needsRecovery(): boolean;
  enqueue(peerId: string, picked: PickedFile[]): void;
  accept(): void;
  reject(): void;
  cancel(dir: "send" | "recv"): void;
  cancelQueued(id: number): void;
  dismissSend(x: Xfer): void;
  dismissRecv(x: Xfer): void;
  active(): boolean;
  reset(): void;
}

export function createMixedFileSession(deps: MixedFileSessionDeps): MixedFileSession {
  const chooseTarget = deps.pickSaveTarget ?? defaultPickSaveTarget;
  const now = deps.now ?? Date.now;
  const consentTimeoutMs = deps.consentTimeoutMs ?? MIXED_FILE_CONSENT_TIMEOUT_MS;
  const receiveStallMs = deps.receiveStallMs ?? MIXED_FILE_RECEIVE_STALL_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? MIXED_FILE_DRAIN_TIMEOUT_MS;
  const gapTimeoutMs = deps.gapTimeoutMs ?? MIXED_FILE_GAP_TIMEOUT_MS;

  let link = $state.raw<MixedPeerLink | null>(null);
  let incoming = $state.raw<Incoming | null>(null);
  let recv = $state.raw<Xfer | null>(null);
  let send = $state.raw<Xfer | null>(null);
  let queued = $state.raw<LocalBatch[]>([]);
  let errorKey = $state<FileLaneErrorKey>("");

  let nextBatchId = 1;
  let generation = 0;
  let outbound: Outbound | null = null;
  let inbound: Inbound | null = null;
  let launching: LocalBatch | null = null;
  /**
   * How many outbound runs have not finished unwinding.
   *
   * A retired run is not harmless: its `dataFrames` generator does async work
   * (slice, chain hash, seal) and reserves its nonce inside that work, so it can
   * still advance the sender sequence after a gap failed its batch. If the next
   * generation announced its resume point in that window, the announcement would
   * be one seq short and the peer would reject the first chunk that followed.
   * So no batch starts — and therefore no RESUME_START is emitted — until every
   * earlier run has returned and can burn nothing more.
   */
  let outboundRunning = 0;
  let pumpToken = 0;
  let pendingInbound: { link: MixedPeerLink; files: FileMeta[]; total: number } | null = null;
  let recvChain: Promise<void> = Promise.resolve();
  let recvChainOwner: object | null = null;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let consentTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedInboundBytes = 0;
  /** In a transport gap: nothing may be sent and no batch may launch. */
  let suspended = false;
  /** I2 (realignment invariant), sender half: the next batch on this link must
   *  announce where its sequence resumes before it consumes another nonce. */
  let resyncOut = false;
  /** I2, receiver half: exactly one RESUME_START is required, and accepted, per
   *  transport generation after the first — and nothing protected before it. */
  let resyncIn: "none" | "required" = "none";
  /** See MixedFileSession.needsRecovery. */
  let recoveryIntent = false;
  const poisonedCodecs = new WeakSet<object>();

  /** Work in flight right now. Deliberately distinct from `needsRecovery()`,
   *  which answers the historical question a gap makes unanswerable here. */
  const active = () => !!outbound || !!inbound || !!pendingInbound || !!launching
    || queued.length > 0;

  const lanePoisoned = (candidate = link) => !!candidate
    && (poisonedCodecs.has(candidate.fileSender) || poisonedCodecs.has(candidate.fileReceiver));

  function poison(candidate: MixedPeerLink) {
    poisonedCodecs.add(candidate.fileSender);
    poisonedCodecs.add(candidate.fileReceiver);
  }

  function detachHandlers() {
    if (!link) return;
    if (link.fileChannel.onmessage === messageHandler) link.fileChannel.onmessage = null;
    if (link.fileChannel.onclose === closeHandler) link.fileChannel.onclose = null;
    messageHandler = null;
    closeHandler = null;
  }

  function closeSinkAfterReceiveChain(current: Inbound, poisonOnError = true) {
    // Retirement closes/poisons this generation before returning, so no later
    // task can legitimately touch its sink. The promise need not become the
    // current generation's recvChain (which attach may reset to another codec).
    // On a transport gap the same serialization applies, but a failing sink says
    // nothing about the codec sequence, so it must not poison a reusable one.
    void recvChain.then(() => closeSink(current)).catch((err) => {
      console.error("relayium mixed file sink retirement error", err);
      if (poisonOnError) poison(current.link);
    });
  }

  function retireActiveState(candidate: MixedPeerLink, expectedGeneration: number) {
    const oldOutbound = outbound?.link === candidate && outbound.generation === expectedGeneration
      ? outbound : null;
    const oldInbound = inbound?.link === candidate && inbound.generation === expectedGeneration
      ? inbound : null;
    const hadActiveWireState = !!oldOutbound || !!oldInbound || pendingInbound?.link === candidate;
    if (!hadActiveWireState) return;

    clearInboundTimers();
    if (oldOutbound) {
      oldOutbound.cancelRequested = true;
      oldOutbound.decide("reject");
      oldOutbound.complete();
      oldOutbound.creditWake?.();
      oldOutbound.terminal = true;
      outbound = null;
      if (send && !send.done) send = { ...send, status: "sendFail", done: true, ok: false, speed: 0 };
    }
    if (oldInbound) {
      inbound = null;
      incoming = null;
      if (recv && !recv.done) recv = { ...recv, status: "recvFail", done: true, ok: false, speed: 0 };
      closeSinkAfterReceiveChain(oldInbound);
    }
    if (pendingInbound?.link === candidate) pendingInbound = null;
    poison(candidate);
    try { candidate.fileChannel.close(); } catch { /* already terminal */ }
  }

  function clearInboundTimers() {
    clearTimeout(consentTimer);
    consentTimer = undefined;
    clearTimeout(resumeTimer);
    resumeTimer = undefined;
    if (inbound?.drainTimer) clearTimeout(inbound.drainTimer);
    if (inbound?.receiveTimer) clearTimeout(inbound.receiveTimer);
  }

  function resetCompletion(current: Outbound) {
    let complete!: () => void;
    current.completed = new Promise<void>((resolve) => { complete = resolve; });
    current.complete = complete;
    current.gotComplete = false;
  }

  function batchOffset(files: FileMeta[], point: ResumePoint): number {
    return files.slice(0, point.index).reduce((sum, file) => sum + file.size, 0) + point.offset;
  }

  function pointAtOrBefore(candidate: ResumePoint, frontier: ResumePoint): boolean {
    return candidate.index < frontier.index
      || (candidate.index === frontier.index && candidate.offset <= frontier.offset);
  }

  function advanceProduced(current: Outbound, point: ResumePoint) {
    if (pointAtOrBefore(current.produced, point)) current.produced = point;
  }

  function validResumeRequest(current: Outbound, point: ResumePoint): boolean {
    const sizes = current.batch.files.map((file) => file.size);
    if (!resumePointInRange(point, sizes) || !pointAtOrBefore(point, current.produced)) return false;
    // Sender.dataFrames hashes fixed CHUNK_SIZE source pieces, so every honest
    // durable checkpoint is a chunk boundary or the exact file end — including
    // on a connection that fragmented those pieces across several messages.
    return resumePointAligned(point, sizes);
  }

  /**
   * End one outbound batch without ending its lane.
   *
   * Every caller here has a reusable codec pair: the peer answered, or its answer
   * can no longer arrive, while the sequence itself is intact and the generation's
   * pending realignment still repairs whatever the gap burned. So this reports the
   * batch's own outcome and leaves `resyncOut`, the queue and the link alone.
   * `final === null` is the local-cancel outcome: no card at all.
   */
  function endOutboundBatch(current: Outbound, final: { status: StatusKey; ok: boolean } | null) {
    current.decide("reject");
    current.complete();
    current.creditWake?.();
    current.terminal = true;
    if (!final) send = null;
    else if (send && !send.done) send = { ...send, ...final, done: true, speed: 0 };
  }

  function armOutboundResumeTimer(current: Outbound) {
    clearTimeout(resumeTimer);
    const candidate = current.link;
    const expectedGeneration = current.generation;
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (outbound === current && current.phase === "resuming"
          && candidate === link && expectedGeneration === generation) {
        // Only this batch failed. Nothing proves the lane is unusable: no byte was
        // lost, the codecs are the ones the replacement is already using, and the
        // realignment this generation owes is still unspent. Poisoning here would
        // let one unanswered request end a link that is otherwise working, so the
        // next batch gets to announce the origin and carry on.
        endOutboundBatch(current, { status: "sendFail", ok: false });
        finishOutbound(current);
      }
    }, receiveStallMs);
  }

  function clearGapTimer() {
    if (gapTimer !== undefined) clearTimeout(gapTimer);
    gapTimer = undefined;
  }

  function armGapTimer() {
    clearGapTimer();
    const candidate = link;
    const expectedGeneration = generation;
    if (!candidate) return;
    gapTimer = setTimeout(() => {
      gapTimer = undefined;
      // No replacement arrived. A lane that can neither send nor realign is not
      // reusable, so end it explicitly rather than leaving it apparently idle.
      if (suspended && link === candidate && generation === expectedGeneration) {
        markLaneFailed(candidate, "recvFail", expectedGeneration);
      }
    }, gapTimeoutMs);
  }

  /**
   * A transport gap on this lane. See MixedFileSession.suspend.
   *
   * A consented batch pauses in place. Its source files, destination sink and
   * last durable receive checkpoint survive; only the dead transport generation
   * retires. Pre-consent work still fails closed because no byte-level checkpoint
   * contract exists before ACCEPT.
   */
  function suspend() {
    const candidate = link;
    if (!candidate || suspended || lanePoisoned(candidate)) return;
    suspended = true;
    // Sampled BEFORE anything below mutates lane state: this is the whole point
    // of the marker. `active()` after this call is deliberately a different
    // question ("is there work now") from the one recovery needs to answer.
    recoveryIntent = recoveryIntent || active();
    const expectedGeneration = generation;
    const oldOutbound = outbound?.link === candidate && outbound.generation === expectedGeneration
      ? outbound : null;
    const oldInbound = inbound?.link === candidate && inbound.generation === expectedGeneration
      ? inbound : null;
    clearInboundTimers();
    if (oldOutbound) {
      const consented = oldOutbound.phase === "sending" || oldOutbound.phase === "finishing"
        || oldOutbound.phase === "resuming";
      // A decision the peer has already given is not pending work. Parking such a
      // batch in `resuming` would wait for a RESUME_REQ that by definition cannot
      // come — a peer that rejected or completed this batch has no checkpoint left
      // to ask from — and would end in a timeout rather than in the answer it
      // already holds.
      const answered = oldOutbound.remoteStop || oldOutbound.gotComplete;
      if (consented && !answered) {
        oldOutbound.phase = "resuming";
        oldOutbound.resumeRequest = null;
        oldOutbound.resumeStarted = false;
        // Unblock credit, buffer and completion waits. The old run observes the
        // generation mismatch and retires without finishing this batch.
        oldOutbound.creditWake?.();
        oldOutbound.complete();
        if (send && !send.done) send = { ...send, status: "resuming", speed: 0 };
      } else if (consented) {
        // Same precedence as the live path: an explicit local stop outranks a
        // remote answer, and losing the transport must not change that.
        if (oldOutbound.cancelRequested) endOutboundBatch(oldOutbound, null);
        else if (oldOutbound.gotComplete) endOutboundBatch(oldOutbound, { status: "sendDone", ok: true });
        else endOutboundBatch(oldOutbound, { status: "rejected", ok: false });
        outbound = null;
      } else {
        // Pre-consent: no byte-level checkpoint contract exists yet, so there is
        // nothing to resume and the batch fails closed.
        oldOutbound.cancelRequested = true;
        endOutboundBatch(oldOutbound, { status: "sendFail", ok: false });
        outbound = null;
      }
    }
    if (oldInbound) {
      if (oldInbound.phase === "receiving" || oldInbound.phase === "resuming") {
        oldInbound.phase = "resuming";
        incoming = null;
        if (recv && !recv.done) recv = { ...recv, status: "resuming", speed: 0 };
      } else {
        inbound = null;
        incoming = null;
        if (recv && !recv.done) recv = { ...recv, status: "recvFail", done: true, ok: false, speed: 0 };
        // A picker or prompt has no durable byte contract to resume.
        closeSinkAfterReceiveChain(oldInbound, false);
      }
    }
    pendingInbound = null;
    detachHandlers();
    generation++;
    if (oldOutbound && outbound === oldOutbound) oldOutbound.generation = generation;
    if (oldInbound && inbound === oldInbound) oldInbound.generation = generation;
    resyncOut = true;
    resyncIn = "required";
    armGapTimer();
  }

  function markLaneFailed(
    candidate: MixedPeerLink,
    status: "sendFail" | "recvFail" = "recvFail",
    expectedGeneration = generation,
  ) {
    if (!lanePoisoned(candidate)) poison(candidate);
    // A stale async operation must retire only its own codec. It must never
    // erase a replacement link's queue, consent prompt, sink or UI state.
    if (candidate !== link || expectedGeneration !== generation) return;
    errorKey = "failed";
    clearInboundTimers();
    clearGapTimer();
    suspended = false;
    // A lane that ended for a protocol reason has nothing left to reconnect for,
    // so it must stop asking the link to be held on its behalf.
    recoveryIntent = false;
    resyncOut = false;
    resyncIn = "none";
    clearTimeout(replayTimer);
    replayTimer = undefined;
    pendingInbound = null;
    incoming = null;
    pumpToken++;
    launching = null;
    if (send && !send.done) send = { ...send, status, done: true, ok: false, speed: 0 };
    if (recv && !recv.done) recv = { ...recv, status: "recvFail", done: true, ok: false, speed: 0 };
    const failedOutbound = outbound;
    if (failedOutbound) {
      failedOutbound.cancelRequested = true;
      failedOutbound.decide("reject");
      failedOutbound.complete();
      failedOutbound.creditWake?.();
      failedOutbound.terminal = true;
    }
    outbound = null;
    const failedInbound = inbound;
    inbound = null;
    queued = [];
    if (failedInbound) closeSinkAfterReceiveChain(failedInbound);
    try { candidate.fileChannel.close(); } catch { /* already terminal */ }
  }

  /** Does this candidate carry the codecs the lane is using right now? A
   *  transport replacement preserves them by contract, so this is what separates
   *  "an old transport generation of the LIVE lane" (repairable by realignment)
   *  from "a dead link's codecs" (poison, as before). */
  const sharesCodecs = (candidate: MixedPeerLink) => !!link
    && link.fileSender === candidate.fileSender
    && link.fileReceiver === candidate.fileReceiver;

  /**
   * Why a frame could not reach the wire.
   *
   * - `gap`: the live lane has no transport. Enter/stay in the gap; the next
   *   generation's RESUME_START repairs whatever this frame consumed.
   * - `stale`: an older generation of the same codecs, already retired by a gap.
   *   It must be completely inert — it may neither poison nor suspend a lane
   *   that has since been rebuilt and is working.
   * - `failed`: anything else. The codec cannot prove continuity; poison it.
   */
  function sendFailure(
    candidate: MixedPeerLink,
    expectedGeneration: number,
  ): "gap" | "stale" | "failed" {
    if (lanePoisoned(candidate)) return "failed";
    if (candidate === link && expectedGeneration === generation) {
      return suspended || candidate.fileChannel.readyState !== "open" ? "gap" : "failed";
    }
    return sharesCodecs(candidate) ? "stale" : "failed";
  }

  function sendControl(
    frame: Uint8Array<ArrayBuffer>,
    candidate = link,
    expectedGeneration = generation,
  ): boolean {
    if (!candidate || candidate !== link || expectedGeneration !== generation || lanePoisoned(candidate)) return false;
    if (suspended || candidate.fileChannel.readyState !== "open") return false;
    try {
      candidate.fileChannel.send(frame);
      deps.onActivity?.();
      return true;
    } catch {
      markLaneFailed(candidate, "recvFail", expectedGeneration);
      return false;
    }
  }

  function sendBarrier(
    frame: Uint8Array<ArrayBuffer>,
    candidate: MixedPeerLink,
    expectedGeneration = generation,
  ): boolean {
    if (sendControl(frame, candidate, expectedGeneration)) return true;
    const failure = sendFailure(candidate, expectedGeneration);
    // A barrier lost to a dead transport is not ambiguous: no frame from a
    // retired generation can arrive on the next one, so the generation boundary
    // IS the ordered barrier. Neither case may poison a reusable codec.
    if (failure === "gap") suspend();
    // Losing a lifecycle barrier on a live transport makes the next unscoped
    // batch ambiguous. Do not optimistically reuse this file lane.
    else if (failure === "failed") markLaneFailed(candidate, "recvFail", expectedGeneration);
    return false;
  }

  function sendProtected(
    frame: Uint8Array<ArrayBuffer>,
    candidate: MixedPeerLink,
    expectedGeneration: number,
  ) {
    if (candidate !== link || expectedGeneration !== generation
        || lanePoisoned(candidate) || suspended
        || candidate.fileChannel.readyState !== "open") {
      const failure = sendFailure(candidate, expectedGeneration);
      // batchFrame/dataFrames already consumed a sender nonce. The peer never
      // saw the frame, but the next generation's RESUME_START announces the new
      // start seq, so the burn is repaired rather than terminal.
      if (failure === "gap") suspend();
      if (failure !== "failed") throw new TransportGapError();
      // A poisoned or genuinely orphaned codec has no realignment path: it can no
      // longer prove continuity and must not be reused.
      markLaneFailed(candidate, "sendFail", expectedGeneration);
      throw new Error("relayium: protected file frame could not enter the channel");
    }
    try {
      candidate.fileChannel.send(frame);
      deps.onActivity?.();
    } catch (err) {
      markLaneFailed(candidate, "sendFail", expectedGeneration);
      throw err;
    }
  }

  function asBuffer(data: unknown): ArrayBuffer | null {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }
    return null;
  }

  function handleControl(buf: ArrayBuffer) {
    const current = outbound;
    if (!current || current.link !== link || current.generation !== generation || current.terminal) return;

    if (isResumeReq(buf)) {
      const point = parseResumeReq(buf);
      if (current.phase !== "resuming" || current.resumeRequest || !point
          || !validResumeRequest(current, point)) {
        markLaneFailed(current.link, "sendFail", current.generation);
        return;
      }
      if (current.cancelRequested) {
        clearTimeout(resumeTimer);
        resumeTimer = undefined;
        if (!sendBarrier(BATCH_ABORT, current.link, current.generation)) return;
        send = null;
        finishOutbound(current);
        return;
      }
      current.resumeRequest = point;
      maybeResumeOutbound();
      return;
    }

    const ack = parseAck(buf);
    if (ack !== null) {
      // ACK has no batch ID. Clamp it to bytes actually emitted in this batch so
      // a delayed/forged cumulative ACK cannot open a later batch's whole window.
      const nextAck = advanceAck(current.acked, current.sentBytes, ack);
      if ((current.phase === "sending" || current.phase === "finishing")
          && nextAck !== current.acked) {
        current.acked = nextAck;
        const wake = current.creditWake;
        current.creditWake = null;
        wake?.();
      }
      return;
    }

    const kind = controlKind(buf);
    if (!kind) return;
    if (kind === "accept" && current.phase === "waitingAccept") current.decide("accept");
    else if (kind === "reject") {
      if (current.phase === "waitingAccept") current.decide("reject");
      else if (current.phase === "resuming") {
        current.remoteStop = true;
        current.creditWake?.();
        current.complete();
        if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        finishOutbound(current);
      }
      else if (current.phase === "sending" || current.phase === "finishing") {
        current.remoteStop = true;
        current.creditWake?.();
        current.complete();
      }
    } else if (kind === "busy" && current.phase === "waitingAccept") current.decide("busy");
    else if (kind === "complete" && current.phase === "finishing") {
      current.gotComplete = true;
      current.complete();
    }
  }

  /**
   * How to treat a failure raised by an already-admitted receive task.
   *
   * The live generation poisons, as it always has (I5). A generation a gap
   * retired must not: its task can fail simply because the gap cleared the state
   * it was about to touch, and the codecs it names are the ones the replacement
   * is using right now. Realignment covers whatever it left behind.
   */
  function failReceive(candidate: MixedPeerLink, expectedGeneration: number) {
    if (candidate === link && expectedGeneration === generation) {
      markLaneFailed(candidate, "recvFail", expectedGeneration);
      return;
    }
    if (!sharesCodecs(candidate)) poison(candidate);
  }

  function queueInbound(buf: ArrayBuffer, candidate: MixedPeerLink, expectedGeneration: number) {
    queuedInboundBytes += buf.byteLength;
    if (queuedInboundBytes > FLOW_WINDOW * 2) {
      queuedInboundBytes -= buf.byteLength;
      markLaneFailed(candidate, "recvFail", expectedGeneration);
      return;
    }
    const task = recvChain.then(async () => {
      if (lanePoisoned(candidate)) return;
      // The frame was admitted in wire order. Skipping feed after a link/session
      // switch would strand the link-owned receiver sequence — UNLESS the codecs
      // survived, in which case the peer's mandatory RESUME_START realigns the
      // sequence past everything this generation admitted but never fed (I2).
      if (candidate !== link || expectedGeneration !== generation) {
        if (!link || link.fileReceiver !== candidate.fileReceiver) poison(candidate);
        return;
      }
      const kind = new Uint8Array(buf)[0];
      // The encrypted manifest is the consent prompt and must always be fed in
      // wire order, including while busy. File content is different: before
      // ACCEPT, decrypting even transiently would violate the product privacy
      // rule. Fail this lane without feed(); its nonce state is intentionally
      // abandoned together with the channel.
      if ((kind === FRAME.CHUNK || kind === FRAME.DONE)
          && (!inbound || (inbound.phase !== "receiving" && inbound.phase !== "draining"))) {
        throw new Error("relayium: protected file content arrived before consent");
      }
      // I2: after a gap this side's sequence is unaligned, so exactly one frame
      // is acceptable until the peer says where it resumed. A protected frame
      // here would either fail to decrypt or, worse, decrypt at a sequence this
      // side cannot prove was never used.
      if (resyncIn === "required" && kind !== FRAME.RESUME) {
        throw new Error("relayium: protected file frame before resume realignment");
      }
      const out = await candidate.fileReceiver.feed(new Uint8Array(buf), candidate.keys);
      await handleInboundOutput(candidate, out);
    }).finally(() => {
      if (expectedGeneration === generation) {
        queuedInboundBytes = Math.max(0, queuedInboundBytes - buf.byteLength);
      }
    });
    recvChain = task.catch((err) => {
      console.error("relayium mixed file receive error", err);
      failReceive(candidate, expectedGeneration);
    });
  }

  function queueAbort(candidate: MixedPeerLink, expectedGeneration: number) {
    // BATCH_ABORT is a sender-stream ordering barrier, so it shares recvChain
    // with protected frames. Handling it inline could release the lane while an
    // earlier slow sink.write() is still pending.
    const task = recvChain.then(async () => {
      if (candidate !== link || expectedGeneration !== generation) return;
      candidate.fileReceiver.abortBatch();
      if (!inbound || inbound.link !== candidate) {
        if (pendingInbound?.link === candidate) pendingInbound = null;
        return;
      }
      if (inbound.phase === "draining" || inbound.phase === "prompt" || inbound.phase === "picking") {
        finishInbound(false);
      } else if (inbound.phase === "receiving" || inbound.phase === "resuming") {
        const current = inbound;
        recv = recv ? { ...recv, status: "recvFail", done: true, ok: false, speed: 0 } : null;
        await closeSink(current);
        finishInbound(false);
      }
    });
    recvChain = task.catch((err) => {
      console.error("relayium mixed file abort error", err);
      failReceive(candidate, expectedGeneration);
    });
  }

  const stillReceiving = (current: Inbound) => inbound === current
    && current.link === link
    && current.generation === generation
    && current.phase === "receiving";
  const stillOwned = (current: Inbound) => inbound === current
    && (current.phase === "receiving" || current.phase === "resuming");
  const isDraining = (current: Inbound) => inbound === current && current.phase === "draining";

  function refreshReceiveWatchdog(current: Inbound) {
    clearTimeout(current.receiveTimer);
    current.receiveTimer = setTimeout(() => {
      if (stillReceiving(current)) beginDrain(current, "recvFail", true);
      else if (inbound === current && current.phase === "resuming"
          && current.link === link && current.generation === generation) {
        markLaneFailed(current.link, "recvFail", current.generation);
      }
    }, receiveStallMs);
  }

  function refreshDrainWatchdog(current: Inbound) {
    clearTimeout(current.drainTimer);
    current.drainTimer = setTimeout(() => {
      if (inbound === current && current.phase === "draining") {
        markLaneFailed(current.link, "recvFail", current.generation);
      }
    }, drainTimeoutMs);
  }

  function recordDrained(current: Inbound, bytes: number) {
    current.drained += bytes;
    if (current.drained > current.drainLimit) {
      throw new Error("relayium: rejected batch exceeded drain bound");
    }
    refreshDrainWatchdog(current);
  }

  async function handleInboundOutput(
    candidate: MixedPeerLink,
    out: Awaited<ReturnType<MixedPeerLink["fileReceiver"]["feed"]>>,
  ) {
    if (out.resume) {
      // I2, receiver half. Exactly one announcement, only in the state that
      // expects one. A duplicate, or one on a live aligned lane, is a protocol
      // failure — that narrowness is what keeps a forged plaintext frame from
      // being a free sequence jump at any moment the peer chooses.
      if (resyncIn !== "required") {
        throw new Error("relayium: unexpected file resume marker on live link");
      }
      const current = inbound;
      if (current?.phase === "resuming" || (current?.phase === "draining" && current.cancelRequested)) {
        const checkpoint = current.checkpoint;
        if (current.link !== candidate || current.generation !== generation
            || out.resume.index !== checkpoint.index || out.resume.offset !== checkpoint.offset) {
          throw new Error("relayium: resume announcement did not match durable checkpoint");
        }
        candidate.fileReceiver.resumeAt(checkpoint.chain, out.resume.seq);
        if (current.phase === "resuming") {
          current.fileIndex = checkpoint.index;
          current.fileOffset = checkpoint.offset;
          current.got = batchOffset(current.files, checkpoint);
          current.lastAckSent = current.got;
          current.speedBase = current.got;
          current.startedAt = now();
          current.phase = "receiving";
          if (recv && !recv.done) recv = { ...recv, sent: current.got, index: current.fileIndex, status: "receiving", speed: 0 };
          refreshReceiveWatchdog(current);
        }
      } else {
        // An idle direction still needs one generation alignment before its next
        // batch. With no preserved sink, only the batch-free origin is valid.
        if (out.resume.index !== 0 || out.resume.offset !== 0) {
          throw new Error("relayium: resume point without an active batch");
        }
        candidate.fileReceiver.resumeAt(new Uint8Array(32), out.resume.seq);
      }
      resyncIn = "none";
      return;
    }
    if (out.batch) {
      const files = out.batch.files;
      const valid = files.length > 0 && files.length <= MAX_FILES
        && files.every((file) => Number.isSafeInteger(file.size) && file.size >= 0);
      const total = valid ? files.reduce((sum, file) => sum + file.size, 0) : -1;
      if (!valid || !Number.isSafeInteger(total) || total < 0) {
        sendBarrier(REJECT, candidate);
        return;
      }
      onManifest(candidate, files, total);
      return;
    }

    const current = inbound;
    if (!current || current.link !== candidate) {
      throw new Error("relayium: file content arrived without an admitted batch");
    }
    if (current.phase === "prompt" || current.phase === "picking") {
      beginDrain(current, "recvFail");
    }
    if (current.phase === "draining") {
      if (out.chunk) recordDrained(current, out.chunk.length);
      return;
    }
    if (current.phase !== "receiving") return;

    if (out.chunk) {
      const declared = current.files[current.fileIndex]?.size;
      if (!current.sink || wouldExceedDeclared(declared, current.fileOffset, out.chunk.length)) {
        await closeSink(current);
        if (stillReceiving(current)) beginDrain(current, "integrityFail");
        if (isDraining(current)) recordDrained(current, out.chunk.length);
        return;
      }
      await current.sink.write(out.chunk);
      // The write may have crossed a transport replacement. It is nevertheless
      // durable and was already authenticated in the old FIFO chain, so commit
      // it to the checkpoint before deciding whether the old generation may
      // publish progress or send an ACK.
      if (!stillOwned(current)) return;
      current.got += out.chunk.length;
      current.fileOffset += out.chunk.length;
      current.checkpoint = {
        index: current.fileIndex,
        offset: current.fileOffset,
        chain: candidate.fileReceiver.snapshotChain(),
      };
      if (!stillReceiving(current)) {
        publishReceive(current);
        return;
      }
      if (current.got - current.lastAckSent >= FLOW_ACK_INTERVAL) {
        current.lastAckSent = current.got;
        sendControl(ackFrame(current.got), candidate, current.generation);
      }
      refreshReceiveWatchdog(current);
      publishReceive(current);
      return;
    }

    if (out.done) {
      const declared = current.files[current.fileIndex]?.size;
      if (current.fileOffset !== declared) {
        await closeSink(current);
        beginDrain(current, "integrityFail");
        return;
      }
      await closeSink(current);
      if (!stillReceiving(current)) return;
      current.allOk = current.allOk && out.done.ok;
      current.fileIndex++;
      current.fileOffset = 0;
      if (current.fileIndex < current.files.length) {
        const nextSink = await current.target!.file(
          current.files[current.fileIndex].name,
          current.files[current.fileIndex].size,
          current.files[current.fileIndex].path,
        );
        // A gap crossing this open is not a reason to throw the sink away. The
        // batch still owns it, and `SaveTarget.file()` is not idempotent: closing
        // this one would leave an empty file behind and make the resumed DONE open
        // the same name a second time — an empty original plus a suffixed
        // duplicate. Committing it, together with the next file's zero
        // checkpoint, is exactly the durable state the resume request must name.
        // Cancellation, detach and any terminal loss of ownership still close it.
        if (!stillOwned(current) || current.cancelRequested) {
          try { await nextSink.close(); } catch { /* cancelled path owns status */ }
          return;
        }
        current.sink = nextSink;
        current.checkpoint = {
          index: current.fileIndex,
          offset: 0,
          chain: new Uint8Array(32),
        };
        // Progress and the no-progress watchdog belong to a live generation only:
        // a paused batch is governed by the gap timer until its replacement.
        if (!stillReceiving(current)) return;
        refreshReceiveWatchdog(current);
        publishReceive(current, true);
        return;
      }
      if (!current.targetFinalized) {
        await current.target?.done?.();
        current.targetFinalized = true;
      }
      if (!stillReceiving(current)) return;
      const finished: Xfer = {
        peer: candidate.peerId,
        dir: "recv",
        files: current.files,
        index: Math.max(0, current.files.length - 1),
        sent: current.total,
        total: current.total,
        status: current.allOk ? "recvDone" : "integrityFail",
        done: true,
        ok: current.allOk,
        speed: 0,
      };
      recv = finished;
      if (!current.allOk) {
        beginDrain(current, "integrityFail");
        return;
      }
      if (!sendBarrier(COMPLETE, candidate, current.generation)) return;
      finishInbound(true);
    }
  }

  function onManifest(candidate: MixedPeerLink, files: FileMeta[], total: number) {
    if (inbound || pendingInbound) {
      sendBarrier(FILE_BUSY, candidate);
      return;
    }
    if (launching) {
      if (candidate.role === "initiator" || launching.peerId !== candidate.peerId) {
        sendBarrier(FILE_BUSY, candidate);
        return;
      }
      // The larger peer yields even while ensureLink() is still resolving. Mark
      // the displaced local intent as its one allowed replay and invalidate the
      // stale launch continuation before admitting the remote manifest.
      const displaced = launching;
      launching = null;
      pumpToken++;
      queued = [{ ...displaced, replayed: true }, ...queued];
      send = null;
      activateInbound(candidate, files, total);
      return;
    }
    const current = outbound;
    if (current && !current.terminal) {
      if (candidate.role === "initiator") {
        // Deterministic keeper: the smaller room peer ID keeps its outbound.
        sendBarrier(FILE_BUSY, candidate);
        return;
      }
      // Deterministic yielder. If manifest encryption is still running, it may
      // already have consumed a nonce; runOutbound must put that manifest on the
      // channel before yielding so the peer receiver stays aligned.
      pendingInbound = { link: candidate, files, total };
      current.yieldRequested = true;
      if (current.phase === "waitingAccept") current.decide("yield");
      return;
    }
    activateInbound(candidate, files, total);
  }

  function activateInbound(candidate: MixedPeerLink, files: FileMeta[], total: number) {
    if (candidate !== link || inbound || lanePoisoned(candidate)) return;
    const current: Inbound = {
      link: candidate,
      generation,
      files,
      total,
      phase: "prompt",
      fileIndex: 0,
      fileOffset: 0,
      got: 0,
      allOk: true,
      startedAt: 0,
      lastUiAt: 0,
      lastAckSent: 0,
      speedBase: 0,
      checkpoint: { index: 0, offset: 0, chain: new Uint8Array(32) },
      targetFinalized: false,
      cancelRequested: false,
      drainLimit: total,
      drained: 0,
    };
    inbound = current;
    incoming = { from: candidate.peerId, files, total };
    recv = null;
    clearTimeout(consentTimer);
    consentTimer = setTimeout(() => {
      if (inbound === current && current.phase === "prompt") rejectInbound(current);
    }, consentTimeoutMs);
  }

  function acceptInbound(current: Inbound, targetPromise: Promise<SaveTarget>) {
    current.phase = "picking";
    void targetPromise.then(async (target) => {
      if (inbound !== current || current.link !== link || current.phase !== "picking"
          || current.link.fileChannel.readyState !== "open") return;
      deps.requestNotify?.();
      current.target = target;
      try {
        current.sink = await target.file(current.files[0].name, current.files[0].size, current.files[0].path);
      } catch (err) {
        console.error("relayium mixed file save-target error", err);
        rejectInbound(current, "noSave");
        return;
      }
      if (inbound !== current || current.phase !== "picking" || current.link !== link) {
        await closeSink(current);
        return;
      }
      clearTimeout(consentTimer);
      consentTimer = undefined;
      current.phase = "receiving";
      current.startedAt = now();
      refreshReceiveWatchdog(current);
      incoming = null;
      recv = {
        peer: current.link.peerId,
        dir: "recv",
        files: current.files,
        index: 0,
        sent: 0,
        total: current.total,
        status: "receiving",
        done: false,
        ok: false,
        speed: 0,
      };
      if (!sendBarrier(ACCEPT, current.link, current.generation)) return;
    }, (err) => {
      console.error("relayium mixed file picker error", err);
      if (inbound === current) rejectInbound(current, "noSave");
    });
  }

  function rejectInbound(current: Inbound, status?: "noSave") {
    if (inbound !== current) return;
    clearTimeout(consentTimer);
    consentTimer = undefined;
    if (!sendBarrier(REJECT, current.link, current.generation)) return;
    incoming = null;
    if (status) {
      recv = {
        peer: current.link.peerId, dir: "recv", files: current.files,
        index: 0, sent: 0, total: current.total, status,
        done: true, ok: false, speed: 0,
      };
    } else recv = null;
    // Before ACCEPT the sender has emitted only the manifest, so REJECT itself is
    // the complete ordered barrier and the lane can be reused immediately.
    inbound = null;
    pump();
  }

  function beginDrain(
    current: Inbound,
    status: "recvFail" | "integrityFail",
    closeAfterPendingWrites = false,
  ) {
    if (inbound !== current || current.phase === "draining") return;
    clearTimeout(consentTimer);
    consentTimer = undefined;
    current.phase = "draining";
    clearTimeout(current.receiveTimer);
    current.receiveTimer = undefined;
    // Bytes already admitted but not yet written are included in total-got, so
    // no flow-window slack is needed here. The consented manifest is the hard
    // upper bound even on a cancellation path.
    current.drainLimit = Math.max(0, current.total - current.got);
    current.drained = 0;
    incoming = null;
    recv = {
      peer: current.link.peerId, dir: "recv", files: current.files,
      index: Math.min(current.fileIndex, current.files.length - 1),
      sent: current.got, total: current.total,
      status, done: true, ok: false, speed: 0,
    };
    if (!sendBarrier(REJECT, current.link, current.generation)) return;
    // A click can cross an in-flight sink.write(). FileSink explicitly forbids a
    // concurrent close, so user-driven stops serialize close after the already
    // admitted receive chain. Calls already running inside that chain close the
    // sink themselves before entering drain.
    if (closeAfterPendingWrites) {
      const closeTask = recvChain.then(() => closeSink(current));
      recvChain = closeTask.catch((err) => {
        console.error("relayium mixed file sink close error", err);
        if (inbound === current) markLaneFailed(current.link, "recvFail", current.generation);
      });
    }
    refreshDrainWatchdog(current);
  }

  async function closeSink(current: Inbound) {
    const sink = current.sink;
    current.sink = undefined;
    if (sink) {
      try { await sink.close(); } catch { /* failing path already owns status */ }
    }
  }

  function finishInbound(success: boolean) {
    const current = inbound;
    if (!current) return;
    clearTimeout(current.drainTimer);
    clearTimeout(current.receiveTimer);
    clearTimeout(consentTimer);
    consentTimer = undefined;
    incoming = null;
    inbound = null;
    if (!success && recv && !recv.done) recv = null;
    pump();
  }

  function publishReceive(current: Inbound, force = false) {
    if (!recv || recv.done) return;
    const t = now();
    if (!force && t - current.lastUiAt < UI_TICK_MS) return;
    current.lastUiAt = t;
    const elapsed = (t - current.startedAt) / 1000;
    recv = {
      ...recv,
      index: Math.min(current.fileIndex, current.files.length - 1),
      sent: current.got,
      speed: elapsed > 0 ? (current.got - current.speedBase) / elapsed : 0,
    };
  }

  function finishOutbound(current: Outbound) {
    if (outbound !== current) return;
    current.terminal = true;
    current.creditWake?.();
    outbound = null;
    if (pendingInbound?.link === current.link) {
      const next = pendingInbound;
      pendingInbound = null;
      activateInbound(next.link, next.files, next.total);
      return;
    }
    pump();
  }

  function requeueOrFail(current: Outbound) {
    if (current.cancelRequested) {
      send = null;
      return;
    }
    if (!current.batch.replayed) {
      queued = [{ ...current.batch, replayed: true }, ...queued];
      send = null;
    } else {
      send = {
        peer: current.batch.peerId,
        dir: "send",
        files: current.batch.files,
        index: 0,
        sent: current.sentBytes,
        total: current.batch.total,
        status: "peerBusy",
        done: true,
        ok: false,
        speed: 0,
      };
    }
  }

  async function waitForCredit(current: Outbound) {
    while (current.phase !== "resuming" && !current.cancelRequested && !current.remoteStop && !current.terminal
        && current.sentBytes - current.acked > FLOW_WINDOW) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          current.creditWake = null;
          reject(new Error("relayium: receiver stopped acknowledging file data"));
        }, SEND_STALL_MS);
        current.creditWake = () => {
          clearTimeout(timer);
          current.creditWake = null;
          resolve();
        };
      });
    }
  }

  async function waitForBuffer(channel: RTCDataChannel, current: Outbound) {
    // A batch retired by a gap must not park here: the bytes still buffered on a
    // dead channel will never drain, and the wake this would have used was
    // already spent. Waiting out the stall timeout would hold the next batch —
    // and its realignment announcement — for a full minute.
    if (current.phase === "resuming" || current.cancelRequested || current.remoteStop || current.terminal) return;
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.onbufferedamountlow = null;
        current.creditWake = null;
        reject(new Error("relayium: file channel stopped draining"));
      }, SEND_STALL_MS);
      const wake = () => {
        clearTimeout(timer);
        channel.onbufferedamountlow = null;
        current.creditWake = null;
        resolve();
      };
      current.creditWake = wake;
      channel.onbufferedamountlow = wake;
    });
  }

  async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function completeWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error("relayium: receiver did not complete file batch")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runOutbound(current: Outbound, decision: Promise<Decision>) {
    const { batch, link: candidate, generation: expectedGeneration } = current;
    outboundRunning++;
    try {
      // I2, sender half. Emitted lazily and before the first nonce this
      // generation consumes, so the announced seq is exactly the one the next
      // protected frame will carry. A second batch in the same generation emits
      // nothing — the receiver would reject it.
      if (resyncOut) {
        if (!sendBarrier(
          candidate.fileSender.resumeStartFrame({ index: 0, offset: 0 }),
          candidate,
          expectedGeneration,
        )) return;
        resyncOut = false;
      }
      // Frames are cut to this link's negotiated single-message maximum; see
      // wire-limit.ts for why that is a property of the peer, not of us.
      const limit = candidate.conn.maxFrameBytes();
      const frames = await candidate.fileSender.batchFrames(batch.files, candidate.keys, limit);
      // Even if glare/cancel crossed encryption, put the nonce-consuming manifest
      // on the ordered channel before its ABORT barrier.
      for (const frame of frames) sendProtected(frame, candidate, expectedGeneration);
      current.phase = "waitingAccept";
      if (send) send = { ...send, status: "waitingAccept" };

      // Explicit user cancellation wins over an offer that crossed it during
      // async manifest encryption. A glare yield must never resurrect a batch
      // the user already cancelled.
      if (current.cancelRequested) current.decide("reject");
      else if (current.yieldRequested) current.decide("yield");
      const answer = await resolveWithin(decision, consentTimeoutMs, "timeout");

      if (answer === "yield") {
        if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
        requeueOrFail(current);
        return;
      }
      if (answer === "busy") {
        requeueOrFail(current);
        return;
      }
      if (answer === "timeout") {
        if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
        if (current.cancelRequested) send = null;
        else if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        return;
      }
      if (answer === "reject") {
        if (current.cancelRequested) {
          if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
          send = null;
        } else if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        return;
      }

      current.phase = "sending";
      if (send) send = { ...send, status: "sending" };
      const startedAt = now();
      let index = 0;
      let lastUiAt = 0;
      for await (const data of candidate.fileSender.dataFrames(
        batch.picked.map((picked) => picked.file), candidate.keys, undefined, limit,
      )) {
        // dataFrames consumed a nonce before yielding. If a stop crossed that
        // await, this one frame must still enter the channel before BATCH_ABORT.
        if (!current.cancelRequested && !current.remoteStop) await waitForCredit(current);
        await waitForBuffer(candidate.fileChannel, current);
        sendProtected(data, candidate, expectedGeneration);
        if (isChunkFrame(data)) {
          current.sentBytes += data.byteLength - CHUNK_OVERHEAD;
          advanceProduced(current, {
            index,
            offset: current.sentBytes - batchOffset(batch.files, { index, offset: 0 }),
          });
        } else if (data[0] === FRAME.DONE) {
          const finished = index;
          index++;
          advanceProduced(current, index < batch.files.length
            ? { index, offset: 0 }
            : { index: finished, offset: batch.files[finished].size });
        }
        const t = now();
        if (send && t - lastUiAt >= UI_TICK_MS) {
          lastUiAt = t;
          const elapsed = (t - startedAt) / 1000;
          send = {
            ...send,
            sent: Math.min(batch.total, current.sentBytes),
            index: Math.min(index, batch.files.length - 1),
            speed: elapsed > 0 ? current.sentBytes / elapsed : 0,
          };
        }
        if (current.cancelRequested || current.remoteStop) break;
      }

      if (current.cancelRequested || current.remoteStop) {
        if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
        if (current.cancelRequested) send = null;
        else if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        return;
      }

      current.phase = "finishing";
      if (send) send = {
        ...send,
        sent: batch.total,
        index: Math.max(0, batch.files.length - 1),
        status: "finishing",
        speed: 0,
      };
      await completeWithin(current.completed, COMPLETE_TIMEOUT_MS);
      if (candidate !== link || expectedGeneration !== generation) {
        throw new TransportGapError();
      }
      if (current.cancelRequested || current.remoteStop) {
        if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
        if (current.cancelRequested) send = null;
        else if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        return;
      }
      if (!current.gotComplete) throw new Error("relayium: file batch ended without COMPLETE");
      if (send) send = { ...send, status: "sendDone", done: true, ok: true, speed: 0 };
    } catch (err) {
      if (err instanceof TransportGapError) {
        // The throw site already entered the gap (or was inert because a
        // replacement had moved on). Deliberately nothing here: a consented
        // batch stays owned by `outbound` and resumes after this run unwinds.
      } else {
        console.error("relayium mixed file send error", err);
        if (outbound === current && !lanePoisoned(candidate)) {
          markLaneFailed(candidate, "sendFail", expectedGeneration);
        }
      }
    } finally {
      outboundRunning--;
      // A run retired by a gap has no lane state left to finish, but the lane may
      // have become runnable the moment it stopped being able to burn a nonce.
      if (outbound === current && current.phase !== "resuming") finishOutbound(current);
      else if (outbound === current) maybeResumeOutbound();
      else pump();
    }
  }

  async function runOutboundResume(current: Outbound, point: ResumePoint) {
    const { batch, link: candidate, generation: expectedGeneration } = current;
    outboundRunning++;
    try {
      if (!sendBarrier(candidate.fileSender.resumeStartFrame(point), candidate, expectedGeneration)) return;
      if (candidate !== link || expectedGeneration !== generation || suspended) {
        throw new TransportGapError();
      }
      resyncOut = false;
      current.phase = "sending";
      const base = batchOffset(batch.files, point);
      current.sentBytes = base;
      current.acked = base;
      if (send && !send.done) {
        send = { ...send, status: "sending", sent: base, index: point.index, speed: 0 };
      }

      const startedAt = now();
      let index = point.index;
      let fileOffset = point.offset;
      let lastUiAt = 0;
      // A replacement transport negotiates its own maximum message size. Only
      // the fragmentation follows it; `point` is on the CHUNK_SIZE grid either
      // way, so the resumed hash chain lines up with the receiver's checkpoint.
      for await (const data of candidate.fileSender.dataFrames(
        batch.picked.map((picked) => picked.file),
        candidate.keys,
        point,
        candidate.conn.maxFrameBytes(),
      )) {
        if (!current.cancelRequested && !current.remoteStop) await waitForCredit(current);
        await waitForBuffer(candidate.fileChannel, current);
        sendProtected(data, candidate, expectedGeneration);
        if (isChunkFrame(data)) {
          const bytes = data.byteLength - CHUNK_OVERHEAD;
          current.sentBytes += bytes;
          fileOffset += bytes;
          advanceProduced(current, { index, offset: fileOffset });
        } else if (data[0] === FRAME.DONE) {
          const finished = index;
          index++;
          fileOffset = 0;
          advanceProduced(current, index < batch.files.length
            ? { index, offset: 0 }
            : { index: finished, offset: batch.files[finished].size });
        }
        const t = now();
        if (send && t - lastUiAt >= UI_TICK_MS) {
          lastUiAt = t;
          const elapsed = (t - startedAt) / 1000;
          send = {
            ...send,
            sent: Math.min(batch.total, current.sentBytes),
            index: Math.min(index, batch.files.length - 1),
            speed: elapsed > 0 ? (current.sentBytes - base) / elapsed : 0,
          };
        }
        if (current.cancelRequested || current.remoteStop) break;
      }

      if (current.cancelRequested || current.remoteStop) {
        if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
        if (current.cancelRequested) send = null;
        else if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        return;
      }

      current.phase = "finishing";
      if (send) send = {
        ...send,
        sent: batch.total,
        index: Math.max(0, batch.files.length - 1),
        status: "finishing",
        speed: 0,
      };
      await completeWithin(current.completed, COMPLETE_TIMEOUT_MS);
      if (candidate !== link || expectedGeneration !== generation) {
        throw new TransportGapError();
      }
      if (!current.gotComplete) throw new Error("relayium: resumed file batch ended without COMPLETE");
      if (send) send = { ...send, status: "sendDone", done: true, ok: true, speed: 0 };
    } catch (err) {
      if (!(err instanceof TransportGapError)) {
        console.error("relayium mixed file resume error", err);
        if (outbound === current && !lanePoisoned(candidate)) {
          markLaneFailed(candidate, "sendFail", expectedGeneration);
        }
      }
    } finally {
      outboundRunning--;
      current.resumeStarted = false;
      if (outbound === current && current.phase !== "resuming") finishOutbound(current);
      else if (outbound === current) maybeResumeOutbound();
      else pump();
    }
  }

  function maybeResumeOutbound() {
    const current = outbound;
    if (!current || current.phase !== "resuming" || current.resumeStarted
        || !current.resumeRequest || outboundRunning > 0 || suspended
        || current.link !== link || current.generation !== generation
        || current.link.fileChannel.readyState !== "open") return;
    const point = current.resumeRequest;
    current.resumeRequest = null;
    current.resumeStarted = true;
    clearTimeout(resumeTimer);
    resumeTimer = undefined;
    resetCompletion(current);
    void runOutboundResume(current, point);
  }

  function startBatch(batch: LocalBatch, candidate: MixedPeerLink) {
    let decide!: (decision: Decision) => void;
    let complete!: () => void;
    const decision = new Promise<Decision>((resolve) => { decide = resolve; });
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const current: Outbound = {
      batch,
      link: candidate,
      generation,
      phase: "offering",
      yieldRequested: false,
      cancelRequested: false,
      remoteStop: false,
      sentBytes: 0,
      acked: 0,
      creditWake: null,
      decide,
      complete,
      completed,
      gotComplete: false,
      terminal: false,
      resumeRequest: null,
      resumeStarted: false,
      produced: { index: 0, offset: 0 },
    };
    outbound = current;
    send = {
      peer: batch.peerId,
      dir: "send",
      files: batch.files,
      index: 0,
      sent: 0,
      total: batch.total,
      status: "connecting",
      done: false,
      ok: false,
      speed: 0,
    };
    void runOutbound(current, decision);
  }

  function pump() {
    if (suspended || outbound || outboundRunning > 0 || inbound || pendingInbound || launching
        || lanePoisoned() || queued.length === 0) return;
    const batch = queued[0];
    queued = queued.slice(1);
    launching = batch;
    send = {
      peer: batch.peerId, dir: "send", files: batch.files,
      index: 0, sent: 0, total: batch.total,
      status: "connecting", done: false, ok: false, speed: 0,
    };
    const expectedPumpToken = pumpToken;
    const launch = async () => {
      try {
        const candidate = await deps.ensureLink(batch.peerId);
        if (expectedPumpToken !== pumpToken) return;
        launching = null;
        // `suspended` included deliberately: ensureLink can hand back the held
        // link itself while its transport is gone (a lane-only channel close on
        // a live PeerConnection), and a batch must never launch into that. A run
        // still unwinding requeues too; its own finally re-pumps.
        if (suspended || outbound || outboundRunning > 0 || inbound || pendingInbound) {
          queued = [batch, ...queued];
          return;
        }
        attach(candidate);
        if (lanePoisoned(candidate)) throw new Error("relayium: file lane unavailable");
        startBatch(batch, candidate);
      } catch (err) {
        if (expectedPumpToken !== pumpToken) return;
        launching = null;
        console.error("relayium mixed file link error", err);
        errorKey = "failed";
        send = {
          peer: batch.peerId, dir: "send", files: batch.files,
          index: 0, sent: 0, total: batch.total,
          status: "connectFail", done: true, ok: false, speed: 0,
        };
        pump();
      }
    };
    if (batch.replayed && link?.peerId === batch.peerId && link.role === "responder") {
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => { replayTimer = undefined; void launch(); }, MIXED_FILE_REPLAY_DELAY_MS);
    } else void launch();
  }

  function attach(candidate: MixedPeerLink) {
    if (link === candidate && messageHandler) return;
    const previous = link;
    // "Same link, new transport" is not "new link, new codecs", and link-object
    // identity cannot tell them apart. The codec pair can: replaceTransport's
    // whole contract is that these are the SAME objects, so retiring them here
    // would poison the very lane the rebuild exists to preserve (F1/F2).
    const replacement = !!previous
      && previous.peerId === candidate.peerId
      && previous.fileSender === candidate.fileSender
      && previous.fileReceiver === candidate.fileReceiver;
    if (previous) {
      if (replacement) suspend();
      else {
        detachHandlers();
        retireActiveState(previous, generation);
      }
    }
    generation++;
    link = candidate;
    clearGapTimer();
    suspended = false;
    // A replacement is the only thing that answers the question the marker
    // records, so it is the only thing that may clear it.
    recoveryIntent = false;
    queuedInboundBytes = 0;
    candidate.fileChannel.binaryType = "arraybuffer";
    if (recvChainOwner !== candidate.fileReceiver) {
      recvChainOwner = candidate.fileReceiver;
      recvChain = Promise.resolve();
    }
    errorKey = lanePoisoned(candidate) ? "failed" : "";
    const expectedGeneration = generation;
    const resumingOutbound = replacement && outbound?.phase === "resuming" ? outbound : null;
    const resumingInbound = replacement && inbound?.phase === "resuming" ? inbound : null;
    if (resumingOutbound) {
      resumingOutbound.link = candidate;
      resumingOutbound.generation = expectedGeneration;
      resumingOutbound.resumeRequest = null;
      resumingOutbound.resumeStarted = false;
    }
    messageHandler = (event) => {
      const buf = asBuffer(event.data);
      if (!buf || candidate !== link || expectedGeneration !== generation) return;
      deps.onActivity?.();
      if (parseAck(buf) !== null || controlKind(buf) !== null || isResumeReq(buf)) {
        // Receiver->sender controls must not wait behind slow inbound disk writes,
        // or our independent outbound flow-control window can deadlock.
        handleControl(buf);
      } else if (isBatchAbort(buf)) queueAbort(candidate, expectedGeneration);
      else queueInbound(buf, candidate, expectedGeneration);
    };
    closeHandler = () => {
      if (candidate !== link || expectedGeneration !== generation) return;
      // A channel close is a transport gap, not a codec failure — and it may
      // arrive either before or after the PeerConnection's own terminal
      // callback. Routing both orders into one idempotent suspend() removes the
      // ordering race instead of assuming a browser callback order.
      suspend();
    };
    candidate.fileChannel.onmessage = messageHandler;
    candidate.fileChannel.onclose = closeHandler;
    // A replacement whose lane is already dead is not a recovery. Re-entering the
    // gap detaches the handlers again, so the coordinator's attachment check
    // fails the link closed rather than launching a batch into nothing.
    if (candidate.fileChannel.readyState !== "open") {
      if (replacement) suspend();
      return;
    }
    if (resumingOutbound) armOutboundResumeTimer(resumingOutbound);
    if (resumingInbound) {
      // An old task may already have authenticated a chunk and be inside the
      // durable sink.write(). Let the whole admitted FIFO settle before reading
      // the checkpoint; tasks that had not reached feed() are generation-gated
      // and cannot enter it. The request therefore names exactly the durable
      // prefix, never a speculative one.
      const admitted = recvChain;
      void admitted.then(() => {
        if (inbound !== resumingInbound || link !== candidate
            || generation !== expectedGeneration || suspended
            || resumingInbound.phase !== "resuming") return;
        resumingInbound.link = candidate;
        resumingInbound.generation = expectedGeneration;
        if (resumingInbound.cancelRequested) {
          if (!sendControl(REJECT, candidate, expectedGeneration)) return;
          candidate.fileReceiver.abortBatch();
          const closeTask = recvChain.then(() => closeSink(resumingInbound));
          recvChain = closeTask.then(() => {
            if (inbound === resumingInbound) finishInbound(false);
          }).catch((err) => {
            console.error("relayium mixed file resumed cancellation error", err);
            if (inbound === resumingInbound) markLaneFailed(candidate, "recvFail", expectedGeneration);
          });
          return;
        }
        const checkpoint = resumingInbound.checkpoint;
        if (!sendControl(resumeReqFrame(checkpoint.index, checkpoint.offset), candidate, expectedGeneration)) return;
        refreshReceiveWatchdog(resumingInbound);
      });
    }
    maybeResumeOutbound();
    // External reattachment may make a preserved queue runnable. Deferring keeps
    // pump()'s own attach(candidate) path from launching a second batch before
    // startBatch() reserves the lane in the current call stack.
    queueMicrotask(pump);
  }

  function detach() {
    const previous = link;
    const previousGeneration = generation;
    clearGapTimer();
    detachHandlers();
    if (previous) retireActiveState(previous, previousGeneration);
    if (launching) {
      // This intent has left the public queue and is actively establishing the
      // detached link, so explicit detach cancels it instead of silently replaying
      // a connection the user just left. Later queued intents remain preserved.
      pumpToken++;
      clearTimeout(replayTimer);
      replayTimer = undefined;
      launching = null;
      if (send && !send.done) send = { ...send, status: "connectFail", done: true, ok: false, speed: 0 };
    }
    generation++;
    link = null;
    // Final teardown for this lane's link: the marker has no one left to answer
    // it, and a later link brings its own codecs and its own aligned sequence.
    suspended = false;
    recoveryIntent = false;
    resyncOut = false;
    resyncIn = "none";
    queuedInboundBytes = 0;
  }

  return {
    get link() { return link; },
    get incoming() { return incoming; },
    get recv() { return recv; },
    get send() { return send; },
    get queued() { return queued; },
    get errorKey() { return errorKey; },

    attach,
    detach,
    suspend,
    needsRecovery() { return recoveryIntent; },

    enqueue(peerId, picked) {
      const chosen = picked.slice(0, MAX_FILES);
      if (chosen.length === 0) return;
      const files = chosen.map(({ file, path }) => ({ name: file.name, size: file.size, path }));
      const valid = files.every((file) => Number.isSafeInteger(file.size) && file.size >= 0);
      const total = valid ? files.reduce((sum, file) => sum + file.size, 0) : -1;
      if (!valid || !Number.isSafeInteger(total) || total < 0 || lanePoisoned()) {
        errorKey = valid ? "failed" : "unsupported";
        send = {
          peer: peerId, dir: "send", files,
          index: 0, sent: 0, total: Math.max(0, total),
          status: "sendFail", done: true, ok: false, speed: 0,
        };
        return;
      }
      const batch: LocalBatch = {
        id: nextBatchId++,
        peerId,
        picked: chosen,
        files,
        total,
        replayed: false,
      };
      queued = [...queued, batch];
      pump();
    },

    accept() {
      const current = inbound;
      if (!current || current.phase !== "prompt") return;
      // Keep this call synchronous and first in the click path: native save
      // pickers require transient user activation. Notification permission is
      // intentionally requested only after it resolves.
      let target: Promise<SaveTarget>;
      try { target = chooseTarget(current.files); }
      catch (err) { target = Promise.reject(err); }
      acceptInbound(current, target);
    },

    reject() {
      const current = inbound;
      if (current && (current.phase === "prompt" || current.phase === "picking")) rejectInbound(current);
    },

    cancel(dir) {
      if (dir === "send" && outbound) {
        outbound.cancelRequested = true;
        outbound.creditWake?.();
        if (outbound.phase === "waitingAccept") outbound.decide("reject");
        if (outbound.phase === "finishing") outbound.complete();
        if (outbound.phase === "resuming") send = null;
      } else if (dir === "send" && launching) {
        pumpToken++;
        clearTimeout(replayTimer);
        replayTimer = undefined;
        launching = null;
        send = null;
        pump();
      } else if (dir === "recv" && inbound) {
        if (inbound.phase === "prompt" || inbound.phase === "picking") rejectInbound(inbound);
        else if (inbound.phase === "receiving") beginDrain(inbound, "recvFail", true);
        else if (inbound.phase === "resuming") {
          inbound.cancelRequested = true;
          if (!suspended && inbound.link === link && inbound.generation === generation
              && inbound.link.fileChannel.readyState === "open") {
            beginDrain(inbound, "recvFail", true);
          } else if (recv && !recv.done) {
            recv = { ...recv, status: "recvFail", done: true, ok: false, speed: 0 };
          }
        }
      }
    },

    cancelQueued(id) {
      if (launching?.id === id) {
        pumpToken++;
        clearTimeout(replayTimer);
        replayTimer = undefined;
        launching = null;
        send = null;
      } else queued = queued.filter((batch) => batch.id !== id);
      pump();
    },
    dismissSend(x) { if (send === x) send = null; },
    dismissRecv(x) { if (recv === x) recv = null; },
    active,
    reset() {
      pumpToken++;
      clearTimeout(replayTimer);
      replayTimer = undefined;
      outbound?.creditWake?.();
      // Retire the live generation before clearing its object references so an
      // open sink is closed and any consumed nonce makes the old codecs terminal.
      detach();
      clearInboundTimers();
      outbound = null;
      inbound = null;
      launching = null;
      pendingInbound = null;
      queued = [];
      incoming = null;
      recv = null;
      send = null;
      errorKey = "";
    },
  };
}
