#!/usr/bin/env node
// scripts/test/ios-app-store-screenshots-validate-test.mjs — proof that
// `scripts/ios-app-store-screenshots-validate.mjs` actually says no.
//
// ── why a mutation suite and not an assertion suite ──────────────────────────
//
// A screenshot validator that returned zero on everything would be
// indistinguishable from a working one right up until an upload was rejected,
// because there is nothing in this repository for it to pass on: no storefront
// asset exists, and none is created here. So the only way to know a rule is
// present is to build a bundle that breaks it and require the complaint.
//
// Every case below stages a COMPLETE, ACCEPTABLE bundle in a temporary
// directory, applies exactly one edit — an alpha channel, a pixel off by one, a
// Debug capture, an `ocr` review method, a duplicate JSON key, a symlink — and
// runs the validator on it as a child process. The case passes only if the
// validator exits 1 AND its complaint names the defect. A mutation that leaves
// it quiet is a rule that is not there.
//
// Two positive cases anchor the suite at the other end, because a validator
// that rejected everything would also pass every rejection case: one clean
// bundle is accepted, and the Account shot flips from refused to accepted when
// the packet says the subscription products are real.
//
// ── about the fixtures ───────────────────────────────────────────────────────
//
// The images here are SYNTHETIC VALIDATION DATA and nothing else. They are flat
// single-value greyscale rectangles at the accepted pixel sizes, plus a handful
// of deliberately malformed byte streams, and they depict no product surface.
// They are not proposed storefront content, they are not a preview of what the
// screenshots will look like, and none of them is written anywhere but a
// temporary directory that is removed on the way out.
//
// The PNG fixtures carry a real deflate of real scanlines, and the JPEG fixtures
// are ENCODED: standard Huffman tables, a quantization table, and Huffman-coded
// entropy data with the spec's byte stuffing and, in one case, restart markers.
// They are flat block patterns rather than photographs, and they depict nothing,
// but they are files a decoder opens — checked against the system decoder while
// this suite was written. An earlier revision used marker streams (`SOI`, a
// frame header, `EOI`) as its JPEG fixtures; that is not an image, the validator
// now refuses it, and it appears below only as `markerStreamJpeg()`, in the case
// that requires the refusal.
//
// Two fixtures are a deliberate exception to "a decoder opens it", and are
// labelled as such where they are built: the progressive pair carries a `SOF2`
// frame and one spectral band per scan over the SEQUENTIAL encoder's entropy
// bytes. They are structurally progressive and would not decode as progressive.
// That is sound for what they test — the validator resolves table references
// and steps entropy bytes without Huffman-decoding them — and it would not be
// sound for anything that claimed to decode the picture.
//
// The packets are copies of the shipped one with one field changed. The
// `captured` state several cases need does not exist in the shipped packet and
// is not proposed for it: `scripts/ios-app-store-metadata-validate.mjs` pins
// `not-captured`, which is correct, so the accepted-bundle path is reachable
// only against a synthetic packet — and that is the point being proved, not a
// gap being worked around.
//
// Nothing here reads a credential, contacts a network, observes App Store
// Connect, or writes to the repository.
//
// USAGE: node scripts/test/ios-app-store-screenshots-validate-test.mjs
// EXIT   0 every case behaved; 1 at least one did not

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const validator = join(repoRoot, "scripts", "ios-app-store-screenshots-validate.mjs");
const shippedPacketPath = join(repoRoot, "docs", "app-store-metadata-ios.json");
const shippedPacket = JSON.parse(readFileSync(shippedPacketPath, "utf8"));

const SET_IDS = shippedPacket.screenshots.sets.map((set) => set.id);
const LOCALES = shippedPacket.locales;
const SHOT_LIST = shippedPacket.screenshots.shotList;
const ACCOUNT_SHOT = SHOT_LIST.find((shot) => /^account\b/i.test(shot));
const NEUTRAL_SHOTS = SHOT_LIST.filter((shot) => shot !== ACCOUNT_SHOT);
const acceptedSize = (setId) =>
  shippedPacket.screenshots.sets.find((set) => set.id === setId).acceptedPortraitPixelSizes[0];

// Characters that must not be typed as literals into a source file. Built here
// so that every copy, diff and editor this test passes through leaves them
// intact.
const BOM = String.fromCharCode(0xfeff);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const BELL = String.fromCharCode(7);

let failures = 0;
let cases = 0;
const ok = (label) => process.stdout.write(`ok   — ${label}\n`);
const bad = (label, detail) => {
  failures += 1;
  process.stdout.write(`FAIL — ${label}\n     ${detail}\n`);
};

// A property of a FIXTURE that a case depends on but does not show. An encoded
// JPEG that stopped containing a stuffed 0xff00 pair would keep every case
// green while quietly testing something narrower, so the property is asserted
// where it is relied on.
function fixtureCarries(label, holds) {
  cases += 1;
  if (holds) ok(label);
  else bad(label, "the fixture no longer carries the property this case depends on");
}

const work = mkdtempSync(join(tmpdir(), "ios-app-store-screenshots-test."));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

// ── synthetic images ─────────────────────────────────────────────────────────
//
// A full-size PNG costs a multi-megabyte deflate, and the base bundle is staged
// once per case, so every image is built once and cached by its parameters.
// Without this the suite spends its whole runtime compressing the same
// rectangles.

const imageCache = new Map();
function cachedPng(options) {
  const key = JSON.stringify(options);
  if (!imageCache.has(key)) imageCache.set(key, buildPng(options));
  return imageCache.get(key);
}

let crcTable = null;
function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// `colourType` 0 is 8-bit greyscale — one byte per pixel, which keeps the
// uncompressed scanlines a third the size of an RGB fixture. 6 is RGBA, and
// exists here only so the alpha rule has something to refuse; 3 is a palette,
// which is a legal opaque encoding an optimizer such as pngquant produces.
//
// The IDAT is a real deflate of real scanlines, because the validator inflates
// it and measures it. The malformed variants below break exactly one thing each:
// no IDAT at all, an IDAT that is not a zlib stream, an IDAT that inflates one
// row short, IDAT chunks with another chunk wedged between them.
function buildPng({
  width,
  height,
  colourType = 0,
  bitDepth = 8,
  fill = 0,
  palette = null,
  trns = false,
  interlace = 0,
  corruptCrc = false,
  afterIend = null,
  omitIend = false,
  omitIdat = false,
  interruptIdat = false,
  brokenZlib = false,
  scanlineShortfall = 0,
}) {
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1;
  const stride = Math.ceil((width * channels * bitDepth) / 8) + 1;
  const rows = height - scanlineShortfall;
  const raw = Buffer.alloc(stride * rows, fill);
  for (let row = 0; row < rows; row += 1) raw[row * stride] = 0; // filter type 0

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = interlace;

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (palette) parts.push(chunk("PLTE", Buffer.from(palette)));
  if (trns) parts.push(chunk("tRNS", Buffer.from([0x00, 0x01])));

  const compressed = brokenZlib ? Buffer.from("this is not a zlib stream") : deflateSync(raw, { level: 9 });
  if (!omitIdat) {
    if (interruptIdat) {
      const half = Math.max(1, Math.floor(compressed.length / 2));
      parts.push(chunk("IDAT", compressed.subarray(0, half)));
      // A well-formed ancillary chunk in the middle of the IDAT run. Every byte
      // of the image is still present; they are just no longer one stream.
      parts.push(chunk("tEXt", Buffer.from("Comment wedged", "latin1")));
      parts.push(chunk("IDAT", compressed.subarray(half)));
    } else {
      const idat = chunk("IDAT", compressed);
      if (corruptCrc) idat[idat.length - 1] ^= 0xff;
      parts.push(idat);
    }
  }
  if (!omitIend) parts.push(chunk("IEND", Buffer.alloc(0)));
  if (afterIend) parts.push(Buffer.from(afterIend));
  return Buffer.concat(parts);
}

