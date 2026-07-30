import { describe, it, expect } from "vitest";
import { createRateBucket } from "./rate-bucket";

describe("rate bucket", () => {
  it("allows a full burst then refuses", () => {
    let t = 0;
    const b = createRateBucket(3, 1, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, true]);
    expect(b.take()).toBe(false);
  });

  it("refills at the configured rate", () => {
    let t = 0;
    const b = createRateBucket(2, 5, () => t);
    b.take(); b.take();
    expect(b.take()).toBe(false);
    t = 200; // 0.2 s at 5/s = exactly one token
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it("does not grant a partial token", () => {
    let t = 0;
    const b = createRateBucket(1, 5, () => t);
    expect(b.take()).toBe(true);
    t = 100; // 0.1 s at 5/s = half a token
    expect(b.take()).toBe(false);
    t = 200;
    expect(b.take()).toBe(true);
  });

  it("never refills above the burst", () => {
    let t = 0;
    const b = createRateBucket(2, 5, () => t);
    t = 10_000; // long enough for 50 tokens
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
  });

  it("does not mint tokens when the clock goes backwards", () => {
    let t = 1000;
    const b = createRateBucket(1, 1, () => t);
    expect(b.take()).toBe(true);
    t = 0;
    expect(b.take()).toBe(false);
  });

  it("holds its whole burst before the first take, however late it comes", () => {
    let t = 0;
    const b = createRateBucket(3, 1, () => t);
    t = 60_000;
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
});
