#!/usr/bin/env node
// web/scripts/gen-device-inbox-manifest-vectors.mjs — the Device Inbox v3
// manifest vectors, with their derived halves derived.
//
//   node scripts/gen-device-inbox-manifest-vectors.mjs   # run from web/
//
// ## Why this fixture is a HYBRID and not a normal generated one
//
// The other three fixtures in `check-wire-vectors.mjs`'s table are generated end
// to end: their generator invents the inputs, so there is nothing in the file a
// human wrote. This one is different, and deliberately so. Most of
// `device-inbox-manifest-v3-vectors.json` is a *judgement* — which 55 documents
// must be refused and under which named clause, which 13 shapes are worth
// pinning, what each of them is called. None of that can be derived from
// anything; it is the contract, written down. Regenerating it from an
// implementation is exactly the failure its own header warns about: the fixture
// would agree with whatever that implementation currently does.
//
// But three fields inside the accept cases are NOT judgement. Given an item
// list, `canonical`, `kind` and `total` are a pure function of the spec, and a
// human typing 13 canonical byte strings by hand is a human who will eventually
// mistype one — and a mistyped `canonical` is not a red test. It is a WRONG
// CONTRACT that all three implementations are then required to match. That is
// the one thing a frozen fixture cannot survive, because every consumer asserts
// against it rather than re-deriving it.
//
// So this generator owns exactly those three fields and nothing else:
//
//   CARRIED THROUGH from the tracked file, value for value — the hand-authored
//     half: `_` (the header), `version`, `bounds`, every `accept[].name` and
//     `accept[].items`, the whole of `refuse`, the whole of `generated`. These
//     are parsed and written back unexamined: nothing here derives, corrects or
//     overwrites a hand-authored value.
//   DERIVED, from the transcription below — never read from the tracked file:
//     `accept[].canonical`, `accept[].kind`, `accept[].total`.
//
// ## Why that is a claim about VALUES and not about bytes
//
// This generator does not copy any bytes out of the tracked file. It parses the
// whole thing and reserializes the whole thing, so every byte it writes is its
// own: two-space `JSON.stringify` indentation, the top-level and accept-case key
// order fixed by the literals below, `JSON.stringify`'s escaping, and the
// U+2028/U+2029 pass at the end. (Key order inside the hand-authored objects it
// carries through — `bounds`, each `refuse` entry, each item — is whatever
// `JSON.parse` recorded, which is source order but not a guarantee.)
//
// A hand-authored VALUE survives that round trip exactly. A hand-authored
// SPELLING of one does not: `1e3` comes back `1000`, `\u0041` comes back `A`,
// four-space indentation comes back two. Byte identity between this generator's
// input and its output is therefore a FIXED POINT rather than a preservation
// guarantee — it holds because the tracked file was first normalized into this
// generator's own output form (commit `74972146`), and reaching it again is
// exactly what the zero-diff gate measures.
//
// The tracked file is therefore this generator's INPUT as well as its output.
// That is what makes a hand-edit of an item list a legitimate contract change
// (regenerate, review the moved bytes, commit) while a hand-edit of a canonical
// string is a zero-diff failure.
//
// ## Why the rules below are transcribed and not imported
//
// A gate that ran the shipped encoder to produce the bytes the shipped encoder
// is measured against would assert `x == x`. It would be green through any
// escaping change any of the three implementations made, which is the precise
// class of bug the vectors exist to catch — Go's `encoding/json` escapes `<`,
// `>`, `&` and U+2028/U+2029 by default, `JSON.stringify` escapes none of them,
// and `JSONEncoder` reorders keys.
//
// Everything in the SPEC block below is therefore transcribed BY HAND from
// `docs/protocol/relayium-device-inbox-v3.md` — §2 for the version and the
// `{"v":3,"items":[…]}` shape, and, through v3's explicit "using the v2 item,
// bounds, framing and AEAD rules", `relayium-device-inbox-v2.md` §6–§10 for the
// item shape, the canonical encoder, the name rules and the size bounds. This
// file imports node's standard library and NOTHING else: not
// `web/src/lib/inbox-manifest.ts`, not `server/internal/inboxmanifest`, not
// RelayiumKit. If one of those disagrees with what is written here, the fixture
// and that implementation must disagree too, loudly, in that language's own
// vector suite. That disagreement IS the product.
//
// ## What it refuses to do
//
// It validates the hand-authored half against the same transcription before it
// derives anything: version, bounds, and every accept case actually being
// acceptable under §8–§10. An accept vector whose name is a traversal, or whose
// sizes overflow the aggregate, is a contract that says "all three of you must
// accept this" — and this generator will not write it. It throws instead, which
// is a fixture that fails to build rather than three implementations quietly
// taught to accept a Zip-Slip.

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

