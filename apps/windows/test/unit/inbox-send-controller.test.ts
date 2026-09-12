// The Inbox send page's controller: what a person sees while it delivers.
//
// The assertions that matter are the ones about TRUTH under interruption: a
// target that was queued and never started is not reported as failed, an
// unknown outcome is never softened into a delivery, a cancel pressed before
// the job id exists still stops the job main has just created, and an account
// change drops the previous account's devices before the picker can offer a
// machine this account does not have.
//
// The producer is stubbed here on purpose: the REAL `encryptFiles` path is
// exercised by the send service's own suite against the real engine, and what
// is under test here is the page's state machine.

import { describe, expect, it } from "vitest";
import {
  InboxSendController,
  type InboxSendBridge,
} from "../../src/renderer/inbox/inbox-send-controller.svelte.js";
import type { InboxSendStart, InboxView } from "../../src/shared/ipc-contract.js";
import type { InboxSendView } from "../../src/main/features/inbox-send.js";

const VIEW = (epoch: number): InboxView => ({
  status: { kind: "idle", pending: 0 },
  capabilities: [],
  enabled: true,
  hasDestination: true,
  deviceName: "A PC",
  withdrawalPending: false,
  policy: "ask",
  epoch,
  retained: [],
});

const TARGETS = [
  { deviceID: "dev-a", name: "Study desktop", eligible: true, refusal: null },
  { deviceID: "dev-b", name: "Old laptop", eligible: false, refusal: "auto_receive_disabled" },
];

const DELIVERED: InboxSendView = { kind: "delivered", created: true, state: "queued" };

/**
 * A real 32-byte content key, base64url.
 *
 * Not a placeholder: the controller imports it with the production
 * `importStoreKey` and encrypts with the production `encryptFiles`, so a stub
 * string would fail to import and every send would land in the catch — which is
 * exactly how the first version of this suite lied to itself.
 */
const CONTENT_KEY = Buffer.alloc(32, 7).toString("base64url");

function harness(over: Partial<InboxSendBridge> = {}) {
  let pushState: ((payload: unknown) => void) | null = null;
  let pushOutcome: ((payload: unknown) => void) | null = null;
  let pushProgress: ((payload: unknown) => void) | null = null;
  const calls = {
    start: [] as { target: string; kind: string; entries: readonly { path: string; size: number }[] }[],
    feed: 0,
    end: [] as string[],
    cancel: [] as string[],
    converge: [] as string[],
    targets: 0,
  };
  let jobs = 0;
  const base: InboxSendBridge = {
    async targets() {
      calls.targets += 1;
      return { ok: true, targets: TARGETS };
    },
    async start(payload) {
      calls.start.push(payload);
      jobs += 1;
      return {
        ok: true,
        jobId: `job-${String(jobs)}`,
        contentKey: CONTENT_KEY,
        expects: { fileIndex: 0, seq: 1, bytes: 4 },
        cipherBytes: 100,
        fileCount: payload.entries.length,
      } satisfies InboxSendStart;
    },
    async feed() {
      calls.feed += 1;
      return { expects: null };
    },
    async end(payload) {
      calls.end.push(payload.jobId);
      return DELIVERED;
    },
    async cancel(payload) {
      calls.cancel.push(payload.jobId);
      return { kind: "cancelled", state: null };
    },
    async converge(payload) {
      calls.converge.push(payload.jobId);
      return DELIVERED;
    },
    onProgress(cb) {
      pushProgress = cb;
      return () => undefined;
    },
    onOutcome(cb) {
      pushOutcome = cb;
      return () => undefined;
    },
  };
  const bridge = { ...base, ...over };
  const controller = new InboxSendController(bridge, (cb) => {
    pushState = cb;
    return () => undefined;
  });
  return {
    controller,
    calls,
    state: (payload: unknown) => pushState?.(payload),
    outcome: (payload: unknown) => pushOutcome?.(payload),
    progress: (payload: unknown) => pushProgress?.(payload),
  };
}

/** A file the controller can measure without a filesystem. */
function fileOf(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name);
}

