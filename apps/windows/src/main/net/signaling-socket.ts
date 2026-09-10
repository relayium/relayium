// The signalling socket, owned by the main process.
//
// ## Why it is here and not in the renderer
//
// Not a hardening preference — a measured requirement. The renderer is served
// from `app://relayium`, which Chromium reports as a real origin (the scheme is
// registered `standard`), so its WebSocket handshake carries
// `Origin: app://relayium`. `server/wsroute.go:143` calls
// `websocket.Accept(w, r, nil)`, whose default policy refuses a cross-origin
// handshake, and it refuses that one: `request Origin "relayium" is not
// authorized for Host …`. The main process's built-in `WebSocket` sends no
// `Origin` header at all and is accepted.
//
// Both halves were executed end to end against the real pinned library and real
// Electron clients before this file was written; see
// `artifacts/windows-desktop-20260910/realtime/ws-probe/`. The alternative — a
// server CORS/origin relaxation, or renderer `webSecurity` — is deliberately not
// taken: it would widen a boundary for every client in order to fix one.
//
// ## What the renderer can express
//
// A room KIND, and for a code room a six-digit code that is validated here. Not
// a URL, not a host, not a path, not a header. The address is built from the
// origin compiled into this build.

import {
  MAX_SIGNALING_BUFFERED_BYTES,
  MAX_SIGNALING_FRAME_BYTES,
  MAX_SIGNALING_INBOUND_PER_SECOND,
  MAX_SIGNALING_SENDS_PER_SECOND,
  MAX_SIGNALING_SOCKETS,
  SIGNALING_FRAME_TYPES,
  type SignalingCloseReason,
  type SignalingEvent,
  type SignalingRoom,
} from "../../shared/ipc-contract.js";

/** The subset of `WebSocket` this file uses, so a test can drive it without a
 *  network. `bufferedAmount` is required, not optional: it is the backpressure
 *  signal, and a stand-in that omitted it would silently disable that bound. */
export interface SignalingSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type SignalingSocketFactory = (url: string) => SignalingSocketLike;

export class SignalingRefusal extends Error {
  constructor(readonly reason: string) {
    super(`signalling refused: ${reason}`);
    this.name = "SignalingRefusal";
  }
}

const CODE_RE = /^[0-9]{6}$/;

/**
 * Whether a string is a well-formed pairing code.
 *
 * Deliberately re-stated here rather than imported from `web/src/lib/pair-code`:
 * this is the MAIN process, and pulling the web module graph into the privileged
 * bundle to read one regular expression is a worse trade than one line. The two
 * are pinned equal by a test that imports the web predicate and compares
 * verdicts across the alphabet and its neighbours, so they cannot drift silently.
 */
export function isWellFormedCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * The signalling address for a room.
 *
 * Mirrors `wsURL` in `web/src/lib/transfer-link.ts`, and a test pins the two
 * equal for both room kinds. Built from the build's own origin, never from
 * anything the renderer said.
 */