// A 256-entry greyscale ramp, so a palette fixture indexes something real.
function greyPalette() {
  const out = Buffer.alloc(768);
  for (let i = 0; i < 256; i += 1) {
    out[i * 3] = i;
    out[i * 3 + 1] = i;
    out[i * 3 + 2] = i;
  }
  return out;
}

// ── JPEG, actually encoded ───────────────────────────────────────────────────
//
// `buildJpeg` writes a real baseline JPEG: the standard Annex K Huffman tables,
// a quantization table, a frame header, a scan header, and Huffman-coded entropy
// data with the spec's `0xff00` byte stuffing and, on request, restart markers.
// It is a picture — flat 8x8 blocks alternating between the extremes of DC
// category 11, which is a hard black-and-white block pattern and is also what
// drives the coded bits into 0xff bytes, so the stuffing path is exercised by
// the positive fixtures rather than only by a hand-placed pair.
//
// It is written out here because there is no JPEG encoder in the Node standard
// library and this suite takes no dependency. The malformed variants break one
// thing each, and `markerStreamJpeg()` below is the file that used to be the
// ONLY JPEG fixture in this suite: headers with no scan behind them, which the
// validator must now refuse.

const STANDARD_DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STANDARD_DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STANDARD_AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STANDARD_AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

function huffmanCodes(bits, values) {
  const codes = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let n = 0; n < bits[length - 1]; n += 1) {
      codes.set(values[index], { code, length });
      index += 1;
      code += 1;
    }
    code <<= 1;
  }
  return codes;
}

// The bit writer the entropy data goes through. A 0xff byte in coded data is
// written as `0xff 0x00`, which is the rule that makes a JPEG scan walkable at
// all without decoding it.
class EntropyWriter {
  constructor() {
    this.bytes = [];
    this.accumulator = 0;
    this.filled = 0;
  }

  writeBits(code, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.accumulator = ((this.accumulator << 1) | ((code >> i) & 1)) & 0xff;
      this.filled += 1;
      if (this.filled === 8) {
        this.bytes.push(this.accumulator);
        if (this.accumulator === 0xff) this.bytes.push(0x00);
        this.accumulator = 0;
        this.filled = 0;
      }
    }
  }

  pad() {
    while (this.filled !== 0) this.writeBits(1, 1);
  }

  restart(index) {
    this.pad();
    this.bytes.push(0xff, 0xd0 + (index % 8));
  }
}

function encodeEntropy({ mcus, components, restartInterval }) {
  const dc = huffmanCodes(STANDARD_DC_BITS, STANDARD_DC_VALUES);
  const ac = huffmanCodes(STANDARD_AC_BITS, STANDARD_AC_VALUES);
  const endOfBlock = ac.get(0x00);
  const writer = new EntropyWriter();
  const predictor = new Array(components).fill(0);
  let restarts = 0;

  for (let mcu = 0; mcu < mcus; mcu += 1) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      writer.restart(restarts);
      restarts += 1;
      predictor.fill(0);
    }
    for (let component = 0; component < components; component += 1) {
      // One DC coefficient and an immediate end-of-block: a flat 8x8 block.
      const value = mcu % 2 === 0 ? 2047 : 0;
      const difference = value - predictor[component];
      predictor[component] = value;
      let size = 0;
      while (Math.abs(difference) >= 1 << size) size += 1;
      const code = dc.get(size);
      writer.writeBits(code.code, code.length);
      if (size > 0) writer.writeBits(difference >= 0 ? difference : difference + (1 << size) - 1, size);
      writer.writeBits(endOfBlock.code, endOfBlock.length);
    }
  }
  writer.pad();
  return Buffer.from(writer.bytes);
}

function segment(marker, payload) {
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(payload.length + 2, 2);
  payload.copy(out, 4);
  return out;
}

function buildJpeg({
  width,
  height,
  components = 1,
  sofMarker = 0xc0,
  precision = 8,
  restartInterval = 0,
  frame = true,
  scan = true,
  emptyScan = false,
  quantTable = true,
  huffmanTable = true,
  eoi = true,
  nonInterleaved = false,
  truncateScan = false,
  corruptScanAt = null,
  afterEoi = null,
  // Table and reference mutations. Each one replaces exactly the bytes it names
  // and leaves the rest of the encoder alone, so a case reads as the single
  // defect it is: a raw DQT/DHT payload, the frame's component ids and
  // quantization selectors, and the scan's component selectors, table selectors
  // and spectral band.
  dqtPayload = null,
  dhtPayload = null,
  huffmanClasses = ["dc", "ac"],
  frameComponentIds = null,
  frameQuantSelectors = null,
  scanSelectors = null,
  scanTableBytes = null,
  spectralStart = 0,
  spectralEnd = 63,
}) {
  const parts = [Buffer.from([0xff, 0xd8])];

  // APP0/JFIF, as every export writes it. The identifier's terminator and the
  // thumbnail fields are the zeroes the buffer already holds.
  const app0 = Buffer.alloc(14);
  app0.write("JFIF", 0, "latin1");
  app0[5] = 1;
  app0[6] = 1;
  app0.writeUInt16BE(1, 8);
  app0.writeUInt16BE(1, 10);
  parts.push(segment(0xe0, app0));

  if (quantTable) {
    // A flat table. Legal, decodable, and not pretending to be tuned.
    const dqt = Buffer.alloc(65, 16);
    dqt[0] = 0x00; // 8-bit precision, table 0
    parts.push(segment(0xdb, dqtPayload ?? dqt));
  }
  if (huffmanTable) {
    const dcTable = Buffer.concat([
      Buffer.from([0x00]), // class 0 (DC), table 0
      Buffer.from(STANDARD_DC_BITS),
      Buffer.from(STANDARD_DC_VALUES),
    ]);
    const acTable = Buffer.concat([
      Buffer.from([0x10]), // class 1 (AC), table 0
      Buffer.from(STANDARD_AC_BITS),
      Buffer.from(STANDARD_AC_VALUES),
    ]);
    const dht = Buffer.concat([
      ...(huffmanClasses.includes("dc") ? [dcTable] : []),
      ...(huffmanClasses.includes("ac") ? [acTable] : []),
    ]);
    parts.push(segment(0xc4, dhtPayload ?? dht));
  }

  if (frame) {
    const sof = Buffer.alloc(6 + 3 * components);
    sof[0] = precision;
    sof.writeUInt16BE(height, 1);
    sof.writeUInt16BE(width, 3);
    sof[5] = components;
    for (let i = 0; i < components; i += 1) {
      sof[6 + i * 3] = frameComponentIds ? frameComponentIds[i] : i + 1;
      sof[7 + i * 3] = 0x11; // 1x1 sampling: one 8x8 block per component per MCU
      sof[8 + i * 3] = frameQuantSelectors ? frameQuantSelectors[i] : 0;
    }
    parts.push(segment(sofMarker, sof));
  }

  if (restartInterval > 0) {
    const dri = Buffer.alloc(2);
    dri.writeUInt16BE(restartInterval, 0);
    parts.push(segment(0xdd, dri));
  }

  if (scan) {
    // One interleaved scan over every component, or — with `nonInterleaved` —
    // one single-component scan each, which is equally legal baseline JPEG and
    // is the multi-scan shape a progressive file also takes.
    const scanComponents = nonInterleaved
      ? Array.from({ length: components }, (unused, i) => [i])
      : [Array.from({ length: components }, (unused, i) => i)];

    for (const group of scanComponents) {
      const selectors = scanSelectors ?? group.map((component) => (frameComponentIds ? frameComponentIds[component] : component + 1));
      const sos = Buffer.alloc(4 + 2 * selectors.length);
      sos[0] = selectors.length;
      selectors.forEach((selector, i) => {
        sos[1 + i * 2] = selector;
        sos[2 + i * 2] = scanTableBytes ? scanTableBytes[i] : 0x00; // DC table 0, AC table 0
      });
      sos[1 + 2 * selectors.length] = spectralStart; // Ss
      sos[2 + 2 * selectors.length] = spectralEnd; // Se
      sos[3 + 2 * selectors.length] = 0; // Ah/Al
      parts.push(segment(0xda, sos));

      if (emptyScan) continue;
      let entropy = encodeEntropy({
        mcus: Math.ceil(width / 8) * Math.ceil(height / 8),
        components: group.length,
        restartInterval,
      });
      if (corruptScanAt !== null) {
        // An unstuffed 0xff followed by a byte that is not a marker: from here
        // the scan is undecodable, and no segment length says so.
        const at = Math.min(corruptScanAt, entropy.length);
        entropy = Buffer.concat([entropy.subarray(0, at), Buffer.from([0xff, 0x30]), entropy.subarray(at)]);
      }
      if (truncateScan) entropy = entropy.subarray(0, Math.floor(entropy.length / 2));
      parts.push(entropy);
    }
  }

  if (eoi) parts.push(Buffer.from([0xff, 0xd9]));
  if (afterEoi) parts.push(Buffer.from(afterEoi));
  return Buffer.concat(parts);
}

