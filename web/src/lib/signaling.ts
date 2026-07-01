import type { Envelope, Peer } from "./protocol";

export interface WebSocketLike {
  send(d: string): void;
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
    sock.onmessage = (ev) => this.handle(JSON.parse(ev.data) as Envelope);
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

  private send(e: Envelope) { this.sock.send(JSON.stringify(e)); }

  private handle(e: Envelope) {
    if (e.type === "welcome" && e.name) this.selfCb?.(e.name, e.ip ?? "");
    else if (e.type === "peers" && e.peers) this.peersCb?.(e.peers);
    else if (e.type === "signal" && e.from) { const from = e.from; this.signalCbs.forEach((cb) => cb(from, e.data)); }
  }
}
