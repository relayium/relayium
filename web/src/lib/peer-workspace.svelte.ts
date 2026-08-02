// Capability router and mutual-exclusion boundary for the public peer surface.
// App.svelte should express user intent through this object; protocol generation
// selection and the "never show two SAS values" rule stay here.

import { createMixedSession, type MixedSession, type MixedSessionDeps } from "./mixed-session.svelte";
import { peerSupportsLink } from "./peer-caps.svelte";
import type { QueuedFileBatch } from "./mixed-file-session.svelte";
import type { PeerLinkStatus } from "./peer-link.svelte";
import type { PickedFile } from "./drag";
import type { TextSession } from "./text-session.svelte";
import type { Incoming, TransferSession, Xfer } from "./transfer-session.svelte";
import type { Conn, ConnPath } from "./webrtc";

export const EXPLICIT_DISCONNECT_SUPPRESS_MS = 60_000;

type LegacyFiles = Pick<TransferSession,
  "incoming" | "recv" | "send" | "sasCode" | "sendPath" | "recvPath"
  | "busy" | "transferActive" | "sendFiles" | "accept" | "reject" | "abort"
  | "abortAll" | "dismissSend" | "dismissRecv" | "reset" | "conn"
>;

type LegacyText = Pick<TextSession,
  "status" | "peerId" | "sasCode" | "path" | "history" | "errorKey"
  | "openWith" | "accept" | "reject" | "send" | "end" | "clearHistory" | "active"
>;

export interface PeerWorkspaceDeps extends Omit<MixedSessionDeps,
  "supportsLink" | "canAcceptLink" | "now" | "onLinkState"
> {
  joined(): boolean;
  peerIds(): readonly string[];
  unsupported(): boolean;
  legacyFiles: LegacyFiles;
  legacyText: LegacyText;
  supportsLink?(peerId: string): boolean;
  now?: () => number;
}

export interface PeerWorkspace {
  readonly mixed: MixedSession;
  readonly send: Xfer | null;
  readonly recv: Xfer | null;
  readonly incoming: Incoming | null;
  readonly sasCode: string;
  readonly sendPath: ConnPath | undefined;
  readonly recvPath: ConnPath | undefined;
  readonly text: LegacyText | MixedSession["text"];
  readonly textPath: ConnPath | undefined;
  readonly usingMixed: boolean;
  readonly blocksLegacyInbound: boolean;
  readonly warnsOnLeave: boolean;
  /** The one link the unified workspace header describes. "" outside mixed mode. */
  readonly linkPeerId: string;
  readonly linkStatus: PeerLinkStatus;
  /** Identity of the current link, changing on every establishment and teardown.
   *  A surface that says something once per link (the announced verification
   *  code) keys off this rather than off the code itself, so a later link is
   *  never mistaken for the current one because six digits happened to repeat. */
  readonly linkGeneration: number;
  /** The link's single connection path. The legacy surfaces keep their own
   *  per-direction labels; a mixed link has exactly one. */
  readonly linkPath: ConnPath | undefined;
  /** Local file batches waiting for the lane. Always empty on the legacy path,
   *  which has no queue at all. */
  readonly queuedBatches: readonly QueuedFileBatch[];
  cancelQueuedBatch(id: number): void;
  routes(peerId: string): boolean;
  blocksNewIntent(peerId: string): boolean;
  sendFiles(peerId: string, files: PickedFile[]): void;
  openText(peerId: string): Promise<void>;
  acceptFile(): void;
  rejectFile(): void;
  abortFile(dir: "send" | "recv"): void;
  dismissSend(xfer: Xfer): void;
  dismissRecv(xfer: Xfer): void;
  acceptText(): void;
  rejectText(): void;
  sendText(body: string): Promise<void>;
  clearText(): void;
  endText(): void;
  conn(): Conn | null;
  start(): void;
  syncPeers(): void;
  disconnect(): void;
  resetRoom(): void;
  stop(): void;
}

