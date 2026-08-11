import { describe, it, expect } from "vitest";
import {
  CAP_PREUPLOAD,
  HANDOFF_VERSION,
  InvalidHandoffError,
  KIND_STORED_KEYS,
  MAX_HANDOFF_ITEMS,
  decodeHandoff,
  encodeHandoff,
  mergeHandoff,
} from "./preupload-handoff";
import { advertisedCaps } from "./peer-caps.svelte";
import { encodeKey } from "./store-crypto";

const key = (fill = 7) => encodeKey(new Uint8Array(32).fill(fill));
const item = (id: string, fill = 7) => ({ id, key: key(fill) });

describe("key-handoff codec", () => {
  it("round-trips a batch", () => {
    const items = [item("a1b2", 1), item("c3d4", 2)];
    expect(decodeHandoff(encodeHandoff(items))).toEqual(items);
  });

  it("emits the versioned shape the protocol fixes, in the fixed key order", () => {
    // Byte-for-byte, because the Swift port freezes fixtures against this and a
    // reordered key would silently invalidate them.
    expect(encodeHandoff([item("zz", 3)])).toBe(
      `{"v":${HANDOFF_VERSION},"items":[{"id":"zz","key":"${key(3)}"}]}`,
    );
  });

  it("refuses an unknown version outright rather than parsing what it recognises", () => {
    const future = JSON.stringify({ v: 2, items: [item("a", 1)] });
    expect(() => decodeHandoff(future)).toThrow(InvalidHandoffError);
  });

  it("refuses ids that would not be inert in a URL path", () => {
    for (const id of ["../me", "a/b", "a#b", "", "a b", "a".repeat(129)]) {
      expect(() => decodeHandoff(JSON.stringify({ v: 1, items: [{ id, key: key() }] })), id).toThrow(
        InvalidHandoffError,
      );
    }
  });

  it("refuses keys that are not exactly 32 base64url bytes", () => {
    const bad = [
      encodeKey(new Uint8Array(31)), // truncated
      encodeKey(new Uint8Array(33)), // overlong
      "not+base64url/", // standard alphabet
      "A", // a length base64 cannot produce
      "",
    ];
    for (const k of bad) {
      expect(() => decodeHandoff(JSON.stringify({ v: 1, items: [{ id: "ok", key: k }] })), k).toThrow(
        InvalidHandoffError,
      );
    }
  });

  it("refuses junk, wrong shapes and an empty or oversized set", () => {
    for (const payload of [
      "not json",
      "[]",
      "null",
      '"a string"',
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, items: [] }),
      JSON.stringify({ v: 1, items: "nope" }),
      JSON.stringify({ v: 1, items: [null] }),
      JSON.stringify({ v: 1, items: [{ id: "a" }] }),
      JSON.stringify({ v: 1, items: [{ key: key() }] }),
      JSON.stringify({ v: 1, items: [{ id: 5, key: key() }] }),
      JSON.stringify({ v: 1, items: Array.from({ length: MAX_HANDOFF_ITEMS + 1 }, (_, i) => item(`id${i}`)) }),
    ]) {
      expect(() => decodeHandoff(payload), payload.slice(0, 40)).toThrow(InvalidHandoffError);
    }
  });

  it("refuses a duplicate id inside one message — that is malformed, not a retry", () => {
    expect(() => encodeHandoff([item("same", 1), item("same", 2)])).toThrow(InvalidHandoffError);
    expect(() =>
      decodeHandoff(JSON.stringify({ v: 1, items: [item("same", 1), item("same", 2)] })),
    ).toThrow(InvalidHandoffError);
  });

  it("never puts the offending value — an id or a real key — into the message", () => {
    const secret = key(9);
    try {
      decodeHandoff(JSON.stringify({ v: 1, items: [{ id: "../secret-path", key: secret }] }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-path");
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe("handoff retry and idempotency", () => {
  // The sender re-sends the WHOLE set on every (re)established link, which is
  // what makes a dropped link cost a re-send instead of a stranded transfer.
  // These are the rules that make blind resending safe.
  it("treats a re-delivered id as a no-op", () => {
    const first = [item("a", 1)];
    expect(mergeHandoff(first, first)).toEqual(first);
    expect(mergeHandoff(first, [...first, item("b", 2)])).toEqual([item("a", 1), item("b", 2)]);
  });

  it("keeps the key it is already downloading with when an id is re-sent with a different one", () => {
    const held = [item("a", 1)];
    expect(mergeHandoff(held, [item("a", 2)])).toEqual(held);
  });

  it("appends genuinely new items in arrival order", () => {
    const merged = mergeHandoff([item("a", 1)], [item("c", 3), item("b", 2)]);
    expect(merged.map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate what it was given", () => {
    const held = [item("a", 1)];
    mergeHandoff(held, [item("b", 2)]);
    expect(held).toHaveLength(1);
  });
});

describe("capability gate", () => {
  it("is an exact, versioned capability on its own frame kind", () => {
    expect(CAP_PREUPLOAD).toBe("preupload/1");
    expect(KIND_STORED_KEYS).toBe(10);
  });

  it("is NOT advertised yet, because this build cannot act on it", () => {
    // The sender and receiver halves land in the next checkpoint. Announcing a
    // capability before the code behind it exists invites a peer to send us a
    // kind-10 frame we would treat as an unknown kind — a hard error that fails
    // the whole transfer. Flipping this on is the first step of that work, and
    // this assertion is what makes forgetting it impossible.
    expect(advertisedCaps()).not.toContain(CAP_PREUPLOAD);
  });
});