// SOI, a frame header, EOI. No tables, no scan, no entropy-coded byte anywhere:
// a header that claims a picture and carries none of it. It is here to be
// REFUSED, and it is named for what it is rather than passed off as an image.
function markerStreamJpeg({ width, height, components = 3 }) {
  return buildJpeg({
    width,
    height,
    components,
    quantTable: false,
    huffmanTable: false,
    scan: false,
  });
}

const jpegCache = new Map();
function cachedJpeg(options) {
  const key = JSON.stringify(options);
  if (!jpegCache.has(key)) jpegCache.set(key, buildJpeg(options));
  return jpegCache.get(key);
}

function pngFor(setId, variant) {
  const [width, height] = acceptedSize(setId).split("x").map(Number);
  return cachedPng({ width, height, fill: variant });
}

// ── staging a bundle ─────────────────────────────────────────────────────────

const CAPTURE = {
  configuration: "Release",
  source: "simulator",
  buildIdentifier: "synthetic-release-fixture",
  launchArguments: [],
  usedUITestFixtures: false,
  fabricatedPrices: false,
  retouched: false,
};

const HUMAN_REVIEW = {
  method: "human-visual",
  reviewer: "Fixture Reviewer",
  reviewedAt: "2026-09-03",
  neutralContentConfirmed: true,
  truthfulUnretouchedConfirmed: true,
  notes: "Synthetic validation rectangle; no product surface is depicted.",
};

// One file per set per localization, which is the packet's minimum. Cases that
// need a second file in a cell add it explicitly.
function baseFiles() {
  const files = [];
  let variant = 1;
  for (const setId of SET_IDS) {
    for (const locale of LOCALES) {
      files.push({
        set: setId,
        locale,
        name: "01-inbox.png",
        shot: NEUTRAL_SHOTS[0],
        bytes: pngFor(setId, variant),
        pixelSize: acceptedSize(setId),
      });
      variant += 1;
    }
  }
  return files;
}

function secondFile(setId, locale, shot, variant) {
  return {
    set: setId,
    locale,
    name: "02-send.png",
    shot,
    bytes: pngFor(setId, variant),
    pixelSize: acceptedSize(setId),
  };
}

function capturedPacket(fileCount) {
  const packet = JSON.parse(JSON.stringify(shippedPacket));
  packet.screenshots.state = "captured";
  packet.screenshots.capturedCount = fileCount;
  packet.screenshots.blockedBy = [];
  return packet;
}

let bundleNumber = 0;
function stage({ files = baseFiles(), packet, manifestMutate, rawMutate, diskMutate, entryMutate }) {
  bundleNumber += 1;
  const dir = join(work, `bundle-${bundleNumber}`);
  const entries = [];

  for (const file of files) {
    const relative = `${file.set}/${file.locale}/${file.name}`;
    if (!file.skipDisk) {
      mkdirSync(join(dir, file.set, file.locale), { recursive: true });
      writeFileSync(join(dir, ...relative.split("/")), file.bytes);
    } else {
      mkdirSync(join(dir, file.set, file.locale), { recursive: true });
    }
    entries.push({
      file: file.path ?? relative,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      bytes: file.bytes.length,
      encoding: file.encoding ?? "png",
      pixelSize: file.pixelSize,
      shot: file.shot,
      capture: { ...CAPTURE },
      humanReview: { ...HUMAN_REVIEW },
    });
  }
  mkdirSync(dir, { recursive: true });

  if (entryMutate) entryMutate(entries[0], entries);

  const manifest = {
    schemaVersion: 1,
    bundle: {
      marketingVersion: shippedPacket.record.marketingVersion,
      stagedAt: "2026-09-03",
      stagedBy: "Fixture Stager",
    },
    files: entries,
  };
  if (manifestMutate) manifestMutate(manifest);

  let text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (rawMutate) text = rawMutate(text);
  writeFileSync(join(dir, "manifest.json"), text);

  if (diskMutate) diskMutate(dir);

  let packetPath = shippedPacketPath;
  if (packet !== null) {
    const resolved = packet ?? capturedPacket(files.filter((file) => !file.skipDisk).length);
    packetPath = join(work, `packet-${bundleNumber}.json`);
    writeFileSync(packetPath, `${JSON.stringify(resolved, null, 2)}\n`);
  }
  return { dir, packetPath };
}

