// The staged-selection controller: what it turns entries into, and when it
// stops.

import { describe, expect, it } from "vitest";
import { OsEntryController } from "../../src/renderer/os-entry/os-entry-controller.svelte.js";
import type { OsEntryBridge } from "../../src/renderer/os-entry/bridge.js";
import { OS_ENTRY_EMPTY, type OsEntryView } from "../../src/shared/os-entry.js";

const stagedView = (over: Partial<Extract<OsEntryView, { kind: "staged" }>> = {}): OsEntryView => ({
  kind: "staged",
  selectionId: "sel-1",
  entries: [
    { token: "t1", name: "a.txt", relativePath: "box/a.txt", size: 4 },
    { token: "t2", name: "b.txt", relativePath: "box/b.txt", size: 0 },
  ],
  rootNames: ["box"],
  totalBytes: 4,
  stagedAt: 1,
  refusedSince: 0,
  ...over,
});

function harness() {
  const calls = { state: 0, clear: 0, reads: [] as string[] };
  const answers = { state: OS_ENTRY_EMPTY as OsEntryView, clear: OS_ENTRY_EMPTY as OsEntryView };
  const listeners = new Set<(p: unknown) => void>();
  const bridge: OsEntryBridge = {
    async state() {
      calls.state += 1;
      return answers.state;
    },
    async read({ token, offset, length }) {
      calls.reads.push(`${token}:${String(offset)}:${String(length)}`);
      return { kind: "bytes", bytes: new Uint8Array([1, 2, 3, 4]).subarray(0, Math.min(4, length)) };
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
  return {
    controller: new OsEntryController(bridge),
    calls,
    answers,
    push: (v: unknown) => {
      for (const l of [...listeners]) l(v);
    },
    subscriptions: () => listeners.size,
  };
}

describe("staged entries become lazy files", () => {
  it("exposes one File-shaped adapter per entry, with paths preserved", () => {
    const h = harness();
    h.push(stagedView());
    const files = h.controller.files();
    expect(files.length).toBe(2);
    expect(files[0]?.name).toBe("a.txt");
    expect(files[0]?.webkitRelativePath).toBe("box/a.txt");
    // An empty file is still an entry: a folder missing one is not the folder
    // that was staged.
    expect(files[1]?.size).toBe(0);
  });

  it("reads through the bridge, bounded, only when asked", async () => {
    const h = harness();
    h.push(stagedView());
    expect(h.calls.reads).toEqual([]);
    const file = h.controller.entries()[0];
    await file?.slice(0, 4).arrayBuffer();
    expect(h.calls.reads).toEqual(["t1:0:4"]);
  });

  it("has no files when nothing is staged", () => {
    const h = harness();
    h.push({ kind: "empty", selectionId: "sel-2", refusal: "too-many" });
    expect(h.controller.files()).toEqual([]);
    expect(h.controller.staged).toBe(false);
    expect(h.controller.refusal).toBe("too-many");
  });
});

describe("ordering and lifecycle", () => {
  it("a push supersedes a read already in flight", async () => {
    const h = harness();
    h.answers.state = stagedView({ selectionId: "old" });
    const loading = h.controller.load();
    h.push(stagedView({ selectionId: "new" }));
    await loading;
    expect(h.controller.view.selectionId).toBe("new");
  });

  it("ignores a malformed push", () => {
    const h = harness();
    h.push(stagedView());
    const before = h.controller.view;
    h.push(null);
    h.push({ kind: "staged" });
    h.push({ selectionId: "x" });
    expect(h.controller.view).toBe(before);
  });

  it("clears once, and not while busy", async () => {
    const h = harness();
    h.push(stagedView());
    await Promise.all([h.controller.clear(), h.controller.clear()]);
    expect(h.calls.clear).toBe(1);
    expect(h.controller.busy).toBe(false);
  });

  it("destroy releases the subscription and refuses new work", async () => {
    const h = harness();
    expect(h.subscriptions()).toBe(1);
    h.controller.destroy();
    expect(h.subscriptions()).toBe(0);
    await h.controller.load();
    await h.controller.clear();
    expect(h.calls).toMatchObject({ state: 0, clear: 0 });
  });

  it("a refused burst is visible on the held selection", () => {
    const h = harness();
    h.push(stagedView({ refusedSince: 2 }));
    const view = h.controller.view;
    if (view.kind !== "staged") throw new Error("expected staged");
    expect(view.refusedSince).toBe(2);
  });
});
