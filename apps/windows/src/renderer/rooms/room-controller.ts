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
import { chooseRtcConfig, fetchIceConfig, type IceConfig } from "../../../../../web/src/lib/ice";
import { SignalingClient } from "../../../../../web/src/lib/signaling";
import { createPeerWorkspace, type PeerWorkspace } from "../../../../../web/src/lib/peer-workspace.svelte";
import type { Peer } from "../../../../../web/src/lib/protocol";
import type { SignalingRoom } from "../../shared/ipc-contract.js";
import { createIceTransport } from "../transport/ice-transport.js";
import { createSignalingTransport, type SignalingTransport } from "../transport/signaling-transport.js";
import { mintToken, type TransportBridge } from "../transport/bridge.js";
import { RoomCaps } from "./room-caps.js";

export interface RoomControllerDeps {
  readonly bridge: TransportBridge;
  readonly room: SignalingRoom;
  /** The name this client announces in its join frame. */
  readonly displayName: string;
  /** Told whenever something a surface renders has changed. R-T has no product
   *  UI; the harness route uses this, and R-LAN's real UI will replace it. */
  readonly onChange?: () => void;
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
  #peers: Peer[] = [];
  #selfId = "";
  #joined = false;
  /** A code room whose socket closed before it ever joined: the code was wrong,
   *  expired, or already claimed. Distinct from an ordinary drop, because there
   *  is nothing to reconnect to. */
  #refused = false;
  #ice: IceConfig | null = null;
  #stopped = false;
  #unsubscribeSignal: (() => void) | null = null;

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
        if (!this.#stopped) this.#ice = cfg;
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
      unsupported: () => false,
      signaling: () => this.#signaling,
      rtcConfig: () => this.rtcConfig(),
      // The two seams that make this room's capabilities its own. Every routing
      // and inbound-guard read in the composed modules goes through these, so
      // the web module's page-global `announced` is never consulted and never
      // pruned by the other room's roster churn.
      supportsLink: (peerId) => this.caps.supportsLink(peerId),
      supportsPreupload: (peerId) => this.caps.supportsPreupload(peerId),
    });

    this.#wire();
  }

  get selfId(): string {
    return this.#selfId;
  }

  get joined(): boolean {
    return this.#joined;
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
    return chooseRtcConfig({ iceServers: cfg?.iceServers ?? [], relays: cfg?.relays ?? [] }, null);
  }

  #wire(): void {
    this.#signaling.onSelfId((id) => {
      this.#selfId = id;
      this.#joined = true;
      this.#refused = false;
      this.#changed();
    });

    this.#signaling.onPeers((peers) => {
      this.#peers = peers;
      const ids = peers.map((p) => p.id);
      // THIS room's roster prunes THIS room's registry. The other room's peers
      // are in another registry and are not touched.
      this.caps.retain(ids);
      this.#announcer.rosterChanged(ids.filter((id) => id !== this.#selfId));
      this.workspace.syncPeers();
      this.#changed();
    });

    this.#signaling.onPeerLeft((peerId) => {
      this.workspace.peerLeft(peerId);
      this.#changed();
    });

    this.#signaling.onClose(() => {
      // In a code room, a close before this client ever joined means the code
      // or link was refused — there is nothing to reconnect to, and saying so
      // is the difference between an error the user can act on and a spinner.
      if (this.#deps.room.kind === "code" && !this.#joined) {
        this.#refused = true;
        this.#changed();
        return;
      }
      this.#selfId = "";
      this.#joined = false;
      this.#peers = [];
      this.#changed();
    });

    // The capability hello. `didHearFrom` RETIRES what this page owes and never
    // produces an announcement of its own — answering a hello with a hello is
    // how two clients greet each other forever.
    this.#unsubscribeSignal = this.#signaling.onSignal((from, data) => {
      if (from === this.#selfId) return;
      if (this.caps.record(from, data)) {
        this.#announcer.didHearFrom(from);
        this.#changed();
      }
    });

    this.workspace.start();
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
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
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
