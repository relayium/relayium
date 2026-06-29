export interface Peer {
  id: string;
  name: string;
}

export type Envelope = {
  type: "join" | "welcome" | "peers" | "signal";
  from?: string;
  to?: string;
  name?: string;
  ip?: string; // server-observed public IP, present only on a self welcome
  peers?: Peer[];
  data?: unknown;
};
