// The Device Inbox v3 encrypted manifest — the small authenticated JSON
// document a sender seals at frame 0 of a delivery, describing what the frames
// after it contain.
//
// This is the TypeScript third of one codec. The other two are
// `server/internal/inboxmanifest` and RelayiumKit's `InboxManifest.swift`, and
// all three are checked against the same frozen vectors in
// `apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json`.
//
// It is DELIBERATELY separate from `manifest.ts`/`store-crypto.ts`, the shared
// Stored-Wire manifest. Those bytes are frozen and interop-tested across
// unrelated products; teaching them a content kind would change what a public
// share object looks like. This one is free to be stricter, and is.
//
// INVARIANTS:
//
//  1. KIND IS SEALED. Content kind exists here and nowhere else. Central holds
//     ciphertext, so a message and a file delivery are indistinguishable to it.
//  2. ONE KIND PER DELIVERY. A mixed manifest is refused, not partly honoured:
//     a receiver would otherwise have to write half a delivery into the user's
//     receive folder and half into the message store.
//  3. CANONICAL OR REFUSED. There is exactly ONE byte sequence per manifest.
//     `decodeInboxManifest` re-encodes what it parsed and requires equality, so
//     reordered keys, duplicates, whitespace and dropped fields are refusals.
//  4. AEAD IS NOT VALIDATION. Decryption proves who wrote the bytes and nothing
//     about whether their numbers and names are safe to act on.
//  5. TEXT IS NOT IN HERE. A message's bytes travel in the encrypted frames;
//     the manifest carries only its length.

export const INBOX_MANIFEST_VERSION = 3;

/** Item-count bounds. `MAX` matches the shared manifest's, so a folder that can
 *  be shared can also be sent to a device. */
export const INBOX_MANIFEST_MAX_ITEMS = 1000;
export const INBOX_MANIFEST_MIN_ITEMS = 1;

/** One file name, in UTF-8 BYTES — the filesystem limit it eventually meets is
 *  a byte limit, not a character one. */
export const INBOX_MANIFEST_MAX_NAME_BYTES = 1024;

/** "/"-separated components in one name. A name may be a relative path so a
 *  folder send keeps its shape; this stops a thousand-deep demanded tree. */
export const INBOX_MANIFEST_MAX_PATH_DEPTH = 64;

/** JavaScript's exact-integer ceiling, and therefore the protocol's. A size
 *  only Go and Swift could represent exactly would decode differently here. */
export const INBOX_MANIFEST_MAX_SAFE_INTEGER = 9007199254740991;

/** Message length bounds, in UTF-8 bytes of the message itself. 1 because an
 *  empty message is not a message; 64 KiB because that is far more than anyone
 *  types and small enough for a receiver to hold one in memory to show it. */
export const INBOX_MANIFEST_MIN_TEXT_BYTES = 1;
export const INBOX_MANIFEST_MAX_TEXT_BYTES = 65536;

/** The closed content-kind set. A delivery is files or it is a message; there
 *  is no third value and no "unknown" a receiver could guess at. */
export type InboxManifestKind = "file" | "text";

/** Why a manifest was refused. A closed set rather than message text, so a
 *  caller branches on the reason and the frozen vectors can pin each clause. */
export type InboxManifestReason =
  | "version"
  | "itemCount"
  | "unknownKind"
  | "mixedKinds"
  | "name"
  | "textName"
  | "textItemCount"
  | "size"
  | "totalOverflow"
  | "malformed"
  | "notCanonical";

export class InboxManifestError extends Error {
  readonly reason: InboxManifestReason;
  constructor(reason: InboxManifestReason, detail: string) {
    super(`relayium: inbox manifest ${reason}: ${detail}`);
    this.name = "InboxManifestError";
    this.reason = reason;
  }
}

/** One entry. `name` is present for a file and ABSENT for text — not empty,
 *  absent — because text has no name and a receiver must never be handed a
 *  string it could be tempted to treat as a destination. */
export interface InboxManifestItem {
  kind: InboxManifestKind;
  name?: string;
  size: number;
}

export interface InboxManifest {
  v: typeof INBOX_MANIFEST_VERSION;
  items: InboxManifestItem[];
}

const utf8 = new TextEncoder();

function fail(reason: InboxManifestReason, detail: string): never {
  throw new InboxManifestError(reason, detail);
}

// ── construction ───────────────────────────────────────────────────────────

/** Build a validated file manifest. The constructors exist so no caller
 *  assembles an object literal and skips the bounds. */
export function fileManifest(items: { name: string; size: number }[]): InboxManifest {
  const m: InboxManifest = {
    v: INBOX_MANIFEST_VERSION,
    items: items.map((f) => ({ kind: "file" as const, name: f.name, size: f.size })),
  };
  validateInboxManifest(m);
  return m;
}

/** Build the one-item manifest for a message of `size` UTF-8 bytes. */
export function textManifest(size: number): InboxManifest {
  const m: InboxManifest = { v: INBOX_MANIFEST_VERSION, items: [{ kind: "text", size }] };
  validateInboxManifest(m);
  return m;
}

