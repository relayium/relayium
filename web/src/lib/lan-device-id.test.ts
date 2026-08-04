import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LAN_SEED_KEY, LAN_EPOCH_MS, deriveLanDeviceId, lanEpoch, lanDeviceId, resetLanDeviceIdCache,
} from "./lan-device-id";

const SEED = "a".repeat(64);
const OTHER_SEED = "b".repeat(64);

beforeEach(() => {
  localStorage.clear();
  resetLanDeviceIdCache();
});

describe("deriveLanDeviceId", () => {
  it("produces the exact opaque shape the server accepts", async () => {
    const id = await deriveLanDeviceId(SEED, 20_000);
    // 32 lower-case hex characters — signal.ValidDeviceID rejects anything else,
    // and a rejected id silently drops this device back to legacy behaviour.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never transmits the seed or anything reversible to it", async () => {
    const id = await deriveLanDeviceId(SEED, 20_000);
    expect(id).not.toContain(SEED);
    expect(SEED).not.toContain(id);
    // A different seed at the same epoch shares nothing.
    expect(await deriveLanDeviceId(OTHER_SEED, 20_000)).not.toBe(id);
  });

  it("is stable inside one epoch and rotates across epochs", async () => {
    const a = await deriveLanDeviceId(SEED, 20_000);
    expect(await deriveLanDeviceId(SEED, 20_000)).toBe(a);
    expect(await deriveLanDeviceId(SEED, 20_001)).not.toBe(a);
  });
});

describe("lanEpoch", () => {
  it("advances once per 24h so the advertised value is bounded in time", () => {
    expect(lanEpoch(0)).toBe(0);
    expect(lanEpoch(LAN_EPOCH_MS - 1)).toBe(0);
    expect(lanEpoch(LAN_EPOCH_MS)).toBe(1);
    expect(LAN_EPOCH_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("lanDeviceId", () => {
  it("gives every tab of this browser the same id, from a seed that stays local", async () => {
    const first = await lanDeviceId(() => 1_000);
    // A second tab is a fresh module instance reading the same origin storage.
    resetLanDeviceIdCache();
    const second = await lanDeviceId(() => 1_000);
    expect(second).toBe(first);

    const seed = localStorage.getItem(LAN_SEED_KEY);
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(seed as string);
  });

  it("gives a different browser profile a different id", async () => {
    const mine = await lanDeviceId(() => 1_000);
    localStorage.setItem(LAN_SEED_KEY, OTHER_SEED); // another profile's seed
    resetLanDeviceIdCache();
    expect(await lanDeviceId(() => 1_000)).not.toBe(mine);
  });

  it("caches within the epoch and re-derives after it rolls over", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const first = await lanDeviceId(() => 1_000);
    await lanDeviceId(() => 2_000);
    expect(digest).toHaveBeenCalledTimes(1); // same epoch — no re-derivation
    const later = await lanDeviceId(() => 1_000 + LAN_EPOCH_MS);
    expect(later).not.toBe(first);
    digest.mockRestore();
  });

  it("replaces a seed that is not the shape we wrote", async () => {
    localStorage.setItem(LAN_SEED_KEY, "not-a-seed");
    const id = await lanDeviceId(() => 1_000);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(localStorage.getItem(LAN_SEED_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to no identity when storage is unavailable", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    // Nothing can be shared between tabs without storage, so claiming an
    // identity would be a lie: an empty id means "join like an older client".
    expect(await lanDeviceId(() => 1_000)).toBe("");
    get.mockRestore();
  });

  it("does not claim a shared identity when storage silently drops writes", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    expect(await lanDeviceId(() => 1_000)).toBe("");
    set.mockRestore();
  });
});
