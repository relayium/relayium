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
const KIND_RESUME_START = 4;
const KIND_RESUME_REQ = 5;
const KIND_ACK = 6;
const KIND_BATCH_ENC = 7;
const KIND_DONE_ENC = 8;
const KIND_TEXT_ENC = 9;
const KIND_CHUNK_PART = 10;
const KIND_BATCH_PART = 11;
const CTRL_ACCEPT = 0xfe;
const CTRL_REJECT = 0xff;
const CTRL_COMPLETE = 0xfd;

// transfer.ts's protocol constants. CHUNK_SIZE is the LOGICAL unit the hash
// chain, the checkpoint grid and every resume point are defined in; it does not
// vary with the connection. piecePlainBytes is the number that does.
const CHUNK_SIZE = 192 * 1024;
const CHUNK_OVERHEAD = 5 + 16;
const MIN_PIECE_BYTES = 4096;
// web/src/lib/wire-limit.ts
const CHROME_MAX_MESSAGE_BYTES = 262_144;
const CONSERVATIVE_MAX_MESSAGE_BYTES = 65_536;

function piecePlainBytes(maxFrameBytes) {
  const usable = Math.min(Math.floor(maxFrameBytes) - CHUNK_OVERHEAD, CHUNK_SIZE);
  if (!(usable >= MIN_PIECE_BYTES)) throw new Error(`maxFrameBytes ${maxFrameBytes} too small`);
  return usable;
}

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

// ── message (kind 9) frames ────────────────────────────────────────────────
// These were previously appended to the fixture by hand, which meant a rerun of
// this generator would silently DELETE them and break the Swift text-frame
// tests. They are a pure function of (key, seq, body), so they are reproduced
// here instead — regenerating the fixture is now byte-identical rather than
// lossy. The bodies are written with explicit escapes: the second one ends in
// `e` + COMBINING ACUTE (U+0301), NOT precomposed U+00E9, and the two differ by
// two bytes of ciphertext.
const textKeyRaw = fromHex("7006ef36a5f62f92dbfa01bdef3ddb3e5edb1cda4517679539b0491d97d5eade");
const textKey = await crypto.subtle.importKey("raw", textKeyRaw, "AES-GCM", false, ["encrypt", "decrypt"]);
const textBodies = [
  "relayium message",
  "\u4f60\u597d \u0645\u0631\u062d\u0628\u0627 \ud83c\udf0d e\u0301",
  "  \tif x:\n\n\t\tprintf %s hello\n   \r\n  trailing   ",
];
const textFrames = [];
for (let i = 0; i < textBodies.length; i++) {
  const ct = await seal(textKey, i, enc.encode(textBodies[i]));
  textFrames.push({ seq: i, body: textBodies[i], frameHex: hex(frame(KIND_TEXT_ENC, i, ct)) });
}

// ── transport fragmentation and durable resume ─────────────────────────────
//
// Everything below reproduces transfer.ts's `Sender.pieces` / `Sender.dataFrames`
// / `Sender.batchFrames` / `Sender.resumeStartFrame` exactly, so the Swift port
// is pinned to Web-generated bytes rather than to a second reading of the spec.

/**
 * How the multi-megabyte parts of this fixture stay a few kilobytes without
 * stopping being an exact byte pin.
 *
 * A whole resumed transfer is ~600 KB of plaintext and as much again of
 * ciphertext; as hex that is a >7 MB file in Git for every regeneration. So
 * bodies are described by (size, seed) and pinned by SHA-256, and frame streams
 * are described per frame by (kind, seq, length) and pinned by one SHA-256 over
 * their exact concatenation. A Swift port that produces a single different byte
 * — a wrong nonce, a wrong kind, a re-sent chunk, a rewound seq — fails the
 * digest just as it would fail a hex comparison. Small frames (control frames,
 * manifests) keep their full hex, because reading them is worth more than the
 * bytes they cost.
 */
async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** A frame stream as (kind, seq, length) per frame plus a digest over the exact
 *  concatenated bytes. */