export function signalingURL(origin: string, room: SignalingRoom): string {
  const parsed = new URL(origin);
  const proto = parsed.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${parsed.host}/ws`;
  if (room.kind === "lan") return base;
  if (!isWellFormedCode(room.code)) throw new SignalingRefusal("malformed room code");
  return `${base}?code=${encodeURIComponent(room.code)}`;
}

/**
 * How large this frame actually is on the wire.
 *
 * `String.length` counts UTF-16 code units and the ceiling is named in BYTES,
 * so the two disagree by up to 3x for CJK and 2x for anything astral. Against a
 * 64 KiB ceiling that is a frame of nearly 192 KiB accepted by a check that
 * reads as if it refused it - and Chinese filenames are the ordinary case for
 * this product, not an exotic input. Measured as UTF-8 octets, which is what
 * the socket sends and what the server counts.
 */
export function frameByteLength(frame: string): number {
  return Buffer.byteLength(frame, "utf8");
}

/**
 * Whether this app is willing to put a frame on a signalling socket.
 *
 * The socket talks to this build's own server, so this is not defence against a
 * hostile peer — it is what keeps the capability a SIGNALLING channel rather
 * than a general-purpose tunnel out of a sandboxed renderer. A renderer fault
 * that can post arbitrary bodies to an arbitrary path is a different and much
 * larger capability than the one under review here.
 */
export function isPermittedFrame(frame: string): boolean {
  if (frame.length === 0 || frameByteLength(frame) > MAX_SIGNALING_FRAME_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && SIGNALING_FRAME_TYPES.includes(type);
}

/** A fixed-window counter. Cheap, and the bound it enforces is a ceiling rather
 *  than a smooth rate, which is the right shape for "a fault is running away". */
class RateWindow {
  private windowStart = 0;
  private count = 0;

  constructor(private readonly limit: number) {}

  allow(now: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}

interface Entry {
  readonly token: string;
  /** The ROOM this socket belongs to. A reconnect mints a new socket token but
   *  keeps the owner, so anything held for the room survives the swap. */
  readonly owner: string;
  readonly kind: SignalingRoom["kind"];
  readonly socket: SignalingSocketLike;
  readonly generation: number;
  readonly outbound: RateWindow;
  readonly inbound: RateWindow;
  closed: boolean;
}

/**
 * Every signalling socket this process owns.
 *
 * One hub per window. Sockets are keyed by the token the RENDERER minted before
 * it asked for one — see `MAX_SOCKET_TOKEN_LENGTH` in the contract for why the
 * naming has to run in that direction.
 */
export class SignalingHub {
  private readonly sockets = new Map<string, Entry>();

  constructor(
    private readonly deps: {
      readonly origin: string;
      readonly emit: (event: SignalingEvent, generation: number) => void;
      /** A socket ended, whichever way. Anything else main holds for that room
       *  is released here rather than waiting for the document to go away. */
      readonly onRetire?: (owner: string, generation: number) => void;
      readonly factory?: SignalingSocketFactory;
      readonly now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  get openCount(): number {
    return this.sockets.size;
  }

  /**
   * Open one room's socket.
   *
   * Returns nothing useful on purpose: the token the caller already holds is the
   * name, and the socket may have delivered frames under it before this call
   * returns.
   */
  open(token: string, owner: string, room: SignalingRoom, generation: number): void {
    if (this.sockets.has(token)) throw new SignalingRefusal("token already in use");
    // One socket per room KIND, not merely two sockets. The ceiling alone would
    // permit two LAN sockets — two memberships of the same room under two peer
    // ids — which is not a shape this client has any meaning for: the roster
    // would show the app to itself, and `CapsAnnouncer` would greet its own
    // other socket. Two is the count because there are two kinds, so the kinds
    // are what is enforced.
    for (const open of this.sockets.values()) {
      if (open.kind === room.kind) throw new SignalingRefusal(`a ${room.kind} room is already open`);
    }
    if (this.sockets.size >= MAX_SIGNALING_SOCKETS) throw new SignalingRefusal("socket ceiling reached");

    // Throws for a malformed code BEFORE anything is constructed.
    const url = signalingURL(this.deps.origin, room);
    const factory = this.deps.factory ?? ((u: string) => new WebSocket(u) as unknown as SignalingSocketLike);
    const socket = factory(url);

    const entry: Entry = {
      token,
      owner,
      kind: room.kind,
      socket,
      generation,
      outbound: new RateWindow(MAX_SIGNALING_SENDS_PER_SECOND),
      inbound: new RateWindow(MAX_SIGNALING_INBOUND_PER_SECOND),
      closed: false,
    };
    this.sockets.set(token, entry);

    // Guarded on the entry, not merely on the handler property. Nulling the
    // property at retirement already stops a real `WebSocket` — it reads
    // `onopen` at dispatch — but a handler reference captured before then would
    // otherwise still emit an `open` for a socket the renderer has closed, and
    // an "open" after a "close" is a room the UI believes it is in.
    socket.onopen = () => {
      if (entry.closed) return;
      this.deps.emit({ token, kind: "open" }, generation);
    };
    socket.onmessage = (ev) => this.onMessage(entry, ev);
    socket.onerror = () => {
      // `onerror` is followed by `onclose` for a real WebSocket, so the terminal
      // event is emitted there. Emitting here too would report one death twice.
    };
    socket.onclose = () => this.retire(entry, "remote");
  }

  private onMessage(entry: Entry, ev: { data: unknown }): void {
    if (entry.closed) return;
    const data = ev?.data;
    if (typeof data !== "string") {
      // The signalling protocol is JSON text. A binary frame is not something
      // this client has a meaning for, so it is dropped rather than forwarded
      // as if it were.
      return;
    }
    // ## An honest statement of what this bound is
    //
    // This is a check on DELIVERY, not on allocation. Electron 44.3.0's
    // built-in `WebSocket` (Node 24.20.0 / undici 7.29.0) exposes no
    // maximum-payload option — passing one is accepted and silently ignored —
    // and a 20 MiB inbound frame arrives fully buffered at `onmessage`. That was
    // measured on the shipping runtime, not assumed; see
    // `realtime/ws-probe/inbound-limit.cjs`.
    //
    // So this does NOT prevent the privileged process from allocating an
    // oversized frame. What it does is prevent that frame from reaching the
    // renderer, and end the socket that produced it. The claim is deliberately
    // written small, because the larger claim would be false.
    //
    // Measured in UTF-8 bytes for the same reason the outbound check is: the
    // ceiling is named in bytes, and a peer that sends CJK text would otherwise
    // pass a UTF-16 length check at up to 3x the stated bound.
    if (frameByteLength(data) > MAX_SIGNALING_FRAME_BYTES) {
      this.terminate(entry, "oversize");
      return;
    }
    if (!entry.inbound.allow(this.now())) {
      this.terminate(entry, "flooded");
      return;
    }
    this.deps.emit({ token: entry.token, kind: "message", data }, entry.generation);
  }

  send(token: string, frame: string): void {
    const entry = this.sockets.get(token);
    if (!entry || entry.closed) throw new SignalingRefusal("unknown socket");
    if (!isPermittedFrame(frame)) throw new SignalingRefusal("frame not permitted");
    if (!entry.outbound.allow(this.now())) throw new SignalingRefusal("send rate exceeded");
    // Backpressure. Refused rather than queued: an unbounded queue in the
    // privileged process is the failure this bound exists to prevent, and a
    // silently dropped frame is a session that stalls with nothing on screen.
    if (entry.socket.bufferedAmount > MAX_SIGNALING_BUFFERED_BYTES) {
      throw new SignalingRefusal("socket backpressure");
    }
    entry.socket.send(frame);
  }

  /** The renderer is done with this room. */
  close(token: string): void {
    const entry = this.sockets.get(token);
    if (!entry) return;
    this.terminate(entry, "local");
  }

  /**
   * Drop every socket held for a document that is gone.
   *
   * Called from the router's revocation hook, so a reload or a renderer crash
   * cannot leave a live socket with no owner. Sockets belonging to a LATER
   * generation are untouched.
   */
  revoke(generation: number): void {
    for (const entry of [...this.sockets.values()]) {
      if (entry.generation !== generation) continue;
      this.terminate(entry, "revoked");
    }
  }

  closeAll(): void {
    for (const entry of [...this.sockets.values()]) this.terminate(entry, "local");
  }

  private terminate(entry: Entry, reason: SignalingCloseReason): void {
    if (entry.closed) return;
    this.retire(entry, reason);
    try {
      entry.socket.close();
    } catch {
      // Already gone; the retirement above is what callers observe.
    }
  }

  /** Emit the one terminal event and forget the socket. Idempotent. */
  private retire(entry: Entry, reason: SignalingCloseReason): void {
    if (entry.closed) return;
    entry.closed = true;
    this.sockets.delete(entry.token);
    entry.socket.onopen = null;
    entry.socket.onmessage = null;
    entry.socket.onclose = null;
    entry.socket.onerror = null;
    this.deps.emit({ token: entry.token, kind: "close", reason }, entry.generation);
    this.deps.onRetire?.(entry.owner, entry.generation);
  }
}
