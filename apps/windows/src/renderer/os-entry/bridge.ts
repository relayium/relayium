// The preload surface the OS-entry pane uses. Declared, not inferred.
//
// No path crosses in either direction. `read` carries a capability token and a
// bounded range; everything else is a closed token or nothing at all.

import type { OsEntryView, SelectionReadResult } from "../../shared/os-entry.js";
import type {
  ReceivedAction,
  ReceivedActionOutcome,
} from "../../shared/received-drag.js";

export interface OsEntryBridge {
  state(): Promise<OsEntryView>;
  /** One bounded range of one staged file. See `MAX_SELECTION_CHUNK`. */
  read(payload: { token: string; offset: number; length: number }): Promise<SelectionReadResult>;
  /** Dismiss the staged selection. Sending is the send lane's, not this one's. */
  clear(): Promise<OsEntryView>;
  onState(cb: (payload: unknown) => void): () => void;
}

/** Drag or reveal a received file. Separate surface, separate registry. */
export interface ReceivedDragBridge {
  act(payload: { action: ReceivedAction; token: string }): Promise<ReceivedActionOutcome>;
}