async function frameStream(frames) {
  return {
    count: frames.length,
    frames: frames.map((f) => ({
      kind: f[0],
      seq: new DataView(f.buffer, f.byteOffset).getUint32(1),
      length: f.length,
    })),
    streamSha256: await sha256Hex(concat(frames)),
  };
}

/** Deterministic, incompressible-enough content: an all-zero file passes even a
 *  broken reassembly. Same xorshift as web/src/lib/transfer-fragmentation.test.ts. */
function content(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** transfer.ts `Sender.pieces`: cut one plaintext into sealed frames of at most
 *  `pieceBytes` payload, the last carrying `finalKind`. An empty plaintext still
 *  yields exactly one (final) frame; an exact multiple yields no trailing empty
 *  one. Each piece consumes its own seq. */
async function* pieces(state, plain, pieceBytes, partKind, finalKind) {
  let off = 0;
  for (;;) {
    const end = Math.min(off + pieceBytes, plain.length);
    const last = end >= plain.length;
    const s = state.seq++;
    yield frame(last ? finalKind : partKind, s, await seal(state.key, s, plain.slice(off, end)));
    if (last) return;
    off = end;
  }
}

/** transfer.ts `Sender.batchFrames`. */
async function batchFrames(state, metas, maxFrameBytes) {
  const payload = enc.encode(JSON.stringify({ files: metas }));
  const out = [];
  for await (const f of pieces(state, payload, piecePlainBytes(maxFrameBytes), KIND_BATCH_PART, KIND_BATCH_ENC)) {
    out.push(f);
  }
  return out;
}

/** transfer.ts `resumePointAligned`. */
function resumePointAligned(p, sizes) {
  const size = sizes[p.index];
  if (size === undefined) return false;
  return p.offset === size || p.offset % CHUNK_SIZE === 0;
}

/** transfer.ts `Sender.dataFrames`: files before `resume.index` are skipped,
 *  file `resume.index` streams from `resume.offset` — but every chunk is hashed
 *  from byte 0, so the per-file DONE still covers the whole file. */
async function dataFrames(state, bodies, resume, maxFrameBytes) {
  const pieceBytes = piecePlainBytes(maxFrameBytes);
  if (resume && !resumePointAligned(resume, bodies.map((b) => b.length))) {
    throw new Error("resume point is not on a chunk boundary");
  }
  const out = [];
  for (let fi = 0; fi < bodies.length; fi++) {
    if (resume && fi < resume.index) continue;
    const body = bodies[fi];
    const from = resume && fi === resume.index ? resume.offset : 0;
    let hash = new Uint8Array(32);
    for (let offset = 0; offset < body.length; offset += CHUNK_SIZE) {
      const piece = body.slice(offset, offset + CHUNK_SIZE);
      hash = await chainHash(hash, piece);
      if (offset >= from) {
        for await (const f of pieces(state, piece, pieceBytes, KIND_CHUNK_PART, KIND_CHUNK)) out.push(f);
      }
    }
    const ds = state.seq++;
    out.push(frame(KIND_DONE_ENC, ds, await seal(state.key, ds, enc.encode(JSON.stringify({ sha256: hex(hash) })))));
  }
  return out;
}

/** transfer.ts `Sender.resumeStartFrame`: plaintext, consumes no seq, announces
 *  the seq the FIRST resumed protected frame will carry. */
function resumeStartFrame(state, point) {
  return frame(KIND_RESUME_START, 0, enc.encode(JSON.stringify({ ...point, seq: state.seq })));
}

/** transfer.ts `resumeReqFrame`: receiver -> sender, plaintext, canonical key order. */
function resumeReqFrame(index, offset) {
  return frame(KIND_RESUME_REQ, 0, enc.encode(JSON.stringify({ index, offset })));
}

async function newState(keyHex) {
  const raw = fromHex(keyHex);
  return { seq: 0, keyHex, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
}

// --- the control frames, on their own ---
const resumeSection = {
  reqPoint: { index: 3, offset: 987654 },
  reqFrameHex: hex(resumeReqFrame(3, 987654)),
  // A canonical RESUME_START for {index,offset} at a known seq, in Web key order
  // ({...point, seq}) — index, offset, then seq.
  startPoint: { index: 1, offset: 2 * CHUNK_SIZE, seq: 9 },
  startFrameHex: hex(resumeStartFrame({ seq: 9 }, { index: 1, offset: 2 * CHUNK_SIZE })),
};

// --- fragmentation: a manifest AND a multi-chunk file over a 64 KiB peer ---
const fragKeyHex = "77".repeat(32);
const fragBodies = [content(CHUNK_SIZE * 2 + 5, 33), new Uint8Array(0), content(9, 42)];
const fragMetas = fragBodies.map((b, i) => ({ name: `frag-${i}.bin`, size: b.length }));
const fragState = await newState(fragKeyHex);
const fragBatch = await batchFrames(fragState, fragMetas, CONSERVATIVE_MAX_MESSAGE_BYTES);
const fragData = await dataFrames(fragState, fragBodies, undefined, CONSERVATIVE_MAX_MESSAGE_BYTES);
const fragmentation = {
  keyHex: fragKeyHex,
  maxFrameBytes: CONSERVATIVE_MAX_MESSAGE_BYTES,
  pieceBytes: piecePlainBytes(CONSERVATIVE_MAX_MESSAGE_BYTES),
  manifest: { files: fragMetas },
  bodies: [
    { size: fragBodies[0].length, seed: 33, sha256: await sha256Hex(fragBodies[0]) },
    { size: 0, seed: 0, sha256: await sha256Hex(fragBodies[1]) },
    { size: fragBodies[2].length, seed: 42, sha256: await sha256Hex(fragBodies[2]) },
  ],
  batchFramesHex: fragBatch.map(hex),
  dataFrames: await frameStream(fragData),
  // The logical chunks the receiver must reassemble, whatever carried them.
  logicalChunkLengths: [CHUNK_SIZE, CHUNK_SIZE, 5, 9],
  doneHashes: await Promise.all(fragBodies.map(async (b) => {
    let h = new Uint8Array(32);
    for (let o = 0; o < b.length; o += CHUNK_SIZE) h = await chainHash(h, b.slice(o, o + CHUNK_SIZE));
    return hex(h);
  })),
};

// --- durable resume across a CHANGE of negotiated message size ---
// Attempt 1 runs on a desktop-class connection (whole chunks, no PART). Two
// chunks are durably written; the third is emitted and lost with the transport.
// The replacement connection negotiates only 64 KiB, so the SAME sender — with
// its seq counter never rewound — refragments the rest.
const durKeyHex = "88".repeat(32);
const durBody = content(CHUNK_SIZE * 3 + 1234, 61);
const durMeta = [{ name: "big.bin", size: durBody.length }];
const durState = await newState(durKeyHex);
const durBatch = await batchFrames(durState, durMeta, CHROME_MAX_MESSAGE_BYTES);
const durFirst = await dataFrames(durState, [durBody], undefined, CHROME_MAX_MESSAGE_BYTES);
// Attempt 1 stops after the receiver has durably written two logical chunks.
// dataFrames emitted every frame; the ones past the checkpoint are the
// sent-but-not-durable ones whose seqs are burned and never reused.
const durDelivered = durFirst.slice(0, 2);
const durLost = durFirst.slice(2);
const durCheckpoint = { index: 0, offset: CHUNK_SIZE * 2 };
let durChain = new Uint8Array(32);
for (let o = 0; o < durCheckpoint.offset; o += CHUNK_SIZE) {
  durChain = await chainHash(durChain, durBody.slice(o, o + CHUNK_SIZE));
}
// The sender's counter after attempt 1: BATCH + 4 emitted data frames + DONE.
const durResumeStart = resumeStartFrame(durState, durCheckpoint);
const durResumeSeq = durState.seq;
const durResumed = await dataFrames(durState, [durBody], durCheckpoint, CONSERVATIVE_MAX_MESSAGE_BYTES);
const durableResume = {
  keyHex: durKeyHex,
  manifest: { files: durMeta },
  body: { size: durBody.length, seed: 61, sha256: await sha256Hex(durBody) },
  firstMaxFrameBytes: CHROME_MAX_MESSAGE_BYTES,
  resumedMaxFrameBytes: CONSERVATIVE_MAX_MESSAGE_BYTES,
  batchFramesHex: durBatch.map(hex),
  deliveredFrames: await frameStream(durDelivered),
  lostFrames: await frameStream(durLost),
  checkpoint: durCheckpoint,
  chainAtCheckpointHex: hex(durChain),
  resumeReqHex: hex(resumeReqFrame(durCheckpoint.index, durCheckpoint.offset)),
  resumeStartHex: hex(durResumeStart),
  resumeSeq: durResumeSeq,
  resumedFrames: await frameStream(durResumed),
  doneHashHex: await (async () => {
    let h = new Uint8Array(32);
    for (let o = 0; o < durBody.length; o += CHUNK_SIZE) h = await chainHash(h, durBody.slice(o, o + CHUNK_SIZE));
    return hex(h);
  })(),
};

// --- multi-file checkpoints: the exact end of a file, and a later file ---
const mfKeyHex = "99".repeat(32);
const mfBodies = [content(CHUNK_SIZE + 3, 41), content(9, 42), content(CHUNK_SIZE * 2, 43)];
const mfMetas = mfBodies.map((b, i) => ({ name: `mf-${i}.bin`, size: b.length }));
const mfCases = [];
for (const point of [
  { index: 0, offset: mfBodies[0].length },   // the exact end of file 0
  { index: 2, offset: 0 },                    // a later file, nothing of it written
  { index: 2, offset: CHUNK_SIZE },           // mid-file on the chunk grid
]) {
  // A resumed batch never re-sends BATCH: consent was given once and the
  // manifest is already authenticated. The sender's counter continues from
  // wherever attempt 1 left it — modelled here as a fixed non-zero start.
  const st = await newState(mfKeyHex);
  st.seq = 17;
  const start = resumeStartFrame(st, point);
  const seqAtResume = st.seq;
  const frames = await dataFrames(st, mfBodies, point, CONSERVATIVE_MAX_MESSAGE_BYTES);
  mfCases.push({
    point,
    seqAtResume,
    resumeStartHex: hex(start),
    frames: await frameStream(frames),
    resumeReqHex: hex(resumeReqFrame(point.index, point.offset)),
  });
}
const multiFileResume = {
  keyHex: mfKeyHex,
  manifest: { files: mfMetas },
  bodies: mfBodies.map((b, i) => ({ size: b.length, seed: [41, 42, 43][i] })),
  maxFrameBytes: CONSERVATIVE_MAX_MESSAGE_BYTES,
  cases: mfCases,
};

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
  text: { kind: KIND_TEXT_ENC, maxBytes: 64 * 1024, keyHex: hex(textKeyRaw), frames: textFrames },
  kinds: {
    chunk: KIND_CHUNK,
    chunkPart: KIND_CHUNK_PART,
    batchEnc: KIND_BATCH_ENC,
    batchPart: KIND_BATCH_PART,
    resumeStart: KIND_RESUME_START,
    resumeReq: KIND_RESUME_REQ,
    doneEnc: KIND_DONE_ENC,
  },
  limits: { chunkSize: CHUNK_SIZE, chunkOverhead: CHUNK_OVERHEAD, minPieceBytes: MIN_PIECE_BYTES },
  resume: resumeSection,
  fragmentation,
  durableResume,
  multiFileResume,
};

writeFileSync("../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log(
  "wrote realtime-wire-vectors.json; frames:",
  framesHex.length,
  "frameStreamHex len:",
  frameStreamHex.length,
);
