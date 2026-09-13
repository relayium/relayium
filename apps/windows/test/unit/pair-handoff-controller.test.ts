// The handoff controller: whether a QR, a link and a "Copied" all still
// describe the code on screen.

import { describe, expect, it, vi } from "vitest";
import { PairHandoffController } from "../../src/renderer/pair/pair-handoff-controller.svelte.js";
import type { PairHandoffBridge } from "../../src/renderer/pair/bridge.js";
import {
  PAIR_HANDOFF_IDLE,
  type PairCopyOutcome,
  type PairHandoffView,
} from "../../src/shared/pair-handoff.js";

const ORIGIN = "https://relayium.test";
const live = (code: string, generation: number, expiresAt = 9_999): PairHandoffView => ({
  kind: "live",
  code,
  expiresAt,
  link: `${ORIGIN}/cross-network#c=${code}`,
  generation,
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness() {
  const calls = { state: 0, copy: [] as string[] };
  const answers = {
    state: PAIR_HANDOFF_IDLE as PairHandoffView,
    copy: { kind: "copied", generation: 1 } as PairCopyOutcome,
  };
  const rejects = { copy: false };
  const listeners = new Set<(p: unknown) => void>();
  const bridge: PairHandoffBridge = {
    async state() {
      calls.state += 1;
      return answers.state;
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
  return {
    controller: new PairHandoffController(bridge),
    calls,
    answers,
    rejects,
    push: (v: unknown) => {
      for (const l of [...listeners]) l(v);
    },
    subscriptions: () => listeners.size,
  };
}

/** Let the dynamic QR import and its promise chain settle. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 5));
};

describe("the QR belongs to one link", () => {
  it("renders a real data URL for a live code", async () => {
    const h = harness();
    h.push(live("483920", 1));
    await settle();
    expect(h.controller.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(h.controller.qrPending).toBe(false);
  });

  it("drops the previous QR the moment the generation moves", async () => {
    const h = harness();
    h.push(live("483920", 1));
    await settle();
    const first = h.controller.qrDataUrl;
    expect(first).not.toBeNull();
    h.push(live("111111", 2));
    // Dropped synchronously on the push, not when the next encode finishes: a
    // QR for the previous code must never be on screen beside the new one.
    expect(h.controller.qrDataUrl).toBeNull();
    await settle();
    expect(h.controller.qrDataUrl).not.toBeNull();
    expect(h.controller.qrDataUrl).not.toBe(first);
  });

  it("discards an encode that finishes after the code changed", async () => {
    const h = harness();
    h.push(live("483920", 1));
    // Supersede before the first encode can resolve.
    h.push(live("111111", 2));
    await settle();
    const view = h.controller.view;
    if (view.kind !== "live") throw new Error("expected live");
    expect(view.code).toBe("111111");
    // Whatever landed must be the current one's, never the abandoned encode's.
    expect(h.controller.qrDataUrl).not.toBeNull();
  });

  it("clears the QR when the code goes away", async () => {
    const h = harness();
    h.push(live("483920", 1));
    await settle();
    h.push({ kind: "idle", generation: 2 });
    expect(h.controller.qrDataUrl).toBeNull();
    expect(h.controller.view.kind).toBe("idle");
  });
});

describe("copying", () => {
  it("sends only the closed token", async () => {
    const h = harness();
    h.push(live("483920", 1));
    h.answers.copy = { kind: "copied", generation: 1 };
    await h.controller.copy();
    expect(h.calls.copy).toEqual(["copy-join-link"]);
    expect(h.controller.copied).toBe(true);
  });

  it("refuses to copy when there is no live code", async () => {
    const h = harness();
    h.push({ kind: "idle", generation: 1 });
    await h.controller.copy();
    expect(h.calls.copy).toEqual([]);
  });

  it("drops the confirmation when the code changes underneath it", async () => {
    const h = harness();
    h.push(live("483920", 1));
    h.answers.copy = { kind: "copied", generation: 1 };
    await h.controller.copy();
    expect(h.controller.copied).toBe(true);
    h.push(live("111111", 2));
    // The mac's `onChange(of: url) { copied = false }`, one layer down: a
    // confirmation belongs to one link, never to the component slot.
    expect(h.controller.copied).toBe(false);
    expect(h.controller.copyNotice).toBeNull();
  });

  it("ignores an outcome whose generation disagrees with main's", async () => {
    const h = harness();
    h.push(live("483920", 2));
    // Main copied a link this pane is no longer showing.
    h.answers.copy = { kind: "copied", generation: 1 };
    await h.controller.copy();
    expect(h.controller.copied).toBe(false);
  });

  it("reports expiry as its own sentence", async () => {
    const h = harness();
    h.push(live("483920", 1));
    h.answers.copy = { kind: "expired" };
    await h.controller.copy();
    expect(h.controller.copyNotice).toEqual({ kind: "expired" });
    expect(h.controller.copied).toBe(false);
  });

  it("reports a broken channel as a failure, not as a copy", async () => {
    const h = harness();
    h.push(live("483920", 1));
    h.rejects.copy = true;
    await h.controller.copy();
    expect(h.controller.copyNotice).toEqual({ kind: "failed" });
    expect(h.controller.copied).toBe(false);
  });

  it("is single-flight", async () => {
    const h = harness();
    h.push(live("483920", 1));
    const hold = deferred<PairCopyOutcome>();
    (h.controller as unknown as { bridge: PairHandoffBridge }).bridge.copy = () => hold.promise;
    const first = h.controller.copy();
    await h.controller.copy();
    hold.resolve({ kind: "copied", generation: 1 });
    await first;
    expect(h.controller.copying).toBe(false);
  });

  it("writes nothing when the code changed while the copy was in flight", async () => {
    const h = harness();
    h.push(live("483920", 1));
    const hold = deferred<PairCopyOutcome>();
    (h.controller as unknown as { bridge: PairHandoffBridge }).bridge.copy = () => hold.promise;
    const running = h.controller.copy();
    h.push(live("111111", 2));
    hold.resolve({ kind: "copied", generation: 1 });
    await running;
    expect(h.controller.copyNotice).toBeNull();
    expect(h.controller.copying).toBe(false);
  });
});

describe("lifecycle", () => {
  it("ignores a malformed push", () => {
    const h = harness();
    h.push(live("483920", 1));
    const before = h.controller.view;
    h.push(null);
    h.push({ kind: "live" });
    h.push({ generation: 5 });
    expect(h.controller.view).toBe(before);
  });

  it("a stale initial read does not overwrite a newer push", async () => {
    const h = harness();
    h.answers.state = live("483920", 1);
    const loading = h.controller.load();
    h.push(live("111111", 2));
    await loading;
    const view = h.controller.view;
    if (view.kind !== "live") throw new Error("expected live");
    expect(view.code).toBe("111111");
  });

  it("destroy releases the subscription and clears everything it owns", async () => {
    const h = harness();
    h.push(live("483920", 1));
    await settle();
    expect(h.subscriptions()).toBe(1);
    h.controller.destroy();
    expect(h.subscriptions()).toBe(0);
    expect(h.controller.qrDataUrl).toBeNull();
    expect(h.controller.copyNotice).toBeNull();
    await h.controller.copy();
    expect(h.calls.copy).toEqual([]);
  });
});
