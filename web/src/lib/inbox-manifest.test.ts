import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  INBOX_MANIFEST_MAX_ITEMS,
  INBOX_MANIFEST_MAX_NAME_BYTES,
  INBOX_MANIFEST_MAX_PATH_DEPTH,
  INBOX_MANIFEST_MAX_SAFE_INTEGER,
  INBOX_MANIFEST_MAX_TEXT_BYTES,
  INBOX_MANIFEST_MIN_ITEMS,
  INBOX_MANIFEST_MIN_TEXT_BYTES,
  INBOX_MANIFEST_VERSION,
  InboxManifestError,
  decodeInboxManifest,
  encodeInboxManifest,
  encodeInboxManifestBytes,
  fileManifest,
  inboxManifestKind,
  inboxManifestTotal,
  textManifest,
  validateInboxManifest,
  type InboxManifest,
  type InboxManifestReason,
} from "./inbox-manifest";

/** The reason a call threw, or `null` if it did not throw at all. */
function reasonOf(fn: () => unknown): InboxManifestReason | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof InboxManifestError) return e.reason;
    throw e;
  }
}

const files = (entries: { name: string; size: number }[]) => () => fileManifest(entries);
const decode = (s: string) => () => decodeInboxManifest(s);

describe("the canonical form", () => {
  it("has fixed key order, sender item order, and no whitespace", () => {
    const m = fileManifest([
      { name: "b.txt", size: 2 },
      { name: "a.txt", size: 1 },
    ]);
    expect(encodeInboxManifest(m)).toBe(
      '{"v":3,"items":[{"kind":"file","name":"b.txt","size":2},{"kind":"file","name":"a.txt","size":1}]}',
    );
  });

  it("omits the name key entirely for text", () => {
    // Absent, not empty. An empty string is something a receiver could be
    // tempted to treat as a destination; an absent key cannot be.
    const encoded = encodeInboxManifest(textManifest(11));
    expect(encoded).toBe('{"v":3,"items":[{"kind":"text","size":11}]}');
    expect(encoded).not.toContain("name");
  });

  it("emits the characters other encoders would escape, raw", () => {
    // Only characters a VALID name may contain are here. The encoder also
    // escapes the backslash, tab and the C0 controls, but the name rule refuses
    // all of those outright, so no manifest can reach those branches — Go
    // asserts them against the helper directly instead.
    for (const [name, escaped] of [
      ['say "hi".txt', 'say \\"hi\\".txt'],
      // Go's own encoder escapes these four by default and JavaScript's does
      // not; a canonical form built on either would diverge across languages.
      ["a<b>&c.txt", "a<b>&c.txt"],
      ["line\u2028sep.txt", "line\u2028sep.txt"],
      ["a\u202eb.txt", "a\u202eb.txt"],
      ["发票 2026.pdf", "发票 2026.pdf"],
    ]) {
      expect(encodeInboxManifest(fileManifest([{ name, size: 1 }]))).toBe(
        `{"v":3,"items":[{"kind":"file","name":"${escaped}","size":1}]}`,
      );
    }
  });

  it("round-trips through bytes", () => {
    for (const m of [
      fileManifest([{ name: "a/b/c.txt", size: 0 }]),
      fileManifest([{ name: "发票 2026.pdf", size: INBOX_MANIFEST_MAX_SAFE_INTEGER }]),
      textManifest(INBOX_MANIFEST_MAX_TEXT_BYTES),
    ]) {
      const encoded = encodeInboxManifestBytes(m);
      const back = decodeInboxManifest(encoded);
      expect(back).toEqual(m);
      expect(encodeInboxManifestBytes(back)).toEqual(encoded);
    }
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expect(reasonOf(() => decodeInboxManifest(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("malformed");
  });
});

describe("fail-closed clauses", () => {
  it("decides the version before anything else", () => {
    // A v1 document is `{"files":[…]}` — no `v` at all. Diagnosed by the
    // unknown-key rule it would be "unknown field: files", which is true and
    // useless; diagnosed as a version it is something a person can act on.
    expect(reasonOf(decode('{"files":[{"name":"a.txt","size":1}]}'))).toBe("version");
    expect(reasonOf(decode('{"v":1,"items":[{"kind":"file","name":"a.txt","size":1}]}'))).toBe("version");
    expect(reasonOf(decode('{"v":4,"items":[{"kind":"file","name":"a.txt","size":1}]}'))).toBe("version");
    expect(reasonOf(decode('{"items":[{"kind":"file","name":"a.txt","size":1}]}'))).toBe("version");
    expect(reasonOf(decode('{"v":0,"items":[{"kind":"file","name":"a.txt","size":1}]}'))).toBe("version");
  });

  it("allows exactly one content kind per delivery", () => {
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"file","name":"a.txt","size":1},{"kind":"text","size":5}]}'))).toBe(
      "mixedKinds",
    );
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"text","size":5},{"kind":"file","name":"a.txt","size":1}]}'))).toBe(
      "mixedKinds",
    );
    // A single stray item at the end of a long run: a check that only compared
    // neighbours, or only looked at the first two, would pass both cases above
    // and let this one through.
    const items = Array.from({ length: 39 }, () => ({ kind: "file" as const, name: "f", size: 1 }));
    const strayed = { v: 3, items: [...items, { kind: "text" as const, size: 1 }] } as InboxManifest;
    expect(reasonOf(() => validateInboxManifest(strayed))).toBe("mixedKinds");
  });

  it("makes text exactly one unnamed bounded item", () => {
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"text","size":5},{"kind":"text","size":6}]}'))).toBe(
      "textItemCount",
    );
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"text","name":"note.txt","size":5}]}'))).toBe("textName");
    for (const size of [0, -1, INBOX_MANIFEST_MAX_TEXT_BYTES + 1, INBOX_MANIFEST_MAX_SAFE_INTEGER]) {
      expect(reasonOf(() => textManifest(size)), `text of ${size}`).toBe("size");
    }
    for (const size of [INBOX_MANIFEST_MIN_TEXT_BYTES, 1024, INBOX_MANIFEST_MAX_TEXT_BYTES]) {
      expect(reasonOf(() => textManifest(size)), `text of ${size}`).toBeNull();
    }
  });

  it("refuses traversal and control characters in names", () => {
    for (const bad of [
      "",
      "../etc/passwd",
      "a/../../b.txt",
      "./a.txt",
      "a/..",
      "/etc/passwd",
      "/a",
      "C:/Windows/a.dll",
      "C:a.dll",
      "a\\b.txt",
      "..\\a.txt",
      "a//b.txt",
      "a/b/",
      "a\u0000b.txt",
      "a\nb.txt",
      "a\rb.txt",
      "a\u001bb.txt",
      "a\u007fb.txt",
      "a\ud800b.txt", // a lone surrogate has no UTF-8 encoding
      "a".repeat(INBOX_MANIFEST_MAX_NAME_BYTES + 1),
      "é".repeat(INBOX_MANIFEST_MAX_NAME_BYTES / 2 + 1),
      "a/".repeat(INBOX_MANIFEST_MAX_PATH_DEPTH) + "b",
    ]) {
      expect(reasonOf(files([{ name: bad, size: 1 }])), JSON.stringify(bad)).toBe("name");
    }
    // The boundary cases that must PASS, so the rule is a rule and not a ban on
    // ordinary names.
    for (const ok of [
      "a.txt",
      "trip/day 1/IMG_0001.jpg",
      "a..b.txt",
      ".hidden",
      "发票 2026.pdf",
      // The drive-prefix rule is positional, and its position is a BYTE offset.
      // ":" sits at string index 1 here but at byte index 2, so a check written
      // against this runtime's UTF-16 indices refused a name Go and Swift
      // accept — one manifest, two verdicts, which §8 exists to rule out.
      "é:1.txt",
      "ab:c.txt",
      "a".repeat(INBOX_MANIFEST_MAX_NAME_BYTES),
      "a/".repeat(INBOX_MANIFEST_MAX_PATH_DEPTH - 1) + "b",
    ]) {
      expect(reasonOf(files([{ name: ok, size: 1 }])), JSON.stringify(ok)).toBeNull();
    }
  });

  it("bounds sizes and their total", () => {
    expect(reasonOf(files([{ name: "a", size: -1 }]))).toBe("size");
    expect(reasonOf(files([{ name: "a", size: INBOX_MANIFEST_MAX_SAFE_INTEGER + 1 }]))).toBe("size");
    expect(reasonOf(files([{ name: "a", size: 1.5 }]))).toBe("size");
    expect(reasonOf(files([{ name: "a", size: NaN }]))).toBe("size");
    expect(reasonOf(files([{ name: "a", size: Infinity }]))).toBe("size");
    // Each item fits; the SUM does not. This is the one an item-at-a-time bound
    // misses, and it is what a receiver would preallocate against.
    expect(
      reasonOf(
        files([
          { name: "a", size: INBOX_MANIFEST_MAX_SAFE_INTEGER },
          { name: "b", size: 1 },
        ]),
      ),
    ).toBe("totalOverflow");
    // Zero is legal: an empty file is a real file.
    expect(reasonOf(files([{ name: "a", size: 0 }]))).toBeNull();
  });

  it("bounds the item count", () => {
    expect(reasonOf(files([]))).toBe("itemCount");
    const at = Array.from({ length: INBOX_MANIFEST_MAX_ITEMS }, () => ({ name: "f", size: 1 }));
    expect(reasonOf(() => fileManifest(at))).toBeNull();
    expect(reasonOf(() => fileManifest([...at, { name: "f", size: 1 }]))).toBe("itemCount");
  });

  it("refuses unknown fields instead of ignoring them", () => {
    expect(reasonOf(decode('{"v":3,"note":"hi","items":[{"kind":"file","name":"a.txt","size":1}]}'))).toBe("malformed");
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"file","name":"a.txt","size":1,"path":"/tmp"}]}'))).toBe(
      "malformed",
    );
    // The one that matters: a sender must not be able to smuggle the message
    // body into the structure every receiver parses first.
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"text","size":5,"text":"hello"}]}'))).toBe("malformed");
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}],"key":"AAAA"}'))).toBe("malformed");
  });

  it("refuses every non-canonical spelling", () => {
    for (const doc of [
      '{"items":[{"kind":"file","name":"a.txt","size":1}],"v":3}',
      '{"v":3,"items":[{"size":1,"kind":"file","name":"a.txt"}]}',
      '{"v": 3, "items": [{"kind": "file", "name": "a.txt", "size": 1}]}',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}]}\n',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1,"size":2}]}',
      '{"v":3,"items":[{"kind":"file","name":"a\\/b.txt","size":1}]}',
      '{"v":3,"items":[{"kind":"file","name":"a\\u003cb.txt","size":1}]}',
      // JavaScript cannot tell these spellings apart after JSON.parse; the
      // canonical-form check is the only thing that catches them here, which is
      // exactly why the check exists.
      '{"v":3.0,"items":[{"kind":"file","name":"a.txt","size":1}]}',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1.0}]}',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1e3}]}',
    ]) {
      expect(reasonOf(decode(doc)), doc).toBe("notCanonical");
    }
  });

  it("refuses malformed documents", () => {
    for (const doc of [
      "",
      "not json",
      '[{"kind":"file","name":"a.txt","size":1}]',
      '{"v":3,"items":{"kind":"file","name":"a.txt","size":1}}',
      '{"v":3,"items":["a.txt"]}',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":"1"}]}',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1.5}]}',
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}',
      // A second document appended to the first.
      '{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}]}{"v":3,"items":[{"kind":"text","size":1}]}',
    ]) {
      expect(reasonOf(decode(doc)), doc).toBe("malformed");
    }
  });

  it("never guesses at an unknown kind", () => {
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"folder","name":"a","size":1}]}'))).toBe("unknownKind");
    expect(reasonOf(decode('{"v":3,"items":[{"name":"a.txt","size":1}]}'))).toBe("unknownKind");
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"File","name":"a.txt","size":1}]}'))).toBe("unknownKind");
    expect(reasonOf(decode('{"v":3,"items":[{"kind":"","name":"a.txt","size":1}]}'))).toBe("unknownKind");
  });

  it("refuses to ENCODE an invalid manifest", () => {
    // A codec that only checked on the way in would seal a traversal name
    // happily and leave the refusal to the receiver — after the upload, and only
    // if the receiver is this careful.
    for (const m of [
      { v: 3, items: [{ kind: "file", name: "../a", size: 1 }] },
      { v: 3, items: [{ kind: "file", name: "a", size: 1 }, { kind: "text", size: 1 }] },
      { v: 3, items: [] },
      { v: 1, items: [{ kind: "file", name: "a", size: 1 }] },
      { v: 3, items: [{ kind: "text", name: "n", size: 1 }] },
    ] as unknown as InboxManifest[]) {
      expect(reasonOf(() => encodeInboxManifest(m)), JSON.stringify(m)).not.toBeNull();
    }
  });

  it("reads back the kind and total that were sealed", () => {
    const m = fileManifest([
      { name: "a", size: 1 },
      { name: "b", size: 41 },
    ]);
    expect(inboxManifestKind(m)).toBe("file");
    expect(inboxManifestTotal(m)).toBe(42);
    const t = textManifest(11);
    expect(inboxManifestKind(t)).toBe("text");
    expect(inboxManifestTotal(t)).toBe(11);
  });
});

