import { webcrypto as nodeCrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
const crypto = nodeCrypto;

const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));

// --- constants (must equal store-crypto.ts) ---
const STORE_CHUNK_SIZE = 192 * 1024;
const FRAME_OVERHEAD = 4 + 16;

function nonce(seq) {
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(4, Math.floor(seq / 2 ** 32));
  v.setUint32(8, seq >>> 0);
  return n;
}
function encodeKey(raw) {
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function frame(ct) {
  const out = new Uint8Array(4 + ct.length);
  new DataView(out.buffer).setUint32(0, ct.length);
  out.set(ct, 4);
  return out;
}
function cipherSizeFor(sizes) {
  let n = 0;
  for (const s of sizes) n += s + FRAME_OVERHEAD * Math.ceil(s / STORE_CHUNK_SIZE);
  return n;
}

// fixed key
const keyRaw = fromHex("55".repeat(32));
const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt", "decrypt"]);

// files (small, deterministic). Note the bidi char U+202E in the 2nd name.
const files = [
  { name: "hello.txt", data: new TextEncoder().encode("hello world") }, // 11 bytes
  { name: `a${String.fromCodePoint(0x202e)}b.txt`, data: new TextEncoder().encode("xyz") }, // 3 bytes
];

// manifest: raw (unsanitized) names + sizes matching data length
const manifestObj = { files: files.map((f) => ({ name: f.name, size: f.data.length })) };
const manifestPt = new TextEncoder().encode(JSON.stringify(manifestObj));
const manifestCt = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(0) }, key, manifestPt));

// frames: seq 1,2,… (each file < chunk → one frame)
let seq = 1;
const parts = [];
for (const f of files) {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(seq) }, key, f.data));
  parts.push(frame(ct));
  seq++;
}
const stream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
{
  let o = 0;
  for (const p of parts) {
    stream.set(p, o);
    o += p.length;
  }
}

// sanitize expectations (safeDisplayName): strip bidi controls + C0/C1.
// Copied verbatim (as code-point-built regexes, not literal bidi characters in
// source — see filename.ts's own comment on why) from web/src/lib/filename.ts.
const BIDI_CONTROL_RE = new RegExp(
  `[${String.fromCodePoint(0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069)}]`,
  "g",
);
const CONTROL_RE = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}]`,
  "g",
);
const safe = (s) => s.replace(BIDI_CONTROL_RE, "").replace(CONTROL_RE, "");

const secondName = files[1].name;
const out = {
  keyHex: hex(keyRaw),
  keyB64url: encodeKey(keyRaw),
  manifest: { json: manifestObj, ctHex: hex(manifestCt), sanitizedNames: files.map((f) => safe(f.name)) },
  files: files.map((f) => ({ name: f.name, dataHex: hex(f.data) })),
  streamHex: hex(stream),
  cipherSize: cipherSizeFor(files.map((f) => f.data.length)),
  plaintextBytes: files.reduce((n, f) => n + f.data.length, 0),
  sanitize: { in: secondName, out: safe(secondName) },
};
writeFileSync("../apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote store-wire-vectors.json; cipherSize", out.cipherSize, "sanitizedNames", out.manifest.sanitizedNames);
