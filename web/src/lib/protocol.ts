export interface Peer {
  id: string;
  name: string;
}

export type Envelope = {
  type: "join" | "welcome" | "peers" | "signal";
  from?: string;
  to?: string;
  name?: string;
  peers?: Peer[];
  data?: unknown;
};
