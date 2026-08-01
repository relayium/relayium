// Reusable file batches on a long-lived authenticated peer link.
//
// The link owns Sender/Receiver for its whole lifetime. This module therefore
// never reconstructs a codec between batches: manifests, chunks and DONE frames
// all consume one monotonically increasing nonce sequence in each direction.

import type { PickedFile } from "./drag";
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
  parseAck,
  type FileMeta,
} from "./transfer";
import { wouldExceedDeclared } from "./transfer-session.svelte";

export const MIXED_FILE_CONSENT_TIMEOUT_MS = 10 * 60_000;
export const MIXED_FILE_DRAIN_TIMEOUT_MS = 30_000;
export const MIXED_FILE_REPLAY_DELAY_MS = 250;
export const MIXED_FILE_RECEIVE_STALL_MS = 60_000;

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

type OutboundPhase = "offering" | "waitingAccept" | "sending" | "finishing";
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
  gotComplete: boolean;
  terminal: boolean;
}

type InboundPhase = "prompt" | "picking" | "receiving" | "draining";

interface Inbound {
  readonly link: MixedPeerLink;
  readonly generation: number;
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
  drainLimit: number;
  drained: number;
  drainTimer?: ReturnType<typeof setTimeout>;
  receiveTimer?: ReturnType<typeof setTimeout>;
}

export interface MixedFileSessionDeps {
  selfId(): string;
  ensureLink(peerId: string): Promise<MixedPeerLink>;
  pickSaveTarget?(files: FileMeta[]): Promise<SaveTarget>;
  requestNotify?(): void;
  now?(): number;
  consentTimeoutMs?: number;
  receiveStallMs?: number;
  drainTimeoutMs?: number;
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
  let pumpToken = 0;
  let pendingInbound: { link: MixedPeerLink; files: FileMeta[]; total: number } | null = null;
  let recvChain: Promise<void> = Promise.resolve();
  let recvChainOwner: object | null = null;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let consentTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let protectedTransportGeneration: number | null = null;
  let queuedInboundBytes = 0;
  const poisonedCodecs = new WeakSet<object>();

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

  function closeSinkAfterReceiveChain(current: Inbound) {
    // Retirement closes/poisons this generation before returning, so no later
    // task can legitimately touch its sink. The promise need not become the
    // current generation's recvChain (which attach may reset to another codec).
    void recvChain.then(() => closeSink(current)).catch((err) => {
      console.error("relayium mixed file sink retirement error", err);
      poison(current.link);
    });
  }

  function retireActiveState(candidate: MixedPeerLink, expectedGeneration: number) {
    const oldOutbound = outbound?.link === candidate && outbound.generation === expectedGeneration
      ? outbound : null;
    const oldInbound = inbound?.link === candidate && inbound.generation === expectedGeneration
      ? inbound : null;
    const hadActiveWireState = !!oldOutbound || !!oldInbound || pendingInbound?.link === candidate
      || protectedTransportGeneration === expectedGeneration;
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
    if (protectedTransportGeneration === expectedGeneration) protectedTransportGeneration = null;
    poison(candidate);
    try { candidate.fileChannel.close(); } catch { /* already terminal */ }
  }

  function clearInboundTimers() {
    clearTimeout(consentTimer);
    consentTimer = undefined;
    if (inbound?.drainTimer) clearTimeout(inbound.drainTimer);
    if (inbound?.receiveTimer) clearTimeout(inbound.receiveTimer);
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
    protectedTransportGeneration = null;
    if (failedInbound) closeSinkAfterReceiveChain(failedInbound);
    try { candidate.fileChannel.close(); } catch { /* already terminal */ }
  }