function run(dir, packetPath, extraArgs = []) {
  const args = [validator, "--packet", packetPath, "--quiet", ...extraArgs];
  if (dir !== null) args.push("--bundle", dir);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function rejects(label, spec, expected) {
  cases += 1;
  const { dir, packetPath } = stage(spec);
  const { status, out } = run(dir, packetPath);
  if (status !== 1) {
    bad(label, `exited ${status}, expected 1; output: ${out.trim().split("\n").slice(0, 3).join(" | ")}`);
    return;
  }
  if (!out.includes(expected)) {
    bad(label, `rejected, but no finding mentioned ${JSON.stringify(expected)}; output: ${out.trim()}`);
    return;
  }
  ok(label);
}

function accepts(label, spec) {
  cases += 1;
  const { dir, packetPath } = stage(spec);
  const { status, out } = run(dir, packetPath);
  if (status !== 0) {
    bad(label, `exited ${status}, expected 0; output: ${out.trim()}`);
    return;
  }
  ok(label);
}

function exitsTwo(label, args) {
  cases += 1;
  const result = spawnSync(process.execPath, [validator, ...args], { encoding: "utf8" });
  if (result.status !== 2) {
    bad(label, `exited ${result.status}, expected 2; output: ${`${result.stdout}${result.stderr}`.trim()}`);
    return;
  }
  ok(label);
}

// A packet mutation the validator must treat as fatal rather than as a rule to
// enforce: if the source of truth is broken, checking files against it would
// carry the break into an upload.
function packetIsFatal(label, mutate, expected) {
  cases += 1;
  const packet = capturedPacket(4);
  mutate(packet);
  const packetPath = join(work, `fatal-packet-${cases}.json`);
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const result = spawnSync(process.execPath, [validator, "--packet", packetPath, "--expect-blocked"], {
    encoding: "utf8",
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 2) {
    bad(label, `exited ${result.status}, expected 2; output: ${out.trim()}`);
    return;
  }
  if (!out.includes(expected)) {
    bad(label, `exited 2, but the message did not mention ${JSON.stringify(expected)}; output: ${out.trim()}`);
    return;
  }
  ok(label);
}

// ── the two positive anchors ─────────────────────────────────────────────────

accepts("a complete bundle beside a captured packet", {});

accepts("the Account shot, once the packet says the products are real", {
  files: [
    ...baseFiles(),
    ...SET_IDS.flatMap((setId, s) =>
      LOCALES.map((locale, l) => ({
        ...secondFile(setId, locale, ACCOUNT_SHOT, 40 + s * 4 + l),
      })),
    ),
  ],
  packet: (() => {
    const packet = capturedPacket(SET_IDS.length * LOCALES.length * 2);
    packet.subscriptions.productIdentifiersAreProposedDrafts = false;
    packet.appStoreConnectObservation.observedFields.find((e) => e.id === "subscription-products").present = true;
    return packet;
  })(),
});

// ── the readiness gate, which staging cannot substitute for ──────────────────

rejects(
  "a perfect bundle beside the shipped not-captured packet",
  { packet: null },
  "A staged bundle cannot be reported ready",
);

rejects(
  "a captured packet that still records a blocker",
  {
    packet: (() => {
      const packet = capturedPacket(4);
      packet.screenshots.blockedBy = ["the subscription products do not exist"];
      return packet;
    })(),
  },
  "a captured gate has none left",
);

rejects(
  "a captured count that does not match the staged files",
  { packet: capturedPacket(9) },
  "screenshots.capturedCount",
);

rejects(
  "the Account shot while the packet records no real products",
  {
    files: [
      ...baseFiles(),
      ...SET_IDS.flatMap((setId, s) =>
        LOCALES.map((locale, l) => secondFile(setId, locale, ACCOUNT_SHOT, 50 + s * 4 + l)),
      ),
    ],
    packet: capturedPacket(SET_IDS.length * LOCALES.length * 2),
  },
  "captures the Account screen",
);

// ── image bytes ──────────────────────────────────────────────────────────────
//
// Every case here replaces one staged file's BYTES. The two helpers keep the
// edit visible: `pngCase` and `jpegCase` stage a small malformed image in the
// first cell and require the validator to name the defect. The positive
// encoders are asserted separately, because a positive case that accepted a
// marker stream would prove nothing at all.

function pngCase(label, options, expected) {
  rejects(
    label,
    {
      files: (() => {
        const files = baseFiles();
        files[0] = { ...files[0], bytes: buildPng({ width: 4, height: 8, ...options }), pixelSize: "4x8" };
        return files;
      })(),
    },
    expected,
  );
}

function jpegCase(label, options, expected) {
  rejects(
    label,
    {
      files: (() => {
        const files = baseFiles();
        files[0] = {
          ...files[0],
          name: "01-inbox.jpg",
          encoding: "jpeg",
          bytes: options.bytes ?? buildJpeg({ width: 64, height: 128, ...options }),
          pixelSize: "64x128",
        };
        return files;
      })(),
    },
    expected,
  );
}

pngCase("a PNG with an alpha channel", { colourType: 6 }, "alpha channel (colour type 6)");
pngCase("a PNG carrying a tRNS transparency chunk", { trns: true }, "tRNS transparency chunk");
pngCase("a PNG with a failed chunk CRC", { corruptCrc: true }, "fails its CRC");
pngCase("a PNG with bytes after IEND", { afterIend: [0x52, 0x45, 0x4c, 0x41] }, "byte(s) after IEND");
pngCase("a PNG with no IEND", { omitIend: true }, "it has no IEND");

// A header and an end marker, with no image between them. This is the shape a
// hand-built fixture takes, and it used to pass.
pngCase("a PNG with no IDAT at all", { omitIdat: true }, "no IDAT image data");

pngCase(
  "a PNG whose IDAT chunks have another chunk wedged between them",
  { interruptIdat: true },
  "IDAT chunks are not consecutive",
);

pngCase(
  "a PNG whose IDAT data is not a zlib stream",
  { brokenZlib: true },
  "do not inflate to an image",
);

pngCase(
  "a PNG whose IDAT inflates one scanline short of its header",
  { scanlineShortfall: 1 },
  "inflates to",
);

// Both fields are legal on their own. The PAIR is not: PNG defines truecolour
// at 8 and 16 bits only, and a decoder that accepted this would be guessing.
pngCase(
  "a PNG whose colour type and bit depth are not a pair PNG defines",
  { colourType: 2, bitDepth: 4 },
  "at bit depth 4 on colour type 2",
);

pngCase(
  "a palette PNG carrying no PLTE",
  { colourType: 3, bitDepth: 8 },
  "no PLTE chunk",
);

pngCase(
  "a palette PNG whose PLTE is larger than its indices can address",
  { colourType: 3, bitDepth: 2, palette: greyPalette() },
  "more than the 4 a 2-bit index can address",
);

// 256 entries is PNG's hard ceiling on a palette, and it holds on a TRUECOLOUR
// image too, where the palette is the optional suggested one. There is no index
// width to check it against there, so the colour-type-3 rule above never fires
// and an over-long PLTE would otherwise ship unchallenged.
pngCase(
  "a truecolour PNG whose optional PLTE holds more than 256 entries",
  { colourType: 2, bitDepth: 8, palette: Buffer.alloc(300 * 3, 9) },
  "holds 300 entries, and PNG allows at most 256",
);

// Adam7 is legal PNG and is refused rather than half-checked; the message has to
// say that plainly, because a rejected valid file is a support question.
pngCase("an Adam7 interlaced PNG", { interlace: 1 }, "Adam7 interlaced PNG");

// The palette path is legal and opaque, so it also has to be ACCEPTED. Without
// this, "reject colour type 3" would pass every case above.
accepts("a bundle whose first file is an 8-bit palette PNG", {
  files: (() => {
    const files = baseFiles();
    const [width, height] = acceptedSize(SET_IDS[0]).split("x").map(Number);
    files[0] = {
      ...files[0],
      bytes: cachedPng({ width, height, colourType: 3, palette: [...greyPalette()], fill: 7 }),
      pixelSize: acceptedSize(SET_IDS[0]),
    };
    return files;
  })(),
});

rejects(
  "a pixel size one row short of an accepted one",
  {
    files: (() => {
      const files = baseFiles();
      const [width, height] = acceptedSize(SET_IDS[0]).split("x").map(Number);
      files[0] = {
        ...files[0],
        bytes: cachedPng({ width, height: height - 1, fill: 9 }),
        pixelSize: `${width}x${height - 1}`,
      };
      return files;
    })(),
  },
  "the packet accepts",
);

rejects(
  "a landscape frame",
  {
    files: (() => {
      const files = baseFiles();
      files[0] = { ...files[0], bytes: cachedPng({ width: 8, height: 4, fill: 11 }), pixelSize: "8x4" };
      return files;
    })(),
  },
  "which is not portrait",
);

rejects(
  "a manifest pixel size that disagrees with the file's own header",
  { entryMutate: (entry) => { entry.pixelSize = "1x1"; } },
  "the file's own header says",
);

// ── JPEG ─────────────────────────────────────────────────────────────────────

const [jpegWidth, jpegHeight] = acceptedSize(SET_IDS[0]).split("x").map(Number);
const encodedJpeg = cachedJpeg({ width: jpegWidth, height: jpegHeight, components: 1 });
const restartJpeg = cachedJpeg({ width: jpegWidth, height: jpegHeight, components: 3, restartInterval: 17 });
const multiScanJpeg = cachedJpeg({ width: jpegWidth, height: jpegHeight, components: 3, nonInterleaved: true });

// A marker cannot appear inside entropy-coded data — a 0xff byte there is
// written as `0xff00`, and the only markers allowed between are restarts — so
// counting the pairs counts segments.
function countMarkers(bytes, marker) {
  let count = 0;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === marker) count += 1;
  }
  return count;
}

