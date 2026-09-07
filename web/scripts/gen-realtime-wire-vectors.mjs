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

// --- capability negotiation: the one thing both clients must agree on before
// --- anybody dials, and the only part of `link/1` nothing pinned across the two
// --- languages until now.
//
// It is here rather than in a Swift or TS literal because the drift this catches
// had already happened: `LinkWebWorkspaceInteropTests` hard-coded the browser's
// hello as two capabilities and called it "capsSignal() verbatim", while
// `peer-caps.test.ts` pinned the browser to three. Both tests passed. Nothing in
// the repository could see that they disagreed, because the path filters mean no
// commit ever runs both suites (macos.yml triggers on apps/**, web.yml on web/**).
const CAP_TEXT = "text/1";
const CAP_LINK = "link/1";
const CAP_PREUPLOAD = "preupload/1";

// `LinkCapabilityAnnouncer` (Swift) and `CapsAnnouncer` (TS). Both rooms, both
// languages, one cadence: three attempts at 1.5s land at 0, 1.5 and 3.0 seconds,
// every one inside `settleSeconds` below. A client whose last attempt landed
// after that window would be announcing to a peer that had already committed to
// a legacy lane it cannot come back from.
const capsRetry = { attempts: 3, intervalMs: 1_500 };
// `LinkWorkspaceModel.pairingCapabilityWait`.
const capsSettleSeconds = 5;

const capability = {
  // The roster-level hello each client sends, byte-exact. They are NOT equal,
  // and that is the point of writing both down: the browser announces the
  // pre-upload handoff the native clients do not implement, so a test that
  // asserts one client's frame as if it were the other's is asserting a fiction.
  hello: {
    // The browser no longer announces `text/1`: the single-lane conversation
    // transport behind that capability is gone, so announcing it invited a peer
    // onto a lane the page could not open. The two hellos therefore no longer
    // stand in a subset relation in EITHER direction, and the contract they
    // share is narrower and exact — both must name `link/1`, and that is the one
    // capability either side may act on. See `advertisedCaps` (peer-caps) and
    // `testBothHellosNameTheSameExactLink` (LinkCapabilityVectorTests).
    web: { caps: [CAP_LINK, CAP_PREUPLOAD] },
    native: { caps: [CAP_TEXT, CAP_LINK] },
    // What a NATIVE client announces in a room where link mode is not allowed —
    // an iOS pairing room today, and any future narrowed scope.
    //
    // The name is now wider than the thing, and is kept anyway. It reads as
    // "either client's inactive hello", which stopped being true when the
    // browser withdrew `text/1`: a browser that cannot open a link announces an
    // EMPTY hello, because withdrawing `text/1` left it nothing else it can
    // honour. Renaming the key to say so is a one-line improvement that breaks
    // every Swift reader of it — `LinkWebWorkspaceInteropTests` reads it by this
    // exact string — for no behavioural gain, so the row stays put and the
    // narrowing is written down here instead. The Web side's inactive answer is
    // pinned locally by `peer-caps.test.ts`; no native client reads it.
    linkRoomInactive: { caps: [CAP_TEXT] },
  },
  retry: capsRetry,
  settleSeconds: capsSettleSeconds,
  // Every attempt must land strictly inside the peer's window, with the last one
  // leaving room to be acted on. Asserted in both suites so neither constant can
  // be raised alone.
  lastAttemptSeconds: ((capsRetry.attempts - 1) * capsRetry.intervalMs) / 1000,
  // Exact match, deliberately: `link/2` is a different wire and `LINK/1` is not
  // this one. Both languages assert `link`.
  //
  // `resolvesImmediately` and `legacyLane` are NATIVE-ONLY fields and are read
  // only by the Swift suite. They describe which legacy lane a non-`link/1` peer
  // falls to and whether that fall is decided on the spot or waits out the
  // capability window. The browser has no such lane and no such window: a peer
  // that is not exact `link/1` is unsupported, terminally and immediately, so
  // there is nothing on the Web side those two fields could still name. They are
  // kept because iOS still ships the legacy lane they describe.
  promotion: [
    { caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD], link: true, resolvesImmediately: true },
    { caps: [CAP_TEXT, CAP_LINK], link: true, resolvesImmediately: true },
    { caps: [CAP_LINK], link: true, resolvesImmediately: true },
    { caps: [CAP_TEXT], link: false, resolvesImmediately: true, legacyLane: "text" },
    { caps: [], link: false, resolvesImmediately: false, legacyLane: "files" },
    { caps: ["link/2"], link: false, resolvesImmediately: false, legacyLane: "files" },
    { caps: ["LINK/1"], link: false, resolvesImmediately: false, legacyLane: "files" },
    { caps: ["text/2"], link: false, resolvesImmediately: false, legacyLane: "files" },
  ],
  // `LegacyLane.mode`. A staged batch outranks anything the peer said, because a
  // text lane cannot carry it at all.
  legacyLane: [
    { peerAnnouncesText: true, hasArmedBatch: false, lane: "text" },
    { peerAnnouncesText: false, hasArmedBatch: false, lane: "files" },
    { peerAnnouncesText: true, hasArmedBatch: true, lane: "files" },
    { peerAnnouncesText: false, hasArmedBatch: true, lane: "files" },
  ],
  // What a client that has just given up on `link/1` announces, so the downgrade
  // is agreed rather than one-sided. It names the lane the legacy session can
  // actually carry: an empty array is a hello that revokes, and a frame with no
  // `caps` field would not be a hello at all and would leave the stale `link/1`
  // standing.
  //
  // Both rows revoke `link/1`, and that half is asserted in both languages. What
  // they downgrade TO is native-only now: a browser answers either row the same
  // way, by no longer routing that peer at all.
  downgrade: { text: { caps: [CAP_TEXT] }, files: { caps: [] } },
  // A hello is a SNAPSHOT, not an additive grant, in both languages. `link` is
  // the shared assertion; `text` is native-only, for the same reason the
  // `legacyLane` rows above are.
  revocation: { first: { caps: [CAP_TEXT, CAP_LINK] }, then: { caps: [] }, link: false, text: false },
  // Not a hello at all: no `caps` field means "a frame we do not understand",
  // which must leave an earlier announcement standing rather than clear it.
  notAHello: [{ relayRtt: { a: 1 } }, { caps: "text/1" }, { caps: 3 }, { rename: "x" }],
  // `linkRole` / `peer-link.svelte.ts`: the smaller id offers. Both orders, so a
  // client cannot be correct in only the half of pairings it happens to test.
  role: [
    { self: "aaaaaaaa", peer: "bbbbbbbb", role: "initiator" },
    { self: "bbbbbbbb", peer: "aaaaaaaa", role: "responder" },
    { self: "0a1b2c3d", peer: "0a1b2c3e", role: "initiator" },
    { self: "0a1b2c3e", peer: "0a1b2c3d", role: "responder" },
  ],
  // A `link`-generation frame is itself the announcement — nothing else composes
  // one. It stands in for a hello that never arrived, and only for a peer that
  // has said nothing; see `PeerCapabilityRegistry.recordProvenLink`.
  provenLink: {
    signal: { link: true, sdp: { type: "offer", sdp: "v=0\r\n" } },
    caps: [CAP_LINK],
    // The same frame must NOT overrule a peer that already stated its wire.
    doesNotOverrule: { caps: [CAP_TEXT] },
  },
};

