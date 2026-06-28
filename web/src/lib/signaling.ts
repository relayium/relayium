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
  private selfCb: ((id: string) => void) | null = null;
  private peersCb: ((p: Peer[]) => void) | null = null;
  private signalCbs: ((from: string, data: unknown) => void)[] = [];

  constructor(
    url: string,
    private name: string,
    wsFactory: WsFactory = (u) => new WebSocket(u) as unknown as WebSocketLike,
  ) {
    this.sock = wsFactory(url);
    this.sock.onopen = () => this.send({ type: "join", name: this.name });
    this.sock.onmessage = (ev) => this.handle(JSON.parse(ev.data) as Envelope);
  }

  onSelfId(cb: (id: string) => void) { this.selfCb = cb; }
  onPeers(cb: (p: Peer[]) => void) { this.peersCb = cb; }
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
    if (e.type === "welcome" && e.name) this.selfCb?.(e.name);
    else if (e.type === "peers" && e.peers) this.peersCb?.(e.peers);
    else if (e.type === "signal" && e.from) { const from = e.from; this.signalCbs.forEach((cb) => cb(from, e.data)); }
  }
}
