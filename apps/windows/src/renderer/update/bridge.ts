// The preload surface the update pane uses. Declared, not inferred.
//
// Every argument is a closed token. No URL, path, version or digest ever
// originates here, and none is returned that a page could navigate to.

import type {
  UpdateAction,
  UpdateExternalTarget,
  UpdateSummaryView,
} from "../../shared/update-summary.js";

export interface UpdateSummaryBridge {
  /** The snapshot main holds. Never triggers work by itself. */
  state(): Promise<UpdateSummaryView>;
  /** One closed action. Carries nothing else; main owns every fact. */
  act(payload: { action: UpdateAction }): Promise<UpdateSummaryView>;
  /** Re-read the residue counts for the `blocked` explanation. */
  residue(): Promise<UpdateSummaryView>;
  /** Open the release notes. A token, never an address. */
  openExternal(payload: { target: UpdateExternalTarget }): Promise<{ ok: boolean }>;
  /** Main pushed a new snapshot — a core transition, or a gate change. */
  onState(cb: (payload: unknown) => void): () => void;
}
