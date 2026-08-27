// Capability gate and single-transport boundary for the public peer surface.
//
// App.svelte expresses user intent through this object. There is exactly one
// transport behind it — an authenticated `link/1` peer link — so this file no
// longer SELECTS between protocol generations: it decides whether a peer may be
// reached at all, and every intent that survives that decision reaches the link.
//
// A peer that does not announce exact `link/1` is unsupported, and unsupported
// is terminal here. There is deliberately no second transport to fall through
// to: the removed legacy file and text lanes were the only reason `routes`
// ever had a false branch that still did something, and re-adding one would
// reintroduce the two-SAS surface this composition exists to prevent.

import { createMixedSession, type MixedSession, type MixedSessionDeps } from "./mixed-session.svelte";
import { peerSupportsLink } from "./peer-caps.svelte";
import type { QueuedFileBatch } from "./mixed-file-session.svelte";
import type { PeerLinkStatus } from "./peer-link.svelte";
import type { PickedFile } from "./drag";
import type { Incoming, Xfer } from "./transfer-model";
import type { RelayGate } from "./relay-selection";
import type { Conn, ConnPath } from "./webrtc";

export const EXPLICIT_DISCONNECT_SUPPRESS_MS = 60_000;

export interface PeerWorkspaceDeps extends Omit<MixedSessionDeps,
  "supportsLink" | "canAcceptLink" | "now" | "onLinkState" | "joined"
> {
  joined(): boolean;
  peerIds(): readonly string[];
  unsupported(): boolean;
  supportsLink?(peerId: string): boolean;
  now?: () => number;
  /**
   * The room's relay agreement, read by the link manager before it puts the
   * first legal `link/1` request or offer on the wire.
   *
   * A getter rather than a value: the gate belongs to a room, and the page swaps
   * rooms without rebuilding this object. Omitted — or answering null — means no
   * pool to choose from and therefore nothing to wait for, which is every LAN
   * room and every STUN-only code.
   */
  relayGate?(): RelayGate | null;
}

export interface PeerWorkspace {
  readonly mixed: MixedSession;
  readonly send: Xfer | null;
  readonly recv: Xfer | null;
  readonly incoming: Incoming | null;
  readonly sasCode: string;
  readonly sendPath: ConnPath | undefined;
  readonly recvPath: ConnPath | undefined;
  readonly text: MixedSession["text"];
  readonly textPath: ConnPath | undefined;
  readonly usingMixed: boolean;
  /** Whether an authenticated link object genuinely exists right now.
   *
   *  Narrower than `usingMixed`, deliberately: that one is already true while a
   *  request is in flight, because the workspace owns the screen from the moment
   *  the user asks for it. Anything that must not act before the peers are
   *  authenticated — opening a lane, for instance — reads this instead. */
  readonly hasLink: boolean;
  readonly warnsOnLeave: boolean;
  /** The one link the unified workspace header describes. "" outside mixed mode. */
  readonly linkPeerId: string;
  readonly linkStatus: PeerLinkStatus;
  /** Identity of the current link, changing on every establishment and teardown.
   *  A surface that says something once per link (the announced verification
   *  code) keys off this rather than off the code itself, so a later link is
   *  never mistaken for the current one because six digits happened to repeat. */
  readonly linkGeneration: number;
  /** The link's single connection path. Every surface reads this one label:
   *  a link has exactly one transport under both of its lanes. */
  readonly linkPath: ConnPath | undefined;
  /** Local file batches waiting for the lane. Empty whenever no workspace is
   *  open, which is the only state that has no queue. */
  readonly queuedBatches: readonly QueuedFileBatch[];
  /** The relayed link is inside its credential warning window. False on any
   *  link with no credential boundary. */
  readonly relayExpiring: boolean;
  /** False while a live link could NOT be rebuilt if its transport died — the
   *  signalling socket is gone, rejoined under a new identity, or was refused.
   *  The link itself is untouched; this is a statement about its future. */
  readonly recoveryAvailable: boolean;
  /** Why the last link ended, when that is something the user must act on. */
  readonly linkEndReason: MixedSession["endReason"];
  /** Dismiss that explanation once it has been read. Tears nothing down. */
  dismissLinkEnd(): void;
  cancelQueuedBatch(id: number): void;
  routes(peerId: string): boolean;
  blocksNewIntent(peerId: string): boolean;
  sendFiles(peerId: string, files: PickedFile[]): void;
  /**
   * Bring up the link this peer's pre-uploaded entries need, and send nothing.
   *
   * The intent behind a batch that is ALL keys. A batch that finished uploading
   * before anybody joined — the ordinary shape of a code room — has nothing for
   * the live lane, so there is no `sendFiles` that could carry it: the transfer
   * is frame kind 12, and that frame needs a link to travel on and the link's
   * verification code to be on screen before a sender confirmation can mean
   * anything. Its own call, rather than an empty batch (which is a manifest with
   * no files in it) or a conversation nobody asked for.
   *
   * Sends no keys by itself. The file lane pulls the current set on every
   * (re)established transport, and what that pull answers is gated separately —
   * see handoff-authorization.
   */
  prepareHandoff(peerId: string): void;
  /** Re-hand the peer the current pre-uploaded set. Used when an upload that was
   *  still in flight when the peer joined finishes on an already-open link. */
  sendStoredKeys(): void;
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
  /**
   * Retire what a relay gate is holding for a peer the room's roster no longer
   * names.
   *
   * Deliberately separate from `peerLeft`: a roster that stops naming an id is
   * not a confirmed physical departure, so this touches no established link, no
   * in-flight establishment and no outstanding request, and records nothing in
   * `departed`. It reaches only the gated phases — see
   * `PeerLinkManager.rosterPeerGone` — which have no transport under them and
   * exist solely because that peer was expected to answer.
   */
  rosterPeerGone(peerId: string): void;
  /** End sessions bound to a signaling peer the server confirmed closed. */
  peerLeft(peerId: string): void;
  disconnect(): void;
  resetRoom(): void;
  stop(): void;
}

