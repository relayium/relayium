// The preload surface the handoff uses. Declared, not inferred.
//
// One read, one closed token, one subscription. No URL, no code and no
// clipboard payload ever originates here.

import type {
  PairCopyOutcome,
  PairHandoffAction,
  PairHandoffView,
} from "../../shared/pair-handoff.js";

export interface PairHandoffBridge {
  state(): Promise<PairHandoffView>;
  /** The token carries nothing; main copies what main retained. */
  copy(payload: { action: PairHandoffAction }): Promise<PairCopyOutcome>;
  onState(cb: (payload: unknown) => void): () => void;
}