// ── link/1: lifecycle bytes, the frame partition, and authenticated signalling
//
// docs/protocol/relayium-link-v1.md is the authoritative prose; this block is
// the byte-level pin under it, and it exists because everything in it was
// SOURCE-ONLY until now. `linkFileFrameClass`, `linkLeavePayload`, `authPayload`
// and the lifecycle bytes each live in two hand-written implementations
// (`web/src/lib/webrtc-core.ts` + `transfer.ts` + `text-wire.ts`, and
// `apps/RelayiumKit/.../LinkProtocol.swift`) with nothing between them. A third
// port re-deriving them by hand is exactly the drift check-wire-vectors.mjs was
// written to stop.
//
// ## Why the escaping inputs are written as UTF-16 code units
//
// The escaping vectors are the point of the `linkLeavePayload` block, and the
// inputs they need include a lone surrogate — which no Swift `String` can hold
// and which, written literally, would put a `\ud800` into a fixture four
// language suites parse. So every input string in that block is an array of
// UTF-16 code units and every rendered payload is pinned as UTF-8 hex. A
// consumer that cannot represent one input skips exactly that row (the
// `swiftRepresentable` flag names them) instead of failing to parse the file.
//
// Control characters are built with String.fromCodePoint rather than typed
// literally, for the same Trojan-source reason `files` above does it: a RLO or
// a bare C1 in this source would reorder or hide the code around it.

const S = String.fromCodePoint;

// web/src/lib/peer-caps.svelte.ts, webrtc.ts, webrtc-core.ts, peer-link.svelte.ts
const LINK_CAPABILITY = CAP_LINK;
const LINK_CHANNEL_LABELS = ["relayium", "relayium-text"];
const LINK_CAPTURE_MAX_BYTES = 256 * 1024;
const LINK_AUTH_TAG_LENGTH = 44;
const LINK_LEAVE_MAX_ATTEMPTS = 8;
const LINK_HELD_SIGNAL_MAX = 64;
const MAX_CANDIDATE_PROGRESS = 6;
const MANIFEST_MAX_BYTES = 200 * 1024;
const MAX_FILES = 1000;
const MAX_FILE_NAME_LENGTH = 1024;
const FLOW_WINDOW = 8 << 20;
const FLOW_ACK_INTERVAL = 512 * 1024;
const TEXT_MAX_BYTES = 64 * 1024;
const TEXT_FRAME_OVERHEAD = 5 + 16;

// transfer.ts control bytes the file lane owns on top of the shared three.
const CTRL_BUSY = 0xf9;
const CTRL_BATCH_ABORT = 0xf8;
// text-wire.ts lifecycle bytes. ACCEPT/REJECT are the SHARED 0xfe/0xff; the
// DataChannel label is what scopes their meaning to a conversation.
const CTRL_TEXT_REQUEST = 0xfa;
const CTRL_TEXT_END = 0xfb;