export function createPeerWorkspace(deps: PeerWorkspaceDeps): PeerWorkspace {
  const supports = deps.supportsLink ?? peerSupportsLink;
  const now = deps.now ?? Date.now;
  const suppressedUntil = new Map<string, number>();
  /**
   * Peer ids the SERVER said have physically left this room.
   *
   * Deliberately not derived from `peerIds()`: a roster that stops naming an id
   * is a representative handoff, whose socket and data channel are both still
   * alive — `syncPeers` says so at length. Only a `left` frame is the socket.
   * Same lifetime as `suppressedUntil`: it belongs to one room.
   *
   * Reactive, and replaced rather than mutated, because `recoveryAvailable` is
   * read by the workspace header during render. A plain Set would answer the
   * question correctly to anyone who asked again and never cause anyone to ask:
   * the warning would only appear if some other reactive value happened to
   * change afterwards. `suppressedUntil` above needs none of this — it is only
   * ever read from inside an event handler.
   */
  let departed = $state.raw<ReadonlySet<string>>(new Set());

  /**
   * Whether an established link with a live transport already binds this peer.
   *
   * The correlated-loss invariant, stated at the router. Everything `routes`
   * asks below is a fact about SIGNALLING — this room's membership, this page's
   * own id, and a capability announcement that arrives over signalling and is
   * pruned with the roster (peer-caps' `retainPeers`) — and none of those is a
   * fact about the DataChannel between the two pages. A peer's socket dropping,
   * or this page's own, therefore used to make a healthy, authenticated,
   * mutually verified link's peer read as unreachable: new file batches were
   * refused outright by `blocksNewIntent` while the link carried on working.
   *
   * Scoped to `open`, so this is never a way to bypass a gate. A held link has
   * no transport under it and getting one back means a rebuild through the
   * signalling layer that just went away — the ordinary answer is the honest one
   * there. And it says nothing about links that do not exist yet: a new link, an
   * inbound offer or request, and a recovery all keep the exact capability and
   * membership tests they had.
   */
  function linkAuthoritative(peerId: string): boolean {
    const link = mixed.link;
    return !!link && link.peerId === peerId && mixed.status === "open";
  }

  function routes(peerId: string): boolean {
    if (linkAuthoritative(peerId)) return true;
    return deps.joined() && deps.selfId() !== "" && supports(peerId);
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
        && !isSuppressed(peerId);
    },
    connect: deps.connect,
    // Forwarded for the same reason `connect` is: a transport rebuild is now
    // actually triggered, so the seam has to reach the manager that drives it.
    resume: deps.resume,
    pickSaveTarget: deps.pickSaveTarget,
    requestNotify: deps.requestNotify,
    storedKeysToSend: deps.storedKeysToSend,
    onStoredKeys: deps.onStoredKeys,
    supportsPreupload: deps.supportsPreupload,
    // The recovery-availability inputs. `joined` is the SAME predicate the
    // admission rules above read, so "we can still start a link" and "we could
    // still rebuild this one" cannot answer differently.
    joined: deps.joined,
    rejoinRefused: deps.rejoinRefused,
    // The far-side half of the same question. `peerLeft` records the departure;
    // this is where it stops a link being described as rebuildable.
    peerPresent: (peerId) => !departed.has(peerId),
    relayDeadline: deps.relayDeadline,
    now,
    idleMs: deps.idleMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });

  // Installed once, on the manager the session just built. It reads through the
  // `deps` getter on every use, so a room switch that replaces the gate needs no
  // second call here.
  mixed.manager.setRelayGate(deps.relayGate ? {
    ready: () => deps.relayGate?.()?.ready() ?? true,
    notePeer: (peerId) => { deps.relayGate?.()?.notePeer(peerId); },
    whenReady: (cb) => {
      const gate = deps.relayGate?.();
      if (!gate) { cb(); return; }
      gate.whenReady(cb);
    },
  } : null);

  function usingMixed(): boolean {
    return !!mixed.link || mixed.status === "requesting" || mixed.status === "connecting"
      || mixed.file.active() || mixed.text.active()
      // A link that ended of something the user must act on keeps the workspace
      // on screen to SAY so. Without this the surface silently reverts to the
      // device chooser and the only evidence that a transfer stopped mid-flight
      // is that it is no longer there. Deliberately not part of
      // `linkEngaged`/`blocksNewIntent` below: it holds the screen, it
      // does not hold the peer — starting a new link is exactly the way out, and
      // doing so clears it.
      || mixed.endReason !== ""
      // …and a plain FAILED establishment is the same product rule with no
      // reason string attached. `endReason` is only set by the two ends that
      // need naming — an expired relay credential, a lost signalling socket — so
      // a link that simply never came up (the peer refused, the transport never
      // opened, the request timed out) left every clause above false and
      // unmounted the whole workspace, header included, one frame after it
      // appeared. The user saw a flash and got the device chooser back, with the
      // failure reported nowhere.
      //
      // `WorkspaceHeader` already renders this state truthfully — `stateFailed`,
      // no SAS, no path badge — and the terminal card offers Restart rather than
      // Disconnect, because there is no connection left to end. Restart runs
      // `dismissLinkEnd`, which clears `endReason` and calls the manager's
      // `clearFailed` to put it back to `idle`, returning this getter to false.
      // So the terminal state is readable AND has a way out. Kept out of
      // `linkEngaged`/`blocksNewIntent` for the same reason `endReason`
      // is: it holds the screen, not the peer.
      || mixed.status === "failed";
  }

  /**
   * Whether this page is committed to a link right now — requested, connecting,
   * open, or with either lane still doing something.
   *
   * Internal, and deliberately no longer on the public interface. It used to be
   * `blocksLegacyInbound`, read by the two legacy lanes to refuse an inbound
   * offer while a link owned the screen. Those lanes are gone, so its only
   * remaining reader is `blocksNewIntent` below — and a member named for a
   * transport that no longer exists would be a standing invitation to wire one
   * back up.
   */
  function linkEngaged(): boolean {
    return mixed.status === "requesting" || mixed.status === "connecting"
      || mixed.status === "open" || !!mixed.link || mixed.file.active() || mixed.text.active();
  }

  function clearSuppressionForIntent(peerId: string) {
    suppressedUntil.delete(peerId);
  }

  function blocksNewIntent(peerId: string): boolean {
    if (linkEngaged()) {
      return !(routes(peerId) && mixed.peerId === peerId);
    }
    return false;
  }

  return {
    get mixed() { return mixed; },
    get send() { return mixed.file.send; },
    get recv() { return mixed.file.recv; },
    get incoming() { return mixed.file.incoming; },
    get sasCode() { return mixed.link?.sas ?? ""; },
    get sendPath() { return mixed.file.send ? mixed.path ?? undefined : undefined; },
    get recvPath() { return mixed.file.recv ? mixed.path ?? undefined : undefined; },
    get text() { return mixed.text; },
    get textPath() { return mixed.path ?? undefined; },
    get usingMixed() { return usingMixed(); },
    get hasLink() { return !!mixed.link; },
    get warnsOnLeave() { return mixed.active(); },
    get linkPeerId() { return usingMixed() ? mixed.peerId : ""; },
    get linkStatus() { return mixed.status; },
    get linkGeneration() { return mixed.linkGeneration; },
    get linkPath() { return usingMixed() ? mixed.path ?? undefined : undefined; },
    get queuedBatches() { return usingMixed() ? mixed.file.queued : []; },
    get relayExpiring() { return mixed.relayExpiring; },
    get recoveryAvailable() { return mixed.recoveryAvailable; },
    get linkEndReason() { return mixed.endReason; },
    dismissLinkEnd() { mixed.dismissEnded(); },
    cancelQueuedBatch(id) { mixed.file.cancelQueued(id); },
    routes,
    blocksNewIntent,
    prepareHandoff(peerId) {
      if (!peerId) return;
      if (blocksNewIntent(peerId)) return;
      // Unsupported is terminal, exactly as it is for every other intent below.
      if (!routes(peerId)) return;
      // The one intent that does NOT clear the explicit-disconnect suppression,
      // because it is the one intent the user did not express. Clearing it would
      // let a queue of pre-uploaded entries — which stay queued, and stay owed —
      // rebuild the workspace the user just closed, immediately and repeatedly.
      if (isSuppressed(peerId)) return;
      // Failure is the link surface's to report: `linkStatus`, and the terminal
      // reason behind it, are already on screen for every other way a link is
      // built. There is no batch here whose state could be left half-set.
      void mixed.ensure(peerId).catch(() => {});
    },
    sendStoredKeys() { mixed.file.sendStoredKeys(); },
    sendFiles(peerId, files) {
      // An empty batch is never a transfer, and the one caller that can produce
      // one is the auto-send effect draining a queue whose only entries are
      // uploading or already uploaded. Refused HERE as well as at that call site
      // because this is the single choke point every batch passes through.
      if (!files.length) return;
      if (blocksNewIntent(peerId)) return;
      // Unsupported is terminal. There is no second transport to seal this batch
      // onto, so the batch is simply not started — and because `routes` is the
      // exact `link/1` test, a peer that announced nothing, `text/1`, a cased
      // variant or a later version never receives a speculative offer here.
      if (!routes(peerId)) return;
      clearSuppressionForIntent(peerId);
      mixed.file.enqueue(peerId, files);
    },
    async openText(peerId) {
      if (blocksNewIntent(peerId)) return;
      if (!routes(peerId)) return;
      clearSuppressionForIntent(peerId);
      await mixed.text.openWith(peerId);
    },
    acceptFile() { mixed.file.accept(); },
    rejectFile() { mixed.file.reject(); },
    abortFile(dir) { mixed.file.cancel(dir); },
    dismissSend(xfer) { mixed.file.dismissSend(xfer); },
    dismissRecv(xfer) { mixed.file.dismissRecv(xfer); },
    acceptText() { mixed.text.accept(); },
    rejectText() { mixed.text.reject(); },
    sendText(body) { return mixed.text.send(body); },
    clearText() { mixed.text.clearHistory(); },
    endText() { mixed.text.end(); },
    conn() { return mixed.link?.conn ?? null; },
    start() { mixed.start(); },
    syncPeers() {
      // A target we are still WAITING on gets the same rule. A device's current
      // page can be replaced between our request and its accept (the user
      // switched tabs, or closed that one), and the roster is how we hear about
      // it — without this the sender sits on "Waiting for the other device to
      // accept…" for a page that is no longer anybody's target.
      const awaiting = mixed.manager.requestedPeerId;
      if (awaiting && !deps.peerIds().includes(awaiting)) mixed.disconnect();
      for (const suppressed of suppressedUntil.keys()) {
        if (!deps.peerIds().includes(suppressed)) suppressedUntil.delete(suppressed);
      }
    },
    rosterPeerGone(peerId) { mixed.rosterPeerGone(peerId); },
    peerLeft(peerId) {
      // Unlike a roster representative handoff, this event means the peer's
      // physical SIGNALING connection is gone. That is a statement about the
      // rendezvous socket and about nothing else: the DataChannel between the
      // two pages is a separate transport, and the far side losing its
      // WebSocket — the ordinary way this event is produced — leaves it
      // untouched and still carrying whatever it was carrying.
      //
      // Recorded first, before any decision reads it: it is what makes an
      // established link report `recoveryAvailable === false` from this instant,
      // and what makes a later transport death terminal instead of a recovery
      // window spent addressing a peer that is not in the room.
      departed = new Set(departed).add(peerId);
      // The current link decides for itself — preserve a healthy one, end a held
      // one that has no transport left to preserve. Only when it holds nothing
      // for this peer does a cancellation reach the phases that are still
      // pending: an in-flight establishment and an outstanding request are not
      // an authenticated link, and nothing of theirs survives the peer.
      if (!mixed.peerDeparted(peerId) && mixed.manager.boundPeerId === peerId) {
        mixed.disconnect();
      }
      suppressedUntil.delete(peerId);
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
      departed = new Set();
      mixed.disconnect();
      // The new room has its own peers, its own ICE config and its own credential
      // boundary; an explanation about the old room's link is not about anything
      // the user can still see.
      mixed.dismissEnded();
    },
    stop() {
      suppressedUntil.clear();
      departed = new Set();
      mixed.stop();
    },
  };
}
