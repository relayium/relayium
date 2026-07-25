import { webcrypto as nodeCrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
const crypto = nodeCrypto;

const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
const concat = (arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

// --- exact byte ops from web/src/lib/transfer.ts + web/src/lib/crypto.ts ---
const KIND_CHUNK = 1;
const KIND_ACK = 6;
const KIND_BATCH_ENC = 7;
const KIND_DONE_ENC = 8;
const CTRL_ACCEPT = 0xfe;
const CTRL_REJECT = 0xff;
const CTRL_COMPLETE = 0xfd;

// frame(kind, seq, payload) = [kind:1][seq:uint32 BE][payload]  (transfer.ts `frame`)
function frame(kind, seq, payload) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

// nonceFromSeq(seq): 12 bytes, high 4 zero, next 4 = hi32, next 4 = lo32 (crypto.ts)
function nonce(seq) {
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(4, Math.floor(seq / 2 ** 32));
  v.setUint32(8, seq >>> 0);
  return n;
}

async function seal(key, seq, plaintext) {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(seq) }, key, plaintext);
  return new Uint8Array(ct);
}

// chainHash(prev, chunk) = SHA-256(prev || chunk); starts at 32 zero bytes per file.
async function chainHash(prev, chunk) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat([prev, chunk])));
}

function ackFrame(n) {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, n);
  return frame(KIND_ACK, 0, payload);
}

// --- fixed session key (32 bytes) ---
const keyRaw = fromHex("66".repeat(32));
const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt", "decrypt"]);

// --- fixed files ---
const enc = new TextEncoder();
// The manifest carries RAW (unsanitized) names — only the receiver sanitizes,
// on decode, per web/src/lib/filename.ts's `sanitizeNames` (name + per-`/`-
// segment path). The second file's name and path deliberately embed a bidi
// control (U+202E, RLO) and a C0 control (U+0007, BEL) so the sealed BATCH
// frame actually contains characters that must be stripped — proving the
// Swift `sanitizeFileMeta` really strips rather than the golden vectors just
// happening to be clean already. Built via String.fromCodePoint, not literal
// characters, so this source file doesn't itself become a Trojan-source
// vector (RLO reorders anything after it in an editor) — see filename.ts's
// own comment for why.
const files = [
  { name: "a.txt", data: enc.encode("hello world") }, // 11 bytes, no path
  {
    name: "b" + String.fromCodePoint(0x202e) + "c.txt",
    data: enc.encode("xyz"),
    path: "sub" + String.fromCodePoint(0x202e) + "dir/" + "c" + String.fromCodePoint(0x07) + ".txt",
  }, // 3 bytes, path present, both segments carry a control char
];

// Expected receiver-side sanitized values — same strip logic as
// web/src/lib/filename.ts's `safeDisplayName`/`sanitizeNames`: Bidi_Control
// {U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069} + C0/C1
// {U+0000-U+001F, U+007F-U+009F} removed from `name` and from each `/`-
// separated segment of `path`. Copied as code-point-built regexes (not
// literal bidi characters) for the same Trojan-source reason as above.
const BIDI_CONTROL_RE = new RegExp(
  `[${String.fromCodePoint(0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069)}]`,
  "g",
);
const CONTROL_RE = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}]`,
  "g",
);
const safeDisplayName = (s) => s.replace(BIDI_CONTROL_RE, "").replace(CONTROL_RE, "");
const sanitizePath = (p) => p.split("/").map(safeDisplayName).join("/");
const sanitizedNames = files.map((f) => {
  const out = { name: safeDisplayName(f.name) };
  if (f.path !== undefined) out.path = sanitizePath(f.path);
  return out;
});

// manifest: {files:[{name,size,path?}]} — path key omitted when absent
const manifestObj = {
  files: files.map((f) => {
    const m = { name: f.name, size: f.data.length };
    if (f.path !== undefined) m.path = f.path;
    return m;
  }),
};
const manifestPt = enc.encode(JSON.stringify(manifestObj));

// sender seq counter starts at 0
let seq = 0;
const batchCt = await seal(key, seq, manifestPt);
const batchFrame = frame(KIND_BATCH_ENC, seq, batchCt);
seq++;

const framesHex = [hex(batchFrame)];
const doneHashes = [];

for (const f of files) {
  // one chunk (files are < CHUNK_SIZE)
  const hash = await chainHash(new Uint8Array(32), f.data);
  const chunkCt = await seal(key, seq, f.data);
  const chunkFrame = frame(KIND_CHUNK, seq, chunkCt);
  framesHex.push(hex(chunkFrame));
  seq++;

  const doneCt = await seal(key, seq, enc.encode(JSON.stringify({ sha256: hex(hash) })));
  const doneFrame = frame(KIND_DONE_ENC, seq, doneCt);
  framesHex.push(hex(doneFrame));
  doneHashes.push(hex(hash));
  seq++;
}

const frameStreamHex = framesHex.join("");
const ackHex = hex(ackFrame(1048576));

const out = {
  sessionKeyHex: hex(keyRaw),
  manifest: manifestObj,
  batchFrameHex: hex(batchFrame),
  files: files.map((f) => ({ dataHex: hex(f.data) })),
  frameStreamHex,
  framesHex,
  ackHex,
  controlHex: {
    accept: CTRL_ACCEPT.toString(16),
    reject: CTRL_REJECT.toString(16),
    complete: CTRL_COMPLETE.toString(16),
  },
  doneHashes,
  sanitizedNames,
};

writeFileSync("../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log(
  "wrote realtime-wire-vectors.json; frames:",
  framesHex.length,
  "frameStreamHex len:",
  frameStreamHex.length,
);
