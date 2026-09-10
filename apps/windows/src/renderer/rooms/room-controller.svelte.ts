// One room: one signalling membership, one capability registry, one workspace.
//
// ## What this file is, and what it deliberately is not
//
// It is composition. Every protocol decision below belongs to a shipping
// `web/src/lib` module that is imported and executed unmodified — the join
// frame, the envelope validation, the capability hello and its bounded retry,
// the link handshake, the SAS, the file and text lanes, the ICE classification.
// Nothing is vendored and nothing is re-derived.
//
// What is new is only that there are TWO of these at once. The Mac runs a
// same-network transfer and a pairing transfer simultaneously; the web page
// never has (it owns one socket and swaps rooms with `reconnect`). So the two
// pieces of per-page state that assumption left behind are made per-room here:
// the capability registry (`RoomCaps`, and see its header for why the global
// cannot be shared) and the announcer (already per-instance, constructed once
// per room).

import { CapsAnnouncer } from "../../../../../web/src/lib/peer-caps.svelte";
import { chooseRtcConfig, fetchIceConfig, measureRelays, type IceConfig } from "../../../../../web/src/lib/ice";
import {
  createRelaySelection,
  parseRelayRtt,
  type RelayGate,
} from "../../../../../web/src/lib/relay-selection";
import { relayDeadline, type RelayDeadline } from "../../../../../web/src/lib/relay-deadline";
import { SignalingClient } from "../../../../../web/src/lib/signaling";
import { createPeerWorkspace, type PeerWorkspace } from "../../../../../web/src/lib/peer-workspace.svelte";
import type { Peer } from "../../../../../web/src/lib/protocol";
import type { SignalingRoom } from "../../shared/ipc-contract.js";
import { createIceTransport } from "../transport/ice-transport.js";
import { createSignalingTransport, type SignalingTransport } from "../transport/signaling-transport.js";
import { mintToken, type TransportBridge } from "../transport/bridge.js";
import { RoomCaps } from "./room-caps.js";
import {
  PartialPublicationError,
  ReceiveCancelledError,
  ReceiveCoordinator,
  type FileMetaLike,
  type ReceiveBridge,
} from "../receive/receive-coordinator.js";

/**
 * What a room's signalling membership is doing right now.
 *
 * `connecting` — opening for the first time; nothing is known yet.
 * `joined` — in the room. An empty roster now genuinely means nobody else.
 * `reconnecting` — dropped, and trying again on a backoff.
 * `offline` — the retries are spent. The user gets a button, not a spinner.
 * `refused` — a code room that was never admitted. Nothing to reconnect to.
 */
export type RoomConnection = "connecting" | "joined" | "reconnecting" | "offline" | "refused";

/**
 * How the last incoming batch actually ended.
 *
 * Recorded rather than inferred. The pane used to read `done && !ok` and print
 * one sentence — "this build cannot write files" — for every failure, which was
 * true only while there was no native helper and is now wrong in both
 * directions: it hides a real permission or conflict error behind a build
 * limitation, and it erases files that WERE saved before something later went
 * wrong.
 */
export type ReceiveOutcome =
  | { readonly kind: "saved"; readonly total: number }
  | { readonly kind: "partial"; readonly saved: number; readonly total: number; readonly residue: boolean }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly residue: boolean;
      /** Files that DID reach their final names before the failure. Never
       *  dropped: they exist, and a receipt that omits them is wrong. */
      readonly saved: number;
      readonly total: number;
    }
  | { readonly kind: "cancelled" };

/** Backoff, bounded. Short enough that an ordinary blip is invisible, and it
 *  stops rather than hammering a server that is plainly not there. */
const RETRY_DELAYS_MS = [500, 1_500, 4_000, 10_000] as const;

/**
 * How many peers' relay maps may be held while this room's ICE answer is in
 * flight.
 *
 * A ceiling rather than a target. The window is one HTTP round trip and a code
 * room holds two peers, so a healthy room never approaches this; it exists so
 * a busy LAN roster — or a peer that broadcasts more often than expected —
 * cannot grow this process's memory on the far side's say-so.
 */
const MAX_HELD_RELAY_PEERS = 8;

