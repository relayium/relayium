// Cross-implementation proof, by EXECUTION, that a sealed box this browser
// produces is one the Relayium device receiver can open.
//
// This suite is the driver. It runs the real Go implementation twice, with the
// real browser implementation in between:
//
//   1. Go (`TestWebSealedBoxEmitDeviceKey`) mints a device keypair with
//      `GenerateKeyPair` — the CLI receiver's own function — and the exact
//      32-byte content key it will later expect back. Both are written before
//      this file has computed anything, so the expected value is never derived
//      from the code under test.
//   2. This file seals that content key with `sealContentKey`, the same call the
//      Web sender makes.
//   3. Go (`TestWebSealedBoxOpen`) opens it with the private half alone and
//      asserts it is byte-for-byte the key from step 1 — then that a different
//      device, a mismatched pair, a tampered byte, a wrong length and a
//      non-canonical spelling all fail.
//
// The final case here is the one that makes the whole gate trustworthy: a
// deliberately corrupted box must make step 3 EXIT NON-ZERO. Without it, a
// silently broken harness would look exactly like a passing interoperability
// test (WORKFLOW-LEARNINGS, 2026-08-08: an assertion that cannot fail is worse
// than none).
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INBOX_KEY_ALGORITHM } from "./device-inbox";
import { sealContentKey, SEALED_BOX_BYTES } from "./device-seal";
import { decodeKey, encodeKey } from "./store-crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, "../../../server");

/** `RELAYIUM_GO_INTEROP` makes the decision explicit rather than accidental:
 *  `1` = run and never skip (the dedicated CI job), `0` = do not run (the
 *  Node-only web job, whose runner image happens to ship Go but is not set up
 *  to build this module). Unset falls back to "run if a toolchain is here",
 *  which is what a developer wants locally. A skip is impossible in the
 *  environment that is supposed to be proving something. */
const FORCED = process.env.RELAYIUM_GO_INTEROP === "1";
const DISABLED = process.env.RELAYIUM_GO_INTEROP === "0";

function shouldRun(): boolean {
  if (DISABLED) return false;
  if (FORCED) return true;
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let dir = "";

function runGo(testName: string): { status: number | null; output: string } {
  const r = spawnSync(
    "go",
    ["test", "-tags", "webinterop", "-count=1", "-run", `^${testName}$`, "./internal/inboxclient/"],
    {
      cwd: serverDir,
      encoding: "utf8",
      env: { ...process.env, RELAYIUM_INTEROP_DIR: dir },
      timeout: 300_000,
    },
  );
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe.skipIf(!shouldRun())("x25519-sealedbox-v1 across implementations", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "relayium-sealedbox-"));
  });

  it(
    "the Go receiver opens a box this browser sealed, and refuses every near miss",
    async () => {
      try {
        const emit = runGo("TestWebSealedBoxEmitDeviceKey");
        expect(emit.status, `the Go device-key phase failed:\n${emit.output}`).toBe(0);

        const key = JSON.parse(readFileSync(path.join(dir, "device-key.json"), "utf8")) as {
          algorithm: string;
          publicKey: string;
          contentKey: string;
        };
        expect(key.algorithm).toBe(INBOX_KEY_ALGORITHM);

        // The real browser call. `contentKey` is Go's bytes, not ours.
        const wrappedKey = await sealContentKey(decodeKey(key.contentKey), key.algorithm, key.publicKey);
        expect(decodeKey(wrappedKey).length).toBe(SEALED_BOX_BYTES);
        const boxPath = path.join(dir, "web-box.json");
        writeFileSync(
          boxPath,
          JSON.stringify({ algorithm: key.algorithm, wrappedKey, sealedBy: "relayium-web" }, null, 2),
        );

        const open = runGo("TestWebSealedBoxOpen");
        expect(open.status, `the Go receiver could not open the browser's box:\n${open.output}`).toBe(0);

        // Adversarial control: corrupt one byte of the ciphertext and require
        // the same Go run to FAIL. This is what proves the pass above was the
        // crypto agreeing rather than the harness succeeding at nothing.
        const raw = decodeKey(wrappedKey);
        raw[raw.length - 1] ^= 0x01;
        writeFileSync(
          boxPath,
          JSON.stringify(
            { algorithm: key.algorithm, wrappedKey: encodeKey(raw), sealedBy: "relayium-web" },
            null,
            2,
          ),
        );
        const tampered = runGo("TestWebSealedBoxOpen");
        expect(
          tampered.status,
          "a tampered box still passed the interoperability gate — the gate proves nothing",
        ).not.toBe(0);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