describe("choosing what and where", () => {
  it("reads the device list and drops a selection that stopped being eligible", async () => {
    const h = harness();
    await h.controller.refreshTargets();
    expect(h.controller.targets).toHaveLength(2);
    h.controller.toggle("dev-a");
    expect(h.controller.selected).toEqual(["dev-a"]);

    // That device turned receiving off. A tick beside a machine that cannot
    // take the delivery is a promise the send is going to break.
    const off = harness({
      async targets() {
        return { ok: true, targets: [{ ...TARGETS[0]!, eligible: false, refusal: "auto_receive_disabled" }] };
      },
    });
    off.controller.toggle("dev-a");
    await off.controller.refreshTargets();
    expect(off.controller.selected).toEqual([]);
  });

  it("keeps an unreadable list distinct from having no devices", async () => {
    const h = harness({
      targets: () => Promise.reject(new Error("network")),
    });
    await h.controller.refreshTargets();
    // Showing an empty picker over a failed read tells the user they have
    // nothing to send to, which may be the opposite of the truth.
    expect(h.controller.targetsUnavailable).toBe(true);
    expect(h.controller.targets).toEqual([]);
  });

  it("freezes the picked files, so a re-pick is a new selection", () => {
    const h = harness();
    const picked = [fileOf("a.bin", 10), fileOf("b.bin", 20)];
    h.controller.pick(picked);
    expect(h.controller.totalBytes).toBe(30);
    expect(Object.isFrozen(h.controller.files)).toBe(true);
    // Mutating the array the caller kept must not change what will be sent.
    picked.push(fileOf("c.bin", 5));
    expect(h.controller.files).toHaveLength(2);
  });

  it("is not ready until there is both something to send and somewhere to send it", () => {
    const h = harness();
    expect(h.controller.ready).toBe(false);
    h.controller.pick([fileOf("a.bin", 1)]);
    expect(h.controller.ready).toBe(false);
    h.controller.toggle("dev-a");
    expect(h.controller.ready).toBe(true);

    h.controller.mode = "text";
    // A message with no text is not a message.
    expect(h.controller.ready).toBe(false);
    h.controller.message = "  ";
    expect(h.controller.ready).toBe(false);
    h.controller.message = "hello";
    expect(h.controller.ready).toBe(true);
  });
});

describe("files chosen by dropping them", () => {
  // A dropped `File` has no `webkitRelativePath` — the folder picker sets it and
  // nothing else does — so a drop that handed over bare files would flatten the
  // tree the person dropped. The manifest is where that shows: `docs/note.txt`
  // would be declared as `note.txt`, and two siblings with the same leaf name
  // would collide.
  it("declares the path the person dropped, not just the leaf name", async () => {
    const h = harness();
    await h.controller.refreshTargets();
    h.controller.pickEntries([
      { file: fileOf("note.txt", 3), path: "docs/note.txt" },
      { file: fileOf("note.txt", 4), path: "docs/sub/note.txt" },
    ]);
    h.controller.toggle("dev-a");
    await h.controller.send();

    expect(h.calls.start[0]?.entries).toEqual([
      { path: "docs/note.txt", size: 3 },
      { path: "docs/sub/note.txt", size: 4 },
    ]);
  });

  // A loose file dropped on its own has no folder to be relative to, so the
  // absence of a path is a fact rather than a gap.
  it("falls back to the leaf name when a dropped file has no path", async () => {
    const h = harness();
    await h.controller.refreshTargets();
    h.controller.pickEntries([{ file: fileOf("loose.bin", 2) }]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.calls.start[0]?.entries).toEqual([{ path: "loose.bin", size: 2 }]);
  });

  it("replaces the selection, as the pickers on this surface do", () => {
    const h = harness();
    h.controller.pick([fileOf("picked.bin", 1)]);
    h.controller.pickEntries([{ file: fileOf("dropped.bin", 2), path: "d/dropped.bin" }]);
    expect(h.controller.files).toHaveLength(1);
    expect(h.controller.pathOf(h.controller.files[0]!)).toBe("d/dropped.bin");
  });

  // Deliberately NOT a test that a picker "forgets" dropped paths. One was
  // written and it passed with the clearing removed, because the map is keyed
  // by File OBJECT: a later selection holds different objects, so a stale entry
  // can never be found by it. Clearing is about not retaining every dropped
  // File for the life of the page, which this suite cannot observe — so the
  // reason is stated where the clearing is, and no test claims to prove it.

  it("takes nothing while a send is in flight", () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 1)]);
    (h.controller as unknown as { busy: boolean }).busy = true;
    h.controller.pickEntries([{ file: fileOf("b.bin", 2), path: "b.bin" }]);
    expect(h.controller.files.map((f) => f.name)).toEqual(["a.bin"]);
  });
});