/** The single kind of a VALID manifest. */
export function inboxManifestKind(m: InboxManifest): InboxManifestKind {
  return m.items[0].kind;
}

/** Sum of item sizes. Safe only on a validated manifest, where the sum is
 *  already known not to exceed the exact-integer ceiling. */
export function inboxManifestTotal(m: InboxManifest): number {
  return m.items.reduce((sum, it) => sum + it.size, 0);
}

// ── validation ─────────────────────────────────────────────────────────────

/** Apply every bound, in a fixed order, and throw on the FIRST violation.
 *
 *  The order is part of the contract, matched by the Go and Swift codecs: the
 *  version, then the shape, then per-item rules, then the aggregate — so a v1
 *  document is reported as a version problem rather than as whatever its items
 *  happen to look like. */
export function validateInboxManifest(m: InboxManifest): void {
  if (m.v !== INBOX_MANIFEST_VERSION) fail("version", String(m.v));
  const items = m.items;
  if (!Array.isArray(items) || items.length < INBOX_MANIFEST_MIN_ITEMS || items.length > INBOX_MANIFEST_MAX_ITEMS) {
    fail("itemCount", String(Array.isArray(items) ? items.length : typeof items));
  }
  const kind = items[0].kind;
  if (kind !== "file" && kind !== "text") fail("unknownKind", String(kind));
  // Checked against item 0 rather than against a permitted set, so "all text
  // except one file" and "all files except one text" are refused by one rule.
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== kind) fail("mixedKinds", `item ${i} is ${items[i].kind}, item 0 is ${kind}`);
  }

  if (kind === "text") {
    // One message per delivery. A second text item would have no way to be told
    // apart from the first in the frame stream, since text carries no name.
    if (items.length !== 1) fail("textItemCount", String(items.length));
    const it = items[0];
    if (it.name !== undefined) fail("textName", "a text item has no name");
    if (!Number.isInteger(it.size) || it.size < INBOX_MANIFEST_MIN_TEXT_BYTES || it.size > INBOX_MANIFEST_MAX_TEXT_BYTES) {
      fail("size", `text of ${it.size} bytes`);
    }
    return;
  }

  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const nameProblem = nameProblemOf(it.name);
    if (nameProblem) fail("name", `at index ${i}: ${nameProblem}`);
    // Zero is legal — an empty file is a real file — but negative is not, and
    // neither is a value this runtime cannot hold exactly.
    if (!Number.isSafeInteger(it.size) || it.size < 0) fail("size", `at index ${i}: ${it.size}`);
    total += it.size;
    if (!Number.isSafeInteger(total)) fail("totalOverflow", `at index ${i}`);
  }
}

/** The traversal-and-control rule, and it is deliberately PLATFORM-NEUTRAL:
 *  exactly these names are accepted on every receiver, so one manifest is
 *  accepted or refused identically everywhere. A name that only some of a
 *  user's devices would take is worse than one none of them would.
 *
 *  Platform-specific hardening — Windows reserved device names, components
 *  ending in a dot or a space — belongs to the receiver's destination planner,
 *  which knows the filesystem it is about to write to. It runs after this, never
 *  instead of it.
 *
 *  Returns a reason string, or `null` when the name is acceptable. */
function nameProblemOf(name: string | undefined): string | null {
  if (typeof name !== "string") return "missing";
  if (name === "") return "empty";
  if (!isWellFormedUTF16(name)) return "not valid UTF-8";
  // Every positional rule below is measured on the UTF-8 BYTES, not on this
  // runtime's UTF-16 code units, because the other two implementations see
  // bytes. `"é:1.txt"` has ":" at STRING index 1 and a continuation byte at
  // BYTE index 1; reading the string index here refused a name Go and Swift
  // accept, and a name only some of a user's devices take is precisely what
  // this rule exists to prevent.
  const bytes = utf8.encode(name);
  if (bytes.length > INBOX_MANIFEST_MAX_NAME_BYTES) return "too long";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    // C0 controls and DEL: bytes that truncate a C string or rewrite a terminal
    // line as the name is logged or displayed.
    if (c < 0x20 || c === 0x7f) return `control character at offset ${i}`;
  }
  // "/" is the separator by protocol. A backslash means "separator" on Windows,
  // so the same manifest would otherwise produce different trees on different
  // receivers.
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/")) return "absolute path";
  // "C:foo" is drive-relative and "C:/foo" drive-absolute on Windows; both
  // escape a receive folder there while looking ordinary here. Byte index 1,
  // matching Go's `name[1]` and Swift's `bytes[1]`.
  if (bytes.length >= 2 && bytes[1] === 0x3a) return "drive-qualified path";
  const parts = name.split("/");
  if (parts.length > INBOX_MANIFEST_MAX_PATH_DEPTH) return "too deeply nested";
  for (const p of parts) {
    if (p === "") return "empty path component";
    if (p === "." || p === "..") return `"${p}" path component`;
  }
  return null;
}

/** True when every surrogate in the string is paired. A lone surrogate has no
 *  UTF-8 encoding, so it is a name the other two implementations could not
 *  agree with us about. `String.prototype.isWellFormed` is not assumed. */