// The two properties the positive cases below are supposed to exercise are
// properties of the ENTROPY DATA, and neither is visible in the case itself. If
// a change to the encoder stopped producing them, the accept cases would keep
// passing while testing a narrower thing, so they are asserted here.
fixtureCarries(
  "the encoded JPEG fixture contains a stuffed 0xff00 pair",
  encodedJpeg.includes(Buffer.from([0xff, 0x00])),
);
fixtureCarries(
  "the restart-marker JPEG fixture contains an RST0 marker",
  restartJpeg.includes(Buffer.from([0xff, 0xd0])),
);
fixtureCarries(
  "the multi-scan JPEG fixture carries three SOS segments",
  countMarkers(multiScanJpeg, 0xda) === 3,
);

accepts("a bundle whose first file is a genuinely encoded baseline JPEG", {
  files: (() => {
    const files = baseFiles();
    files[0] = {
      ...files[0],
      name: "01-inbox.jpg",
      encoding: "jpeg",
      bytes: encodedJpeg,
      pixelSize: acceptedSize(SET_IDS[0]),
    };
    return files;
  })(),
});

// Three single-component scans rather than one interleaved scan: legal baseline
// JPEG, and the same multi-scan shape a progressive file takes. The walk has to
// stop at the marker ending each scan and pick the next SOS up from there.
accepts("a genuinely encoded JPEG split into three single-component scans", {
  files: (() => {
    const files = baseFiles();
    files[0] = {
      ...files[0],
      name: "01-inbox.jpg",
      encoding: "jpeg",
      bytes: multiScanJpeg,
      pixelSize: acceptedSize(SET_IDS[0]),
    };
    return files;
  })(),
});

accepts("a genuinely encoded JPEG carrying restart markers and three components", {
  files: (() => {
    const files = baseFiles();
    files[0] = {
      ...files[0],
      name: "01-inbox.jpg",
      encoding: "jpeg",
      bytes: restartJpeg,
      pixelSize: acceptedSize(SET_IDS[0]),
    };
    return files;
  })(),
});

// The bypass this suite used to contain: SOI, a frame header, EOI. It declares
// 64x128 and carries not one entropy-coded byte, and until the scan was walked
// it satisfied every check the validator made.
jpegCase(
  "a JPEG marker stream: a frame header, EOI, and no scan between them",
  { bytes: markerStreamJpeg({ width: 64, height: 128 }) },
  "reaches EOI with no SOS scan",
);

jpegCase(
  "a JPEG whose scan header is followed straight by its EOI",
  { emptyScan: true },
  "no entropy-coded data",
);

jpegCase(
  "a JPEG whose entropy-coded scan runs off the end of the file",
  { truncateScan: true, eoi: false },
  "runs to the end of the file",
);

jpegCase(
  "a JPEG whose scan carries a corrupt marker pair",
  { corruptScanAt: 40 },
  "is not a JPEG marker",
);

jpegCase(
  "a JPEG that reaches its scan with no Huffman table defined",
  { huffmanTable: false },
  "no DHT Huffman table",
);

jpegCase(
  "a JPEG that reaches its scan with no quantization table defined",
  { quantTable: false },
  "no DQT quantization table",
);

jpegCase(
  "a JPEG with bytes after its EOI",
  { afterEoi: [0x52, 0x45, 0x4c, 0x41] },
  "byte(s) after EOI",
);

jpegCase(
  "a CMYK JPEG",
  { components: 4 },
  "4-component JPEG",
);

// Only the frame marker is arithmetic here; the entropy data behind it is the
// Huffman-coded one the encoder writes. The frame marker is what is refused, and
// it is refused before anything reads the scan.
jpegCase(
  "an arithmetic-coded JPEG",
  { sofMarker: 0xc9 },
  "arithmetic, lossless or hierarchical JPEG",
);

jpegCase(
  "a JPEG with no frame header",
  { frame: false, scan: false },
  "ends before any frame header",
);

// ── JPEG tables, and the references into them ────────────────────────────────
//
// The bypass these close: the validator used to record that a DQT or DHT MARKER
// had gone past and treat that as a table. An empty segment, a half-written one
// and a scan naming a table nothing defined all satisfied "a DQT was present".
// Each case below writes exactly one malformed table or one dangling reference
// and leaves the rest of the encoder's real output in place.
//
// A note on what a pass here means: these prove the scan's references RESOLVE.
// The entropy bytes behind them are still only stepped, never Huffman-decoded,
// so none of this claims the picture decodes.

// A DQT segment with a length field and no table body at all.
jpegCase(
  "a JPEG whose DQT segment is empty",
  { dqtPayload: Buffer.alloc(0) },
  "DQT segment that defines no quantization table",
);

// Declares an 8-bit table 0, then carries 30 of the 64 coefficients it needs.
jpegCase(
  "a JPEG whose DQT table is cut short of its 64 coefficients",
  { dqtPayload: Buffer.concat([Buffer.from([0x00]), Buffer.alloc(30, 16)]) },
  "needs 64 coefficient bytes",
);

jpegCase(
  "a JPEG whose DQT table declares an undefined precision",
  { dqtPayload: Buffer.concat([Buffer.from([0x20]), Buffer.alloc(64, 16)]) },
  "DQT table declares precision 2",
);

jpegCase(
  "a JPEG whose DQT table declares an out-of-range table id",
  { dqtPayload: Buffer.concat([Buffer.from([0x05]), Buffer.alloc(64, 16)]) },
  "DQT table declares id 5",
);

jpegCase(
  "a JPEG whose DHT segment is empty",
  { dhtPayload: Buffer.alloc(0) },
  "DHT segment that defines no Huffman table",
);

// Sixteen counts declaring twelve DC codes, and no symbol bytes behind them.
jpegCase(
  "a JPEG whose DHT table declares codes it does not carry",
  { dhtPayload: Buffer.concat([Buffer.from([0x00]), Buffer.from(STANDARD_DC_BITS)]) },
  "carries 0 symbol byte(s)",
);

jpegCase(
  "a JPEG whose DHT table is cut short of its sixteen code-length counts",
  { dhtPayload: Buffer.from([0x00, 0, 1, 5, 1]) },
  "code-length counts run past its segment",
);

jpegCase(
  "a JPEG whose DHT table declares an undefined table class",
  {
    dhtPayload: Buffer.concat([
      Buffer.from([0x20]),
      Buffer.from(STANDARD_DC_BITS),
      Buffer.from(STANDARD_DC_VALUES),
    ]),
  },
  "DHT table declares class 2",
);

jpegCase(
  "a JPEG whose DHT table declares an out-of-range table id",
  {
    dhtPayload: Buffer.concat([
      Buffer.from([0x07]),
      Buffer.from(STANDARD_DC_BITS),
      Buffer.from(STANDARD_DC_VALUES),
    ]),
  },
  "DHT table declares id 7",
);

// Sixteen zero counts: a structurally complete table that defines no code.
jpegCase(
  "a JPEG whose DHT table defines no codes at all",
  { dhtPayload: Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16, 0)]) },
  "declares no codes at all",
);

// Three one-bit codes. Only two exist, so no canonical table can be built —
// and every byte of the segment is present and correctly sized, which is why
// counting bytes alone would let this through.
jpegCase(
  "a JPEG whose DHT code lengths over-subscribe the code space",
  {
    dhtPayload: Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from([3, ...Array(15).fill(0)]),
      Buffer.from([0, 1, 2]),
    ]),
  },
  "over-subscribe the Huffman code space",
);

jpegCase(
  "a JPEG whose frame declares the same component id twice",
  { components: 3, frameComponentIds: [1, 1, 3] },
  "declares component id 1 twice",
);