const KIND_DONE_LEGACY = 2;
const KIND_BATCH_LEGACY = 3;
const KIND_STORED_KEYS = 12;

const rawBytes = (...b) => new Uint8Array(b);
const utf16 = (s) => [...Array(s.length)].map((_, i) => s.charCodeAt(i));
const asciiOnly = (s) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) return false;
  return true;
};

/** A frame with a real 5-byte header and `n` filler payload bytes. Used for the
 *  classification rows where only (kind, length) decides the answer. */
const shaped = (kind, seq, n) => frame(kind, seq, new Uint8Array(n).fill(0x5a));

// ── the two hand-rolled tag payloads ───────────────────────────────────────
//
// Byte-pinned to webrtc-core.ts. Reproduced here through JSON.stringify — which
// IS the web implementation — so the fixture cannot drift from the browser. The
// half this cannot prove (that the shipped module still renders these bytes) is
// web/src/lib/link-protocol-vectors.test.ts's, which calls the real exports.

/** webrtc-core.ts `authPayload`: an EXPLICIT field list, in this order, so that
 *  adding a field to a signal cannot change what an existing tag covers. */
function authPayload(msg) {
  return JSON.stringify({
    sdpType: msg.sdp?.type ?? null,
    sdp: msg.sdp?.sdp ?? null,
    candidate: msg.ice?.candidate ?? null,
    sdpMid: msg.ice?.sdpMid ?? null,
    sdpMLineIndex: msg.ice?.sdpMLineIndex ?? null,
    usernameFragment: msg.ice?.usernameFragment ?? null,
  });
}

/** webrtc-core.ts `linkLeavePayload`. Deliberately NOT authPayload: a leave has
 *  no SDP and no ICE, so authPayload would render one constant, directionless
 *  string for the life of a link. `kind` also makes this string unreachable
 *  from authPayload, whose output always begins with `sdpType`. */
function linkLeavePayload(from, to) {
  return JSON.stringify({ kind: "link-leave", from, to });
}

/** One rendered payload, pinned as UTF-8 bytes and — only when it happens to be
 *  pure ASCII — as a readable string too. */
function renderedPayload(payload) {
  const out = { payloadUtf8Hex: hex(enc.encode(payload)) };
  if (asciiOnly(payload)) out.payloadAscii = payload;
  return out;
}

// ── the file lane's total frame partition ──────────────────────────────────
//
// `LinkProtocol.swift`'s `linkFileFrameClass`, and the composition of
// `transfer.ts`'s `controlKind` / `isBatchAbort` / `parseAck` / `isResumeReq`
// through which the Web reaches the same answer. Every byte string lands in
// EXACTLY ONE class: no frame can be both counted as flow control and fed to
// the AEAD receiver, and none can be silently dropped.
const linkFileFrameClass = [
  { label: "accept", frameHex: hex(rawBytes(CTRL_ACCEPT)), class: "lifecycle", control: "accept" },
  { label: "reject", frameHex: hex(rawBytes(CTRL_REJECT)), class: "lifecycle", control: "reject" },
  { label: "complete", frameHex: hex(rawBytes(CTRL_COMPLETE)), class: "lifecycle", control: "complete" },
  { label: "busy", frameHex: hex(rawBytes(CTRL_BUSY)), class: "lifecycle", control: "busy" },
  { label: "batchAbort", frameHex: hex(rawBytes(CTRL_BATCH_ABORT)), class: "lifecycle", control: "batchAbort" },
  {
    label: "two bytes starting with ACCEPT",
    frameHex: hex(rawBytes(CTRL_ACCEPT, CTRL_ACCEPT)),
    class: "unroutable",
    why: "a longer frame that merely STARTS with a control byte must never be read as consent",
  },
  {
    label: "two bytes starting with BATCH_ABORT",
    frameHex: hex(rawBytes(CTRL_BATCH_ABORT, 0x00)),
    class: "unroutable",
    why: "same rule, for the one control that travels sender to receiver",
  },
  { label: "empty frame", frameHex: "", class: "unroutable", why: "no kind to dispatch on" },
  {
    label: "one byte that is not a control",
    frameHex: hex(rawBytes(KIND_ACK)),
    class: "unroutable",
    why: "below the 5-byte header there is no kind, whatever the first byte looks like",
  },
  { label: "four bytes", frameHex: hex(rawBytes(KIND_CHUNK, 0, 0, 0)), class: "unroutable", why: "the header is 5 bytes" },

  // ACK: 13 bytes is part of what an ACK IS.
  { label: "ack, exactly 13 bytes", frameHex: ackHex, class: "ack" },
  { label: "ack, 12 bytes", frameHex: hex(shaped(KIND_ACK, 0, 7)), class: "unroutable", why: "parseAck refuses it, and it must not fall through into the protected stream either" },
  { label: "ack, 14 bytes", frameHex: hex(shaped(KIND_ACK, 0, 9)), class: "unroutable", why: "same" },
  { label: "ack, header only", frameHex: hex(shaped(KIND_ACK, 0, 0)), class: "unroutable", why: "same" },

  // Resume control. Kind 5 is resumeRequest INCLUDING a payload that does not
  // parse — a malformed resume request is control the lane must fail closed on,
  // never bytes to route into the protected stream.
  { label: "resume request, well formed", frameHex: resumeSection.reqFrameHex, class: "resumeRequest" },
  { label: "resume request, unparseable payload", frameHex: hex(frame(KIND_RESUME_REQ, 0, enc.encode("{"))), class: "resumeRequest" },
  { label: "resume request, empty payload", frameHex: hex(shaped(KIND_RESUME_REQ, 0, 0)), class: "resumeRequest" },
  { label: "resume start, well formed", frameHex: resumeSection.startFrameHex, class: "resumeStart" },
  { label: "resume start, empty payload", frameHex: hex(shaped(KIND_RESUME_START, 0, 0)), class: "resumeStart" },

  // Everything that carries a nonce, INCLUDING the two legacy kinds: the
  // receiver is the single place that turns those into a loud "older version"
  // error, and a demux that swallowed them here would downgrade a version
  // mismatch into silence.
  { label: "chunk", frameHex: framesHex[1], class: "protected" },
  { label: "batch (manifest)", frameHex: framesHex[0], class: "protected" },
  { label: "done", frameHex: framesHex[2], class: "protected" },
  { label: "chunk part", frameHex: hex(shaped(KIND_CHUNK_PART, 7, 32)), class: "protected" },
  { label: "batch part", frameHex: hex(shaped(KIND_BATCH_PART, 0, 32)), class: "protected" },
  { label: "chunk, header only", frameHex: hex(shaped(KIND_CHUNK, 3, 0)), class: "protected", why: "shape routing only; the AEAD then fails it" },
  { label: "legacy done (kind 2)", frameHex: hex(shaped(KIND_DONE_LEGACY, 0, 16)), class: "protected", why: "routed so the receiver can report an older peer, never parsed" },
  { label: "legacy batch (kind 3)", frameHex: hex(shaped(KIND_BATCH_LEGACY, 0, 16)), class: "protected", why: "same" },

  // Not this lane's.
  { label: "text frame on the file lane", frameHex: hex(shaped(KIND_TEXT_ENC, 0, 16)), class: "unroutable" },
  { label: "kind 0", frameHex: hex(shaped(0, 0, 16)), class: "unroutable" },
  { label: "kind 13", frameHex: hex(shaped(13, 0, 16)), class: "unroutable" },
  {
    label: "stored-keys handoff (kind 12)",
    frameHex: hex(shaped(KIND_STORED_KEYS, 0, 32)),
    class: "unroutable",
    why: "unroutable for a client that does not announce preupload/1, which is every native client. A client that DOES announce it demuxes kind 12 by kind alone, ahead of the file receiver, including a frame too short to be a valid one.",
  },
];

