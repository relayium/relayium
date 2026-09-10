// A private entry that mounts the REAL update pane for the renderer smoke.
//
// Nothing imports this file, so it is not in the shipped bundle. The bridge
// below is a SYNTHETIC in-page object: it reaches no main process, no feed and
// no disk. What it proves is the pane and the controller — that all eighteen
// states render, in both languages, and that the action gates the facade
// publishes are the ones the buttons obey.

import { mount, unmount } from "svelte";
import UpdateDetails from "../pages/UpdateDetails.svelte";
import { UpdateSummaryController } from "./update-controller.svelte.js";
import type { UpdateSummaryBridge } from "./bridge.js";
import { setLang } from "../i18n/index.svelte.js";
import {
  UPDATE_SUMMARY_LOADING,
  type UpdateAction,
  type UpdateSummaryView,
} from "../../shared/update-summary.js";
import "../tokens.css";

const calls = { state: 0, act: [] as UpdateAction[], residue: 0, notes: 0 };
const listeners = new Set<(payload: unknown) => void>();
const answers = { view: UPDATE_SUMMARY_LOADING as UpdateSummaryView, notesOk: true };
/** Which bridge calls should reject, so the failure notice can be driven. */
const rejects = { state: false, act: false, residue: false, notes: false };

const bridge: UpdateSummaryBridge = {
  async state() {
    calls.state += 1;
    if (rejects.state) throw new Error("channel gone");
    return answers.view;
  },
  async act(payload) {
    calls.act.push(payload.action);
    if (rejects.act) throw new Error("channel gone");
    return answers.view;
  },
  async residue() {
    calls.residue += 1;
    if (rejects.residue) throw new Error("channel gone");
    return answers.view;
  },
  async openExternal() {
    calls.notes += 1;
    if (rejects.notes) throw new Error("channel gone");
    return { ok: answers.notesOk };
  },
  onState(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");

/**
 * Mutable so the driver can start over.
 *
 * A genuine FIRST-read failure cannot be staged on a controller that has
 * already accepted pushes: `confirmed` is latched by design, so the oracle
 * would be asserting against a pane that legitimately knows its state. The only
 * honest way to test it is a fresh controller and a fresh mount.
 */
let controller = new UpdateSummaryController(bridge);
let app_ = mount(UpdateDetails, { target, props: { controller } });

Object.defineProperty(globalThis, "__updateHarness", {
  value: {
    push(view: UpdateSummaryView): void {
      answers.view = view;
      for (const listener of [...listeners]) listener(view);
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    setNotesOk(ok: boolean): void {
      answers.notesOk = ok;
    },
    setRejects(next: Partial<typeof rejects>): void {
      Object.assign(rejects, next);
    },
    load(): Promise<void> {
      return controller.load();
    },
    /** Tear down and rebuild, for a genuine first-read case. */
    async remount(): Promise<void> {
      controller.destroy();
      await unmount(app_);
      target.textContent = "";
      controller = new UpdateSummaryController(bridge);
      app_ = mount(UpdateDetails, { target, props: { controller } });
    },
    calls: () => JSON.parse(JSON.stringify(calls)) as typeof calls,
    resetCalls(): void {
      calls.state = 0;
      calls.act.length = 0;
      calls.residue = 0;
      calls.notes = 0;
    },
  },
  enumerable: true,
});