jpegCase(
  "a JPEG whose frame component selects an out-of-range quantization table",
  { frameQuantSelectors: [5] },
  "selects quantization table 5, and JPEG defines only tables 0-3",
);

// In range, correctly sized, and pointing at a table the file never defines.
jpegCase(
  "a JPEG whose frame component selects a quantization table nothing defines",
  { frameQuantSelectors: [2] },
  "selects quantization table 2, which no DQT segment defines",
);

jpegCase(
  "a JPEG whose scan selects a component its frame does not declare",
  { scanSelectors: [9] },
  "selects component 9, which its frame header does not declare",
);

jpegCase(
  "a JPEG whose scan selects the same component twice",
  { components: 3, scanSelectors: [1, 1, 2] },
  "selects component 1 twice",
);

jpegCase(
  "a JPEG whose scan selects a DC Huffman table nothing defines",
  { scanTableBytes: [0x30] },
  "selects DC Huffman table 3 for component 1, which no DHT segment defines",
);

jpegCase(
  "a JPEG whose scan selects an AC Huffman table nothing defines",
  { scanTableBytes: [0x03] },
  "selects AC Huffman table 3 for component 1, which no DHT segment defines",
);

// A sequential scan codes both bands, so dropping either table is fatal even
// though the other one is present and the DHT segment itself is well formed.
jpegCase(
  "a sequential JPEG whose DHT defines only the AC table",
  { huffmanClasses: ["ac"] },
  "selects DC Huffman table 0 for component 1, which no DHT segment defines",
);

jpegCase(
  "a sequential JPEG whose DHT defines only the DC table",
  { huffmanClasses: ["dc"] },
  "selects AC Huffman table 0 for component 1, which no DHT segment defines",
);

// The other half of that rule, and the one a naive "require both tables" check
// gets wrong. A PROGRESSIVE scan codes one band, so a DC-band scan reaches no
// AC table and an AC-band scan reaches no DC table. Neither file may be
// rejected for the table its scan cannot use.
//
// These two fixtures are structurally progressive — SOF2, one spectral band per
// scan — over the sequential encoder's entropy bytes. That is honest here for
// exactly the reason stated above: the validator steps those bytes and never
// decodes them, so what the cases exercise is the table-resolution rule and
// nothing else.
const progressiveDcJpeg = cachedJpeg({
  width: jpegWidth,
  height: jpegHeight,
  components: 1,
  sofMarker: 0xc2,
  huffmanClasses: ["dc"],
  spectralStart: 0,
  spectralEnd: 0,
});
const progressiveAcJpeg = cachedJpeg({
  width: jpegWidth,
  height: jpegHeight,
  components: 1,
  sofMarker: 0xc2,
  huffmanClasses: ["ac"],
  spectralStart: 1,
  spectralEnd: 63,
});

// The property these two cases turn on is invisible in the cases themselves:
// each fixture must define ONE Huffman class and omit the other. If the encoder
// started emitting both, both cases would keep passing while proving nothing.
const DC_TABLE_BYTES = Buffer.concat([Buffer.from([0x00]), Buffer.from(STANDARD_DC_BITS)]);
const AC_TABLE_BYTES = Buffer.concat([Buffer.from([0x10]), Buffer.from(STANDARD_AC_BITS)]);
fixtureCarries(
  "the progressive DC fixture declares SOF2 and defines only a DC Huffman table",
  countMarkers(progressiveDcJpeg, 0xc2) === 1 &&
    progressiveDcJpeg.includes(DC_TABLE_BYTES) &&
    !progressiveDcJpeg.includes(AC_TABLE_BYTES),
);
fixtureCarries(
  "the progressive AC fixture declares SOF2 and defines only an AC Huffman table",
  countMarkers(progressiveAcJpeg, 0xc2) === 1 &&
    progressiveAcJpeg.includes(AC_TABLE_BYTES) &&
    !progressiveAcJpeg.includes(DC_TABLE_BYTES),
);

accepts("a progressive JPEG whose DC-band scan needs only the DC table it defines", {
  files: (() => {
    const files = baseFiles();
    files[0] = {
      ...files[0],
      name: "01-inbox.jpg",
      encoding: "jpeg",
      bytes: progressiveDcJpeg,
      pixelSize: acceptedSize(SET_IDS[0]),
    };
    return files;
  })(),
});

accepts("a progressive JPEG whose AC-band scan needs only the AC table it defines", {
  files: (() => {
    const files = baseFiles();
    files[0] = {
      ...files[0],
      name: "01-inbox.jpg",
      encoding: "jpeg",
      bytes: progressiveAcJpeg,
      pixelSize: acceptedSize(SET_IDS[0]),
    };
    return files;
  })(),
});

rejects(
  "JPEG bytes behind a .png extension",
  {
    files: (() => {
      const files = baseFiles();
      files[0] = { ...files[0], bytes: buildJpeg({ width: 4, height: 8 }), pixelSize: "4x8", encoding: "jpeg" };
      return files;
    })(),
  },
  "but the file's bytes are jpeg",
);

rejects(
  "a declared encoding that disagrees with the magic number",
  {
    files: (() => {
      const files = baseFiles();
      files[0] = {
        ...files[0],
        name: "01-inbox.jpg",
        bytes: buildJpeg({ width: 4, height: 8 }),
        pixelSize: "4x8",
        encoding: "png",
      };
      return files;
    })(),
  },
  "says 'png', but the file's bytes are jpeg",
);

rejects(
  "a file that is neither a PNG nor a JPEG",
  {
    files: (() => {
      const files = baseFiles();
      files[0] = { ...files[0], bytes: Buffer.from("this is not an image\n"), pixelSize: "4x8" };
      return files;
    })(),
  },
  "neither a PNG nor a JPEG by its magic number",
);

rejects(
  "an empty file",
  {
    files: (() => {
      const files = baseFiles();
      files[0] = { ...files[0], bytes: Buffer.alloc(0) };
      return files;
    })(),
  },
  "is empty",
);

// ── the manifest against the bytes ───────────────────────────────────────────

rejects(
  "two byte-identical files",
  {
    files: (() => {
      const files = baseFiles();
      files[1] = { ...files[1], bytes: files[0].bytes };
      return files;
    })(),
  },
  "is byte-identical to",
);

rejects(
  "a digest that does not match the file",
  { entryMutate: (entry) => { entry.sha256 = "0".repeat(64); } },
  "the file hashes to",
);

rejects(
  "a digest that is not a digest",
  { entryMutate: (entry) => { entry.sha256 = "not-a-digest"; } },
  "lowercase 64-character SHA-256",
);

rejects(
  "a byte count that does not match the file",
  { entryMutate: (entry) => { entry.bytes = 1; } },
  "the file is",
);

// ── the grid ─────────────────────────────────────────────────────────────────

rejects(
  "a missing set-locale cell",
  {
    files: baseFiles().slice(0, -1),
    packet: capturedPacket(SET_IDS.length * LOCALES.length - 1),
  },
  "has no screenshot",
);

rejects(
  "a cell over the packet's own maximum",
  {
    files: [...baseFiles(), secondFile(SET_IDS[0], LOCALES[0], NEUTRAL_SHOTS[1], 60)],
    packet: (() => {
      const packet = capturedPacket(SET_IDS.length * LOCALES.length + 1);
      packet.screenshots.rules.maxPerSetPerLocale = 1;
      return packet;
    })(),
  },
  "the packet allows at most 1",
);

rejects(
  "a cell under the packet's own minimum",
  {
    packet: (() => {
      const packet = capturedPacket(SET_IDS.length * LOCALES.length);
      packet.screenshots.rules.minPerSetPerLocale = 3;
      return packet;
    })(),
  },
  "the packet requires at least 3",
);