// ── the two lanes' lifecycle bytes ─────────────────────────────────────────
const linkLifecycle = {
  // transfer.ts `controlKind` + `isBatchAbort`; Swift `linkFileLifecycleKind`.
  file: [
    { frameHex: hex(rawBytes(CTRL_ACCEPT)), kind: "accept" },
    { frameHex: hex(rawBytes(CTRL_REJECT)), kind: "reject" },
    { frameHex: hex(rawBytes(CTRL_COMPLETE)), kind: "complete" },
    { frameHex: hex(rawBytes(CTRL_BUSY)), kind: "busy" },
    { frameHex: hex(rawBytes(CTRL_BATCH_ABORT)), kind: "batchAbort" },
    { frameHex: hex(rawBytes(CTRL_TEXT_REQUEST)), kind: null, why: "0xfa is the TEXT lane's request byte and has no meaning here" },
    { frameHex: hex(rawBytes(CTRL_TEXT_END)), kind: null, why: "0xfb likewise" },
    { frameHex: hex(rawBytes(0x00)), kind: null },
    { frameHex: "", kind: null },
    { frameHex: hex(rawBytes(CTRL_COMPLETE, CTRL_COMPLETE)), kind: null, why: "exactly one byte, or it is not a control" },
  ],
  // text-wire.ts `textLifecycleKind`; Swift `linkTextLifecycleKind`.
  text: [
    { frameHex: hex(rawBytes(CTRL_TEXT_REQUEST)), kind: "request" },
    { frameHex: hex(rawBytes(CTRL_ACCEPT)), kind: "accept" },
    { frameHex: hex(rawBytes(CTRL_REJECT)), kind: "reject" },
    { frameHex: hex(rawBytes(CTRL_TEXT_END)), kind: "end" },
    { frameHex: hex(rawBytes(CTRL_COMPLETE)), kind: null, why: "COMPLETE belongs to the file protocol and has no meaning on a conversation" },
    { frameHex: hex(rawBytes(CTRL_BUSY)), kind: null },
    { frameHex: hex(rawBytes(CTRL_BATCH_ABORT)), kind: null },
    { frameHex: "", kind: null },
    { frameHex: hex(rawBytes(CTRL_TEXT_REQUEST, CTRL_TEXT_REQUEST)), kind: null, why: "exactly one byte" },
  ],
  // text-wire.ts `isTextFrame`; Swift `isLinkTextFrame`. A header with no room
  // for an AEAD tag is not a frame.
  textFrame: [
    { frameHex: textFrames[0].frameHex, isTextFrame: true },
    { frameHex: hex(shaped(KIND_TEXT_ENC, 0, TEXT_FRAME_OVERHEAD - 5)), isTextFrame: true, why: "the minimum: 5-byte header plus a 16-byte tag" },
    { frameHex: hex(shaped(KIND_TEXT_ENC, 0, TEXT_FRAME_OVERHEAD - 6)), isTextFrame: false, why: "one byte short of a tag; the Web fails the text lane on this rather than routing it" },
    { frameHex: hex(shaped(KIND_CHUNK, 0, 64)), isTextFrame: false },
    { frameHex: hex(rawBytes(KIND_TEXT_ENC)), isTextFrame: false },
    { frameHex: "", isTextFrame: false },
  ],
};

