// A private entry that mounts the REAL pending-selection pane for the smoke.
//
// Nothing imports this file, so it is not in the shipped bundle. The bridge is
// synthetic and in-page: no main process and no filesystem.

import { mount, unmount } from "svelte";
import PendingSelection from "../pages/PendingSelection.svelte";
import { OsEntryController } from "./os-entry-controller.svelte.js";
import type { OsEntryBridge } from "./bridge.js";
import { setLang } from "../i18n/index.svelte.js";
import { OS_ENTRY_EMPTY, type OsEntryView } from "../../shared/os-entry.js";
import "../tokens.css";

const calls = { state: 0, clear: 0, reads: [] as string[] };
const listeners = new Set<(payload: unknown) => void>();
const answers = { view: OS_ENTRY_EMPTY as OsEntryView, clear: OS_ENTRY_EMPTY as OsEntryView };

const bridge: OsEntryBridge = {
  async state() {
    calls.state += 1;
    return answers.view;
  },
  async read({ token, offset, length }) {
    calls.reads.push(`${token}:${String(offset)}:${String(length)}`);
    return { kind: "bytes", bytes: new Uint8Array(Math.min(4, length)) };
  },
  async clear() {
    calls.clear += 1;
    return answers.clear;
  },
  onState(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");
let controller = new OsEntryController(bridge);
let app_ = mount(PendingSelection, { target, props: { controller } });

Object.defineProperty(globalThis, "__osEntryHarness", {
  value: {
    push(view: OsEntryView): void {
      answers.view = view;
      for (const listener of [...listeners]) listener(view);
    },
    setClear(view: OsEntryView): void {
      answers.clear = view;
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    calls: () => JSON.parse(JSON.stringify(calls)) as typeof calls,
    resetCalls(): void {
      calls.state = 0;
      calls.clear = 0;
      calls.reads.length = 0;
    },
    async remount(): Promise<void> {
      controller.destroy();
      await unmount(app_);
      target.textContent = "";
      controller = new OsEntryController(bridge);
      app_ = mount(PendingSelection, { target, props: { controller } });
    },
  },
  enumerable: true,
});
