export interface Peer {
  id: string;
  name: string;
}

export type Envelope = {
  /**
   * `ice-renew` / `ice-grant` carry the relay-renewal round exchange
   * (`docs/protocol/relay-renew-v1.md` §2). They ride this existing envelope
   * rather than a new HTTP endpoint so the request is bound to the SOCKET that
   * holds the room membership — the server's authority for "these are the two
   * original peers" is the connection, not a cookie.
   *
   * A server that does not implement them ignores the frame, and a client that
   * does not send them is unaffected by their presence here.
   */
  type: "join" | "welcome" | "peers" | "left" | "signal" | "activate" | "ice-renew" | "ice-grant";
  from?: string;
  to?: string;
  name?: string;
  ip?: string; // server-observed public IP, present only on a self welcome
  peers?: Peer[];
  peer?: string; // server-only: a physical signaling peer actually disconnected
  data?: unknown;
  // Outbound-only LAN presence (see lan-device-id.ts). Both are sent on join in
  // the code-less LAN room only, and the server never echoes either back: the
  // roster stays {id, name}, so no client learns another's installation id.
  deviceId?: string;
  active?: boolean;
};
