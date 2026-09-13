// The helper's own wire codes, and what the screen is told they mean.
//
// ## The defect this file exists for
//
// Main narrows the `failed` path through `FAILURE_BY_CODE`. The PARTIAL path
// had no such step: `native-helper-client.ts` checks the helper's `failed.code`
// only for being a non-empty string and forwards it, and the helper's codes are
// `E_ACCESS`, `E_NO_SPACE`, `E_EXISTS` and friends
// (`native/internal/wire/code.go`, classified from NTSTATUS at
// `winio/nt_windows.go:105`).
//
// Nothing downstream could match those. Every partial publication failure on
// Windows therefore rendered one sentence — "Could not write to the folder you
// chose" — including a full disk, for which it is false and sends somebody to
// check permissions on a folder that is perfectly fine.
import { describe, expect, it } from "vitest";

import { NativeHelperDestination } from "../../src/main/net/native-receive-adapter.js";
import type { NativePublishReport, NativeReceiveDestination } from "../../src/main/io/native-helper-client.js";
import type { PublishFailureReason } from "../../src/shared/ipc-contract.js";

/** A destination that reports one partial publication with the given code. */
function failingWith(code: string): NativeReceiveDestination {
  const report: NativePublishReport = {
    status: "partial",
    publishedCount: 2,
    total: 5,
    failedIndex: 2,
    reason: code,
  };
  return {
    fileCount: 5,
    assertAuthority() {},
    begin: () => Promise.resolve(),
    write: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    publish: () => Promise.resolve(report),
    cancel: () => Promise.resolve(),
  };
}

async function reasonFor(code: string): Promise<PublishFailureReason> {
  const report = await new NativeHelperDestination(failingWith(code)).publish();
  if (report.status !== "partial") throw new Error(`expected partial, got ${report.status}`);
  return report.reason;
}

describe("the helper's wire codes, on the way to a sentence", () => {
  // Every code `winio/nt_windows.go:105` can classify an NTSTATUS into, plus
  // the lifecycle codes a publish can end on. Listed from the Go source rather
  // than from the map under test, which is the point of the case.
  const EXPECTED: ReadonlyArray<readonly [string, PublishFailureReason]> = [
    ["E_EXISTS", "exists"],
    ["E_TYPE_CONFLICT", "exists"],
    ["E_ACCESS", "permission"],
    ["E_SHARING", "in-use"],
    ["E_NO_SPACE", "no-space"],
    ["E_NOT_FOUND", "gone"],
    ["E_NAME_TOO_LONG", "name-too-long"],
    ["E_DELETE_PENDING", "io-failed"],
    ["E_IO", "io-failed"],
    ["E_CANCELLED", "cancelled"],
    ["E_INTERNAL", "internal"],
  ];

  for (const [code, reason] of EXPECTED) {
    it(`${code} arrives as ${reason}`, async () => {
      await expect(reasonFor(code)).resolves.toBe(reason);
    });
  }

  it("never lets a raw wire code reach the renderer", async () => {
    // The actual failure mode. A code with no entry — a helper this build does
    // not know, or a new one — must arrive as a reason the screen can answer,
    // not as `E_SOMETHING_NEW` that every branch misses.
    for (const code of ["E_SOMETHING_NEW", "E_ROOT", "E_REPARSE_COMPONENT", ""]) {
      const reason = await reasonFor(code);
      expect(reason, code).toBe("io-failed");
      expect(reason.startsWith("E_"), code).toBe(false);
    }
  });

  it("keeps the four filesystem outcomes a person can act on APART", async () => {
    const reasons = await Promise.all(
      ["E_EXISTS", "E_ACCESS", "E_NO_SPACE", "E_SHARING"].map(reasonFor),
    );
    expect(new Set(reasons).size).toBe(4);
  });

  it("passes the counts through untouched", async () => {
    const report = await new NativeHelperDestination(failingWith("E_NO_SPACE")).publish();
    expect(report).toMatchObject({ status: "partial", publishedCount: 2, total: 5, failedIndex: 2 });
  });
});
