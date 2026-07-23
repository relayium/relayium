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

export class SignalingClient {
  private sock: WebSocketLike;
  private selfCb: ((id: string, ip: string) => void) | null = null;
  private peersCb: ((p: Peer[]) => void) | null = null;
  private signalCbs: ((from: string, data: unknown) => void)[] = [];
  private closeCb: (() => void) | null = null;

  constructor(
    url: string,
    private name: string,
    private wsFactory: WsFactory = (u) => new WebSocket(u) as unknown as WebSocketLike,
  ) {
    this.sock = this.open(url);
  }

  private open(url: string): WebSocketLike {
    const sock = this.wsFactory(url);
    sock.onopen = () => this.send({ type: "join", name: this.name });
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
    else if (e.type === "peers" && Array.isArray(e.peers)) this.peersCb?.(e.peers);
    else if (e.type === "signal" && typeof e.from === "string") { const from = e.from; this.signalCbs.forEach((cb) => cb(from, e.data)); }
  }
}
