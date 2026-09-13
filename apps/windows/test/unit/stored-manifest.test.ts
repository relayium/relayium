// The pre-helper manifest gate: what it refuses, and the two totals it derives.
//
// `src/main/io/plan.ts` owns the per-name and per-pair rules and has its own
// suite. What is tested here is what this module adds: the aggregate bounds the
// native helper enforces and the TypeScript planner does not, the exact
// ciphertext geometry, the validated-segments rejoin, and the fact that no
// refusal carries a filename.
import { describe, expect, it } from "vitest";

import {
  MAX_DISTINCT_DIRECTORIES,
  MAX_MANIFEST_NAME_BYTES,
  planStoredManifest,
  sealedManifestBytes,
} from "../../src/main/stored/manifest.js";

/** The wire geometry the frozen vectors were generated with. */
const GEOMETRY = { storeChunkSize: 192 * 1024, frameOverhead: 4 + 16 } as const;

const plan = (files: readonly { name: string; size: number }[]) =>
  planStoredManifest({ files }, GEOMETRY);

describe("the write plan", () => {
  it("carries the validated segments, rejoined", () => {
    const result = plan([{ name: "trip/day1/a.txt", size: 3 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.manifest).toEqual([{ name: "trip/day1/a.txt", size: 3 }]);
    expect(result.plan.totalBytes).toBe(3);
  });

  it("computes the ciphertext total per file, not per object", () => {
    const chunk = GEOMETRY.storeChunkSize;
    const cases: readonly (readonly [number[], number])[] = [
      // One partial frame.
      [[11], 11 + 20],
      // Exactly one full chunk is still one frame; one byte more is two.
      [[chunk], chunk + 20],
      [[chunk + 1], chunk + 1 + 40],
      // Two files, each framed independently — no separator frame between them.
      [[11, 3], 11 + 20 + 3 + 20],
      // A zero-byte file carries NO frame at all.
      [[0], 0],
      [[3, 0, 2], 3 + 20 + 0 + 2 + 20],
    ];
    for (const [sizes, expected] of cases) {
      const result = plan(sizes.map((size, index) => ({ name: `f${String(index)}.bin`, size })));
      expect(result.ok, sizes.join(",")).toBe(true);
      if (!result.ok) continue;
      expect(result.plan.cipherBytes, sizes.join(",")).toBe(expected);
    }
  });
});

describe("refusals", () => {
  it("refuses an empty manifest rather than reporting 0 of 0 saved", () => {
    const result = plan([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({ kind: "count" });
  });

  it("refuses more files than the shared wire permits", () => {
    const files = Array.from({ length: 1001 }, (_, i) => ({ name: `f${String(i)}.bin`, size: 1 }));
    const result = plan(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({ kind: "count" });
  });

  it("refuses the Windows names that cannot be created, with the reason", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["../escape.txt", "traversal"],
      ["..\\escape.txt", "backslash-in-segment"],
      ["C:\\Windows\\evil.txt", "absolute"],
      ["C:relative.txt", "drive-relative"],
      ["\\\\server\\share\\x.txt", "unc-or-device"],
      ["NUL.txt", "reserved-device-name"],
      ["stream.txt:hidden", "alternate-data-stream"],
      ["trailing. ", "trailing-dot-or-space"],
      ["bad|name.txt", "invalid-character"],
      [`${"n".repeat(256)}.txt`, "segment-too-long"],
    ];
    for (const [name, reason] of cases) {
      const result = plan([{ name, size: 1 }]);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.refusal, name).toEqual({ kind: "path", reason });
    }
  });

  it("refuses a case collision and a file-versus-parent conflict", () => {
    const duplicate = plan([
      { name: "A.txt", size: 1 },
      { name: "a.txt", size: 1 },
    ]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.refusal).toEqual({ kind: "duplicate" });

    const conflict = plan([
      { name: "thing/child.txt", size: 1 },
      { name: "thing", size: 1 },
    ]);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.refusal).toEqual({ kind: "file-vs-parent" });
  });

  it("refuses an aggregate name budget the helper's `open` frame cannot hold", () => {
    // The bound `plan.ts` does not have. Every file shares ONE directory chain,
    // so the distinct-directory bound stays far away and this is the check that
    // fires. 64 segments of 255 characters is 16,383 bytes per name.
    const chain = Array.from({ length: 63 }, (_, i) => `d${String(i)}${"x".repeat(250)}`).join("/");
    const perName = new TextEncoder().encode(`${chain}/${"f".repeat(255)}`).length;
    const needed = Math.floor(MAX_MANIFEST_NAME_BYTES / perName) + 1;
    const files = Array.from({ length: needed }, (_, i) => ({
      name: `${chain}/${String(i).padStart(255, "f")}`,
      size: 1,
    }));
    const result = plan(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({ kind: "manifest-too-large" });
  });

  it("refuses more distinct directories than the helper will pin handles for", () => {
    // 5 unique directories per file, so the cap is crossed well inside the
    // 1000-file limit and inside the name budget.
    const files = Array.from({ length: 1000 }, (_, i) => ({
      name: `a${String(i)}/b${String(i)}/c${String(i)}/d${String(i)}/e${String(i)}/f.bin`,
      size: 1,
    }));
    expect(files.length * 5).toBeGreaterThan(MAX_DISTINCT_DIRECTORIES);
    const result = plan(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({ kind: "too-many-directories" });
  });

  it("counts case-folded directories once, as NTFS does", () => {
    // `A/x` and `a/y` need ONE directory. Counting two would refuse manifests
    // the helper accepts.
    const result = plan([
      { name: "Dir/x.bin", size: 1 },
      { name: "dir/y.bin", size: 1 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("never carries a filename in a refusal", () => {
    const result = plan([{ name: "../tax-return-2025.pdf", size: 1 }]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("tax-return");
  });
});

describe("the sealed manifest's base64", () => {
  const valid = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

  it("decodes a well-formed document", () => {
    const bytes = sealedManifestBytes(valid);
    expect(bytes).not.toBeNull();
    expect(bytes?.byteLength).toBe(32);
  });

  it("refuses what Buffer.from would silently accept", () => {
    // Each of these decodes to *something* under Node's lenient base64, which
    // is why the alphabet, the padding and the length are checked first.
    for (const bad of ["!!!!!!!!", "aaaa aaaa", "====", "AAAAA", `${valid}!`, "a===aaaa"]) {
      expect(sealedManifestBytes(bad), bad).toBeNull();
    }
  });

  it("refuses a value too short to be a sealed frame", () => {
    // 16 bytes is the GCM tag alone: there is no manifest inside it.
    expect(sealedManifestBytes(Buffer.from(new Uint8Array(16)).toString("base64"))).toBeNull();
    expect(sealedManifestBytes("")).toBeNull();
  });
});