  function sendControl(
    frame: Uint8Array<ArrayBuffer>,
    candidate = link,
    expectedGeneration = generation,
  ): boolean {
    if (!candidate || candidate !== link || expectedGeneration !== generation || lanePoisoned(candidate)) return false;
    if (candidate.fileChannel.readyState !== "open") return false;
    try {
      if (candidate.fileChannel.bufferedAmount === 0
          && protectedTransportGeneration === expectedGeneration) protectedTransportGeneration = null;
      candidate.fileChannel.send(frame);
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
    // Losing a lifecycle barrier makes the next unscoped batch ambiguous. Do not
    // optimistically reuse this file lane.
    markLaneFailed(candidate, "recvFail", expectedGeneration);
    return false;
  }

  function sendProtected(
    frame: Uint8Array<ArrayBuffer>,
    candidate: MixedPeerLink,
    expectedGeneration: number,
  ) {
    if (candidate !== link || expectedGeneration !== generation
        || lanePoisoned(candidate) || candidate.fileChannel.readyState !== "open") {
      // batchFrame/dataFrames already consumed a sender nonce. If the resulting
      // frame cannot enter this ordered channel, this codec can no longer prove
      // continuity and must not be reused.
      markLaneFailed(candidate, "sendFail", expectedGeneration);
      throw new Error("relayium: protected file frame could not enter the channel");
    }
    protectedTransportGeneration = expectedGeneration;
    try {
      candidate.fileChannel.send(frame);
    } catch (err) {
      protectedTransportGeneration = null;
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
    if (link?.fileChannel.bufferedAmount === 0) protectedTransportGeneration = null;
    const current = outbound;
    if (!current || current.link !== link || current.generation !== generation || current.terminal) return;

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
      // switch would strand the link-owned receiver sequence.
      if (candidate !== link || expectedGeneration !== generation) {
        poison(candidate);
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
      const out = await candidate.fileReceiver.feed(new Uint8Array(buf), candidate.keys);
      await handleInboundOutput(candidate, out);
    }).finally(() => {
      if (expectedGeneration === generation) {
        queuedInboundBytes = Math.max(0, queuedInboundBytes - buf.byteLength);
      }
    });
    recvChain = task.catch((err) => {
      console.error("relayium mixed file receive error", err);
      if (candidate === link && expectedGeneration === generation) {
        markLaneFailed(candidate, "recvFail", expectedGeneration);
      }
      else poison(candidate);
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
      } else if (inbound.phase === "receiving") {
        const current = inbound;
        recv = recv ? { ...recv, status: "recvFail", done: true, ok: false, speed: 0 } : null;
        await closeSink(current);
        finishInbound(false);
      }
    });
    recvChain = task.catch((err) => {
      console.error("relayium mixed file abort error", err);
      if (candidate === link) markLaneFailed(candidate, "recvFail", expectedGeneration);
    });
  }

  const stillReceiving = (current: Inbound) => inbound === current
    && current.link === link
    && current.generation === generation
    && current.phase === "receiving";
  const isDraining = (current: Inbound) => inbound === current && current.phase === "draining";