// ── the frozen cross-language vectors ──────────────────────────────────────

/** One file, three ecosystems: this test, Go's `vectors_test.go` and Swift's
 *  `InboxManifestTests` read the SAME bytes, so an implementation that drifts
 *  fails here rather than on a user's device halfway through a delivery.
 *
 *  It lives under the Swift package because SwiftPM can only load test
 *  resources from inside its own package directory. Go and this test have no
 *  such restriction and reach it by relative path, so there is one copy. */
const VECTOR_PATH = "../apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json";

interface AcceptVector {
  name: string;
  canonical: string;
  kind: string;
  total: number;
  items: { kind: string; name?: string; size: number }[];
}
interface RefuseVector {
  name: string;
  reason: InboxManifestReason;
  anyRefusal?: boolean;
  json: string;
}
interface GeneratedVector {
  name: string;
  reason: string;
  count?: number;
  nameBytes?: number;
  depth?: number;
}

const vectors = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as {
  version: number;
  bounds: Record<string, number>;
  accept: AcceptVector[];
  refuse: RefuseVector[];
  generated: GeneratedVector[];
};

describe("the frozen cross-language vectors", () => {
  it("agree with this implementation's bounds", () => {
    // The constants, before the documents. A bound that drifted here would make
    // every vector below pass against the wrong rule.
    expect(vectors.version).toBe(INBOX_MANIFEST_VERSION);
    expect(vectors.bounds.maxItems).toBe(INBOX_MANIFEST_MAX_ITEMS);
    expect(vectors.bounds.minItems).toBe(INBOX_MANIFEST_MIN_ITEMS);
    expect(vectors.bounds.maxNameBytes).toBe(INBOX_MANIFEST_MAX_NAME_BYTES);
    expect(vectors.bounds.maxPathDepth).toBe(INBOX_MANIFEST_MAX_PATH_DEPTH);
    expect(vectors.bounds.maxSafeInteger).toBe(INBOX_MANIFEST_MAX_SAFE_INTEGER);
    expect(vectors.bounds.minTextBytes).toBe(INBOX_MANIFEST_MIN_TEXT_BYTES);
    expect(vectors.bounds.maxTextBytes).toBe(INBOX_MANIFEST_MAX_TEXT_BYTES);
  });

  it("loaded a non-empty set", () => {
    expect(vectors.accept.length).toBeGreaterThan(0);
    expect(vectors.refuse.length).toBeGreaterThan(0);
    expect(vectors.generated.length).toBeGreaterThan(0);
  });

  it.each(vectors.accept.map((v) => [v.name, v] as const))("accepts %s", (_name, tc) => {
    // DECODE: the frozen bytes must parse to exactly the stated shape.
    const m = decodeInboxManifest(tc.canonical);
    expect(inboxManifestKind(m)).toBe(tc.kind);
    expect(inboxManifestTotal(m)).toBe(tc.total);
    expect(m.items).toEqual(tc.items);
    // ENCODE: and this implementation must produce those exact bytes from that
    // shape. Decoding alone would let a lenient encoder pass.
    expect(encodeInboxManifest({ v: 3, items: tc.items } as InboxManifest)).toBe(tc.canonical);
  });

  it.each(vectors.refuse.map((v) => [v.name, v] as const))("refuses %s", (_name, tc) => {
    const reason = reasonOf(decode(tc.json));
    expect(reason, "was accepted").not.toBeNull();
    // `anyRefusal` vectors are ones the three JSON parsers cannot all observe
    // identically. They must still be refused — only the clause may differ.
    if (!tc.anyRefusal) expect(reason).toBe(tc.reason);
  });

  it.each(vectors.generated.map((v) => [v.name, v] as const))("handles %s", (_name, tc) => {
    let entries: { name: string; size: number }[];
    if (tc.count !== undefined) {
      entries = Array.from({ length: tc.count }, () => ({ name: "f", size: 1 }));
    } else if (tc.nameBytes !== undefined) {
      entries = [{ name: "a".repeat(tc.nameBytes), size: 1 }];
    } else if (tc.depth !== undefined) {
      entries = [{ name: "a/".repeat(tc.depth - 1) + "b", size: 1 }];
    } else {
      throw new Error(`generated vector ${tc.name} describes nothing to build`);
    }
    if (tc.reason === "accept") {
      const m = fileManifest(entries);
      // Round-trips too: a bound only validation honoured would still break a
      // real delivery at encode or decode time.
      expect(decodeInboxManifest(encodeInboxManifestBytes(m))).toEqual(m);
      return;
    }
    expect(reasonOf(() => fileManifest(entries))).toBe(tc.reason);
  });
});
