// A private entry that mounts the REAL handoff for the renderer smoke.
//
// Nothing imports this file, so it is not in the shipped bundle. The bridge is a
// SYNTHETIC in-page object: no main process and no clipboard. What it proves is
// the component and the controller — that a live code renders a real QR, that
// the artefacts follow the generation, and that the copy sends only a token.
//
// It is also what makes the BUILD prove the dependency: this entry reaches
// `qr.ts`, so a `qrcode` the bundler could not resolve fails the harness build
// rather than degrading silently.

import { mount, unmount } from "svelte";
import PairHandoff from "../pages/PairHandoff.svelte";
import { PairHandoffController } from "./pair-handoff-controller.svelte.js";
import { QR_SIDE } from "./qr.js";
import type { PairHandoffBridge } from "./bridge.js";
import { setLang } from "../i18n/index.svelte.js";
import {
  PAIR_HANDOFF_IDLE,
  type PairCopyOutcome,
  type PairHandoffView,
} from "../../shared/pair-handoff.js";
import "../tokens.css";

const calls = { state: 0, copy: [] as string[] };
const listeners = new Set<(payload: unknown) => void>();
const answers = {
  view: PAIR_HANDOFF_IDLE as PairHandoffView,
  copy: { kind: "copied", generation: 1 } as PairCopyOutcome,
};
const rejects = { state: false, copy: false };

const bridge: PairHandoffBridge = {
  async state() {
    calls.state += 1;
    if (rejects.state) throw new Error("channel gone");
    return answers.view;
  },
  async copy(payload) {
    calls.copy.push(payload.action);
    if (rejects.copy) throw new Error("channel gone");
    return answers.copy;
  },
  onState(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");
let controller = new PairHandoffController(bridge);
let app_ = mount(PairHandoff, { target, props: { controller } });

Object.defineProperty(globalThis, "__pairHarness", {
  value: {
    push(view: PairHandoffView): void {
      answers.view = view;
      for (const listener of [...listeners]) listener(view);
    },
    setCopyOutcome(outcome: PairCopyOutcome): void {
      answers.copy = outcome;
    },
    setRejects(next: Partial<typeof rejects>): void {
      Object.assign(rejects, next);
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    /**
     * Encode a link INDEPENDENTLY of the product's QR path.
     *
     * There is no decoder available here, so the payload check runs the other
     * direction: the encoder is deterministic, so re-encoding the link the
     * driver expects must reproduce the rendered image byte for byte.
     *
     * It calls the library directly rather than `renderJoinQr`, and that is the
     * whole point — a negative control that made `renderJoinQr` encode the
     * query form passed the equality check, because the reference went through
     * the same defect. A reference sharing the code under test verifies
     * nothing.
     */
    async encode(link: string): Promise<string | null> {
      try {
        const module = await import("qrcode");
        return await module.toDataURL(link, { margin: 1, width: QR_SIDE });
      } catch {
        return null;
      }
    },
    calls: () => JSON.parse(JSON.stringify(calls)) as typeof calls,
    resetCalls(): void {
      calls.state = 0;
      calls.copy.length = 0;
    },
    async remount(): Promise<void> {
      controller.destroy();
      await unmount(app_);
      target.textContent = "";
      controller = new PairHandoffController(bridge);
      app_ = mount(PairHandoff, { target, props: { controller } });
    },
  },
  enumerable: true,
});
