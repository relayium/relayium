// What the page shows for a transfer whose events outrun its acknowledgement.
//
// `receive()` returns the job id; the progress and outcome events do not wait
// for it. Both races are real over a process boundary, and both are asserted
// here against the actual rune module the renderer runs.

import { describe, expect, it } from "vitest";
import {
  StoredController,
  type StoredBridge,
  type StoredReport,
} from "../../src/renderer/stored/stored-controller.svelte.js";

const SAVED: StoredReport = {
  status: "saved",
  publishedCount: 1,
  residue: false,
  cleanupTicket: null,
};

/**
 * A bridge whose `receive` is HELD, so a test can push events into the window
 * between admission and acknowledgement — the window the buffers exist for.
 */
function bridge(over: { holdReceive?: boolean } = {}) {
  const progress: Array<(payload: unknown) => void> = [];
  const outcome: Array<(payload: unknown) => void> = [];
  let releaseReceive!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseReceive = resolve;
  });
  let seq = 0;
  const impl: StoredBridge = {
    async receive() {
      seq += 1;
      const jobId = `stored-receive-${String(seq)}`;
      if (over.holdReceive === true) await held;
      return { ok: true, jobId };
    },
    async cancel() {
      return { cancelled: true };
    },
    async result() {
      return { result: null };
    },
    async inventory() {
      return { active: 0, retained: [], retrying: [] };
    },
    async retryCleanup() {
      return { outcome: "clean" };
    },
    onProgress(cb) {
      progress.push(cb);
      return () => undefined;
    },
    onOutcome(cb) {
      outcome.push(cb);
      return () => undefined;
    },
  };
  return {
    bridge: impl,
    releaseReceive,
    pushProgress: (payload: unknown) => {
      for (const cb of progress) cb(payload);
    },
    pushOutcome: (payload: unknown) => {
      for (const cb of outcome) cb(payload);
    },
  };
}

describe("a progress frame that arrives before its acknowledgement", () => {
  it("is applied once the id is known, instead of being dropped", async () => {
    const wired = bridge({ holdReceive: true });
    const stored = new StoredController(wired.bridge);
    stored.link = "https://relayium.com/d/abc#k=Zm9v";

    const opening = stored.open();
    // The transfer is already moving; the page does not yet know its id.
    wired.pushProgress({ jobId: "stored-receive-1", received: 30, total: 100 });
    expect(stored.received).toBe(0);

    wired.releaseReceive();
    await opening;

    // A transfer that reports once — a small object, or a stalled one — used to
    // leave the bar at zero for good.
    expect(stored.received).toBe(30);
    expect(stored.total).toBe(100);
  });

  it("is fenced on the id, so a replaced job cannot move the bar", async () => {
    const wired = bridge({ holdReceive: true });
    const stored = new StoredController(wired.bridge);
    stored.link = "https://relayium.com/d/abc#k=Zm9v";

    const opening = stored.open();
    // A frame belonging to some OTHER job — a previous document's, or one this
    // page never started.
    wired.pushProgress({ jobId: "stored-receive-99", received: 90, total: 100 });
    wired.releaseReceive();
    await opening;

    expect(stored.received).toBe(0);
    expect(stored.total).toBe(0);
  });

  it("is discarded when the job had already finished", async () => {
    const wired = bridge({ holdReceive: true });
    const stored = new StoredController(wired.bridge);
    stored.link = "https://relayium.com/d/abc#k=Zm9v";

    const opening = stored.open();
    wired.pushProgress({ jobId: "stored-receive-1", received: 30, total: 100 });
    wired.pushOutcome({ jobId: "stored-receive-1", outcome: { ok: true, report: SAVED } });
    wired.releaseReceive();
    await opening;

    // The receipt is what the user needs; a bar for a transfer that has ended
    // is not, and showing one would contradict it.
    expect(stored.report).toEqual(SAVED);
    expect(stored.received).toBe(0);
    expect(stored.busy).toBe(false);
  });

  it("holds only the last frame per job, and only a bounded number of jobs", async () => {
    const wired = bridge({ holdReceive: true });
    const stored = new StoredController(wired.bridge);
    stored.link = "https://relayium.com/d/abc#k=Zm9v";

    const opening = stored.open();
    // Superseded, not accumulated.
    wired.pushProgress({ jobId: "stored-receive-1", received: 10, total: 100 });
    wired.pushProgress({ jobId: "stored-receive-1", received: 70, total: 100 });
    // And nine other jobs nobody will ever claim, which must not push the real
    // one out — it is the most recent, and eviction is oldest-first.
    for (let i = 0; i < 9; i += 1) {
      wired.pushProgress({ jobId: `orphan-${String(i)}`, received: 1, total: 100 });
    }
    wired.pushProgress({ jobId: "stored-receive-1", received: 80, total: 100 });
    wired.releaseReceive();
    await opening;

    expect(stored.received).toBe(80);
  });

  it("ignores a malformed frame rather than showing one", async () => {
    const wired = bridge({ holdReceive: true });
    const stored = new StoredController(wired.bridge);
    stored.link = "https://relayium.com/d/abc#k=Zm9v";

    const opening = stored.open();
    wired.pushProgress({ jobId: "stored-receive-1", received: "30", total: 100 });
    wired.pushProgress({ received: 30, total: 100 });
    wired.releaseReceive();
    await opening;

    expect(stored.received).toBe(0);
  });
});
