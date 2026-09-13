import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  abandonedCount, drainAbandoned, spawnHelperTransport,
} from "../../src/main/secret/helper-transport.js";
import {
  FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, MAX_PLAINTEXT_BYTES, OP_OPEN, OP_SEAL, RESPONSE_MAGIC,
} from "../../src/main/secret/protocol.js";

/**
 * Driven against controllable children.
 *
 * A real fixture cannot express the cases that matter — a process that survives
 * a kill, one that errors without closing, one that streams forever — so the
 * spawn seam supplies them. None of this asserts on the module's source text:
 * a string match proves the code was written a way, not that it behaves one.
 */
type FakeChild = EventEmitter & {
  stdout: PassThrough; stderr: PassThrough; stdin: PassThrough;
  kill: () => boolean; kills: number; pid: number | undefined;
};

/**
 * Ownership is module-level by design: it must outlive an invocation to be
 * retried. Tests therefore close the children they created, exactly as a real
 * process eventually does — they do NOT ask the module to forget live ones.
 */
const created: FakeChild[] = [];

afterEach(async () => {
  for (const child of created.splice(0)) child.emit("close", null, "SIGKILL");
  await tick(20);
  expect(abandonedCount()).toBe(0);
});

const fakeChild = (over: Partial<{ killReturns: boolean; killThrows: boolean }> = {}): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.kills = 0;
  child.kill = () => {
    child.kills += 1;
    if (over.killThrows) throw new Error("access denied");
    return over.killReturns ?? true;
  };
  created.push(child);
  return child;
};

const make = (child: FakeChild, timeoutMs = 120, cleanupMs = 150) => {
  const reasons: string[] = [];
  return {
    reasons,
    transport: spawnHelperTransport({
      executable: "irrelevant",
      timeoutMs,
      cleanupMs,
      reportFailure: (r) => reasons.push(r),
      spawnChild: () => child as never,
    }),
  };
};

const settle = <T,>(p: Promise<T>) => {
  const state = { done: false, value: undefined as T | undefined };
  void p.then((v) => { state.done = true; state.value = v; });
  return state;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const okFrame = (payload: Buffer) => {
  const h = Buffer.alloc(FRAME_HEADER_BYTES);
  RESPONSE_MAGIC.copy(h, 0);
  h.writeUInt8(1, 4); h.writeUInt8(0, 5); h.writeUInt32BE(payload.byteLength, 6);
  return Buffer.concat([h, payload]);
};

describe("bounded termination when a kill does not take", () => {
  it("abandons ownership after the cleanup window instead of waiting forever", async () => {
    // `get` runs on the sign-in path. An unbounded wait here is an app that
    // never finishes signing in.
    const child = fakeChild({ killReturns: false });
    const { transport, reasons } = make(child);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    const state = settle(pending);

    await tick(200);
    expect(reasons).toContain("timeout");
    expect(reasons).toContain("kill-not-delivered");
    expect(child.kills).toBeGreaterThan(0);
    // Still pending: a killed process is not a closed one.
    expect(state.done).toBe(false);

    await tick(250);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(reasons.some((r) => r.startsWith("abandoned-pid:"))).toBe(true);
    // Ownership retained, not a fabricated close.
    expect(abandonedCount()).toBe(1);
  }, 20000);

  it("retries cleanup of an abandoned child on the next invocation", async () => {
    const stubborn = fakeChild({ killReturns: false });
    const first = make(stubborn);
    await first.transport.invoke(OP_SEAL, Buffer.from("secret")).catch(() => undefined);
    await tick(350);
    const killsAfterFirst = stubborn.kills;

    const next = fakeChild();
    const second = make(next);
    const pending = second.transport.invoke(OP_SEAL, Buffer.from("x"));
    next.stdout.write(okFrame(Buffer.from("blob")));
    next.emit("close", 0, null);
    await pending;

    expect(stubborn.kills).toBeGreaterThan(killsAfterFirst);
    expect(second.reasons.some((r) => r.startsWith("retry-cleanup:"))).toBe(true);
  }, 20000);

  it("stops retrying once the abandoned child finally closes", async () => {
    const child = fakeChild({ killReturns: false });
    const { transport } = make(child);
    await transport.invoke(OP_SEAL, Buffer.from("secret"));
    await tick(250);
    const held = abandonedCount();
    child.emit("close", null, "SIGKILL");
    await tick(20);

    const next = fakeChild();
    const second = make(next);
    const pending = second.transport.invoke(OP_SEAL, Buffer.from("x"));
    next.stdout.write(okFrame(Buffer.from("b")));
    next.emit("close", 0, null);
    await pending;
    expect(abandonedCount()).toBeLessThan(held);
  }, 20000);
});

describe("an error is not a close", () => {
  it("stays pending until close, then reports helper-unavailable", async () => {
    const child = fakeChild();
    const { transport, reasons } = make(child, 10000, 5000);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    const state = settle(pending);

    child.emit("error", new Error("boom"));
    await tick(120);
    expect(reasons).toContain("spawn-error");
    expect(state.done).toBe(false);

    child.emit("close", 4, null);
    const result = await pending;
    expect(!result.ok && result.failure).toBe("helper-unavailable");
  }, 20000);
});

describe("output overflow fails immediately", () => {
  it("kills at once rather than streaming until the deadline", async () => {
    const child = fakeChild();
    // A long timeout: if overflow waited for it, this test would time out.
    const { transport, reasons } = make(child, 10000, 100);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    child.stdout.write(Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + FRAME_HEADER_BYTES + 1, 7));
    await tick(60);
    expect(reasons).toContain("stdout-over-bound");
    expect(child.kills).toBeGreaterThan(0);
    child.emit("close", null, "SIGTERM");
    expect((await pending).ok).toBe(false);
  }, 20000);

  it("reports a stderr overflow instead of ignoring it", async () => {
    const child = fakeChild();
    const { transport, reasons } = make(child, 10000, 100);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    child.stderr.write(Buffer.alloc(8192, 3));
    await tick(40);
    child.stdout.write(okFrame(Buffer.from("blob")));
    child.emit("close", 0, null);
    await pending;
    expect(reasons).toContain("stderr-over-bound");
  }, 20000);
});

