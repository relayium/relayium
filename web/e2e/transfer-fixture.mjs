/** Synthetic bytes for the opt-in small-file workload. No product imports.
 * Byte k of the workload depends only on its global offset k, so 1000 files of
 * 1024 bytes concatenate to exactly the 1 x 1,024,000-byte file. The legacy
 * `(i*37 + index*13 + 11) % 251` pattern repeats every 251 files and would let
 * a swap of file 0 and 251 pass a full-hash check; this one must not. */
import { createHash } from 'node:crypto';

export const FIXTURE_VERSION = 'relayium-small-files-fixture/1';

/** Self-contained (no outer references): injected into the sender page via toString(). */
export function fixtureBytes(offset, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    let x = Math.imul((offset + i) ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
    out[i] = x & 0xff;
  }
  return out;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Per-file {offset, bytes, sha256} for `files` consecutive slices of `size` bytes.
 * Refuses any two files with the same full digest. */
export function fileDigests(files, size, generate = fixtureBytes) {
  const rows = [], seen = new Map();
  for (let index = 0; index < files; index++) {
    const body = generate(index * size, size);
    if (body.byteLength !== size) throw new Error(`fixture file ${index} has ${body.byteLength} bytes`);
    const row = { offset: index * size, bytes: size, sha256: sha(body) };
    if (seen.has(row.sha256)) throw new Error(`fixture content collision: files ${seen.get(row.sha256)} and ${index}`);
    seen.set(row.sha256, index); rows.push(row);
  }
  return rows;
}

/** Identity of the paired workload; refuses unequal totals, collisions or a single
 * file that is not the exact concatenation of the small files. */
export function pairedManifest(manyFiles, manySize, singleSize, generate = fixtureBytes) {
  if (manyFiles * manySize !== singleSize) throw new Error('paired workloads must carry equal total bytes');
  const many = fileDigests(manyFiles, manySize, generate);
  const concatenated = createHash('sha256');
  for (const row of many) concatenated.update(generate(row.offset, row.bytes));
  const [single] = fileDigests(1, singleSize, generate);
  const concatenatedSha256 = concatenated.digest('hex');
  if (concatenatedSha256 !== single.sha256) throw new Error('single file is not the concatenation of the small files');
  return { version: FIXTURE_VERSION, totalBytes: singleSize, manyFiles, manySize,
    distinctManyDigests: many.length, manyDigestListSha256: sha(many.map(r => r.sha256).join('\n')),
    singleSha256: single.sha256, many, single };
}