  function refreshReceiveWatchdog(current: Inbound) {
    clearTimeout(current.receiveTimer);
    current.receiveTimer = setTimeout(() => {
      if (stillReceiving(current)) beginDrain(current, "recvFail", true);
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
      // Authenticated transport replacement is deliberately a later stage. A
      // resume marker on the initial long-lived channel is not valid.
      throw new Error("relayium: unexpected file resume marker on live link");
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
      if (!stillReceiving(current)) return;
      current.got += out.chunk.length;
      current.fileOffset += out.chunk.length;
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
        if (!stillReceiving(current)) {
          try { await nextSink.close(); } catch { /* cancelled path owns status */ }
          return;
        }
        current.sink = nextSink;
        refreshReceiveWatchdog(current);
        publishReceive(current, true);
        return;
      }
      await current.target?.done?.();
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
      if (deps.selfId() < candidate.peerId || launching.peerId !== candidate.peerId) {
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
      if (deps.selfId() < candidate.peerId) {
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
      speed: elapsed > 0 ? current.got / elapsed : 0,
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
    while (!current.cancelRequested && !current.remoteStop
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

  async function runOutbound(current: Outbound, decision: Promise<Decision>, completed: Promise<void>) {
    const { batch, link: candidate, generation: expectedGeneration } = current;
    try {
      const frame = await candidate.fileSender.batchFrame(batch.files, candidate.keys);
      // Even if glare/cancel crossed encryption, put the nonce-consuming manifest
      // on the ordered channel before its ABORT barrier.
      sendProtected(frame, candidate, expectedGeneration);
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
      for await (const data of candidate.fileSender.dataFrames(batch.picked.map((picked) => picked.file), candidate.keys)) {
        // dataFrames consumed a nonce before yielding. If a stop crossed that
        // await, this one frame must still enter the channel before BATCH_ABORT.
        if (!current.cancelRequested && !current.remoteStop) await waitForCredit(current);
        await waitForBuffer(candidate.fileChannel, current);
        sendProtected(data, candidate, expectedGeneration);
        if (data[0] === FRAME.CHUNK) current.sentBytes += data.byteLength - CHUNK_OVERHEAD;
        else if (data[0] === FRAME.DONE) index++;
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
      await completeWithin(completed, COMPLETE_TIMEOUT_MS);
      if (current.cancelRequested || current.remoteStop) {
        if (!sendBarrier(BATCH_ABORT, candidate, expectedGeneration)) return;
        if (current.cancelRequested) send = null;
        else if (send) send = { ...send, status: "rejected", done: true, ok: false, speed: 0 };
        return;
      }
      if (!current.gotComplete) throw new Error("relayium: file batch ended without COMPLETE");
      if (protectedTransportGeneration === expectedGeneration) protectedTransportGeneration = null;
      if (send) send = { ...send, status: "sendDone", done: true, ok: true, speed: 0 };
    } catch (err) {
      console.error("relayium mixed file send error", err);
      if (outbound === current && !lanePoisoned(candidate)) {
        markLaneFailed(candidate, "sendFail", expectedGeneration);
      }
    } finally {
      finishOutbound(current);
    }
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
      gotComplete: false,
      terminal: false,
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
    void runOutbound(current, decision, completed);
  }

  function pump() {
    if (outbound || inbound || pendingInbound || launching || lanePoisoned() || queued.length === 0) return;
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
        if (outbound || inbound || pendingInbound) {
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
    if (batch.replayed && deps.selfId() > batch.peerId) {
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => { replayTimer = undefined; void launch(); }, MIXED_FILE_REPLAY_DELAY_MS);
    } else void launch();
  }

  function attach(candidate: MixedPeerLink) {
    if (link === candidate && messageHandler) return;
    const previous = link;
    const previousGeneration = generation;
    if (previous) {
      detachHandlers();
      retireActiveState(previous, previousGeneration);
    }
    generation++;
    link = candidate;
    protectedTransportGeneration = null;
    queuedInboundBytes = 0;
    candidate.fileChannel.binaryType = "arraybuffer";
    if (recvChainOwner !== candidate.fileReceiver) {
      recvChainOwner = candidate.fileReceiver;
      recvChain = Promise.resolve();
    }
    errorKey = lanePoisoned(candidate) ? "failed" : "";
    const expectedGeneration = generation;
    messageHandler = (event) => {
      const buf = asBuffer(event.data);
      if (!buf || candidate !== link || expectedGeneration !== generation) return;
      if (parseAck(buf) !== null || controlKind(buf) !== null) {
        // Receiver->sender controls must not wait behind slow inbound disk writes,
        // or our independent outbound flow-control window can deadlock.
        handleControl(buf);
      } else if (isBatchAbort(buf)) queueAbort(candidate, expectedGeneration);
      else queueInbound(buf, candidate, expectedGeneration);
    };
    closeHandler = () => {
      if (candidate !== link || expectedGeneration !== generation) return;
      // An idle close is still terminal for this link-owned codec pair. Keeping
      // it apparently reusable would make the next batch consume a nonce only to
      // discover that its ordered transport no longer exists.
      markLaneFailed(candidate, outbound ? "sendFail" : "recvFail", expectedGeneration);
    };
    candidate.fileChannel.onmessage = messageHandler;
    candidate.fileChannel.onclose = closeHandler;
    // External reattachment may make a preserved queue runnable. Deferring keeps
    // pump()'s own attach(candidate) path from launching a second batch before
    // startBatch() reserves the lane in the current call stack.
    queueMicrotask(pump);
  }

  function detach() {
    const previous = link;
    const previousGeneration = generation;
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
    protectedTransportGeneration = null;
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
    active() { return !!outbound || !!inbound || !!pendingInbound || !!launching || queued.length > 0; },
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
      protectedTransportGeneration = null;
    },
  };
}