describe("stream errors are recorded and do not resolve", () => {
  it("keeps waiting for close after a stdout stream error", async () => {
    const child = fakeChild();
    const { transport, reasons } = make(child, 10000, 5000);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    const state = settle(pending);
    child.stdout.emit("error", new Error("pipe"));
    await tick(80);
    expect(reasons).toContain("stdout-stream-error");
    expect(state.done).toBe(false);
    child.emit("close", 0, null);
    expect((await pending).ok).toBe(false);
  }, 20000);
});

describe("requests are validated before anything is spawned", () => {
  it("refuses an unknown op without a child", async () => {
    let spawned = 0;
    const transport = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 1000, reportFailure: () => undefined,
      spawnChild: () => { spawned += 1; return fakeChild() as never; },
    });
    const result = await transport.invoke(99, Buffer.from("x"));
    expect(!result.ok && result.failure).toBe("helper-unavailable");
    expect(spawned).toBe(0);
  });

  it("refuses an over-bound payload without putting it on a pipe", async () => {
    let spawned = 0;
    const transport = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 1000, reportFailure: () => undefined,
      spawnChild: () => { spawned += 1; return fakeChild() as never; },
    });
    const result = await transport.invoke(OP_SEAL, Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 1));
    expect(!result.ok && result.failure).toBe("helper-unavailable");
    expect(spawned).toBe(0);
  });
});

describe("the happy path still works", () => {
  it("returns a copy that survives the sink being wiped", async () => {
    const child = fakeChild();
    const { transport } = make(child, 10000, 1000);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    child.stdout.write(okFrame(Buffer.from("protected-blob")));
    child.emit("close", 0, null);
    const result = await pending;
    expect(result.ok).toBe(true);
    // Copied before the source was wiped; a view would now read as zeroes.
    expect(result.ok && result.payload.toString()).toBe("protected-blob");
  }, 20000);
});

// ---------------------------------------------------------------------------
// The three properties the reviewer's compiled probe found RED. Asserted on
// actual observed state — `abandonedCount()` and spawn counts — not on how the
// module is written.
// ---------------------------------------------------------------------------

describe("one child yields at most one owned entry", () => {
  it("does not accumulate entries across repeated overflow chunks", async () => {
    // Three chunks, because two did not reproduce it: each chunk after the
    // first used to schedule another cleanup timer and add another entry for
    // the SAME child.
    const child = fakeChild({ killReturns: false });
    const { transport } = make(child, 10000, 80);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    const overflow = Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + FRAME_HEADER_BYTES + 1, 7);
    child.stdout.write(overflow);
    child.stdout.write(Buffer.alloc(4096, 8));
    child.stdout.write(Buffer.alloc(4096, 9));
    await tick(250);
    await pending;
    expect(abandonedCount()).toBe(1);
    // And only one kill sequence was started for the one child.
    expect(child.kills).toBeGreaterThan(0);
    child.emit("close", null, "SIGKILL");
    await tick(20);
    expect(abandonedCount()).toBe(0);
  }, 20000);
});