rejects(
  "the same shot staged twice in one cell",
  {
    files: [...baseFiles(), secondFile(SET_IDS[0], LOCALES[0], NEUTRAL_SHOTS[0], 61)],
    packet: capturedPacket(SET_IDS.length * LOCALES.length + 1),
  },
  "times in one cell",
);

rejects(
  "one localization telling a different story than the other",
  {
    files: baseFiles().map((file, index) =>
      index === 1 ? { ...file, shot: NEUTRAL_SHOTS[1] } : file,
    ),
  },
  "a different ordered shot sequence per localization",
);

rejects(
  "a shot the packet does not list",
  { entryMutate: (entry) => { entry.shot = "Some screen that is not in the shot list"; } },
  "screenshots.shotList entries exactly",
);

// ── provenance ───────────────────────────────────────────────────────────────

rejects(
  "a Debug capture",
  { entryMutate: (entry) => { entry.capture.configuration = "Debug"; } },
  "the packet requires 'Release'",
);

rejects(
  "a --relayium-ui-testing launch",
  { entryMutate: (entry) => { entry.capture.launchArguments = ["--relayium-ui-testing"]; } },
  "a UI-testing launch renders fixture data",
);

rejects(
  "an admitted UI-test fixture",
  { entryMutate: (entry) => { entry.capture.usedUITestFixtures = true; } },
  "usedUITestFixtures",
);

rejects(
  "an admitted fabricated price",
  { entryMutate: (entry) => { entry.capture.fabricatedPrices = true; } },
  "false commercial claim",
);

rejects(
  "an admitted retouch",
  { entryMutate: (entry) => { entry.capture.retouched = true; } },
  "the packet forbids retouching",
);

rejects(
  "a capture source that is neither a simulator nor a device",
  { entryMutate: (entry) => { entry.capture.source = "photoshop"; } },
  "it must be 'simulator' or 'device'",
);

rejects(
  "an unrecorded build identifier",
  { entryMutate: (entry) => { entry.capture.buildIdentifier = ""; } },
  "buildIdentifier",
);

rejects(
  "a missing capture block",
  { entryMutate: (entry) => { delete entry.capture; } },
  "every file states how it was captured",
);

// ── the human review this program cannot perform ─────────────────────────────

rejects(
  "a missing human review",
  { entryMutate: (entry) => { delete entry.humanReview; } },
  "there is no OCR and no image inspection in this validator",
);

rejects(
  "a review claimed to have been done by OCR",
  { entryMutate: (entry) => { entry.humanReview.method = "ocr"; } },
  "This validator performs no OCR",
);

rejects(
  "a review claimed to have been automated",
  { entryMutate: (entry) => { entry.humanReview.method = "automated"; } },
  "This validator performs no OCR",
);

rejects(
  "a review method that is not the accepted one",
  { entryMutate: (entry) => { entry.humanReview.method = "glanced-at"; } },
  "it must be exactly 'human-visual'",
);

rejects(
  "an unconfirmed neutral-content review",
  { entryMutate: (entry) => { entry.humanReview.neutralContentConfirmed = false; } },
  "Nothing here reads the pixels",
);

rejects(
  "an unconfirmed truthfulness review",
  { entryMutate: (entry) => { entry.humanReview.truthfulUnretouchedConfirmed = false; } },
  "real appearance and real data, unretouched",
);

rejects(
  "an unnamed reviewer",
  { entryMutate: (entry) => { entry.humanReview.reviewer = "   "; } },
  "an unfilled attestation field is not an attestation",
);

rejects(
  "a review date that is not a real date",
  { entryMutate: (entry) => { entry.humanReview.reviewedAt = "2026-02-30"; } },
  "which is not a real date",
);

rejects(
  "a review date that is not a date at all",
  { entryMutate: (entry) => { entry.humanReview.reviewedAt = "yesterday"; } },
  "ISO 'YYYY-MM-DD' date",
);

rejects(
  "a review with no written note",
  { entryMutate: (entry) => { delete entry.humanReview.notes; } },
  "humanReview.notes: is missing",
);

// ── paths and the disk ───────────────────────────────────────────────────────

rejects(
  "a double-extension file name",
  {
    files: (() => {
      const files = baseFiles();
      files[0] = { ...files[0], name: "01-inbox.png.command" };
      return files;
    })(),
  },
  "unsafe file name",
);

rejects(
  "a '..' path segment",
  { entryMutate: (entry) => { entry.file = `..${"/"}${LOCALES[0]}/01-inbox.png`; } },
  "contains a '.' or '..' segment",
);

rejects(
  "a path that escapes the set/locale depth",
  { entryMutate: (entry) => { entry.file = `${SET_IDS[0]}/${LOCALES[0]}/nested/01-inbox.png`; } },
  "path segment(s)",
);

rejects(
  "an absolute path",
  { entryMutate: (entry) => { entry.file = "/etc/passwd.png"; } },
  "is an absolute path",
);

rejects(
  "a backslash in a path",
  { entryMutate: (entry) => { entry.file = `${SET_IDS[0]}${"\\"}${LOCALES[0]}${"\\"}01-inbox.png`; } },
  "contains a backslash",
);

rejects(
  "a control character in a path",
  { entryMutate: (entry) => { entry.file = `${SET_IDS[0]}/${LOCALES[0]}/01${BELL}inbox.png`; } },
  "contains a control character",
);

rejects(
  "a set the packet does not declare",
  { entryMutate: (entry) => { entry.file = `iphone-4.7/${LOCALES[0]}/01-inbox.png`; } },
  "which the packet does not declare",
);

rejects(
  "a locale the packet does not declare",
  { entryMutate: (entry) => { entry.file = `${SET_IDS[0]}/fr-FR/01-inbox.png`; } },
  "which the packet does not declare",
);

rejects(
  "the same path listed twice",
  {
    manifestMutate: (manifest) => {
      manifest.files.push(JSON.parse(JSON.stringify(manifest.files[0])));
    },
  },
  "a second time",
);

rejects(
  "a manifest entry with no file behind it",
  {
    diskMutate: (dir) => {
      rmSync(join(dir, SET_IDS[0], LOCALES[0], "01-inbox.png"));
    },
  },
  "names a file that is not in the bundle",
);

rejects(
  "a file on disk the manifest does not list",
  {
    diskMutate: (dir) => {
      writeFileSync(join(dir, SET_IDS[0], LOCALES[0], ".DS_Store"), "leftover");
    },
  },
  "does not list it",
);

rejects(
  "a set directory the packet does not declare",
  {
    diskMutate: (dir) => {
      mkdirSync(join(dir, "iphone-4.7"), { recursive: true });
      writeFileSync(join(dir, "iphone-4.7", "stray.png"), "stray");
    },
  },
  "is not one of the packet's sets",
);

rejects(
  "a locale directory the packet does not declare",
  {
    diskMutate: (dir) => {
      mkdirSync(join(dir, SET_IDS[0], "fr-FR"), { recursive: true });
      writeFileSync(join(dir, SET_IDS[0], "fr-FR", "stray.png"), "stray");
    },
  },
  "is not one of the packet's locales",
);

rejects(
  "a directory below the set/locale level",
  {
    diskMutate: (dir) => {
      mkdirSync(join(dir, SET_IDS[0], LOCALES[0], "originals"), { recursive: true });
    },
  },
  "exactly two levels deep",
);

rejects(
  "a symlink staged in the bundle",
  {
    diskMutate: (dir) => {
      symlinkSync(join(dir, SET_IDS[0], LOCALES[0], "01-inbox.png"), join(dir, SET_IDS[0], LOCALES[0], "02-link.png"));
    },
  },
  "is a symlink",
);

// ── manifest structure ───────────────────────────────────────────────────────

rejects(
  "a key the manifest schema does not define",
  { entryMutate: (entry) => { entry.retouced = false; } },
  "is not a key this manifest schema defines",
);