export interface RoomControllerDeps {
  readonly bridge: TransportBridge;
  readonly room: SignalingRoom;
  /** The name this client announces in its join frame. */
  readonly displayName: string;
  /** Told whenever something a surface renders has changed. */
  readonly onChange?: () => void;
  /**
   * The privileged receive half.
   *
   * Optional so the transport tests can compose a room without a filesystem.
   * When absent, no `pickSaveTarget` is injected — and that is deliberately NOT
   * the same as falling back to the browser's own picker: `mixed-file-session`
   * would then hand bytes to a Chromium download in a renderer that has no
   * download UI, and report it as saved. A room with no receive bridge simply
   * cannot accept files, which is the honest answer.
   */
  readonly receive?: ReceiveBridge;
  /**
   * Bring the link up without waiting for the user to press anything.
   *
   * For a PAIRING room, where it is the correct product behaviour and not a
   * convenience: two peers who have agreed a six-digit code have already
   * expressed the intent. There is no roster to choose from — a code room holds
   * exactly the two of them — so a Connect button would be a second question
   * asking what the code already answered, and it is the reason two Windows
   * clients could join the same code and then sit there, each waiting for the
   * other to start.
   *
   * LAN is the opposite and stays manual: the roster is a list of devices the
   * user did not choose, and connecting to one is a decision.
   */
  readonly autoConnect?: boolean;
}

/**
 * A room, from "open the socket" to "tear everything down".
 *
 * Deliberately not a Svelte component and not a rune module: the composition
 * rules below are the ones a race would break, and rules that only exist inside
 * a component cannot be driven by a test. The reactive state lives where it
 * already did — inside the workspace — and surfaces read it from there.
 */
export class RoomController {
  readonly caps = new RoomCaps();
  readonly workspace: PeerWorkspace;

  #deps: RoomControllerDeps;
  #signaling: SignalingClient;
  #transport: SignalingTransport;
  #announcer: CapsAnnouncer;
  #peers = $state<Peer[]>([]);
  #selfId = $state("");
  #joined = $state(false);
  /** A code room whose socket closed before it ever joined: the code was wrong,
   *  expired, or already claimed. Distinct from an ordinary drop, because there
   *  is nothing to reconnect to. */
  #refused = $state(false);
  /**
   * What the signalling membership is actually doing.
   *
   * The UI had no way to ask this, so a room whose socket never opened rendered
   * exactly like a healthy empty room: "No other devices yet" next to a Stop
   * receiving button, while nothing was connected at all. Those are opposite
   * situations — one is "nobody else is here", the other is "this PC is not
   * there".
   */
  #connection = $state<RoomConnection>("connecting");
  /** True once this room has ever completed a join, which is what makes an
   *  empty roster meaningful rather than merely unknown. */
  #everJoined = $state(false);
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAttempt = 0;
  #ice = $state<IceConfig | null>(null);
  /**
   * The credential boundary for a RELAYED link in this room.
   *
   * Derived from the ICE answer at FETCH time, which is what makes the
   * clock-skew correction a duration on this clock rather than on one measured
   * later — see `relay-deadline.ts`. Null whenever nothing in the answer relays,
   * which is every LAN room and every STUN-only code.
   */
  #relayBound: RelayDeadline | null = null;
  /**
   * True until this room's ICE answer has been installed.
   *
   * The other half of the gate. Without it, an inbound offer arriving before
   * the read lands snapshots an EMPTY configuration and commits the connection
   * to it for its whole life — which is the cross-network asymmetry where
   * whichever side is offered to first loses its relay.
   */
  #icePending = true;
  /** Waiters parked while ICE is pending. Dropped, not run, on a supersede. */
  #iceWaiters: Array<(live: boolean) => void> = [];
  /**
   * Relay RTT maps that arrived before this room's pool existed.
   *
   * Replayed after `reset` so they inform this room's FIRST choice rather than
   * the one after it — but held as PARSED maps, one per peer, latest wins, and
   * only from peers currently on the roster.
   *
   * The earlier version kept raw `unknown` signal frames in an unbounded array.
   * Three things were wrong with that and only the first is obvious: a peer
   * broadcasts a map per relay that answers, so an ordinary five-relay pool
   * appended five entries per peer for a window this side does not control;
   * every one of them was an arbitrary signal payload retained by reference; and
   * replaying them merged whatever keys they carried into `theirs`, including
   * ids belonging to no relay in this room's pool.
   *
   * Now: parsed at the boundary, superseded per peer, bounded by roster
   * membership and by `MAX_HELD_RELAY_PEERS`, filtered to this room's own pool
   * ids on replay, and dropped when a peer leaves or the room stops.
   */
  #heldRelayRtt = new Map<string, Record<string, number>>();
  #measureEpoch = 0;
  /**
   * The user stopped this room's link, and it must stay stopped.
   *
   * Auto-connect is a standing rule whose preconditions are "idle and no link"
   * — which is exactly the state Disconnect produces. Without an intent record,
   * pressing Disconnect returned the room to the state that starts a link and it
   * immediately re-offered to the same peer: the user's action undone by the
   * thing that started it, in the same frame.
   *
   * So it fences BOTH directions. Outbound, auto-connect stands down. Inbound,
   * `unsupported()` makes `canAcceptLink` false, so a re-offer is answered
   * `busy` — the peer is told, rather than black-holed — and a frame already in
   * flight when the user pressed Disconnect cannot reopen the room behind them.
   *
   * Cleared only by a deliberate new intent: pressing Connect, or joining a
   * code (which builds a new room anyway).
   */
  #userStopped = $state(false);