// `web/` is the working directory, as it is for every generator in
// `check-wire-vectors.mjs`'s table; see that file's note on why.
const FIXTURE = "../apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json";

// ─────────────────────────────────────────────────────────────────────────────
// SPEC — transcribed by hand. Nothing below is imported from an implementation.
// ─────────────────────────────────────────────────────────────────────────────

/** v3 §2: the protocol is `3` only, and the manifest is `{"v":3,"items":[…]}`. */
const VERSION = 3;

/** v2 §6 (items), §8 (names) and §9 (sizes), which v3 §2 adopts unchanged. */
const BOUNDS = {
  maxItems: 1000,
  minItems: 1,
  maxNameBytes: 1024,
  maxPathDepth: 64,
  maxSafeInteger: 9007199254740991,
  minTextBytes: 1,
  maxTextBytes: 65536,
};

const KINDS = ["file", "text"];

/**
 * v2 §7, the canonical string.
 *
 * Escaped: `"`, `\`, and the C0 controls — `\b \t \n \f \r` by name, the rest as
 * lowercase `\u00xx`. Emitted RAW as UTF-8: everything else, including DEL
 * (U+007F), the C1 controls, bidi overrides such as U+202E, U+2028/U+2029 and
 * all non-ASCII text. `/` is never escaped.
 *
 * The C0 escapes are unreachable from a valid manifest — §8 refuses those bytes
 * in a name outright — and are written out anyway, because the rule is the rule
 * whether or not a vector can reach it.
 *
 * Iteration is over CODE POINTS (`for…of`), not UTF-16 units, so an astral name
 * is copied through as one character rather than as two halves.
 */
const NAMED_C0 = new Map([[0x08, "\\b"], [0x09, "\\t"], [0x0a, "\\n"], [0x0c, "\\f"], [0x0d, "\\r"]]);
function canonicalString(value) {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (NAMED_C0.has(cp)) out += NAMED_C0.get(cp);
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** v2 §7: integers in their shortest decimal form — `2`, never `2.0` or `2e0`. */
function canonicalInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error(`not an exactly representable integer: ${value}`);
  return String(value);
}

/**
 * v2 §7: fixed key order `kind`, `name`, `size`, with `name` OMITTED ENTIRELY
 * — not empty — when the kind is `text`, and no whitespace anywhere.
 */
function canonicalItem(item) {
  const name = item.kind === "file" ? `,"name":${canonicalString(item.name)}` : "";
  return `{"kind":${canonicalString(item.kind)}${name},"size":${canonicalInteger(item.size)}}`;
}

/** v3 §2 + v2 §7: fixed key order `v`, `items`; item order is the SENDER's. */
function canonicalManifest(items) {
  return `{"v":${canonicalInteger(VERSION)},"items":[${items.map(canonicalItem).join(",")}]}`;
}

/** UTF-8 byte length. Every positional rule in v2 §8 is measured on these. */
const utf8 = (value) => Buffer.from(value, "utf8");

/**
 * v2 §8. Throws with the spec's own clause name.
 *
 * The drive-prefix check is the one that has to be spelled in bytes: in
 * `é:1.txt` the `:` sits at UTF-16 index 1 and at byte index 2, so a check
 * written against string indices refuses a name Go and Swift accept.
 */