describe("delivering to several devices", () => {
  it("gives each target its own job, its own status and its own outcome", async () => {
    const h = harness();
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    h.controller.toggle("dev-b");
    await h.controller.send();

    // Two jobs, because a delivery is sealed to ONE device's key.
    expect(h.calls.start.map((s) => s.target)).toEqual(["dev-a", "dev-b"]);
    expect(h.controller.status["dev-a"]).toMatchObject({ phase: "settled", view: DELIVERED });
    expect(h.controller.status["dev-b"]).toMatchObject({ phase: "settled", view: DELIVERED });
    expect(h.controller.busy).toBe(false);
  });

  it("does not abandon the others when one target refuses", async () => {
    const h = harness({
      async start(payload) {
        if (payload.target === "dev-a") return { ok: false, refusal: "unavailable" };
        return {
          ok: true,
          jobId: "job-b",
          contentKey: CONTENT_KEY,
          expects: { fileIndex: 0, seq: 1, bytes: 4 },
          cipherBytes: 1,
          fileCount: 1,
        };
      },
    });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    h.controller.toggle("dev-b");
    await h.controller.send();

    // "Your laptop has receiving off" is not a reason to give up on the desktop.
    expect(h.controller.status["dev-a"]).toMatchObject({ phase: "settled", refusal: "unavailable" });
    expect(h.controller.status["dev-b"]).toMatchObject({ phase: "settled", view: DELIVERED });
  });

  it("sends a message as ONE item declaring its byte length", async () => {
    const h = harness();
    h.controller.mode = "text";
    h.controller.message = "meet me at six";
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.calls.start[0]).toMatchObject({ kind: "text" });
    expect(h.calls.start[0]?.entries).toEqual([
      { path: "message", size: new TextEncoder().encode("meet me at six").byteLength },
    ]);
  });

  it("applies a progress frame that arrived before its start answered", async () => {
    const h = harness();
    // The first committed frame can beat `start`'s answer back to this side.
    h.progress({ jobId: "job-1", committed: 40, total: 100 });
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    const sending = h.controller.send();
    await sending;
    // It is applied rather than dropped: a progress bar that started at zero
    // after the upload had begun would run backwards on screen.
    expect(h.calls.end).toEqual(["job-1"]);
  });
});

describe("stopping", () => {
  it("cancels a job whose start had not answered yet", async () => {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      async start(payload) {
        await parked;
        return {
          ok: true,
          jobId: "job-late",
          contentKey: CONTENT_KEY,
          expects: { fileIndex: 0, seq: 1, bytes: 4 },
          cipherBytes: 1,
          fileCount: payload.entries.length,
        };
      },
    });
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    const sending = h.controller.send();
    // Pressed while `start` is still in flight — which is when a person is
    // most likely to press it. There is no job id to name yet.
    await h.controller.cancel();
    release();
    await sending;
    // The job main created is cancelled rather than left running for a page
    // that has moved on.
    expect(h.calls.cancel).toEqual(["job-late"]);
    expect(h.calls.end).toEqual([]);
  });

  it("reports a target that never started as cancelled, not as failed", async () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    h.controller.toggle("dev-b");
    // Queued and then cancelled before its turn.
    h.controller.status = {
      "dev-a": { phase: "sending", jobId: "job-1", committed: 0, total: 1, view: null, refusal: null },
      "dev-b": { phase: "queued", jobId: null, committed: 0, total: 0, view: null, refusal: null },
    };
    h.controller.busy = true;
    await h.controller.cancel();
    expect(h.controller.status["dev-b"]?.view).toEqual({ kind: "cancelled", state: null });
  });
});

describe("an outcome nobody can establish", () => {
  it("is never softened, and converging replays rather than resends", async () => {
    const unknown: InboxSendView = { kind: "unknown", reason: "revoked:cancelled" };
    const h = harness({
      async end() {
        return unknown;
      },
    });
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.controller.status["dev-a"]?.view).toEqual(unknown);

    await h.controller.converge("dev-a");
    // The SAME job, replayed. Never a fresh `start`, which would be a second
    // delivery of one thing.
    expect(h.calls.converge).toEqual(["job-1"]);
    expect(h.calls.start).toHaveLength(1);
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
  });

  it("will not converge anything else", async () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    // Delivered. There is nothing to converge, and replaying it would be a
    // fresh attempt wearing a converge's name.
    await h.controller.converge("dev-a");
    expect(h.calls.converge).toEqual([]);
  });
});