describe("no second helper while the first is unkilled", () => {
  it("refuses to spawn until the previous child closes", async () => {
    const stubborn = fakeChild({ killReturns: false });
    const first = make(stubborn, 80, 80);
    await first.transport.invoke(OP_SEAL, Buffer.from("secret"));
    await tick(250);

    let spawned = 0;
    const reasons: string[] = [];
    const transport = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 500, cleanupMs: 80,
      reportFailure: (r) => reasons.push(r),
      spawnChild: () => { spawned += 1; return fakeChild() as never; },
    });
    const result = await transport.invoke(OP_SEAL, Buffer.from("again"));
    expect(result.ok).toBe(false);
    expect(spawned).toBe(0);
    expect(reasons).toContain("abandoned-child-still-live");

    // Once it really closes, spawning resumes.
    stubborn.emit("close", null, "SIGKILL");
    await tick(20);
    const next = fakeChild();
    const third = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 5000, cleanupMs: 500,
      reportFailure: () => undefined,
      spawnChild: () => { spawned += 1; return next as never; },
    });
    const ok = third.invoke(OP_SEAL, Buffer.from("x"));
    next.stdout.write(okFrame(Buffer.from("blob")));
    next.emit("close", 0, null);
    expect((await ok).ok).toBe(true);
    expect(spawned).toBe(1);
  }, 20000);
});

describe("a late close releases ownership immediately", () => {
  it("drops to zero once every abandoned child has closed", async () => {
    const child = fakeChild({ killReturns: false });
    const { transport } = make(child, 80, 80);
    await transport.invoke(OP_SEAL, Buffer.from("secret"));
    await tick(220);
    expect(abandonedCount()).toBe(1);
    child.emit("close", null, "SIGKILL");
    await tick(20);
    // Without waiting for another invocation to sweep.
    expect(abandonedCount()).toBe(0);
  }, 20000);
});

describe("per-op bounds", () => {
  it("refuses a seal payload above the PLAINTEXT ceiling", async () => {
    let spawned = 0;
    const transport = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 1000, reportFailure: () => undefined,
      spawnChild: () => { spawned += 1; return fakeChild() as never; },
    });
    // Between the two ceilings: valid for an open, never for a seal.
    const result = await transport.invoke(OP_SEAL, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(spawned).toBe(0);
  });

  it("refuses an oversized seal RESPONSE", async () => {
    const child = fakeChild();
    const { transport, reasons } = make(child, 10000, 200);
    const pending = transport.invoke(OP_OPEN, Buffer.from("blob"));
    // An open returns plaintext, so the plaintext ceiling applies.
    child.stdout.write(okFrame(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 1)));
    child.emit("close", 0, null);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(reasons).toContain("response-over-bound");
  }, 20000);
});

describe("stderr overflow is a failure, not a note", () => {
  it("terminates instead of returning ok", async () => {
    const child = fakeChild();
    const { transport, reasons } = make(child, 10000, 80);
    const pending = transport.invoke(OP_SEAL, Buffer.from("secret"));
    child.stderr.write(Buffer.alloc(8192, 3));
    await tick(60);
    expect(reasons).toContain("stderr-over-bound");
    child.stdout.write(okFrame(Buffer.from("blob")));
    child.emit("close", 0, null);
    // A helper that broke the bound does not get to succeed.
    expect((await pending).ok).toBe(false);
  }, 20000);
});

describe("drain retries and joins; it never forgets a live child", () => {
  it("keeps ownership through a drain that cannot kill, and releases only on close", async () => {
    const child = fakeChild({ killReturns: false });
    const { transport } = make(child, 80, 80);
    await transport.invoke(OP_SEAL, Buffer.from("secret"));
    await tick(250);
    expect(abandonedCount()).toBe(1);

    const killsBefore = child.kills;
    // The drain tries again and joins — and still reports it owned, because the
    // child never closed. Releasing here would re-open the spawn gate against a
    // live process and leave a failed quit-cleanup with nothing to retry.
    const remaining = await drainAbandoned(200);
    expect(remaining).toBe(1);
    expect(abandonedCount()).toBe(1);
    expect(child.kills).toBeGreaterThan(killsBefore);

    // And a fresh invocation is still refused.
    let spawned = 0;
    const blocked = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 500, cleanupMs: 80,
      reportFailure: () => undefined,
      spawnChild: () => { spawned += 1; return fakeChild() as never; },
    });
    expect((await blocked.invoke(OP_SEAL, Buffer.from("x"))).ok).toBe(false);
    expect(spawned).toBe(0);

    // Only an OBSERVED close releases it.
    child.emit("close", null, "SIGKILL");
    await tick(20);
    expect(abandonedCount()).toBe(0);
    expect(await drainAbandoned(100)).toBe(0);

    const next = fakeChild();
    const allowed = spawnHelperTransport({
      executable: "irrelevant", timeoutMs: 5000, cleanupMs: 500,
      reportFailure: () => undefined,
      spawnChild: () => next as never,
    });
    const pending = allowed.invoke(OP_SEAL, Buffer.from("x"));
    next.stdout.write(okFrame(Buffer.from("blob")));
    next.emit("close", 0, null);
    expect((await pending).ok).toBe(true);
  }, 25000);
});