rejects(
  "a top-level key the manifest schema does not define",
  { manifestMutate: (manifest) => { manifest.uploadedAt = "2026-09-03"; } },
  "manifest.json.uploadedAt",
);

rejects(
  "a manifest staged against a different marketing version",
  { manifestMutate: (manifest) => { manifest.bundle.marketingVersion = "0.2.0"; } },
  "the packet's record is at",
);

rejects(
  "an unknown manifest schema version",
  { manifestMutate: (manifest) => { manifest.schemaVersion = 2; } },
  "this validator reads version 1",
);

rejects(
  "a manifest with no files",
  { manifestMutate: (manifest) => { manifest.files = []; } },
  "a bundle with no files is not a bundle",
);

rejects(
  "a manifest that does not say who staged it",
  { manifestMutate: (manifest) => { delete manifest.bundle.stagedBy; } },
  "bundle.stagedBy: is missing",
);

rejects(
  "a duplicate key in the manifest",
  { rawMutate: (text) => text.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,') },
  "twice in one object",
);

rejects(
  "a __proto__ key in the manifest",
  { rawMutate: (text) => text.replace('"schemaVersion": 1,', '"__proto__": {},\n  "schemaVersion": 1,') },
  "declares a '__proto__' key",
);

// One key, two spellings. `JSON.parse` decodes `\u0072etouched` to `retouched`
// and keeps whichever came last, so a scan comparing the raw TEXT sees two
// different keys, reports nothing, and lets one `retouched` attestation
// silently override the other. Both orderings are staged: a scan that decoded
// only the second string would still pass one of them. The values are equal, so
// the duplicate is the ONLY thing wrong with these manifests — nothing else in
// the validator can reject them.
rejects(
  "a key duplicated by an escaped spelling, plain first",
  {
    rawMutate: (text) =>
      text.replace('"retouched": false', '"retouched": false,\n          "\\u0072etouched": false'),
  },
  "declares the key 'retouched' twice",
);

rejects(
  "a key duplicated by an escaped spelling, escaped first",
  {
    rawMutate: (text) =>
      text.replace('"retouched": false', '"\\u0072etouched": false,\n          "retouched": false'),
  },
  "declares the key 'retouched' twice",
);

rejects(
  "a __proto__ key written with an escape",
  { rawMutate: (text) => text.replace('"schemaVersion": 1,', '"__proto\\u005f_": {},\n  "schemaVersion": 1,') },
  "declares a '__proto__' key",
);

rejects("a manifest with a BOM", { rawMutate: (text) => `${BOM}${text}` }, "UTF-8 BOM");

rejects("a manifest with a CRLF", { rawMutate: (text) => text.replace("\n", `${CR}\n`) }, "carriage return");

rejects("a manifest indented with a tab", { rawMutate: (text) => text.replace("  ", TAB) }, "contains a tab");

rejects("a manifest with no trailing newline", { rawMutate: (text) => text.trimEnd() }, "does not end with a newline");

rejects(
  "a manifest that is not valid JSON",
  { rawMutate: (text) => text.replace("{", "{{") },
  "is not valid JSON",
);

// ── the packet as the source of truth ────────────────────────────────────────

packetIsFatal(
  "a packet that permits an alpha channel",
  (packet) => { packet.screenshots.rules.alphaChannelAllowed = true; },
  "says an alpha channel is allowed",
);

packetIsFatal(
  "a packet that stops forbidding retouching",
  (packet) => { packet.screenshots.capture.retouchingForbidden = false; },
  "retouchingForbidden",
);

packetIsFatal(
  "a packet that stops forbidding Debug builds",
  (packet) => { packet.screenshots.capture.debugBuildsForbidden = false; },
  "debugBuildsForbidden",
);

packetIsFatal(
  "a packet listing a landscape size as a portrait one",
  (packet) => { packet.screenshots.sets[0].acceptedPortraitPixelSizes[0] = "2868x1320"; },
  "but it is not portrait",
);

packetIsFatal(
  "a packet with a maximum below its minimum",
  (packet) => { packet.screenshots.rules.maxPerSetPerLocale = 0; },
  "malformed maxPerSetPerLocale",
);

packetIsFatal(
  "a packet that declares the same set twice",
  (packet) => { packet.screenshots.sets.push(packet.screenshots.sets[0]); },
  "twice",
);

// ── --expect-blocked, which asserts the gate rather than skipping it ─────────

cases += 1;
{
  const result = spawnSync(process.execPath, [validator, "--expect-blocked", "--quiet"], { encoding: "utf8" });
  if (result.status !== 0) {
    bad("the shipped packet's gate is honestly blocked", `exited ${result.status}: ${result.stderr}`);
  } else ok("the shipped packet's gate is honestly blocked");
}

function expectBlockedRejects(label, mutate, expected) {
  cases += 1;
  const packet = JSON.parse(JSON.stringify(shippedPacket));
  mutate(packet);
  const packetPath = join(work, `blocked-packet-${cases}.json`);
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const result = spawnSync(process.execPath, [validator, "--packet", packetPath, "--expect-blocked", "--quiet"], {
    encoding: "utf8",
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 1) {
    bad(label, `exited ${result.status}, expected 1; output: ${out.trim()}`);
    return;
  }
  if (!out.includes(expected)) {
    bad(label, `rejected, but no finding mentioned ${JSON.stringify(expected)}; output: ${out.trim()}`);
    return;
  }
  ok(label);
}

expectBlockedRejects(
  "--expect-blocked against a packet that says captured",
  (packet) => { packet.screenshots.state = "captured"; },
  "the gate is no longer blocked",
);

expectBlockedRejects(
  "--expect-blocked against a non-zero captured count",
  (packet) => { packet.screenshots.capturedCount = 6; },
  "screenshots.capturedCount",
);

expectBlockedRejects(
  "--expect-blocked against a packet that records no blocker",
  (packet) => { packet.screenshots.blockedBy = []; },
  "an uncaptured gate must say what blocks it",
);

expectBlockedRejects(
  "--expect-blocked against an observation that says the gate is met",
  (packet) => {
    packet.appStoreConnectObservation.observedFields.find((entry) => entry.id === "screenshots").present = true;
  },
  "no longer reads as an unmet blocking gate",
);

expectBlockedRejects(
  "--expect-blocked against a state that is neither captured nor not-captured",
  (packet) => { packet.screenshots.state = "in-progress"; },
  "which is neither",
);

// ── the CLI contract ─────────────────────────────────────────────────────────

cases += 1;
{
  const result = spawnSync(process.execPath, [validator, "--quiet"], { encoding: "utf8" });
  if (result.status !== 1) {
    bad("no bundle at all is a refusal, not a pass", `exited ${result.status}`);
  } else if (!`${result.stdout}${result.stderr}`.includes("'nothing staged' is a failing state")) {
    bad("no bundle at all is a refusal, not a pass", "the refusal did not explain itself");
  } else ok("no bundle at all is a refusal, not a pass");
}

exitsTwo("--expect-blocked cannot be combined with --bundle", ["--expect-blocked", "--bundle", work]);
exitsTwo("an unknown option exits 2", ["--nonsense"]);
exitsTwo("an unreadable packet exits 2", ["--packet", join(work, "nothing-here.json"), "--expect-blocked"]);
exitsTwo("a bundle directory that does not exist exits 2", ["--bundle", join(work, "no-such-bundle")]);

cases += 1;
{
  const missingManifest = join(work, "manifest-less");
  mkdirSync(missingManifest, { recursive: true });
  const result = spawnSync(process.execPath, [validator, "--bundle", missingManifest], { encoding: "utf8" });
  if (result.status !== 2) bad("a bundle with no manifest exits 2", `exited ${result.status}`);
  else ok("a bundle with no manifest exits 2");
}

// ── report ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${cases} cases, ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
