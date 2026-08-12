// What ends a pre-uploaded object, asserted against the SOURCE that describes it.
//
// The Web mirror of server/account/pairroom_lifecycle_claims_test.go, and it
// exists for the same reason that one does: this claim came apart three times in
// three consecutive checkpoints without a single test failing, because a comment
// is not compiled against the thing it describes.
//
//   before completion existed    "there is no completion, ever"
//   after it existed             "nobody spends it yet"
//   after the receiver spent it  "an operator or account deletion", naming a
//                                route that has never existed
//
// It matters more here than in most places. These particular comments are the
// argument for two irreversible decisions this client makes on its own — a
// receiver spending a completion (which deletes the sender's only copy) and a
// sender declining to delete objects it cannot hand off. Somebody re-deriving
// either decision reads these paragraphs, and a paragraph that says the storage
// is reclaimed by an operator makes both look cheaper than they are.
//
// THE RULE (docs/protocol/relayium-pair-room-v1.md §2): a joined room's
// ciphertext leaves in exactly three ways, none of which is a clock —
//
//   1. the RECEIVER completes it            (preupload-receive.svelte.ts)
//   2. the OWNING ACCOUNT releases the room (PairRoomStorage.svelte, /me)
//   3. the account is deleted
//
// There is no fourth. No operator route removes one, and nothing expires.
//
// The guard bans the sentences that were actually wrong rather than prescribing
// a phrasing: a test that dictates prose gets worked around instead of read.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const srcRoot = resolve(import.meta.dirname, "..");

/**
 * The files a reader opens to find out what the rule IS. Not every file that
 * touches a pre-upload — only the ones carrying the lifecycle argument, which is
 * where a stale sentence does its damage.
 */
const claimFiles = [
  "App.svelte",
  "lib/preupload.svelte.ts",
  "lib/preupload-receive.svelte.ts",
  "lib/outbox.svelte.ts",
  "lib/PairRoomStorage.svelte",
  "lib/stored-file.ts",
];

/**
 * Every entry was real text in this repository, not a hypothetical. That is the
 * bar for adding one: a sentence that was true, shipped, and became false.
 */
const staleClaims: { text: string; why: string }[] = [
  {
    text: "an operator or account deletion",
    why: "No operator route removes a pair room. The account's own release (GET /api/pair-rooms, DELETE /api/pair-rooms/{id}) is the manual exit.",
  },
  {
    text: "until an operator",
    why: "Same: there is no such route, and there never was one.",
  },
  {
    text: "nothing but an operator",
    why: "Same. The three causes are receiver completion, owner release, account deletion.",
  },
  {
    text: "no completion ever spent against them, nothing but an operator",
    why: "Same, in the sender's capability-gate comment.",
  },
  {
    text: "no receiver spends",
    why: "This receiver spends completions (preupload-receive.svelte.ts, spendCompletion).",
  },
];

/**
 * Claims that would mean a clock was invented — the reinterpretation of §2 that
 * this protocol has already refused twice, once in the server (a 24-hour
 * "storage backstop") and once in the doc.
 */
const timerClaims = ["fallback expiry is", "expires after", "auto-expire", "automatically expires"];

describe("the pre-upload lifecycle comments name every cause and invent none", () => {
  for (const file of claimFiles) {
    it(`${file} claims nothing that has stopped being true`, () => {
      const src = readFileSync(join(srcRoot, file), "utf8");
      for (const { text, why } of staleClaims) {
        const at = src.indexOf(text);
        // 1-based line, so a failure names a place to go rather than a string to
        // hunt for. Only ever read when `at` is a real offset.
        const line = at < 0 ? 0 : src.slice(0, at).split("\n").length;
        expect(
          at,
          `${file}:${line} says "${text}".\n${why}\n` +
            "A joined room's ciphertext ends when its receiver completes it, when its " +
            "owner releases the room, or when the account is deleted — and never on a clock.",
        ).toBe(-1);
      }
      for (const timer of timerClaims) {
        expect(src, `${file} says "${timer}", which would mean a joined room is on a clock. It is not.`).not.toContain(
          timer,
        );
      }
    });
  }

  // The positive half. Banning stale sentences keeps a comment from being wrong;
  // it cannot keep one from going quiet, and a silent lifecycle note is how the
  // owner's release becomes undiscoverable to the next reader all over again.
  it("says somewhere that the owner can release the room, on both sides of the handoff", () => {
    for (const file of ["lib/outbox.svelte.ts", "lib/preupload-receive.svelte.ts"]) {
      const src = readFileSync(join(srcRoot, file), "utf8");
      expect(
        /(owner|account|sender)[^\n]{0,120}releas(e|es|ing)\b|releas(e|es|ing)[^\n]{0,120}(owner|account|sender)/i.test(src),
        `${file} no longer mentions the owner's release.\n` +
          "It is the only exit that always exists — §7.6 means a receiver on Firefox, " +
          "Safari or any phone can never complete — so a lifecycle comment that omits " +
          "it describes storage with no way out.",
      ).toBe(true);
    }
  });
});
