// The staged selection's state, owned by the shell rather than by the page.
//
// It holds no bytes and no paths. What it turns a staged entry into is a
// `SelectionFile` — a lazy, `File`-shaped view that fetches bounded ranges from
// main when the encryptor asks — so the existing send lane can take it exactly
// as it takes a picked `File`.

import {
  OS_ENTRY_EMPTY,
  type OsEntryView,
  type SelectionRefusal,
} from "../../shared/os-entry.js";
import type { OsEntryBridge } from "./bridge.js";
import { SelectionFile, asFile } from "./selection-file.js";

export class OsEntryController {
  view = $state<OsEntryView>(OS_ENTRY_EMPTY);
  busy = $state(false);

  readonly #stop: Array<() => void> = [];
  #seq = 0;
  #destroyed = false;

  constructor(private readonly bridge: OsEntryBridge) {
    this.#stop.push(
      bridge.onState((payload) => {
        const shaped = payload as OsEntryView | null;
        if (shaped === null || typeof shaped !== "object") return;
        if (typeof (shaped as { kind?: unknown }).kind !== "string") return;
        if (typeof (shaped as { selectionId?: unknown }).selectionId !== "string") return;
        if (this.#destroyed) return;
        this.#seq += 1;
        this.view = shaped;
      }),
    );
  }

  async load(): Promise<void> {
    // Checked before the call, not only after it: a destroyed controller that
    // still issued the IPC would be doing work on behalf of a page that is gone.
    if (this.#destroyed) return;
    const seq = ++this.#seq;
    const view = await this.bridge.state().catch(() => null);
    if (view === null || this.#destroyed || this.#seq !== seq) return;
    this.view = view;
  }

  /** Why the last activation staged nothing, or null. */
  get refusal(): SelectionRefusal | null {
    return this.view.kind === "empty" ? this.view.refusal : null;
  }

  get staged(): boolean {
    return this.view.kind === "staged";
  }

  /**
   * The staged files, as the encryptor may take them.
   *
   * Rebuilt per call from the current view, and keyed to the selection: a file
   * from a superseded selection carries a token main no longer honours, so it
   * cannot read anything even if something held on to it.
   */
  files(): readonly File[] {
    const view = this.view;
    if (view.kind !== "staged") return [];
    return view.entries.map((entry) => asFile(new SelectionFile(this.bridge, entry)));
  }

  /** The same list, unwrapped, for a caller that wants the sizes and paths. */
  entries(): readonly SelectionFile[] {
    const view = this.view;
    if (view.kind !== "staged") return [];
    return view.entries.map((entry) => new SelectionFile(this.bridge, entry));
  }

  async clear(): Promise<void> {
    if (this.#destroyed || this.busy) return;
    this.busy = true;
    const seq = ++this.#seq;
    try {
      const view = await this.bridge.clear().catch(() => null);
      if (view === null || this.#destroyed || this.#seq !== seq) return;
      this.view = view;
    } finally {
      if (!this.#destroyed) this.busy = false;
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#seq += 1;
    for (const stop of this.#stop.splice(0)) stop();
  }
}
