import type { Envelope, Peer } from "./protocol";

/** Parse an inbound frame defensively: a malformed or non-object payload (or
 *  non-JSON entirely) yields null rather than throwing out of onmessage or
 *  letting `e.type` blow up on `null`. The server is trusted for rendezvous, but
 *  a hostile/buggy frame must not crash the client's message loop. */
function safeParseEnvelope(data: string): Envelope | null {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" ? (v as Envelope) : null;
  } catch {
    return null;
  }
}

export interface WebSocketLike {
  send(d: string): void;
  /** 真 WebSocket 有；假 socket 可以不实现。见 SignalingClient.send。 */
  readonly readyState?: number;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

type WsFactory = (url: string) => WebSocketLike;

/** How this connection announces its LAN installation presence, read fresh at
 *  every join because both answers change under a live client: `deviceId` is ""
 *  in a pairing-code room (and the client can switch rooms without reloading),
 *  and `active` follows the page's focus/visibility. */
export interface LanPresence {
  /** Opaque installation id, or "" for "join like a client that has none". */
  deviceId(): string;
  /** Whether this page is the one the user is currently looking at. */
  active(): boolean;
}

export class SignalingClient {
  private sock: WebSocketLike;
  private selfCb: ((id: string, ip: string) => void) | null = null;
  private peersCb: ((p: Peer[]) => void) | null = null;
  private peerLeftCb: ((peerId: string) => void) | null = null;
  private signalCbs: ((from: string, data: unknown) => void)[] = [];
  private closeCb: (() => void) | null = null;

  constructor(
    url: string,
    private name: string,
    private wsFactory: WsFactory = (u) => new WebSocket(u) as unknown as WebSocketLike,
    private presence?: LanPresence,
  ) {
    this.sock = this.open(url);
  }

  /** The join frame for the room this socket is opening into. Presence fields
   *  are omitted entirely (not sent empty) when there is no installation id, so
   *  an older server and a pairing-code room both see the original frame. */
  private joinFrame(): Envelope {
    const deviceId = this.presence?.deviceId() ?? "";
    if (!deviceId) return { type: "join", name: this.name };
    const e: Envelope = { type: "join", name: this.name, deviceId };
    // Only ever true: `active: false` is the default the server already assumes.
    if (this.presence?.active()) e.active = true;
    return e;
  }

  /** Tell the hub this page is now the current one, so a peer that picks this
   *  device reaches this tab rather than a background sibling. Meaningless (and
   *  therefore not sent) without an installation id. */
  sendActivate() {
    if (!this.presence?.deviceId()) return;
    this.send({ type: "activate" });
  }

  private open(url: string): WebSocketLike {
    const sock = this.wsFactory(url);
    sock.onopen = () => this.send(this.joinFrame());
    sock.onmessage = (ev) => this.handle(safeParseEnvelope(ev.data));
    sock.onclose = () => this.closeCb?.();
    return sock;
  }

  /** Rebind to a different room by opening a fresh socket. Registered callbacks
   *  (onSelfId/onPeers/onSignal/onClose) persist on this instance, so no
   *  re-wiring is needed. Used to switch rooms without a full page reload. */
  reconnect(url: string) {
    const old = this.sock;
    old.onclose = null; // this is an intentional swap, not a room drop — don't fire closeCb
    try { old.close(); } catch { /* already gone */ }
    this.sock = this.open(url);
  }

  /** Fires on welcome with the self peer id and the server-observed public IP ("" if none). */
  onSelfId(cb: (id: string, ip: string) => void) { this.selfCb = cb; }
  onPeers(cb: (p: Peer[]) => void) { this.peersCb = cb; }
  /** Fires only when the server confirms that one physical peer connection
   *  closed. A roster id changing by itself can instead be a harmless focus
   *  handoff between pages of the same device. */
  onPeerLeft(cb: (peerId: string) => void) { this.peerLeftCb = cb; }
  onClose(cb: () => void) { this.closeCb = cb; }
  /** Register a signal listener; returns an unsubscribe function. */
  onSignal(cb: (from: string, data: unknown) => void): () => void {
    this.signalCbs.push(cb);
    return () => {
      const i = this.signalCbs.indexOf(cb);
      if (i >= 0) this.signalCbs.splice(i, 1);
    };
  }

  sendSignal(to: string, data: unknown) {
    this.send({ type: "signal", to, data });
  }

  /**
   * 发一帧。**不抛**：底层 socket 在重连窗口里（CLOSING/CLOSED）send 会抛
   * InvalidStateError，而这里的调用点全是即发即忘的 UI 路径（busy 应答、relay RTT
   * 广播），一路抛上去就是一条 unhandled rejection，还可能把 onmessage 的分发循环
   * 打断。信令帧本来就是尽力而为——重连成功后 join/peers 会把状态重新对齐。
   */
  private send(e: Envelope) {
    // readyState 是可选的：WebSocketLike 只要求一个 send，测试里的假 socket 没有它。
    const rs = (this.sock as { readyState?: number }).readyState;
    if (rs !== undefined && rs !== 1 /* OPEN */) return;
    try {
      this.sock.send(JSON.stringify(e));
    } catch {
      /* 重连窗口——丢掉这一帧，重连后会重新对齐 */
    }
  }

  private handle(e: Envelope | null) {
    // Validate the envelope shape at runtime before dispatch: an inbound frame
    // is untrusted input, so each branch requires its type discriminant plus a
    // correctly-typed payload field. `data` on a signal stays opaque here — it's
    // validated downstream by the browser's SDP/ICE APIs and the commit-reveal
    // SAS crypto, the authoritative checks for peer-authored content.
    if (!e || typeof e.type !== "string") return;
    if (e.type === "welcome" && typeof e.name === "string") this.selfCb?.(e.name, typeof e.ip === "string" ? e.ip : "");
    // An absent `peers` is an EMPTY roster, not a frame to drop. Current servers
    // send an explicit [], but older servers can omit the empty array; since
    // device grouping a client can legitimately be told it can see nobody.
    // Ignoring that leaves a departed peer on screen. A present-but-wrong-typed
    // `peers` is still rejected as malformed.
    else if (e.type === "peers" && e.peers === undefined) this.peersCb?.([]);
    else if (e.type === "peers" && Array.isArray(e.peers)) this.peersCb?.(e.peers);
    else if (e.type === "left" && typeof e.peer === "string" && e.peer !== "") this.peerLeftCb?.(e.peer);
    else if (e.type === "signal" && typeof e.from === "string") { const from = e.from; this.signalCbs.forEach((cb) => cb(from, e.data)); }
  }
}