// ── authPayload: the exact bytes a resume/ICE tag covers ───────────────────
const linkAuthPayload = [
  { label: "empty signal", signal: {} },
  { label: "offer", signal: { sdp: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n" } } },
  { label: "answer", signal: { sdp: { type: "answer", sdp: "v=0\r\na=setup:active\r\n" } } },
  {
    label: "ice candidate with every field",
    signal: { ice: { candidate: "candidate:1 1 udp 2113937151 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "abcd" } },
  },
  {
    label: "sdpMLineIndex 0 renders 0, not null",
    signal: { ice: { candidate: "candidate:2 1 udp 1 192.0.2.2 1 typ host", sdpMid: "data", sdpMLineIndex: 0 } },
  },
  { label: "ice candidate only", signal: { ice: { candidate: "candidate:3 1 udp 1 192.0.2.3 1 typ srflx" } } },
  {
    label: "caps and unknown fields are NOT covered",
    signal: { sdp: { type: "offer", sdp: "v=0\r\n" }, caps: ["link/1", "preupload/1"], commit: "Zm9v", rename: "x", link: true },
  },
  { label: "quote and backslash in the sdp", signal: { sdp: { type: "offer", sdp: 'a=x:"q" \\ b' } } },
  { label: "the five short escapes", signal: { sdp: { type: "offer", sdp: "\b\t\n\f\r" } } },
  {
    label: "other C0 controls escape as lower-case backslash-u00XX",
    signal: { sdp: { type: "offer", sdp: "a" + S(0x01) + S(0x0b) + S(0x1f) + "b" } },
  },
  {
    label: "DEL and C1 are emitted RAW, not escaped",
    signal: { ice: { candidate: "a" + S(0x7f) + S(0x9f) + "b" } },
  },
  {
    label: "astral characters are emitted raw as UTF-8, never as surrogate escapes",
    signal: { ice: { sdpMid: S(0x1f30d), candidate: "e" + S(0x301) } },
  },
].map((entry) => ({ ...entry, ...renderedPayload(authPayload(entry.signal)) }));

// ── linkLeavePayload: direction, and JSON.stringify escaping, exactly ───────
const linkLeavePayloadCases = [
  { label: "ordinary hub peer ids", from: "0a1b2c3d4e5f6071", to: "8192a3b4c5d6e7f0" },
  {
    label: "the reverse direction is a DIFFERENT string",
    from: "8192a3b4c5d6e7f0",
    to: "0a1b2c3d4e5f6071",
    why: "a relay that reflects a leave back at its sender verifies the reversed tuple and fails",
  },
  { label: "empty ids", from: "", to: "" },
  { label: "quote and backslash", from: 'a"b', to: "c\\d" },
  { label: "the five short escapes", from: "\b\t\n\f\r", to: "x" },
  { label: "other C0 controls escape as lower-case backslash-u00XX", from: S(0x00) + S(0x01) + S(0x0b) + S(0x0e) + S(0x1f), to: "" },
  { label: "DEL and C1 are emitted RAW", from: "a" + S(0x7f) + "b", to: "c" + S(0x85) + S(0x9f) + "d" },
  { label: "U+2028 and U+2029 are emitted RAW by JSON.stringify", from: "a" + S(0x2028) + "b", to: "c" + S(0x2029) + "d" },
  { label: "astral character, as UTF-8 rather than surrogate escapes", from: S(0x1f30d), to: "e" + S(0x301) },
  {
    label: "unpaired high surrogate",
    from: S(0xd800),
    to: "x",
    swiftRepresentable: false,
    why: "JavaScript escapes a lone surrogate as backslash-udXXX (well-formed JSON.stringify). A Swift String cannot hold one at all, so the Swift port has no defined behaviour here and must skip this row. Reachable only through a hostile signalling relay; hub peer ids are ASCII hex. See relayium-link-v1.md section 12.",
  },
].map((entry) => {
  const payload = linkLeavePayload(entry.from, entry.to);
  const out = {
    label: entry.label,
    fromUtf16: utf16(entry.from),
    toUtf16: utf16(entry.to),
    ...renderedPayload(payload),
  };
  if (entry.swiftRepresentable === false) out.swiftRepresentable = false;
  if (entry.why) out.why = entry.why;
  return out;
});

// ── an authenticated leave, end to end ─────────────────────────────────────
//
// A fixed HMAC key rather than a derived resumeAuth: crypto-vectors.json already
// pins the DERIVATION, and what this block is about is the tag's encoding, its
// exact length, and the shapes a verifier must refuse before it ever computes
// one. Standard base64 WITH padding — not URL-safe, not unpadded — so a 32-byte
// HMAC is exactly LINK_AUTH_TAG_LENGTH characters.
const leaveKeyRaw = fromHex("ab".repeat(32));
const leaveKey = await crypto.subtle.importKey("raw", leaveKeyRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const leaveFrom = "0a1b2c3d4e5f6071";
const leaveTo = "8192a3b4c5d6e7f0";
const leavePayloadString = linkLeavePayload(leaveFrom, leaveTo);
const b64 = (u8) => Buffer.from(u8).toString("base64");
const leaveTag = b64(new Uint8Array(await crypto.subtle.sign("HMAC", leaveKey, enc.encode(leavePayloadString))));
const reversedTag = b64(new Uint8Array(
  await crypto.subtle.sign("HMAC", leaveKey, enc.encode(linkLeavePayload(leaveTo, leaveFrom))),
));

const linkLeave = {
  keyHex: hex(leaveKeyRaw),
  from: leaveFrom,
  to: leaveTo,
  payload: leavePayloadString,
  tag: leaveTag,
  tagLength: leaveTag.length,
  /** The same key over the REVERSED tuple. A verifier that checked direction
   *  loosely would accept this; one that does not, will not. */
  reversedTag,
  maxAttempts: LINK_LEAVE_MAX_ATTEMPTS,
  /** peer-link.svelte.ts `isLinkLeave`; Swift `parsedLinkLeaveAuth`. Recognised
   *  by EXACT shape, before anything cryptographic runs — this signal rides the
   *  `link` generation, so an establishment in flight for the same peer sees it
   *  too, and any extra field would be acted on by a handler that shares it. */
  shapes: [
    { label: "the exact three keys", signal: { link: true, leave: true, auth: leaveTag }, accepted: true },
    { label: "key order does not matter", signal: { auth: leaveTag, leave: true, link: true }, accepted: true },
    { label: "a smuggled caps array", signal: { link: true, leave: true, auth: leaveTag, caps: ["link/1"] }, accepted: false },
    { label: "a smuggled commit", signal: { link: true, leave: true, auth: leaveTag, commit: "Zm9v" }, accepted: false },
    { label: "a smuggled sdp", signal: { link: true, leave: true, auth: leaveTag, sdp: { type: "offer", sdp: "v=0\r\n" } }, accepted: false },
    { label: "a smuggled busy", signal: { link: true, leave: true, auth: leaveTag, busy: true }, accepted: false },
    { label: "a smuggled rename", signal: { link: true, leave: true, auth: leaveTag, rename: "x" }, accepted: false },
    { label: "no auth", signal: { link: true, leave: true }, accepted: false },
    { label: "auth is not a string", signal: { link: true, leave: true, auth: 44 }, accepted: false },
    { label: "auth is null", signal: { link: true, leave: true, auth: null }, accepted: false },
    { label: "auth one character short", signal: { link: true, leave: true, auth: leaveTag.slice(0, LINK_AUTH_TAG_LENGTH - 1) }, accepted: false },
    { label: "auth one character long", signal: { link: true, leave: true, auth: leaveTag + "=" }, accepted: false },
    { label: "auth empty", signal: { link: true, leave: true, auth: "" }, accepted: false },
    {
      label: "auth is 44 characters of nonsense",
      signal: { link: true, leave: true, auth: "!".repeat(LINK_AUTH_TAG_LENGTH) },
      accepted: true,
      verifies: false,
      why: "the SHAPE is right, so one unit of budget is spent and the HMAC runs, and fails",
    },
    { label: "link is not true", signal: { link: false, leave: true, auth: leaveTag }, accepted: false },
    { label: "leave is not true", signal: { link: true, leave: false, auth: leaveTag }, accepted: false },
    { label: "leave missing", signal: { link: true, auth: leaveTag }, accepted: false },
    { label: "resume generation", signal: { resume: true, leave: true, auth: leaveTag }, accepted: false },
  ],
};

// ── signalling: generations and the content-free frames ────────────────────
const linkSignals = {
  request: { link: true, linkRequest: true },
  busy: { link: true, busy: true },
  leave: { link: true, leave: true, auth: leaveTag },
  /** webrtc-core.ts `signalGeneration`. `resume` outranks `link`: a signal
   *  carrying both is a rebuild and never an establishment. The vocabulary is
   *  deliberately WIDER than what can be constructed — a tag this build could
   *  not classify would fall through to `file` and be answered as a legacy
   *  transfer, which is the failure the tags exist to prevent. */
  generation: [
    { signal: {}, generation: "file" },
    { signal: { link: true }, generation: "link" },
    { signal: { resume: true }, generation: "resume" },
    { signal: { text: true }, generation: "text" },
    { signal: { resume: true, link: true }, generation: "resume" },
    { signal: { resume: true, text: true }, generation: "resume" },
    { signal: { link: true, text: true }, generation: "link" },
    { signal: { busy: true }, generation: "file" },
    { signal: { link: true, busy: true }, generation: "link" },
    { signal: { link: false }, generation: "file" },
  ],
  /** peer-link.svelte.ts `isLinkOffer`. */
  isLinkOffer: [
    { signal: { link: true, sdp: { type: "offer", sdp: "v=0\r\n" } }, expected: true },
    { signal: { link: true, sdp: { type: "answer", sdp: "v=0\r\n" } }, expected: false },
    { signal: { link: true, resume: true, sdp: { type: "offer", sdp: "v=0\r\n" } }, expected: false },
    { signal: { sdp: { type: "offer", sdp: "v=0\r\n" } }, expected: false },
    { signal: { link: true }, expected: false },
    { signal: { link: true, linkRequest: true }, expected: false },
  ],
  /** peer-link.svelte.ts `isLinkRequest`. A request carries NO sdp, and that
   *  absence is part of recognising it. */
  isLinkRequest: [
    { signal: { link: true, linkRequest: true }, expected: true },
    { signal: { link: true, linkRequest: true, sdp: { type: "offer", sdp: "v=0\r\n" } }, expected: false },
    { signal: { linkRequest: true }, expected: false },
    { signal: { link: true }, expected: false },
    { signal: { link: false, linkRequest: true }, expected: false },
  ],
};

// ── bounds, at the boundary and one step past it ───────────────────────────
const linkBounds = {
  /** transfer.ts `piecePlainBytes`: min(floor(max) - CHUNK_OVERHEAD, CHUNK_SIZE),
   *  and a result below MIN_PIECE_BYTES is a named error rather than a transfer
   *  that crawls. RFC 8841's default of 65 536 is the case every real browser
   *  hits, and it means EVERY logical chunk fragments. */
  piecePlainBytes: [
    { maxFrameBytes: CONSERVATIVE_MAX_MESSAGE_BYTES, pieceBytes: piecePlainBytes(CONSERVATIVE_MAX_MESSAGE_BYTES) },
    { maxFrameBytes: CHROME_MAX_MESSAGE_BYTES, pieceBytes: piecePlainBytes(CHROME_MAX_MESSAGE_BYTES) },
    { maxFrameBytes: CHUNK_SIZE + CHUNK_OVERHEAD, pieceBytes: piecePlainBytes(CHUNK_SIZE + CHUNK_OVERHEAD) },
    { maxFrameBytes: CHUNK_SIZE + CHUNK_OVERHEAD + 1, pieceBytes: CHUNK_SIZE, why: "capped at CHUNK_SIZE; a bigger allowance buys nothing" },
    { maxFrameBytes: MIN_PIECE_BYTES + CHUNK_OVERHEAD, pieceBytes: MIN_PIECE_BYTES, why: "the smallest connection this protocol will use" },
    { maxFrameBytes: MIN_PIECE_BYTES + CHUNK_OVERHEAD - 1, pieceBytes: null, why: "refused" },
    { maxFrameBytes: 0, pieceBytes: null, why: "refused" },
  ],
  /** text-wire.ts `textPlainLimit`: the product cap lowered to whatever the
   *  sealed frame must fit in. Text deliberately does NOT fragment, so the only
   *  correct answer for an outsized message is to refuse it before sealing —
   *  handing it to send() kills the channel and the whole session with it. */
  textPlainLimit: [
    { maxFrameBytes: CONSERVATIVE_MAX_MESSAGE_BYTES, limit: CONSERVATIVE_MAX_MESSAGE_BYTES - TEXT_FRAME_OVERHEAD },
    { maxFrameBytes: CHROME_MAX_MESSAGE_BYTES, limit: TEXT_MAX_BYTES },
    { maxFrameBytes: TEXT_MAX_BYTES + TEXT_FRAME_OVERHEAD, limit: TEXT_MAX_BYTES },
    { maxFrameBytes: TEXT_FRAME_OVERHEAD, limit: 0 },
    { maxFrameBytes: 0, limit: 0 },
  ],
  /** transfer.ts: the ceiling is compared against the CIPHERTEXT length. GCM
   *  adds a 16-byte tag, so comparing the plaintext would let a critical
   *  manifest pass the check and then blow up inside send(). */
  manifestCiphertext: [
    { payloadBytes: MANIFEST_MAX_BYTES - 16, accepted: true },
    { payloadBytes: MANIFEST_MAX_BYTES - 15, accepted: false },
    { payloadBytes: MANIFEST_MAX_BYTES, accepted: false },
  ],
  /** manifest.ts `validateManifestFiles`. */
  manifestFileCount: [
    { count: 1, accepted: true },
    { count: MAX_FILES, accepted: true },
    { count: MAX_FILES + 1, accepted: false },
    { count: 0, accepted: false, why: "an empty manifest is not a batch" },
  ],
  manifestNameBytes: [
    { nameBytes: 1, accepted: true },
    { nameBytes: MAX_FILE_NAME_LENGTH, accepted: true },
    { nameBytes: MAX_FILE_NAME_LENGTH + 1, accepted: false },
    { nameBytes: 0, accepted: false },
  ],
  /** transfer.ts `advanceAck`. ACK carries no batch identifier, so this clamp is
   *  what stands in for one: a delayed, duplicated or forged cumulative ACK
   *  cannot open a later batch's whole window. */
  advanceAck: [
    { acked: 0, sent: 1000, candidate: 500, result: 500 },
    { acked: 500, sent: 1000, candidate: 500, result: 500, why: "not strictly greater" },
    { acked: 500, sent: 1000, candidate: 400, result: 500, why: "a rewind is ignored" },
    { acked: 500, sent: 1000, candidate: 1000, result: 1000, why: "exactly what was emitted is allowed" },
    { acked: 500, sent: 1000, candidate: 1001, result: 500, why: "beyond what this attempt emitted" },
    { acked: 0, sent: 0, candidate: 1, result: 0 },
  ],
  /** transfer.ts `resumePointAligned` / `resumePointInRange`. The chain hash is
   *  defined only at CHUNK_SIZE boundaries and at the exact end of a file, so an
   *  unaligned point can only come from a peer that is not following this
   *  protocol — and honouring one would make the sender skip the bytes between
   *  the request and the next boundary. */
  resumePoint: [
    { sizes: [CHUNK_SIZE * 2 + 5], point: { index: 0, offset: 0 }, aligned: true, inRange: true },
    { sizes: [CHUNK_SIZE * 2 + 5], point: { index: 0, offset: CHUNK_SIZE }, aligned: true, inRange: true },
    { sizes: [CHUNK_SIZE * 2 + 5], point: { index: 0, offset: CHUNK_SIZE * 2 + 5 }, aligned: true, inRange: true, why: "the exact end of a file" },
    { sizes: [CHUNK_SIZE * 2 + 5], point: { index: 0, offset: CHUNK_SIZE + 1 }, aligned: false, inRange: true },
    { sizes: [CHUNK_SIZE * 2 + 5], point: { index: 0, offset: CHUNK_SIZE * 2 + 6 }, aligned: false, inRange: false },
    { sizes: [CHUNK_SIZE * 2 + 5], point: { index: 1, offset: 0 }, aligned: false, inRange: false, why: "no such file" },
    { sizes: [9, CHUNK_SIZE], point: { index: 0, offset: 9 }, aligned: true, inRange: true },
    { sizes: [9, CHUNK_SIZE], point: { index: 1, offset: CHUNK_SIZE }, aligned: true, inRange: true },
  ],
};

const link = {
  capability: LINK_CAPABILITY,
  channelLabels: LINK_CHANNEL_LABELS,
  /** Combined across BOTH lanes. One maximum encrypted manifest plus lifecycle
   *  overhead — deliberately far smaller than FLOW_WINDOW, because
   *  pre-attachment traffic has not reached a content-consent state yet.
   *  Overflow is fail-closed: a dropped admitted frame is the one failure the
   *  reused receiver codecs cannot survive. */
  captureMaxBytes: LINK_CAPTURE_MAX_BYTES,
  authTagLength: LINK_AUTH_TAG_LENGTH,
  heldSignalMax: LINK_HELD_SIGNAL_MAX,
  maxCandidateProgress: MAX_CANDIDATE_PROGRESS,
  /** Every establishment and recovery bound, in milliseconds. An implementation
   *  may be stricter but must not be unbounded anywhere. */
  deadlines: {
    noProgressMs: 30_000,
    setupHardCapMs: 90_000,
    keyRevealMs: 30_000,
    handshakeDeadlineMs: 90_000,
    linkAuthMs: 30_000,
    linkRequestMs: 30_000,
    linkRequestRetryMs: 3_000,
    recoveryWindowMs: 90_000,
    recoveryRetryMs: 1_500,
  },
  controlHex: {
    accept: CTRL_ACCEPT.toString(16),
    reject: CTRL_REJECT.toString(16),
    complete: CTRL_COMPLETE.toString(16),
    busy: CTRL_BUSY.toString(16),
    batchAbort: CTRL_BATCH_ABORT.toString(16),
    textRequest: CTRL_TEXT_REQUEST.toString(16),
    textEnd: CTRL_TEXT_END.toString(16),
  },
  lifecycle: linkLifecycle,
  frameClass: linkFileFrameClass,
  authPayload: linkAuthPayload,
  linkLeavePayload: linkLeavePayloadCases,
  leave: linkLeave,
  signals: linkSignals,
  flow: { windowBytes: FLOW_WINDOW, ackIntervalBytes: FLOW_ACK_INTERVAL },
  textSession: {
    maxMessages: 500,
    maxBytes: 4 << 20,
    burst: 20,
    perSecond: 5,
    sendBufferMax: 1 << 20,
    idleMs: 600_000,
    historyMax: 200,
  },
  bounds: linkBounds,
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
  capability,
  link,
};

writeFileSync("../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json", JSON.stringify(out, null, 2) + "\n");
console.log(
  "wrote realtime-wire-vectors.json; frames:",
  framesHex.length,
  "frameStreamHex len:",
  frameStreamHex.length,
);
