// The renderer's typed view of the transport half of the preload bridge.
//
// Declared here rather than imported from the preload, for the same reason the
// preload spells its channel names as literals: the bridge is a trust boundary,
// and a boundary whose shape is pulled from the other side of itself is one
// where a change over there silently widens what this side believes it has.
// `ipc.test.ts` is what keeps the two honest: it compares the preload's spelled-out
// channels against `IPC_CHANNELS` as an EXACT set.
//
// Note what is NOT in this interface: no URL, no host, no path, no header, no
// filesystem destination. The renderer names a room KIND and, for a code room,
// six digits. Everything else about the address is main's.

import type {
  IceReply,
  SignalingCloseReason,
  SignalingEvent,
  SignalingRoom,
} from "../../shared/ipc-contract.js";

/** Every reason main is allowed to give. Listed so an unrecognised one is
 *  refused rather than rendered as a close nobody can explain. */
const CLOSE_REASONS: readonly SignalingCloseReason[] = [
  "remote",
  "failed",
  "local",
  "oversize",
  "flooded",
  "revoked",
];

export interface SignalingBridge {
  open(payload: { token: string; owner: string; room: SignalingRoom }): Promise<unknown>;
  send(payload: { token: string; frame: string }): Promise<unknown>;
  close(payload: { token: string }): Promise<unknown>;
  /** Returns its own unsubscribe. A room that closes stops listening; without
   *  that, every reopened room would leave a listener behind on one emitter. */
  subscribe(cb: (payload: unknown) => void): () => void;
}

export interface IceBridge {
  config(payload: { owner: string; code?: string }): Promise<IceReply>;
}

export interface TransportBridge {
  readonly signaling: SignalingBridge;
  readonly ice: IceBridge;
}

/**
 * Narrow one pushed payload, or reject it.
 *
 * The payload comes from main, which this renderer trusts — but it arrives as
 * `unknown` through a bridge that is deliberately untyped at runtime, and a
 * malformed one reaching `SignalingClient.onmessage` would blow up the dispatch
 * loop for every room. Cheaper to check than to reason about.
 */
export function asSignalingEvent(payload: unknown): SignalingEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const shaped = payload as { token?: unknown; kind?: unknown; data?: unknown; reason?: unknown };
  if (typeof shaped.token !== "string") return null;
  if (shaped.kind === "open") return { token: shaped.token, kind: "open" };
  if (shaped.kind === "message") {
    return typeof shaped.data === "string"
      ? { token: shaped.token, kind: "message", data: shaped.data }
      : null;
  }
  if (shaped.kind === "close") {
    const reason = CLOSE_REASONS.find((r) => r === shaped.reason);
    return reason ? { token: shaped.token, kind: "close", reason } : null;
  }
  return null;
}

/**
 * A name minted by the renderer — for a socket, and for the room that owns it.
 *
 * ## Sockets: minted BEFORE main is asked to open one
 *
 * The ordering is the whole point and it is the same argument as the sign-in
 * attempt nonce: `signalingOpen` returns a promise, but the socket it creates is
 * live before that promise settles — a server can send `welcome` and a roster in
 * the same tick main calls `new WebSocket`. A renderer that waited for the
 * response to learn which socket to listen for would miss every frame in that
 * window, and `welcome` carries this page's own peer id, so losing it is losing
 * the room.
 *
 * `getRandomValues` rather than `randomUUID`: the latter needs a secure context
 * and this page is served over a custom `app:` scheme. The token authorises
 * nothing — the trust boundary is the sender check in main — but a collision
 * between two rooms would cross their frames, so it is random.
 *
 * ## Rooms: one owner token, reused across reconnects
 *
 * A room outlives its socket — `SignalingClient.reconnect` swaps one for
 * another — so anything main holds on the room's behalf, in particular an ICE
 * read, is keyed on the ROOM rather than on whichever socket happened to be
 * open when it started. The socket token cannot serve: reusing it across a
 * reconnect would have two live `BridgeSocket`s subscribed to the same name,
 * and the terminal close of the first would immediately kill the second.
 */
export function mintToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