export function createPeerWorkspace(deps: PeerWorkspaceDeps): PeerWorkspace {
  const supports = deps.supportsLink ?? peerSupportsLink;
  const now = deps.now ?? Date.now;
  const suppressedUntil = new Map<string, number>();
  let textOwner: "legacy" | "mixed" = "legacy";

  function routes(peerId: string): boolean {
    return deps.joined() && deps.selfId() !== "" && supports(peerId);
  }

  function legacyEngaged(): boolean {
    return deps.legacyFiles.transferActive || deps.legacyText.active();
  }

  function isSuppressed(peerId: string): boolean {
    const until = suppressedUntil.get(peerId) ?? 0;
    if (until <= now()) {
      suppressedUntil.delete(peerId);
      return false;
    }
    return true;
  }

  const mixed = createMixedSession({
    selfId: deps.selfId,
    signaling: deps.signaling,
    rtcConfig: deps.rtcConfig,
    supportsLink: supports,
    canAcceptLink(peerId) {
      // Deliberately do not inspect mixed.manager here. A larger-ID peer waiting
      // for the deterministic offerer already has status=requesting; treating
      // that as busy would reject the very offer it requested.
      return deps.joined() && deps.selfId() !== ""
        && deps.peerIds().includes(peerId)
        && !deps.unsupported()
        && !legacyEngaged()
        && !isSuppressed(peerId);
    },
    connect: deps.connect,
    // Forwarded for the same reason `connect` is: a transport rebuild is now
    // actually triggered, so the seam has to reach the manager that drives it.
    resume: deps.resume,
    pickSaveTarget: deps.pickSaveTarget,
    requestNotify: deps.requestNotify,
    now,
    idleMs: deps.idleMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });

  function usingMixed(): boolean {
    return !!mixed.link || mixed.status === "requesting" || mixed.status === "connecting"
      || mixed.file.active() || mixed.text.active();
  }

  function blocksLegacyInbound(): boolean {
    return mixed.status === "requesting" || mixed.status === "connecting"
      || mixed.status === "open" || !!mixed.link || mixed.file.active() || mixed.text.active();
  }

  function usesMixedText(): boolean {
    if (mixed.text.active()) {
      textOwner = "mixed";
      return true;
    }
    if (deps.legacyText.active()) {
      textOwner = "legacy";
      return false;
    }
    if (textOwner === "mixed"
      && (mixed.text.status !== "idle" || mixed.text.history.length > 0)) return true;
    if (textOwner === "legacy"
      && (deps.legacyText.status !== "idle" || deps.legacyText.history.length > 0)) return false;
    if (mixed.text.status !== "idle" && deps.legacyText.status === "idle") return true;
    if (deps.legacyText.status !== "idle" && mixed.text.status === "idle") return false;
    return textOwner === "mixed";
  }

  function clearSuppressionForIntent(peerId: string) {
    suppressedUntil.delete(peerId);
  }

  function blocksNewIntent(peerId: string): boolean {
    if (legacyEngaged()) return true;
    if (blocksLegacyInbound()) {
      return !(routes(peerId) && mixed.peerId === peerId);
    }
    return false;
  }

  return {
    get mixed() { return mixed; },
    get send() { return mixed.file.send ?? deps.legacyFiles.send; },
    get recv() { return mixed.file.recv ?? deps.legacyFiles.recv; },
    get incoming() { return mixed.file.incoming ?? deps.legacyFiles.incoming; },
    get sasCode() { return mixed.link?.sas ?? deps.legacyFiles.sasCode; },
    get sendPath() { return mixed.file.send ? mixed.path ?? undefined : deps.legacyFiles.sendPath; },
    get recvPath() { return mixed.file.recv ? mixed.path ?? undefined : deps.legacyFiles.recvPath; },
    get text() { return usesMixedText() ? mixed.text : deps.legacyText; },
    get textPath() { return usesMixedText() ? mixed.path ?? undefined : deps.legacyText.path; },
    get usingMixed() { return usingMixed(); },
    get blocksLegacyInbound() { return blocksLegacyInbound(); },
    get warnsOnLeave() { return deps.legacyFiles.busy || mixed.active(); },
    get linkPeerId() { return usingMixed() ? mixed.peerId : ""; },
    get linkStatus() { return mixed.status; },
    get linkGeneration() { return mixed.linkGeneration; },
    get linkPath() { return usingMixed() ? mixed.path ?? undefined : undefined; },
    get queuedBatches() { return usingMixed() ? mixed.file.queued : []; },
    cancelQueuedBatch(id) {
      // Deliberately unconditional: the legacy path never populates this queue,
      // so there is nothing for a stray id to cancel there.
      mixed.file.cancelQueued(id);
    },
    routes,
    blocksNewIntent,
    sendFiles(peerId, files) {
      if (blocksNewIntent(peerId)) return;
      clearSuppressionForIntent(peerId);
      if (routes(peerId)) mixed.file.enqueue(peerId, files);
      else {
        if (mixed.file.send || mixed.file.recv || mixed.file.incoming) mixed.file.reset();
        deps.legacyFiles.sendFiles(peerId, files);
      }
    },
    async openText(peerId) {
      if (blocksNewIntent(peerId)) return;
      clearSuppressionForIntent(peerId);
      if (routes(peerId)) {
        textOwner = "mixed";
        await mixed.text.openWith(peerId);
      } else {
        textOwner = "legacy";
        await deps.legacyText.openWith(peerId);
      }
    },
    acceptFile() {
      if (mixed.file.incoming) mixed.file.accept();
      else deps.legacyFiles.accept();
    },
    rejectFile() {
      if (mixed.file.incoming) mixed.file.reject();
      else deps.legacyFiles.reject();
    },
    abortFile(dir) {
      const activeMixed = dir === "send" ? mixed.file.send : mixed.file.recv;
      if (activeMixed || mixed.file.active()) mixed.file.cancel(dir);
      else deps.legacyFiles.abort(dir);
    },
    dismissSend(xfer) {
      if (mixed.file.send === xfer) mixed.file.dismissSend(xfer);
      else deps.legacyFiles.dismissSend(xfer);
    },
    dismissRecv(xfer) {
      if (mixed.file.recv === xfer) mixed.file.dismissRecv(xfer);
      else deps.legacyFiles.dismissRecv(xfer);
    },
    acceptText() {
      if (usesMixedText()) { textOwner = "mixed"; mixed.text.accept(); }
      else { textOwner = "legacy"; deps.legacyText.accept(); }
    },
    rejectText() {
      if (usesMixedText()) { textOwner = "mixed"; mixed.text.reject(); }
      else { textOwner = "legacy"; deps.legacyText.reject(); }
    },
    sendText(body) {
      if (usesMixedText()) { textOwner = "mixed"; return mixed.text.send(body); }
      textOwner = "legacy";
      return deps.legacyText.send(body);
    },
    clearText() {
      if (usesMixedText()) mixed.text.clearHistory();
      else deps.legacyText.clearHistory();
    },
    endText() {
      if (usesMixedText()) { textOwner = "mixed"; mixed.text.end(); }
      else { textOwner = "legacy"; deps.legacyText.end(); }
    },
    conn() { return mixed.link?.conn ?? deps.legacyFiles.conn() ?? null; },
    start() { mixed.start(); },
    syncPeers() {
      const peerId = mixed.link?.peerId;
      if (peerId && !deps.peerIds().includes(peerId)) mixed.disconnect();
      for (const suppressed of suppressedUntil.keys()) {
        if (!deps.peerIds().includes(suppressed)) suppressedUntil.delete(suppressed);
      }
    },
    disconnect() {
      const peerId = mixed.link?.peerId || mixed.peerId;
      if (peerId) suppressedUntil.set(peerId, now() + EXPLICIT_DISCONNECT_SUPPRESS_MS);
      // The only caller that announces. `syncPeers` (the peer already left the
      // room), `resetRoom` and `stop` all tear down silently: there is nobody to
      // tell, or no user decision to report.
      mixed.disconnect({ announce: true });
    },
    resetRoom() {
      suppressedUntil.clear();
      mixed.disconnect();
      textOwner = "legacy";
    },
    stop() {
      suppressedUntil.clear();
      mixed.stop();
    },
  };
}
