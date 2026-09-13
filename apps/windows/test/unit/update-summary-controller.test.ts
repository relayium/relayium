// The update controller: which answer may still be installed, and what a
// failure is allowed to claim.
//
// Runs the real rune module. It is not a substitute for driving the pane —
// `test/smoke/update-details-smoke.mjs` does that.

import { describe, expect, it } from "vitest";
import { UpdateSummaryController } from "../../src/renderer/update/update-controller.svelte.js";
import type { UpdateSummaryBridge } from "../../src/renderer/update/bridge.js";
import {
  UPDATE_SUMMARY_LOADING,
  type UpdateAction,
  type UpdateStateView,
  type UpdateSummaryView,
} from "../../src/shared/update-summary.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const view = (state: UpdateStateView, over: Partial<UpdateSummaryView> = {}): UpdateSummaryView => ({
  state,
  actions: {
    canCheck: true,
    canDownload: true,
    canInstall: true,
    canReveal: true,
    canOpenNotes: true,
    busy: false,
  },
  residue: { kind: "unread" },
  currentVersion: "1.3.9",
  ...over,
});

const IDLE = view({ kind: "idle", lastCheckedAt: null });
const CHECKING = view({ kind: "checking" });

function harness() {
  const calls = { state: 0, act: [] as UpdateAction[], residue: 0, notes: 0 };
  const holds = { state: null as Promise<void> | null, act: null as Promise<void> | null };
  const answers = { state: IDLE, act: CHECKING, residue: IDLE, notesOk: true };
  const rejects = { state: false, act: false, notes: false };
  const listeners = new Set<(payload: unknown) => void>();

  const bridge: UpdateSummaryBridge = {
    async state() {
      calls.state += 1;
      if (holds.state) await holds.state;
      if (rejects.state) throw new Error("channel gone");
      return answers.state;
    },
    async act(payload) {
      calls.act.push(payload.action);
      if (holds.act) await holds.act;
      if (rejects.act) throw new Error("channel gone");
      return answers.act;
    },
    async residue() {
      calls.residue += 1;
      return answers.residue;
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

  return {
    controller: new UpdateSummaryController(bridge),
    calls,
    holds,
    answers,
    rejects,
    push: (payload: unknown) => {
      for (const l of [...listeners]) l(payload);
    },
    subscriptions: () => listeners.size,
  };
}

describe("a push is the newest word", () => {
  it("a startup read does not overwrite a transition already pushed", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.state = hold.promise;
    h.answers.state = IDLE;
    const loading = h.controller.load();

    // The core moved on while the initial read was still out.
    h.push(view({ kind: "downloading", candidate: { version: "1.4.0", build: 1400, sizeBytes: 100, hasNotes: false, sha256: null }, receivedBytes: 40 }));
    expect(h.controller.view.state.kind).toBe("downloading");

    hold.resolve();
    await loading;
    // Installing the stale read would roll the pane back to `idle` over a
    // download the user can see moving.
    expect(h.controller.view.state.kind).toBe("downloading");
  });

  it("an action answer does not overwrite a newer push", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.act = hold.promise;
    h.answers.act = CHECKING;
    const running = h.controller.act("check");

    h.push(view({ kind: "up-to-date", checkedAt: 5 }));
    hold.resolve();
    await running;
    expect(h.controller.view.state.kind).toBe("up-to-date");
  });

  it("ignores a malformed push rather than blanking a known pane", () => {
    const h = harness();
    h.push(IDLE);
    const before = h.controller.view;
    h.push(null);
    h.push("nope");
    h.push({ state: {} });
    h.push({ state: {}, actions: {} });
    expect(h.controller.view).toBe(before);
  });

  it("takes one subscription and releases it on destroy", () => {
    const h = harness();
    expect(h.subscriptions()).toBe(1);
    h.controller.destroy();
    expect(h.subscriptions()).toBe(0);
  });
});

describe("actions", () => {
  it("is single-flight across ALL actions, because main holds one slot", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.act = hold.promise;
    const first = h.controller.act("check");
    expect(h.controller.pending).toBe("check");
    // A different action would be refused by main too, and a button that
    // silently does nothing is worse than a disabled one.
    await h.controller.act("download");
    expect(h.calls.act).toEqual(["check"]);
    hold.resolve();
    await first;
    expect(h.controller.pending).toBeNull();
  });

  it("reports a rejected action honestly, installing nothing", async () => {
    const h = harness();
    h.push(IDLE);
    const before = h.controller.view;
    h.rejects.act = true;
    await h.controller.act("check");
    // Main returns the current view for every refusal, so a rejection means the
    // channel failed. Inventing a state for it would put a claim on screen no
    // process made.
    expect(h.controller.view).toBe(before);
    expect(h.controller.pending).toBeNull();
  });

  it("clears pending even when the channel fails", async () => {
    const h = harness();
    h.rejects.act = true;
    await h.controller.act("install");
    expect(h.controller.pending).toBeNull();
  });
});

