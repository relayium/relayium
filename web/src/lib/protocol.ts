export interface Peer {
  id: string;
  name: string;
}

export type Envelope = {
  type: "join" | "welcome" | "peers" | "left" | "signal" | "activate";
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
