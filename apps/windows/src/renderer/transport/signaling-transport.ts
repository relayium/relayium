// A `WebSocketLike` whose socket lives in the main process.
//
// `SignalingClient` takes an injectable `wsFactory`, and that seam is the whole
// integration: the shipping signalling client, its join frame, its envelope
// validation and its reconnect logic are imported and run unmodified. What is
// replaced is only the thing that genuinely cannot work here — the socket
// itself, because a handshake from `app://relayium` carries an `Origin` the
// deployed server refuses (measured; see `realtime/ws-probe/`).
//
// ## Subscribe, then open. Never the other way round.
//
// The renderer mints the token, starts listening for it, and only then asks
// main to open. Turning that around loses frames: the socket is live before
// `signalingOpen` resolves, and the first frame is `welcome`, which carries this
// page's own peer id. A listener installed afterwards can miss the one frame the
// room cannot be joined without.
//
// The buffer below closes the remaining gap on this side. `SignalingClient`
// assigns `onopen`/`onmessage`/`onclose` immediately AFTER the factory returns,
// synchronously, so no dispatched event can land in between — but that is an
// ordering guarantee held by a caller, and holding it here instead costs four
// lines and cannot be broken by a future caller that constructs differently.

import type { WebSocketLike } from "../../../../../web/src/lib/signaling";
import type { SignalingEvent, SignalingRoom } from "../../shared/ipc-contract.js";
import { asSignalingEvent, mintToken, type SignalingBridge } from "./bridge.js";

/** `WebSocket` numeric states, for the `readyState` the client actually reads:
 *  `SignalingClient.send` drops a frame unless this is exactly `OPEN`. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class BridgeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  #state: number = CONNECTING;
  #token: string;
  #bridge: SignalingBridge;
  #unsubscribe: (() => void) | null = null;
  /** Events that arrived before a handler was assigned. See the header. */
  #pending: SignalingEvent[] = [];
  /** The terminal event is delivered exactly once, whichever path produces it:
   *  a close from main, a refused open, or this side calling `close()`. */
  #closeDelivered = false;
  /** Whether this socket ever reached OPEN. See `SignalingTransport.everOpened`. */
  #everOpened = false;

  constructor(bridge: SignalingBridge, room: SignalingRoom, owner: string) {
    this.#bridge = bridge;
    this.#token = mintToken();

    this.#unsubscribe = bridge.subscribe((payload) => {
      const event = asSignalingEvent(payload);
      // One listener serves every socket, so frames for the OTHER room arrive
      // here too and are not this socket's to deliver.
      if (!event || event.token !== this.#token) return;
      this.#deliver(event);
    });

    void bridge.open({ token: this.#token, owner, room }).catch(() => {
      // A refusal — the ceiling, a room of this kind already open, a malformed
      // code — is a socket that will never open. Reported as a close rather
      // than swallowed: a room that silently never connects is the failure the
      // close reasons exist to prevent.
      this.#terminate();
    });
  }

  get readyState(): number {
    return this.#state;
  }

  get everOpened(): boolean {
    return this.#everOpened;
  }

  send(data: string): void {
    if (this.#state !== OPEN) return;
    // Fire-and-forget, like the browser's own `send`. A refusal from main — a
    // frame type outside the allowlist, the rate window, backpressure — rejects
    // this promise, and `SignalingClient` is explicitly written not to throw
    // out of its send path. Signalling frames are best-effort; the join/peers
    // exchange re-aligns state after a reconnect.
    void this.#bridge.send({ token: this.#token, frame: data }).catch(() => undefined);
  }

  close(): void {
    if (this.#state === CLOSED) return;
    void this.#bridge.close({ token: this.#token }).catch(() => undefined);
    // Not marked closed here. Main answers with a terminal `close` event, and
    // routing every ending through that one path is what makes "exactly one
    // onclose" true rather than nearly true.
  }

  #deliver(event: SignalingEvent): void {
    if (event.kind === "open") {
      this.#state = OPEN;
      this.#everOpened = true;
      if (!this.onopen) return this.#buffer(event);
      this.onopen();
      return;
    }
    if (event.kind === "message") {
      if (this.#state === CLOSED) return;
      if (!this.onmessage) return this.#buffer(event);
      this.onmessage({ data: event.data });
      return;
    }
    this.#terminate();
  }

  #buffer(event: SignalingEvent): void {
    this.#pending.push(event);
    // A microtask, so a caller assigning handlers synchronously after
    // construction always wins the race it is entitled to win.
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const event of pending) this.#deliver(event);
  }

  /** Terminal, idempotent, and the only place `onclose` is called. */
  #terminate(): void {
    if (this.#closeDelivered) return;
    this.#closeDelivered = true;
    this.#state = CLOSED;
    this.#pending = [];
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.onclose?.();
  }
}

/**
 * The socket side of one room.
 *
 * ## Why `close` lives here rather than on `SignalingClient`
 *
 * Because `SignalingClient` has no teardown at all — the web page holds one
 * socket for its whole life and lets unload collect it. This client cannot: it
 * holds two rooms at once and has to be able to leave one while staying in the
 * other, and a room left with a live socket is a membership the user thinks
 * they ended.
 *
 * Adding a `close()` to the shared module would be the tidier shape and is not
 * this slice's to make — `web/src/lib/signaling.ts` is not leased here. It also
 * is not necessary: this factory created the socket, so this factory can close
 * it, and the ownership reads correctly either way. Recorded as a follow-up for
 * whoever holds that file next, not worked around silently.
 *
 * The URL argument is ignored. The address is built in MAIN from the compiled
 * origin, so the string the web client computed is deliberately not what opens
 * the connection — the renderer cannot name an address, and this is the line
 * where that would stop being true if anybody changed it.
 */
export interface SignalingTransport {
  /** Handed to `SignalingClient` as its `wsFactory`. */
  readonly factory: (url: string) => WebSocketLike;
  /** Close whichever socket the client currently holds. Idempotent. */
  close(): void;
  /**
   * Whether the current socket ever reached OPEN.
   *
   * The difference between two failures that look identical from the room's
   * side and mean opposite things to a user. A code room whose socket NEVER
   * opened could not reach the server at all — the code was never even offered,
   * so calling it invalid or expired is a guess, and a wrong one. A socket that
   * opened and was then closed before `welcome` is the server having looked at
   * the code and said no.
   */
  everOpened(): boolean;
}

export function createSignalingTransport(
  bridge: SignalingBridge,
  room: SignalingRoom,
  owner: string,
): SignalingTransport {
  // The LATEST socket, not every socket ever made: `SignalingClient.reconnect`
  // swaps one for another and closes the old one itself, so holding them all
  // would mean re-closing sockets that are already gone.
  let current: BridgeSocket | null = null;
  return {
    factory: () => {
      current = new BridgeSocket(bridge, room, owner);
      return current;
    },
    close: () => current?.close(),
    everOpened: () => current?.everOpened ?? false,
  };
}