describe("a failed request is reported, not swallowed", () => {
  it("a failed initial read does not pose as a confirmed disabled build", async () => {
    const h = harness();
    h.rejects.state = true;
    await h.controller.load();
    // The starting value IS `disabled/no-pin`. Rendering it as fact after a read
    // that never happened would claim this build has no signing key on the
    // strength of nothing.
    expect(h.controller.confirmed).toBe(false);
    expect(h.controller.failure).toEqual({ kind: "read" });
    expect(h.controller.retryable).toBe(true);
  });

  it("becomes confirmed on a successful read, and on a push", async () => {
    const h = harness();
    await h.controller.load();
    expect(h.controller.confirmed).toBe(true);

    const pushed = harness();
    expect(pushed.controller.confirmed).toBe(false);
    pushed.push(IDLE);
    expect(pushed.controller.confirmed).toBe(true);
  });

  it("preserves the known view when a LATER request fails", async () => {
    const h = harness();
    h.push(CHECKING);
    const known = h.controller.view;
    h.rejects.state = true;
    await h.controller.load();
    // The last thing main said is still the last thing main said.
    expect(h.controller.view).toBe(known);
    expect(h.controller.confirmed).toBe(true);
    expect(h.controller.failure).toEqual({ kind: "read" });
  });

  it("records which action failed, and retries only that one", async () => {
    const h = harness();
    h.push(IDLE);
    h.rejects.act = true;
    await h.controller.act("check");
    expect(h.controller.failure).toEqual({ kind: "action", action: "check" });
    h.rejects.act = false;
    await h.controller.retry();
    expect(h.calls.act).toEqual(["check", "check"]);
    expect(h.controller.failure).toBeNull();
  });

  it("never re-offers an action whose gate has since closed", async () => {
    const h = harness();
    h.push(IDLE);
    h.rejects.act = true;
    await h.controller.act("check");
    expect(h.controller.retryable).toBe(true);
    // The state moved to a terminal one while the notice was on screen.
    h.push(view({ kind: "publisher-mismatch", candidate: { version: "1.4.0", build: 1400, sizeBytes: 1, hasNotes: false, sha256: null } }, {
      actions: { canCheck: false, canDownload: false, canInstall: false, canReveal: false, canOpenNotes: false, busy: false },
    }));
    // A push clears the notice; even if one were held, the gate governs.
    expect(h.controller.failure).toBeNull();
    h.rejects.act = false;
    await h.controller.retry();
    expect(h.calls.act).toEqual(["check"]);
  });

  it("distinguishes a channel failure from main refusing to open the browser", async () => {
    const refused = harness();
    refused.answers.notesOk = false;
    await refused.controller.openNotes();
    expect(refused.controller.notesFailed).toBe(true);
    expect(refused.controller.failure).toBeNull();

    const broken = harness();
    broken.rejects.notes = true;
    await broken.controller.openNotes();
    expect(broken.controller.failure).toEqual({ kind: "notes" });
    expect(broken.controller.notesFailed).toBe(false);
  });

  it("clears the notice on a push, and on dismiss", async () => {
    const h = harness();
    h.rejects.state = true;
    await h.controller.load();
    expect(h.controller.failure).not.toBeNull();
    h.push(IDLE);
    expect(h.controller.failure).toBeNull();

    h.rejects.state = true;
    await h.controller.load();
    expect(h.controller.failure).not.toBeNull();
    h.controller.dismissFailure();
    expect(h.controller.failure).toBeNull();
  });

  it("a stale failure never lands after a newer push", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.state = hold.promise;
    h.rejects.state = true;
    const loading = h.controller.load();
    h.push(IDLE);
    hold.resolve();
    await loading;
    // The read failed, but main has spoken since. Reporting it now would put a
    // failure notice over a pane that is currently correct.
    expect(h.controller.failure).toBeNull();
    expect(h.controller.view).toBe(IDLE);
  });

  it("a failure after destroy writes nothing", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.state = hold.promise;
    h.rejects.state = true;
    const loading = h.controller.load();
    h.controller.destroy();
    hold.resolve();
    await loading;
    expect(h.controller.failure).toBeNull();
  });
});

describe("release notes", () => {
  it("names a closed token and reports a refusal", async () => {
    const h = harness();
    await h.controller.openNotes();
    expect(h.calls.notes).toBe(1);
    expect(h.controller.notesFailed).toBe(false);
    h.answers.notesOk = false;
    await h.controller.openNotes();
    expect(h.controller.notesFailed).toBe(true);
  });

  it("treats a broken channel as a request failure, not as a refusal", async () => {
    const h = harness();
    h.rejects.notes = true;
    await h.controller.openNotes();
    expect(h.controller.notesFailed).toBe(false);
    expect(h.controller.failure).toEqual({ kind: "notes" });
  });

  it("does not report an older open over a newer state", async () => {
    const h = harness();
    h.answers.notesOk = false;
    const opening = h.controller.openNotes();
    h.push(IDLE);
    await opening;
    expect(h.controller.notesFailed).toBe(false);
  });
});

describe("destroy", () => {
  it("invalidates every pending answer", async () => {
    const h = harness();
    h.push(IDLE);
    const hold = deferred();
    h.holds.state = hold.promise;
    const loading = h.controller.load();
    const before = h.controller.view;
    h.controller.destroy();
    hold.resolve();
    await loading;
    expect(h.controller.view).toBe(before);
  });

  it("refuses to start anything new", async () => {
    const h = harness();
    h.controller.destroy();
    await h.controller.load();
    await h.controller.act("check");
    await h.controller.openNotes();
    await h.controller.refreshResidue();
    expect(h.calls).toEqual({ state: 0, act: [], residue: 0, notes: 0 });
  });

  it("starts from the shipped disabled view, not from an empty one", () => {
    const h = harness();
    expect(h.controller.view).toBe(UPDATE_SUMMARY_LOADING);
    expect(h.controller.view.state).toEqual({ kind: "disabled", reason: "no-pin" });
    expect(h.controller.view.residue).toEqual({ kind: "unread" });
  });
});