describe("when the account moves", () => {
  it("drops the previous account's devices before the picker can offer one", async () => {
    const h = harness();
    await h.controller.refreshTargets();
    h.controller.toggle("dev-a");
    expect(h.controller.selected).toEqual(["dev-a"]);

    h.state(VIEW(1));
    expect(h.calls.targets).toBe(2);
    // A different account. Its devices are not this account's, and a selection
    // that survived would address a delivery to a machine that is not there.
    h.state(VIEW(9));
    expect(h.controller.selected).toEqual([]);
    expect(h.controller.busy).toBe(false);
  });

  it("keeps the picked FILES, which were never sent anywhere", () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.state(VIEW(9));
    // The user's own choice, and losing it means asking them to choose again
    // for a reason that has nothing to do with their files.
    expect(h.controller.files).toHaveLength(1);
  });

  it("ignores a malformed push rather than blanking a known state", () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.state(null);
    h.state({ epoch: "not a number" });
    expect(h.controller.files).toHaveLength(1);
  });
});

describe("outcomes pushed from main", () => {
  it("settles a target whose delivery ended with nobody awaiting it", async () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    const late: InboxSendView = { kind: "refused", reason: "device_cannot_receive", retryable: false, orphanedObject: true };
    h.outcome({ jobId: "job-1", outcome: late });
    expect(h.controller.status["dev-a"]?.view).toEqual(late);
  });

  it("ignores a push for a job it does not know", () => {
    const h = harness();
    h.outcome({ jobId: "somebody-elses-job", outcome: DELIVERED });
    expect(h.controller.status).toEqual({});
  });
});

describe("teardown", () => {
  it("stops listening and invalidates anything in flight", () => {
    const stops: string[] = [];
    const h = harness({
      onProgress() {
        return () => stops.push("progress");
      },
      onOutcome() {
        return () => stops.push("outcome");
      },
    });
    h.controller.dispose();
    expect(stops.sort()).toEqual(["outcome", "progress"]);
  });
});

// ---------------------------------------------------------------------------
// Deliveries nobody can account for
// ---------------------------------------------------------------------------
//
// Independently reproduced against this controller, and both were real. An
// unresolved delivery is the one case where the page holds the ONLY handle to
// something that may have happened, so losing it or overwriting it are the two
// ways the user ends up unable to find out.

describe("an unresolved delivery", () => {
  const unknown: InboxSendView = { kind: "unknown", reason: "upload-unresolved:timeout" };

  async function withUnresolved() {
    const h = harness({ async end() { return unknown; } });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.controller.status["dev-a"]?.view).toEqual(unknown);
    return h;
  }

  it("survives picking new files, because it is the only handle on it", async () => {
    const h = await withUnresolved();
    // Choosing something else is not an answer to "did the last one arrive?".
    h.controller.pick([fileOf("b.bin", 8)]);
    expect(h.controller.status["dev-a"]?.view).toEqual(unknown);
    expect(h.controller.status["dev-a"]?.jobId).toBe("job-1");
    expect(h.controller.unresolved.map((u) => u.deviceID)).toEqual(["dev-a"]);
    // And it is still convergeable — the whole point of keeping it.
    await h.controller.converge("dev-a");
    expect(h.calls.converge).toEqual(["job-1"]);
  });

  it("survives Clear too, and a settled row does not", async () => {
    const h = await withUnresolved();
    h.controller.status = {
      ...h.controller.status,
      "dev-b": { phase: "settled", jobId: "job-9", committed: 0, total: 0, view: DELIVERED, refusal: null },
    };
    h.controller.clear();
    expect(h.controller.status["dev-a"]?.view).toEqual(unknown);
    // A delivered row goes with the selection it described: leaving it beside a
    // new pick would read as this one having arrived.
    expect(h.controller.status["dev-b"]).toBeUndefined();
  });

  it("does not let a second re-check overturn what the first established", async () => {
    let answers = 0;
    const h = harness({
      async end() { return unknown; },
      async converge(payload) {
        answers += 1;
        // The first establishes it; a later one cannot.
        return answers === 1 ? DELIVERED : { kind: "unknown", reason: "still-unresolved" };
      },
    });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();

    await h.controller.converge("dev-a");
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
    // Pressed again. "Could not establish anything" is not news that overturns
    // news: the definite answer stands.
    await h.controller.converge("dev-a");
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
  });

  it("runs ONE re-check at a time per device", async () => {
    let release!: (v: InboxSendView) => void;
    const parked = new Promise<InboxSendView>((resolve) => {
      release = resolve;
    });
    // Counted HERE: this override replaces the base implementation, so the
    // harness's own counter never sees these calls.
    let started = 0;
    const h = harness({
      async end() {
        return unknown;
      },
      converge: () => {
        started += 1;
        return parked;
      },
    });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();

    const first = h.controller.converge("dev-a");
    expect(h.controller.checking("dev-a")).toBe(true);
    // A second press while the first is in flight starts nothing.
    await h.controller.converge("dev-a");
    expect(started).toBe(1);
    release(DELIVERED);
    await first;
    expect(h.controller.checking("dev-a")).toBe(false);
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
  });

  it("ignores a late unknown PUSH over a definite answer", async () => {
    const h = harness();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
    // A push and a returned view are two paths to one row, and only one of them
    // is the later one.
    h.outcome({ jobId: "job-1", outcome: unknown });
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
  });
});

