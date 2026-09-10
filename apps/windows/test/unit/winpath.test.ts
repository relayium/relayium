import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_SEGMENT_UTF16,
  collisionKey,
  validateRelativePath,
  validateSegment,
} from "../../src/main/io/winpath.js";

/**
 * The adversarial corpus is read from the reviewer's own fixture rather than
 * retyped here. A copied list agrees with whatever the implementation happens to
 * do; this one was written against Microsoft's naming rules by someone who was
 * not writing the validator.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/root-path-adversarial.json", import.meta.url)),
    "utf8",
  ),
) as { reject: string[]; positive: string[]; collisionPairs: [string, string][] };

describe("validateRelativePath", () => {
  it.each(fixture.reject)("refuses %j", (name) => {
    expect(validateRelativePath(name).ok).toBe(false);
  });

  it.each(fixture.positive)("accepts %j", (name) => {
    expect(validateRelativePath(name).ok).toBe(true);
  });

  it("names the reason rather than answering only yes/no", () => {
    expect(validateRelativePath("../escape").reason).toBe("traversal");
    expect(validateRelativePath("\\\\server\\share").reason).toBe("unc-or-device");
    expect(validateRelativePath("C:relative").reason).toBe("drive-relative");
    expect(validateRelativePath("name:stream").reason).toBe("alternate-data-stream");
    expect(validateRelativePath("COM¹.txt").reason).toBe("reserved-device-name");
    expect(validateRelativePath("trailing.").reason).toBe("trailing-dot-or-space");
  });

  it("refuses a reserved name whatever the extension, because the device wins", () => {
    for (const name of ["NUL", "nul.txt", "CON.tar.gz", "LPT²", "com1.log"]) {
      expect(validateRelativePath(name).ok).toBe(false);
    }
  });

  it("never returns segments for a refused path", () => {
    expect(validateRelativePath("../escape").segments).toBeUndefined();
  });
});

describe("component length", () => {
  // NTFS counts UTF-16 units. The wire's 1024-BYTE ceiling does not imply this
  // one: 256 ASCII characters are 256 bytes, under the byte limit and over the
  // filesystem's.
  it("accepts 255 UTF-16 units and refuses 256", () => {
    expect(validateSegment("a".repeat(MAX_SEGMENT_UTF16)).ok).toBe(true);
    expect(validateSegment("a".repeat(MAX_SEGMENT_UTF16 + 1)).ok).toBe(false);
    expect(validateSegment("a".repeat(256)).reason).toBe("segment-too-long");
  });

  it("applies the same unit count to multibyte names", () => {
    // 255 CJK characters are 765 UTF-8 bytes — inside the byte ceiling — and
    // exactly at the filesystem's unit limit.
    expect(validateSegment("中".repeat(255)).ok).toBe(true);
    expect(validateSegment("中".repeat(256)).ok).toBe(false);
  });

  it("refuses an over-long component through the full-path entry point too", () => {
    expect(validateRelativePath("a".repeat(256)).ok).toBe(false);
    expect(validateRelativePath(`dir/${"a".repeat(256)}`).ok).toBe(false);
  });
});

describe("validateSegment stands alone", () => {
  // It is exported, so it must be correct for a caller that never went through
  // the splitter. Answering "fine" for `a/b` would let such a caller create a
  // directory the manifest never declared.
  it("refuses a forward slash inside one component", () => {
    expect(validateSegment("a/b").ok).toBe(false);
    expect(validateSegment("a/b").reason).toBe("separator-in-segment");
  });

  it("refuses a backslash, which Windows would also honour as a separator", () => {
    expect(validateSegment("a\\b").reason).toBe("backslash-in-segment");
  });
});

describe("collisionKey", () => {
  it.each(fixture.collisionPairs)("treats %j and %j as one destination", (a, b) => {
    const left = validateRelativePath(a);
    const right = validateRelativePath(b);
    expect(left.ok && right.ok).toBe(true);
    const ka = collisionKey(left.segments!);
    const kb = collisionKey(right.segments!);
    // Either the same key (a case collision) or one is a prefix of the other
    // (the file-versus-parent conflict). Both are conflicts the planner refuses.
    const conflicting = ka === kb || ka.startsWith(`${kb}/`) || kb.startsWith(`${ka}/`);
    expect(conflicting).toBe(true);
  });
});