function assertName(name) {
  if (typeof name !== "string") throw new Error(`name is not a string: ${JSON.stringify(name)}`);
  // A lone surrogate is not valid UTF-8; `Buffer` would silently substitute
  // U+FFFD and hide it, so it is detected on the string itself.
  if (/[\uD800-\uDFFF]/.test(name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))) {
    throw new Error(`name is not valid UTF-8 (lone surrogate): ${JSON.stringify(name)}`);
  }
  const bytes = utf8(name);
  if (bytes.length === 0) throw new Error("name is empty");
  if (bytes.length > BOUNDS.maxNameBytes) {
    throw new Error(`name is ${bytes.length} UTF-8 bytes, over ${BOUNDS.maxNameBytes}`);
  }
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) throw new Error(`name carries a C0/DEL control U+${cp.toString(16)}`);
  }
  if (name.includes("\\")) throw new Error(`name carries a backslash: ${JSON.stringify(name)}`);
  if (bytes[0] === 0x2f) throw new Error(`name is absolute: ${JSON.stringify(name)}`);
  if (bytes.length >= 2 && bytes[1] === 0x3a) throw new Error(`name has a drive prefix: ${JSON.stringify(name)}`);
  const components = name.split("/");
  if (components.length > BOUNDS.maxPathDepth) {
    throw new Error(`name has ${components.length} components, over ${BOUNDS.maxPathDepth}`);
  }
  for (const component of components) {
    if (component === "" || component === "." || component === "..") {
      throw new Error(`name has an empty, "." or ".." component: ${JSON.stringify(name)}`);
    }
  }
}

/**
 * v2 §6 and §10: `name` is present for `file` and ABSENT for `text` — not empty.
 * An empty string is something a receiver could be tempted to treat as a
 * destination; an absent key cannot be.
 */
function assertNameForKind(kind, name) {
  if (kind === "file") assertName(name);
  else if (name !== undefined) throw new Error("a text item carries a name");
}

/**
 * v2 §9 and §10, plus §6's kind agreement, over a whole item list.
 *
 * Returns the delivery's `kind` and its aggregate `total`, which are the two
 * derived scalars the fixture carries alongside `canonical`.
 *
 * The aggregate is summed INCREMENTALLY against the ceiling, exactly as the
 * spec requires, so a pair of sizes that each fit but whose sum does not cannot
 * pass by wrapping into something small.
 */
function deriveKindAndTotal(items) {
  if (!Array.isArray(items)) throw new Error("items is not an array");
  if (items.length < BOUNDS.minItems || items.length > BOUNDS.maxItems) {
    throw new Error(`items has ${items.length} entries, outside ${BOUNDS.minItems}…${BOUNDS.maxItems}`);
  }
  const kind = items[0].kind;
  if (!KINDS.includes(kind)) throw new Error(`unknown kind ${JSON.stringify(kind)}`);
  for (const item of items) {
    if (item.kind !== kind) throw new Error(`mixed kinds: ${JSON.stringify(item.kind)} after ${JSON.stringify(kind)}`);
    const keys = Object.keys(item).sort().join(",");
    const want = kind === "file" ? "kind,name,size" : "kind,size";
    if (keys !== want) throw new Error(`a ${kind} item's keys are [${keys}]; want [${want}]`);
  }
  if (kind === "text") {
    // §10: exactly one item, no `name` key (already enforced above), and the
    // message itself is never in the manifest.
    if (items.length !== 1) throw new Error(`a text delivery has ${items.length} items; want exactly 1`);
  }
  let total = 0;
  for (const item of items) {
    const { size } = item;
    if (!Number.isSafeInteger(size)) throw new Error(`size is not an exactly representable integer: ${size}`);
    if (kind === "file") {
      if (size < 0 || size > BOUNDS.maxSafeInteger) throw new Error(`file size ${size} is out of range`);
    } else if (size < BOUNDS.minTextBytes || size > BOUNDS.maxTextBytes) {
      throw new Error(`text size ${size} is outside ${BOUNDS.minTextBytes}…${BOUNDS.maxTextBytes}`);
    }
    assertNameForKind(kind, item.name);
    total += size;
    if (total > BOUNDS.maxSafeInteger) throw new Error(`the aggregate size ${total} is over the ceiling`);
  }
  return { kind, total };
}