function isWellFormedUTF16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// ── the canonical form ─────────────────────────────────────────────────────

/** Return the ONE canonical string for `m`, after validating it.
 *
 *  Hand-written rather than `JSON.stringify` — even though this runtime's
 *  `JSON.stringify` happens to agree — because the rule has to be stated
 *  somewhere all three languages can implement identically, and two of them
 *  have no `JSON.stringify` to lean on. Go's encoder escapes `<`, `>`, `&` and
 *  U+2028/U+2029; Swift's does not guarantee key order at all.
 *
 *  The rules: no whitespace, fixed key order (`v`, `items`; then `kind`,
 *  `name`, `size`), `name` omitted entirely for text, `"` `\` and the C0
 *  controls escaped (`\b \t \n \f \r` by name, the rest as lowercase
 *  `\u00xx`), everything else — DEL, C1 controls, bidi overrides, all
 *  non-ASCII — emitted raw, and `/` never escaped. */
export function encodeInboxManifest(m: InboxManifest): string {
  validateInboxManifest(m);
  let out = `{"v":${m.v},"items":[`;
  for (let i = 0; i < m.items.length; i++) {
    const it = m.items[i];
    if (i > 0) out += ",";
    out += `{"kind":"${it.kind}"`; // a closed set; no escapable character can occur
    if (it.kind === "file") out += `,"name":"${escapeJSONString(it.name!)}"`;
    out += `,"size":${it.size}}`;
  }
  return out + "]}";
}

/** The canonical bytes, which is what actually gets sealed. */
export function encodeInboxManifestBytes(m: InboxManifest): Uint8Array {
  return utf8.encode(encodeInboxManifest(m));
}

function escapeJSONString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        out += c < 0x20 ? `\\u${c.toString(16).padStart(4, "0")}` : s[i];
    }
  }
  return out;
}

// ── decoding ───────────────────────────────────────────────────────────────

/** Parse, validate, and refuse anything that is not the canonical spelling of
 *  what was parsed (invariant 3).
 *
 *  The canonical-form check is what makes this strict without a hand-written
 *  parser: a duplicate `"size"` key where the last wins, `{"items":…,"v":2}` in
 *  the wrong order, `2.0` for `2`, a trailing newline and an escaped `\/` are
 *  all things `JSON.parse` absorbs silently and the re-encode catches. */
export function decodeInboxManifest(input: string | Uint8Array): InboxManifest {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      // `fatal` so invalid UTF-8 is a refusal rather than a string full of
      // replacement characters that would then fail a confusing later check.
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      fail("malformed", "not valid UTF-8");
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail("malformed", e instanceof Error ? e.message : "unparseable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("malformed", "not a JSON object");
  }
  const raw = parsed as Record<string, unknown>;

  // The version is read FIRST, and that ordering is part of the contract rather
  // than an accident. A v1 document is `{"files":[…]}` — no `v` at all. Refused
  // by the unknown-key check below it would be "unknown field: files", which is
  // true and useless; refused here it is "unsupported version", which a person
  // can act on. All three implementations agree on this order.
  const v = raw.v;
  if (v === undefined || v === null) fail("version", "absent");
  if (typeof v !== "number") fail("malformed", `v is ${typeof v}`);
  if (v !== INBOX_MANIFEST_VERSION) fail("version", String(v));

  for (const key of Object.keys(raw)) {
    if (key !== "v" && key !== "items") fail("malformed", `unknown field ${JSON.stringify(key)}`);
  }
  const rawItems = raw.items;
  if (rawItems === undefined) fail("itemCount", "absent");
  if (!Array.isArray(rawItems)) fail("malformed", "items is not an array");

  // Structural pass over EVERY item before any semantic rule, matching the Go
  // decoder, where types and unknown fields are settled by the decoder itself
  // before validation begins. Without this the two would disagree about which
  // complaint a document with both problems earns.
  const items: InboxManifestItem[] = rawItems.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("malformed", `item ${i} is not an object`);
    }
    const o = entry as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (key !== "kind" && key !== "name" && key !== "size") {
        fail("malformed", `item ${i} has unknown field ${JSON.stringify(key)}`);
      }
    }
    if (o.kind === undefined) fail("unknownKind", `item ${i} has no kind`);
    if (typeof o.kind !== "string") fail("malformed", `item ${i} kind is ${typeof o.kind}`);
    if (o.kind !== "file" && o.kind !== "text") fail("unknownKind", `item ${i}: ${o.kind}`);
    if (o.name !== undefined && typeof o.name !== "string") {
      fail("malformed", `item ${i} name is ${typeof o.name}`);
    }
    if (typeof o.size !== "number" || !Number.isInteger(o.size)) {
      fail("malformed", `item ${i} size is not an integer`);
    }
    const it: InboxManifestItem = { kind: o.kind as InboxManifestKind, size: o.size };
    if (o.name !== undefined) it.name = o.name as string;
    return it;
  });

  const m: InboxManifest = { v: INBOX_MANIFEST_VERSION, items };
  validateInboxManifest(m);
  if (encodeInboxManifest(m) !== text) fail("notCanonical", "not the canonical spelling");
  return m;
}