describe("an unresolved delivery, across a SECOND send", () => {
  const unknown: InboxSendView = { kind: "unknown", reason: "upload-unresolved:timeout" };

  it("keeps the first job reachable after sending again to the same device", async () => {
    // The row is per-device and is replaced by the new send; the HISTORY is per
    // job and is not. Keeping them in one place meant the second send silently
    // took the only handle on the first — a delivery that may be live, no way
    // to ask, and nothing on screen saying so.
    let ends = 0;
    const h = harness({
      async end() {
        ends += 1;
        return ends === 1 ? unknown : DELIVERED;
      },
    });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.controller.unresolved.map((u) => u.jobId)).toEqual(["job-1"]);

    // A completely new selection and a new send to the SAME device. The device
    // is still selected — `send` does not clear the selection — so toggling
    // here would DESELECT it and the second send would never happen.
    h.controller.pick([fileOf("b.bin", 8)]);
    expect(h.controller.selected).toEqual(["dev-a"]);
    await h.controller.send();
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
    // The first one is still there, still named, still checkable.
    expect(h.controller.unresolved.map((u) => u.jobId)).toEqual(["job-1"]);

    await h.controller.converge("dev-a");
    // The OLD job, not the one that just succeeded.
    expect(h.calls.converge).toEqual(["job-1"]);
  });

  it("leaves the history only when a check establishes something", async () => {
    const h = harness({ async end() { return unknown; } });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.controller.unresolved).toHaveLength(1);

    // A check that establishes nothing changes nothing: it stays.
    const stuck = harness({ async end() { return unknown; }, async converge() { return unknown; } });
    await stuck.controller.refreshTargets();
    stuck.controller.pick([fileOf("a.bin", 4)]);
    stuck.controller.toggle("dev-a");
    await stuck.controller.send();
    await stuck.controller.convergeJob("job-1");
    expect(stuck.controller.unresolved).toHaveLength(1);

    // One that DOES establish it removes it, and only then.
    await h.controller.convergeJob("job-1");
    expect(h.controller.unresolved).toHaveLength(0);
  });

  it("does not let an old job's answer rewrite a newer send's row", async () => {
    let ends = 0;
    const h = harness({
      async end() {
        ends += 1;
        return ends === 1 ? unknown : DELIVERED;
      },
      async converge() {
        return { kind: "refused", reason: "device_cannot_receive", retryable: false, orphanedObject: false };
      },
    });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    h.controller.pick([fileOf("b.bin", 8)]);
    await h.controller.send();

    await h.controller.convergeJob("job-1");
    // job-1's answer belongs to job-1. The row now names job-2, which was
    // delivered, and an older job's outcome may not overwrite it.
    expect(h.controller.status["dev-a"]?.view).toEqual(DELIVERED);
    expect(h.controller.unresolved).toHaveLength(0);
  });

  it("drops the history when the account changes", async () => {
    const h = harness({ async end() { return unknown; } });
    await h.controller.refreshTargets();
    h.controller.pick([fileOf("a.bin", 4)]);
    h.controller.toggle("dev-a");
    await h.controller.send();
    expect(h.controller.unresolved).toHaveLength(1);
    // Another account's deliveries are not this account's to ask about, and
    // main refuses a converge across an account change anyway.
    h.state(VIEW(9));
    expect(h.controller.unresolved).toHaveLength(0);
  });
});