  /**
   * This room's relay agreement.
   *
   * Deliberately NOT reactive, mirroring the Web app: `rtcConfig()` must read
   * what is true at the instant a connection is built, not what a render
   * happened to observe.
   */
  readonly #selection = createRelaySelection({
    publish: (map) => {
      for (const peer of this.#peers) {
        if (peer.id !== this.#selfId) this.#signaling.sendSignal(peer.id, { relayRtt: map });
      }
    },
    // MUST be monotonic. It stands in for an unfinished probe's round trip as a
    // LOWER bound, so a clock that runs fast retires relays that could still
    // win. `Date.now()` is not monotonic; this is.
    now: () => performance.now(),
  });
  #stopped = false;
  #unsubscribeSignal: (() => void) | null = null;
  /**
   * Coordinators for batches this room is receiving.
   *
   * A set rather than one, because the room outlives any single batch and the
   * same link can carry another after the first completes.
   *
   * Three rules, each of which was wrong before and is now the point:
   *
   *   * Every coordinator is bound to a PEER and a LINK GENERATION, so an
   *     unrelated device leaving the roster cancels nothing.
   *   * A coordinator that reaches a terminal state is dropped, so a long-lived
   *     room does not accumulate one entry per batch forever.
   *   * A coordinator whose cleanup FAILED is retained until that cleanup
   *     actually settles, and its failure is recorded — bytes may still be in
   *     the user's folder, and dropping it would be reporting a clean teardown.
   */
  #receives = new Set<ReceiveCoordinator>();
  /** Bounded: a count and the first reason. Not an array of `Error`s, for the
   *  same reason `AppService` does not keep one. */
  #cleanupFailure: { count: number; firstReason: string } | null = null;
  #lastReceipt = $state<ReceiveOutcome | null>(null);
  /** Torn down with the room. Watches the link this room's batches belong to. */
  #disposeEffects: (() => void) | null = null;
  #stopping: Promise<void> | null = null;

  constructor(deps: RoomControllerDeps) {
    this.#deps = deps;
    const code = deps.room.kind === "code" ? deps.room.code : "";
    // One name for this ROOM, distinct from the per-socket tokens below and
    // stable across reconnects. It is what main groups this room's ICE reads
    // under, so closing this room releases them and the other room's are
    // untouched.
    const owner = mintToken();

    // The ICE read starts BEFORE the socket, exactly as the web page does it:
    // both are in flight together, and the answer is installed whenever it
    // lands. A LAN room asks with an empty code and is answered STUN-only —
    // that is what Mac does (`NearbyTransferTests`), and treating LAN as
    // "needs no ICE at all" would silently drop STUN and with it every
    // host-candidate-less path.
    const pending = fetchIceConfig(code, createIceTransport(deps.bridge.ice, code, owner));
    void pending
      .then((cfg) => {
        if (!this.#stopped) this.#applyRoomIce(cfg);
        this.#changed();
      })
      .catch(() => {
        // `fetchIceConfig` does not reject for a server or network condition —
        // it answers with a `relayStatus`. Reaching here is a programming
        // error, and an empty list is the same conservative answer the module
        // itself falls back to. Never a third-party STUN.
        this.#changed();
      });

    // The URL argument is what the WEB client would have used. Main builds the
    // real address from the compiled origin; this one is passed only because
    // the constructor takes it, and the factory ignores it. See
    // `createSignalingSocketFactory`.
    this.#transport = createSignalingTransport(deps.bridge.signaling, deps.room, owner);
    this.#signaling = new SignalingClient(
      "app://relayium/ws",
      deps.displayName,
      this.#transport.factory,
      // No LAN presence hint. The install identity belongs to the account
      // surface and a code room must not carry one at all — the web client
      // omits it for exactly this reason. R-LAN adds it for the LAN room only.
      undefined,
    );

    this.#announcer = new CapsAnnouncer((peerId, signal) => this.#signaling.sendSignal(peerId, signal));

    this.workspace = createPeerWorkspace({
      selfId: () => this.#selfId,
      joined: () => this.#joined,
      rejoinRefused: () => this.#refused,
      peerIds: () => this.#peers.map((p) => p.id),
      peerPresent: (peerId) => this.#peers.some((p) => p.id === peerId),
      // Not "this build cannot" — "this room will not". See `#userStopped`.
      unsupported: () => this.#userStopped,
      signaling: () => this.#signaling,
      rtcConfig: () => this.rtcConfig(),
      // The two seams that make this room's capabilities its own. Every routing
      // and inbound-guard read in the composed modules goes through these, so
      // the web module's page-global `announced` is never consulted and never
      // pruned by the other room's roster churn.
      supportsLink: (peerId) => this.caps.supportsLink(peerId),
      supportsPreupload: (peerId) => this.caps.supportsPreupload(peerId),
      // The gate the link manager holds its first legal frame behind, in BOTH
      // roles, and the credential boundary a relayed link ends at.
      relayGate: () => this.gate,
      relayDeadline: () => this.#relayBound,
      // Injected only when this room actually has a privileged destination. The
      // shipping default would open a browser download, which is wrong here in
      // a way that would silently report success.
      ...(deps.receive ? { pickSaveTarget: (files: FileMetaLike[]) => this.#pickSaveTarget(files) } : {}),
    });

    this.#wire();
    this.#watchLink();
    if (deps.autoConnect) this.#watchAutoConnect();
  }

  /**
   * Start the link in a pairing room, from exactly one side.
   *
   * ## Why one side and not both
   *
   * Both peers reach this code, so without a rule both would offer. The
   * protocol survives that — the manager answers a colliding request with
   * `busy` — but the recovery is a wasted round trip and a pair of transient
   * failures on both screens, and the state it passes through is the one users
   * report as "it did not connect the first time".
   *
   * The rule is `selfId < peerId`. Both sides compute it from the same two
   * server-issued ids and get opposite answers, so it needs no negotiation and
   * no clock.
   *
   * ## What it waits for
   *
   * The peer's capability hello, because a peer that has not announced exact
   * `link/1` is unreachable and offering to it produces a transfer whose
   * manifest never arrives. And the room's ICE answer, because a cross-network
   * link needs the relay the server issued — offering before it lands is how a
   * pairing room ends up on host candidates that cannot cross CGNAT.
   */
  #watchAutoConnect(): void {
    const dispose = $effect.root(() => {
      $effect(() => {
        // Read so the fence invalidates this rule rather than being sampled
        // once; and checked, so a stale asynchronous delivery cannot reopen a
        // room the user stopped.
        if (this.#userStopped) return;
        if (this.#stopped || !this.#joined || this.#ice === null) return;
        if (this.workspace.hasLink || this.workspace.linkStatus !== "idle") return;
        const selfId = this.#selfId;
        if (!selfId) return;
        for (const peer of this.#peers) {
          if (peer.id === selfId) continue;
          if (!this.caps.supportsLink(peer.id)) continue;
          if (!this.workspace.routes(peer.id)) continue;
          if (this.workspace.blocksNewIntent(peer.id)) continue;
          // Deterministic, and computed identically on both sides.
          if (selfId >= peer.id) continue;
          void this.workspace.openText(peer.id);
          return;
        }
      });
    });
    const previous = this.#disposeEffects;
    this.#disposeEffects = () => {
      previous?.();
      dispose();
    };
  }

  /**
   * Install the answer this room joined without.
   *
   * The ordering is the Web app's and each step depends on the one before it:
   * the pool and credentials go in, the deadline is derived beside them so it
   * can never outlive the config it came from, the pending flag clears, the
   * selection is reset onto THIS pool (which re-arms its own gate), the peers
   * that arrived during the window are re-noted against a pool that now exists,
   * and only then are the parked waiters released.
   *
   * Re-noting matters: `notePeer` is scoped to a room with a pool, so every
   * roster frame delivered before this line armed nothing at all. Without it a
   * link parked below would wait on a bounded grace nobody ever started — and in
   * a two-peer code room the frame it is waiting for has already been sent.
   */
  #applyRoomIce(cfg: IceConfig): void {
    this.#ice = cfg;
    this.#relayBound = relayDeadline(cfg, Date.now());
    this.#icePending = false;
    void this.#startRelayMeasurement();
    for (const peer of this.#peers) {
      if (peer.id !== this.#selfId) this.#selection.notePeer(peer.id);
    }
    const waiters = this.#iceWaiters;
    this.#iceWaiters = [];
    for (const waiter of waiters) waiter(!this.#stopped);
  }

  /**
   * Measure this room's pool, publishing each relay the moment it answers.
   *
   * Per-relay rather than per-pool, exactly as the Web app does: awaiting the
   * whole pool meant one unreachable node pinned every result at the full probe
   * timeout, with nothing on the wire and nothing to select from.
   *
   * An EMPTY pool starts no probes at all — every LAN room and every STUN-only
   * code — and `reset` leaves that gate open in the same call, so those rooms
   * are as immediate as they were before this existed.
   */
  async #startRelayMeasurement(): Promise<void> {
    const epoch = ++this.#measureEpoch;
    const pool = this.#ice?.relays ?? [];
    this.#selection.reset(pool);
    // After `reset`, which empties `theirs`, and before anything can be built:
    // maps that beat this room's answer belong to its first choice.
    //
    // Filtered to THIS pool's ids. `receive` merges wholesale, and a map naming
    // a relay this room was never issued would sit in `theirs` for the rest of
    // the room — never selectable, since `pickRelay` needs it in both maps, but
    // retained on the say-so of a peer.
    const poolIds = new Set(pool.map((relay) => relay.id));
    for (const [from, map] of this.#heldRelayRtt) {
      const known = Object.fromEntries(Object.entries(map).filter(([id]) => poolIds.has(id)));
      if (Object.keys(known).length > 0) this.#selection.receive(from, { relayRtt: known });
    }
    this.#heldRelayRtt.clear();
    if (pool.length === 0) return;
    await measureRelays(pool, (id, ms) => {
      // The room switched or stopped mid-probe; this answer is another room's.
      if (epoch !== this.#measureEpoch || this.#stopped) return;
      this.#selection.record(id, ms);
    });
    if (epoch !== this.#measureEpoch || this.#stopped) return;
    this.#selection.finishMeasurement();
  }

  /** Whether the user has stopped this room's link. */
  get userStopped(): boolean {
    return this.#userStopped;
  }

  /**
   * The user's own Disconnect.
   *
   * Distinct from `workspace.disconnect()` alone, which tears the link down and
   * leaves every rule that would rebuild it in force.
   */
  disconnect(): void {
    this.#userStopped = true;
    this.workspace.disconnect();
    this.#changed();
  }

  /** A deliberate new intent, which is the only thing that clears the fence. */
  connectTo(peerId: string): void {
    this.#userStopped = false;
    void this.workspace.openText(peerId);
    this.#changed();
  }

  /** The name a peer announced, for a surface that must not show a raw id. */
  peerName(peerId: string): string {
    return this.#peers.find((p) => p.id === peerId)?.name ?? "";
  }

  /**
   * A batch belongs to ONE link. When that link goes, so does the batch.
   *
   * `PeerWorkspaceDeps` deliberately excludes `onLinkState` — the workspace uses
   * it internally — so this observes `linkGeneration` and `hasLink` instead,
   * which are the two `$state` values that change on establishment and
   * teardown. That covers the paths a roster event never reaches: the user
   * pressing Disconnect, the peer tearing the link down, and a transport dying
   * under an integrity or protocol failure.
   *
   * `$effect.root` because this object outlives any component and owns its own
   * teardown; the returned disposer runs in `stop()`.
   */
  #watchLink(): void {
    this.#disposeEffects = $effect.root(() => {
      $effect(() => {
        const generation = this.workspace.linkGeneration;
        const live = this.workspace.hasLink;
        if (this.#stopped) return;
        void this.#cancelReceives((c) => !live || c.linkGeneration !== generation);
      });
    });
  }

  get selfId(): string {
    return this.#selfId;
  }

  get joined(): boolean {
    return this.#joined;
  }

  /** See `RoomConnection`. The one thing a surface must read before it says
   *  anything about the roster. */
  get connection(): RoomConnection {
    return this.#connection;
  }

  /** Whether an empty roster means "nobody else is here" rather than "this PC
   *  never got in". */
  get everJoined(): boolean {
    return this.#everJoined;
  }

  /** True only for a code room the server never let this client into. */
  get refused(): boolean {
    return this.#refused;
  }

  get peers(): readonly Peer[] {
    return this.#peers.filter((p) => p.id !== this.#selfId);
  }

  /** The room's ICE answer, once it has arrived. `null` while in flight — which
   *  is a different thing from "no relay", and callers must not conflate them. */
  get ice(): IceConfig | null {
    return this.#ice;
  }

  /**
   * The gate `peer-link` holds its first legal `link/1` frame behind — for BOTH
   * roles.
   *
   * `peer-link.svelte.ts:375` is `relayGate === null || relayGate.ready()`, so
   * passing nothing left the gate permanently open and every link, initiator and
   * responder alike, snapshotted its configuration immediately. The initiator
   * parks in `gatedEnsure`; the responder parks the offer as `heldOffer` with
   * its following frames queued in arrival order. Both need this to exist.
   *
   * Mirrors `roomGate` in the Web app: the room's whole readiness, not only its
   * relay agreement.
   */
  readonly gate: RelayGate = {
    ready: () => !this.#icePending && this.#selection.gate.ready(),
    notePeer: (peerId) => this.#selection.gate.notePeer(peerId),
    whenReady: (cb) => {
      if (!this.#icePending) {
        this.#selection.gate.whenReady(cb);
        return;
      }
      // Dropped on a supersede rather than run: the socket, the peer and the
      // credentials it was parked for all belong to the room being left.
      this.#iceWaiters.push((live) => {
        if (live) this.#selection.gate.whenReady(cb);
      });
    },
  };

  /**
   * The configuration a new connection is built with.
   *
   * `chooseRtcConfig` with no selection folds in every relay the server issued,
   * which is the shipping behaviour and the right one before measurement has
   * run: dropping a pool this room was just issued would leave both peers on
   * host/srflx candidates that cannot cross CGNAT. Relay MEASUREMENT and
   * selection belong to R-PAIR.
   */
  rtcConfig(): { iceServers: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy } {
    const cfg = this.#ice;
    // `takeChoice`, not a mirrored id: this answer goes straight to the
    // transport constructor, so reading it IS the connection committing to that
    // relay for its whole life. The selection records the consumer, which is
    // what stops a peer leaving later from taking the choice back out from
    // under a transport that already exists (`relock`).
    return chooseRtcConfig(
      { iceServers: cfg?.iceServers ?? [], relays: cfg?.relays ?? [] },
      this.#selection.takeChoice(),
    );
  }

  /**
   * One coordinator per accepted batch, bound to the link that carries it.
   *
   * Registered BEFORE the picker opens, so a room torn down while the user is
   * looking at the dialog has something to cancel — and `cancel` joins the
   * pending picker rather than resolving past it.
   */
  async #pickSaveTarget(files: FileMetaLike[]) {
    const bridge = this.#deps.receive;
    if (!bridge) throw new Error("this room has no receive destination");
    this.#sweep();
    const coordinator = new ReceiveCoordinator(
      bridge,
      this.workspace.linkPeerId,
      this.workspace.linkGeneration,
    );
    this.#receives.add(coordinator);
    if (this.#stopped) {
      // The room went away between the batch being accepted and the picker
      // opening. Cancel rather than open a lease nothing will ever finish.
      void this.#settle(coordinator);
      throw new Error("this room is closed");
    }
    try {
      const target = await coordinator.open(files);
      const total = files.length;
      // Wrapped so the OUTCOME is observed where the typed error still exists.
      // The session calls `done()` and keeps the rejection to itself.
      const done = target.done;
      return {
        ...target,
        done: async () => {
          try {
            await done?.();
            this.#lastReceipt = { kind: "saved", total };
            this.#changed();
          } catch (err) {
            this.#lastReceipt = describeReceipt(err, total);
            this.#changed();
            throw err;
          }
        },
      };
    } catch (err) {
      if (err instanceof ReceiveCancelledError) {
        this.#lastReceipt = { kind: "cancelled" };
        this.#changed();
      }
      // A picker the user cancelled is terminal and drops out; one that failed
      // mid-cleanup is retained by `#settle` until it settles.
      void this.#settle(coordinator);
      throw err;
    }
  }

  /**
   * Cancel the batches this predicate selects, and wait for them.
   *
   * Returns a promise rather than firing and forgetting: a caller tearing the
   * room down has to be able to join the cleanup, and the set is NOT cleared up
   * front — an entry leaves only when its own cancellation has settled.
   */
  #cancelReceives(match: (coordinator: ReceiveCoordinator) => boolean): Promise<void> {
    const chosen = [...this.#receives].filter(match);
    return Promise.all(chosen.map((coordinator) => this.#settle(coordinator))).then(() => undefined);
  }

  /** Cancel one, record a cleanup failure, and drop it once it has settled. */
  #settle(coordinator: ReceiveCoordinator): Promise<void> {
    return coordinator.cancel().then(
      () => {
        this.#receives.delete(coordinator);
      },
      (err: unknown) => {
        // Observed settlement: the cleanup finished and failed. The bytes may
        // still be in the user's folder, so the failure is kept.
        this.#recordCleanupFailure(err);
        this.#receives.delete(coordinator);
      },
    );
  }

  /** Drop coordinators that have reached a terminal state of their own, so a
   *  long-lived room does not grow one entry per batch. */
  #sweep(): void {
    for (const coordinator of [...this.#receives]) {
      if (coordinator.retired) this.#receives.delete(coordinator);
    }
  }

  #recordCleanupFailure(err: unknown): void {
    if (this.#cleanupFailure) {
      this.#cleanupFailure.count += 1;
      return;
    }
    const raw = err instanceof Error ? (err.message ?? err.name) : String(err);
    this.#cleanupFailure = { count: 1, firstReason: raw.slice(0, 200) };
  }

  /** How the last incoming batch ended, for the surface that reports it. */
  get lastReceipt(): ReceiveOutcome | null {
    return this.#lastReceipt;
  }

  /** Cleanup failures this room observed, for a surface that must say so. */
  get cleanupFailure(): { readonly count: number; readonly firstReason: string } | null {
    return this.#cleanupFailure;
  }

  /** Test/diagnostic only. */
  get openReceiveCount(): number {
    return this.#receives.size;
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /**
   * The link generation the user has confirmed the verification code for.
   *
   * Held HERE, not in a page component. A page is disposable — it unmounts when
   * the user looks at another route and remounts when they come back — and a
   * confirmation stored there would silently reset, re-prompting for a link that
   * was already checked, or (worse) appear confirmed for a NEW link because a
   * component happened to survive.
   *
   * Keyed on `linkGeneration` rather than on the code itself: six digits repeat,
   * and a later link that happened to draw the same code is still a different
   * connection that has not been checked.
   */
  #confirmedGeneration = $state(-1);

  get verificationConfirmed(): boolean {
    return this.#confirmedGeneration === this.workspace.linkGeneration;
  }

  confirmVerification(): void {
    this.#confirmedGeneration = this.workspace.linkGeneration;
  }

  #wire(): void {
    this.#signaling.onSelfId((id) => {
      this.#selfId = id;
      this.#joined = true;
      this.#everJoined = true;
      this.#refused = false;
      this.#connection = "joined";
      this.#retryAttempt = 0;
      this.#clearRetry();
      this.#changed();
    });

    this.#signaling.onPeers((peers) => {
      this.#peers = peers;
      const ids = peers.map((p) => p.id);
      // THIS room's roster prunes THIS room's registry. The other room's peers
      // are in another registry and are not touched.
      this.caps.retain(ids);
      // Pruned with the roster, for the same reason the capability records are.
      for (const from of [...this.#heldRelayRtt.keys()]) {
        if (!ids.includes(from)) this.#heldRelayRtt.delete(from);
      }
      if (!this.#icePending) {
        // Departures retire a contributor's map; arrivals start their bounded
        // grace and are re-greeted with whatever this side has measured.
        this.#selection.noteRoster(ids.filter((id) => id !== this.#selfId));
        this.#selection.greet();
      }
      this.#announcer.rosterChanged(ids.filter((id) => id !== this.#selfId));
      this.workspace.syncPeers();
      this.#changed();
    });

    this.#signaling.onPeerLeft((peerId) => {
      // The server confirmed THIS peer's socket is gone. `peerLeft` decides
      // whether the current link absorbs that; either way a batch arriving from
      // that peer has no sender left.
      //
      // Only that peer's. Cancelling every batch on any departure meant an
      // unrelated phone leaving the roster destroyed a transfer in progress
      // from a different device.
      this.workspace.peerLeft(peerId);
      this.#selection.peerGone(peerId);
      // Nothing is owed to a peer that has left, including a map it sent while
      // this room was still waiting for its own pool.
      this.#heldRelayRtt.delete(peerId);
      void this.#cancelReceives((c) => c.peerId === peerId);
      this.#changed();
    });

    this.#signaling.onClose(() => {
      // In a code room, a close before this client ever joined means the code
      // or link was refused — there is nothing to reconnect to, and saying so
      // is the difference between an error the user can act on and a spinner.
      // A code room that has never joined is one of TWO things, and they are
      // opposite answers. If the socket never opened, this PC could not reach
      // the server — the code was never offered to anybody, so calling it
      // invalid or expired is a guess and a wrong one. Only a socket that
      // OPENED and was then closed before `welcome` is the server having looked
      // at the code and refused it.
      //
      // `everJoined`, not `joined`: a code room that connected and then dropped
      // is an ordinary reconnect either way.
      if (this.#deps.room.kind === "code" && !this.#everJoined) {
        if (this.#transport.everOpened()) {
          this.#refused = true;
          this.#connection = "refused";
          this.#changed();
          return;
        }
        // Unreachable, not rejected. Retried like any other transport loss.
        this.#selfId = "";
        this.#joined = false;
        this.#peers = [];
        this.#scheduleRetry();
        this.#changed();
        return;
      }
      this.#selfId = "";
      this.#joined = false;
      this.#peers = [];
      this.#scheduleRetry();
      this.#changed();
    });

    // The capability hello. `didHearFrom` RETIRES what this page owes and never
    // produces an announcement of its own — answering a hello with a hello is
    // how two clients greet each other forever.
    this.#unsubscribeSignal = this.#signaling.onSignal((from, data) => {
      if (from === this.#selfId) return;
      // A relay RTT map. Held until the pool exists, so it informs this room's
      // FIRST choice rather than arriving before there is anything to choose
      // between. Consumed here, so it is not also read as a capability hello.
      if (this.#icePending) {
        const map = parseRelayRtt(data);
        if (map !== null) {
          // From a peer this room actually has, and at most one map per peer —
          // the latest, since a peer broadcasts cumulatively and a later map
          // supersedes an earlier one entirely.
          const known = this.#peers.some((peer) => peer.id === from);
          const room = this.#heldRelayRtt.has(from) || this.#heldRelayRtt.size < MAX_HELD_RELAY_PEERS;
          if (known && room) this.#heldRelayRtt.set(from, map);
          return;
        }
      } else if (this.#selection.receive(from, data)) {
        return;
      }
      if (this.caps.record(from, data)) {
        this.#announcer.didHearFrom(from);
        this.#changed();
      }
    });

    this.workspace.start();
  }

  /**
   * Try again, backing off, and say so while it is happening.
   *
   * Bounded. After the last attempt the room reports `offline` rather than
   * retrying forever behind a spinner — at that point the user is better served
   * by a button than by another silent attempt, and `retry()` is that button.
   */
  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer !== null) return;
    if (this.#retryAttempt >= RETRY_DELAYS_MS.length) {
      this.#connection = "offline";
      return;
    }
    const delay = RETRY_DELAYS_MS[this.#retryAttempt]!;
    this.#retryAttempt += 1;
    this.#connection = "reconnecting";
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#stopped) return;
      // The factory ignores this URL — main builds the real address from the
      // compiled origin — but `SignalingClient.reconnect` takes one.
      this.#signaling.reconnect("app://relayium/ws");
      this.#changed();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** The user asking to try again, from an `offline` or `refused` room. */
  retry(): void {
    if (this.#stopped) return;
    this.#clearRetry();
    this.#retryAttempt = 0;
    this.#refused = false;
    this.#connection = "connecting";
    this.#signaling.reconnect("app://relayium/ws");
    this.#changed();
  }

  #changed(): void {
    if (!this.#stopped) this.#deps.onChange?.();
  }

  /**
   * Terminal, idempotent, and reachable from every path that abandons a room.
   *
   * Order matters: the workspace goes first so its links tear down while the
   * socket can still carry a departure, then the announcer stops owing frames,
   * then the socket closes, then the registry is cleared. Reversed, the
   * workspace would try to signal through a socket that is already gone.
   */
  /** Resolves when everything this room owned has actually been released. */
  get stopped(): Promise<void> {
    return this.#stopping ?? Promise.resolve();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearRetry();
    // Relay work, all of it: the probe epoch is spent so in-flight
    // `measureRelays` results are discarded, the selection's timers and parked
    // waiters go with `suspend`, and anything held for the ICE answer is
    // dropped rather than run.
    this.#measureEpoch += 1;
    this.#selection.suspend();
    const waiters = this.#iceWaiters;
    this.#iceWaiters = [];
    for (const waiter of waiters) waiter(false);
    this.#heldRelayRtt.clear();
    this.#disposeEffects?.();
    this.#disposeEffects = null;
    // Receives first: they hold privileged leases with open handles and staged
    // bytes in the user's folder, and they must be told before the transport
    // under them disappears. The promise is exposed by `stopped` so a caller
    // that must not return early can join it.
    this.#stopping = this.#cancelReceives(() => true);
    this.workspace.stop();
    this.#announcer.stop();
    this.#unsubscribeSignal?.();
    this.#unsubscribeSignal = null;
    // Through the transport, not the client: `SignalingClient` has no teardown
    // of its own. See `createSignalingTransport`.
    this.#transport.close();
    this.caps.reset();
  }
}


/**
 * Turn a publication failure into the receipt a person reads.
 *
 * The counts survive: a `partial`, and a `failed` that happened after files
 * were already published, both name files that exist on disk right now.
 */
function describeReceipt(err: unknown, total: number): ReceiveOutcome {
  if (err instanceof ReceiveCancelledError) return { kind: "cancelled" };
  if (err instanceof PartialPublicationError) {
    if (err.publishedCount > 0 && err.publishedCount < err.total) {
      return {
        kind: "partial",
        saved: err.publishedCount,
        total: err.total || total,
        residue: err.residue,
      };
    }
    return {
      kind: "failed",
      reason: err.reason,
      residue: err.residue,
      saved: err.publishedCount,
      total: err.total || total,
    };
  }
  // Unknown: residue TRUE, because this is exactly the case where the folder
  // cannot be described as clean.
  return { kind: "failed", reason: "internal", residue: true, saved: 0, total };
}
