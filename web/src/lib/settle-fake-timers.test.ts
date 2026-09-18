import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { settleWithFakeTimers } from "./settle-fake-timers";

/** Real timer, captured before any test below installs fake ones. */
const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe("settleWithFakeTimers", () => {
  // The hosted failure, reduced: real async work finishes LATE, and only then is
  // a fake timer installed. A count-driven pump has spent its advances by then
  // and hangs; this must not, however long the real part takes.
  it("still advances a fake timer that is installed after slow real async work", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = (async () => {
      await realDelay(120); // far longer than any fixed number of 0 ms pump turns
      order.push("real work done");
      await new Promise((r) => setTimeout(r, 60_000)); // fake: the reconnect backoff
      order.push("backoff elapsed");
      return "done";
    })();
    expect(await settleWithFakeTimers(run)).toBe("done");
    expect(order).toEqual(["real work done", "backoff elapsed"]);
  });

  it("walks a chain of fake timers interleaved with real work", async () => {
    vi.useFakeTimers();
    const run = (async () => {
      for (let i = 0; i < 5; i++) {
        await realDelay(5);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
      return Date.now();
    })();
    const started = Date.now();
    const finished = await settleWithFakeTimers(run);
    // 1+2+4+8+16 s of FAKE time, and not a large overshoot: the clock moves to
    // the next timer, it is not flung forward.
    expect((finished as number) - started).toBe(31_000);
  });

  it("returns a rejection as a value instead of throwing", async () => {
    vi.useFakeTimers();
    const boom = new Error("boom");
    const run = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw boom;
    })();
    expect(await settleWithFakeTimers(run)).toBe(boom);
  });

  // The first fix for this race was made inside one test file; its twin kept a
  // private count-driven copy and failed hosted CI two days later. A promise-
  // settling pump is therefore defined once, here.
  it("is the only promise-settling fake-timer pump in the suite", () => {
    const dir = import.meta.dirname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts") && f !== "settle-fake-timers.test.ts")
      .filter((f) => /function settle\s*<T>\s*\(\s*p\s*:\s*Promise<T>/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders, "use settleWithFakeTimers from ./settle-fake-timers").toEqual([]);
  });
});
