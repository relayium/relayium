// The handoff's state: one link, its QR, and whether it was copied.
//
// All three belong to ONE link. `generation` comes from main and is the only
// thing that decides whether a QR that finished encoding, or a "Copied" a user
// is still looking at, is about the code currently on screen.

import {
  PAIR_HANDOFF_IDLE,
  type PairCopyOutcome,
  type PairHandoffView,
} from "../../shared/pair-handoff.js";
import type { PairHandoffBridge } from "./bridge.js";
import { renderJoinQr } from "./qr.js";

/** What the last copy attempt did. Closed; the wording is the catalogue's. */
export type PairCopyNotice =
  | { readonly kind: "copied"; readonly generation: number }
  | { readonly kind: "expired" }
  | { readonly kind: "failed" };

export class PairHandoffController {
  view = $state<PairHandoffView>(PAIR_HANDOFF_IDLE);
  /** The encoded QR for the CURRENT link, or null while absent. */
  qrDataUrl = $state<string | null>(null);
  /** True while an encode for the current link is in flight. */
  qrPending = $state(false);
  copyNotice = $state<PairCopyNotice | null>(null);
  copying = $state(false);

  readonly #stop: Array<() => void> = [];
  #seq = 0;
  /** The generation the held QR and notice belong to. */
  #generation = 0;
  #destroyed = false;

  constructor(private readonly bridge: PairHandoffBridge) {
    this.#stop.push(
      bridge.onState((payload) => {
        const shaped = payload as PairHandoffView | null;
        if (shaped === null || typeof shaped !== "object") return;
        if (typeof (shaped as { kind?: unknown }).kind !== "string") return;
        if (typeof (shaped as { generation?: unknown }).generation !== "number") return;
        if (this.#destroyed) return;
        this.#seq += 1;
        this.#adopt(shaped);
      }),
    );
  }

  /** Read what main holds. Called once by the shell. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const view = await this.bridge.state().catch(() => null);
    if (view === null || this.#destroyed || this.#seq !== seq) return;
    this.#adopt(view);
  }

  /**
   * Install a view and, when the link has changed, start its QR.
   *
   * The previous QR and the previous "Copied" are dropped the moment the
   * generation moves. Keeping either would show an artefact of a code that is
   * no longer on screen — the failure `PairingCodeHandoffView` avoids with
   * `onChange(of: url)`.
   */
  #adopt(view: PairHandoffView): void {
    const changed = view.generation !== this.#generation;
    this.#generation = view.generation;
    this.view = view;
    if (!changed) return;
    this.qrDataUrl = null;
    this.copyNotice = null;
    this.qrPending = false;
    if (view.kind !== "live") return;
    this.#encode(view.link, view.generation);
  }

  /**
   * Encode, and install only if the link is still the current one.
   *
   * `renderJoinQr` never rejects, so there is no failure path here — an encoder
   * that was unavailable answers `null` and the pane renders the code and the
   * copy button, which is the affordance minus its accelerator.
   */
  #encode(link: string, generation: number): void {
    this.qrPending = true;
    void renderJoinQr({ link, generation }).then((result) => {
      // Discarded outright if the code moved on while this was encoding.
      if (this.#destroyed || result.generation !== this.#generation) return;
      this.qrPending = false;
      this.qrDataUrl = result.dataUrl;
    });
  }

  /**
   * Copy the join link.
   *
   * A closed token crosses and nothing else; main copies the link it retained.
   * The confirmation is stamped with the generation main reports, so it cannot
   * outlive the link it describes.
   */
  async copy(): Promise<void> {
    if (this.#destroyed || this.copying) return;
    if (this.view.kind !== "live") return;
    this.copying = true;
    this.copyNotice = null;
    const generation = this.#generation;
    let outcome: PairCopyOutcome | null = null;
    try {
      outcome = await this.bridge.copy({ action: "copy-join-link" });
    } catch {
      outcome = null;
    }
    if (this.#destroyed || this.#generation !== generation) {
      // The code changed while the copy was in flight. Reporting it now would
      // put a confirmation over a link nobody copied.
      if (!this.#destroyed) this.copying = false;
      return;
    }
    this.copying = false;
    if (outcome === null) {
      this.copyNotice = { kind: "failed" };
      return;
    }
    switch (outcome.kind) {
      case "copied":
        // Main's generation, not the local one: if they disagree the copy was
        // of a link this pane is no longer showing.
        this.copyNotice =
          outcome.generation === generation ? { kind: "copied", generation } : null;
        return;
      case "expired":
        this.copyNotice = { kind: "expired" };
        return;
      default:
        this.copyNotice = { kind: "failed" };
    }
  }

  /** Whether the confirmation still describes what is on screen. */
  get copied(): boolean {
    const notice = this.copyNotice;
    return notice !== null && notice.kind === "copied" && notice.generation === this.#generation;
  }

  dismissNotice(): void {
    this.copyNotice = null;
  }

  /** Only the app's own teardown calls this. */
  destroy(): void {
    this.#destroyed = true;
    this.#seq += 1;
    // The countdown, the QR and the confirmation are all this object's; none
    // outlives it.
    this.qrDataUrl = null;
    this.copyNotice = null;
    this.qrPending = false;
    for (const stop of this.#stop.splice(0)) stop();
  }
}
