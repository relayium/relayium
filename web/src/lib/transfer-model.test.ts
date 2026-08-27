import { describe, expect, it } from "vitest";
import { wouldExceedDeclared } from "./transfer-model";
import type { Incoming, Xfer } from "./transfer-model";

// `wouldExceedDeclared` is the receive pipeline's bounds check on peer-supplied
// bytes, and it lives here rather than in the pipeline because the call site is
// deep inside a channel closure that a test cannot construct. That extraction is
// the whole reason it is testable at all — so the boundary has to be pinned
// here, exactly, or the extraction bought nothing.
//
// It answers one question: does writing `chunkLen` bytes at `offset` run past
// what the manifest DECLARED for this file? Everything about it is chosen for
// the adversarial case, because the inputs are a remote peer's.
describe("wouldExceedDeclared", () => {
  it("admits a write that ends exactly on the declared size", () => {
    // The off-by-one that matters most: the final chunk of a correct transfer
    // lands on the boundary, and refusing it would fail every complete file.
    expect(wouldExceedDeclared(10, 0, 10)).toBe(false);
    expect(wouldExceedDeclared(10, 9, 1)).toBe(false);
    expect(wouldExceedDeclared(10, 4, 6)).toBe(false);
  });

  it("refuses a write that ends one byte past it", () => {
    expect(wouldExceedDeclared(10, 0, 11)).toBe(true);
    expect(wouldExceedDeclared(10, 10, 1)).toBe(true);
    expect(wouldExceedDeclared(10, 5, 6)).toBe(true);
  });

  it("admits a zero-length write only while the offset is still inside", () => {
    // A zero-length chunk at the end is not an overrun: it writes nothing. A
    // zero-length chunk PAST the end is, because the offset itself is already a
    // position this file does not have.
    expect(wouldExceedDeclared(10, 10, 0)).toBe(false);
    expect(wouldExceedDeclared(10, 11, 0)).toBe(true);
    expect(wouldExceedDeclared(0, 0, 0)).toBe(false);
  });

  it("treats a zero-byte declared file as accepting nothing", () => {
    expect(wouldExceedDeclared(0, 0, 1)).toBe(true);
  });

  /**
   * The case the doc comment calls out: the sender sent a chunk for an index the
   * manifest never named. `undefined` is not "unknown, allow it" — it is a file
   * with no declared size, and every byte is therefore out of bounds.
   *
   * This is the branch an attacker reaches by sending one more file than it
   * declared, so the fail-safe direction is the assertion, not an implementation
   * detail. `?? 0` and a truthiness check are NOT the same function here: a
   * declared size of 0 is a real, legal manifest entry, and it must behave like
   * a zero-byte file rather than like an undeclared one.
   */
  it("refuses every non-empty write to an index the manifest never declared", () => {
    expect(wouldExceedDeclared(undefined, 0, 1)).toBe(true);
    expect(wouldExceedDeclared(undefined, 0, 1024)).toBe(true);
    // …and admits exactly the write that moves nothing, at exactly offset 0,
    // which is what makes this "declared as zero bytes" rather than "blocked".
    expect(wouldExceedDeclared(undefined, 0, 0)).toBe(false);
    expect(wouldExceedDeclared(undefined, 1, 0)).toBe(true);
  });

  it("is not fooled by a large offset with an empty chunk, or the reverse", () => {
    expect(wouldExceedDeclared(10, Number.MAX_SAFE_INTEGER, 0)).toBe(true);
    expect(wouldExceedDeclared(10, 0, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  // A negative offset would move the write BEFORE the start of the file, which
  // arithmetic alone reads as "plenty of room". Pinned as the current, known
  // answer rather than asserted as safety: the sink never produces one (offsets
  // come from a monotonic accumulator seeded at 0 or at a resume point), and
  // this test exists so that a future caller that could produce one finds a
  // recorded expectation instead of discovering the gap in production.
  it("does not itself defend against a negative offset", () => {
    expect(wouldExceedDeclared(10, -5, 5)).toBe(false);
  });
});

// The two shapes the extraction carries. They have no behaviour, so what is
// asserted is that they are still STRUCTURAL — a card on screen is described by
// this contract and not by reaching into a state machine for it.
describe("the file-transfer contract this module owns", () => {
  it("describes an in-flight batch without any session object", () => {
    const xfer: Xfer = {
      peer: "p1", dir: "recv", files: [{ name: "a.txt", size: 3 }],
      index: 0, sent: 0, total: 3, status: "waitingAccept",
      done: false, ok: false, speed: 0,
    };
    expect(xfer.total).toBe(3);
    // `status` is a translation KEY, never a rendered string: the card follows a
    // language switch that happens mid-transfer.
    expect(typeof xfer.status).toBe("string");
  });

  it("marks a re-asked receive card without inventing a second state", () => {
    const first: Incoming = { from: "p1", files: [{ name: "a.txt", size: 3 }], total: 3 };
    const reasked: Incoming = { ...first, retry: true };
    // `retry` is optional and absent by default: the ordinary first ask must not
    // have to say it is not a retry.
    expect(first.retry).toBeUndefined();
    expect(reasked.retry).toBe(true);
  });
});