// ─────────────────────────────────────────────────────────────────────────────
// The hybrid rewrite.
// ─────────────────────────────────────────────────────────────────────────────

let source;
try {
  source = readFileSync(FIXTURE, "utf8");
} catch (err) {
  throw new Error(
    `${FIXTURE} could not be read (${err.code ?? err.message}). This generator reads the`
    + ` hand-authored half of its own output, and is run with web/ as the working directory.`,
  );
}
const fixture = JSON.parse(source);

// The hand-authored half has to be the shape this generator was written for,
// before any of it is carried into a new file.
if (fixture.version !== VERSION) {
  throw new Error(`the fixture states version ${fixture.version}; this generator transcribes v${VERSION}`);
}
for (const [key, want] of Object.entries(BOUNDS)) {
  if (fixture.bounds?.[key] !== want) {
    throw new Error(
      `the fixture's bounds.${key} is ${JSON.stringify(fixture.bounds?.[key])}, but the spec`
      + ` transcription says ${want}. One of the two is wrong; neither may be quietly rewritten`
      + ` by the other.`,
    );
  }
}
if (!Array.isArray(fixture.accept) || fixture.accept.length === 0) {
  throw new Error("the fixture declares no accept vectors");
}

const ACCEPT_KEYS = ["name", "canonical", "kind", "total", "items"];
const accept = fixture.accept.map((vector, index) => {
  const label = `accept[${index}] ${JSON.stringify(vector.name ?? "")}`;
  const unknown = Object.keys(vector).filter((key) => !ACCEPT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} carries unknown key(s) [${unknown.join(", ")}]. This generator rebuilds accept`
      + ` cases key by key, so a field it does not know about would be silently dropped.`,
    );
  }
  if (typeof vector.name !== "string" || vector.name === "") throw new Error(`${label} has no name`);
  let derived;
  try {
    derived = deriveKindAndTotal(vector.items);
  } catch (err) {
    throw new Error(
      `${label} is declared ACCEPTABLE but the spec transcription refuses it: ${err.message}.`
      + ` An accept vector is an instruction to all three implementations to accept these bytes.`,
    );
  }
  // Derived, in the fixture's own key order. `vector.canonical`, `vector.kind`
  // and `vector.total` are deliberately not read: whatever is on disk is the
  // claim under test, not an input.
  return {
    name: vector.name,
    canonical: canonicalManifest(vector.items),
    kind: derived.kind,
    total: derived.total,
    items: vector.items,
  };
});

const out = {
  _: fixture._,
  version: fixture.version,
  bounds: fixture.bounds,
  accept,
  refuse: fixture.refuse,
  generated: fixture.generated,
};

/**
 * U+2028 and U+2029 stay ESCAPED in the outer file even though they are RAW
 * inside the canonical strings the file describes.
 *
 * The two are not in conflict. The canonical manifest bytes must carry them raw
 * — that is what the "U+2028 is raw here and escaped by some encoders" vector
 * pins — and inside a `canonical` string here they are one JSON escape away from
 * the same code point. What the outer file must not do is put a raw line
 * separator on a line of tracked JSON, where a diff tool, a terminal or a
 * JavaScript `eval` of the file would all disagree about how many lines it has.
 * `JSON.stringify` escapes neither, so they are escaped after the fact.
 */
// Built from code points rather than written literally: a raw line separator
// in this file would be the same hazard it is in the fixture.
const LINE_TERMINATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, "g");
const escaped = JSON.stringify(out, null, 2)
  .replace(LINE_TERMINATORS, (ch) => `\\u${ch.codePointAt(0).toString(16)}`);
writeFileSync(FIXTURE, `${escaped}\n`);

const derivedFiles = accept.filter((vector) => vector.kind === "file").length;
process.stdout.write(
  `wrote device-inbox-manifest-v3-vectors.json; derived canonical/kind/total for ${accept.length}`
  + ` accept vector(s) (${derivedFiles} file, ${accept.length - derivedFiles} text), carried`
  + ` ${fixture.refuse.length} refusal(s) and ${fixture.generated.length} generated boundary`
  + ` declaration(s) through unchanged\n`,
);
