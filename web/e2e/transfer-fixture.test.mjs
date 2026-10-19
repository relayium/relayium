import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FIXTURE_VERSION, fileDigests, fixtureBytes, pairedManifest } from './transfer-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The default cases' exact per-file formula (transfer-performance.mjs), file index = offset / 1024.
const legacy = (offset, length) => { const index = Math.floor(offset / 1024);
  return Uint8Array.from({ length }, (_, i) => (i * 37 + index * 13 + 11) % 251); };

describe('small-file workload fixture', () => {
  it('gives all 1000 files distinct full digests and concatenates to the single file', () => {
    const m = pairedManifest(1000, 1024, 1024000);
    expect(m).toMatchObject({ version: FIXTURE_VERSION, totalBytes: 1024000, manyFiles: 1000, manySize: 1024, distinctManyDigests: 1000 });
    expect(new Set(m.many.map(r => r.sha256)).size).toBe(1000);
    expect(m.many.map(r => r.offset)).toEqual(Array.from({ length: 1000 }, (_, i) => i * 1024));
    expect(m.single.sha256).toBe(sha(fixtureBytes(0, 1024000)));
    // Indices that the legacy generator would make identical are distinct here.
    for (const [a, b] of [[0, 251], [0, 999], [251, 502], [748, 999]]) expect(m.many[a].sha256).not.toBe(m.many[b].sha256);
    // Pinned identity: root recomputes it independently; any generator change must show up here.
    expect(m.singleSha256).toBe(m.single.sha256);
    // Cross-checked with an independent Python implementation of the same generator.
    expect(m.manyDigestListSha256).toBe('90bab80b7dd57a014a34cffb1b0d8915021a76ca9a594123299206fee550cb6e');
    expect(m.singleSha256).toBe('8f588b32e6dc34aa126681eb7eaf8eadb587525ea225fc6866957e8a82524acc');
    expect([m.many[0].sha256, m.many[999].sha256]).toEqual(['654e3fd75256aaa9cc709fe9096a9ea172941d02e7d46b7151943d1cd0e160f6', '9fe563c3a449e1f32aac68a1890f361ff3a192eec3ef5d500d1b6d0e36110571']);
  });
  it('catches a content collision such as the legacy pattern at file 251', () => {
    expect(() => fileDigests(1000, 1024, legacy)).toThrow('fixture content collision: files 0 and 251');
    expect(() => pairedManifest(1000, 1024, 1024000, legacy)).toThrow('collision');
  });
  it('refuses unequal totals, wrong lengths and a single file that is not the concatenation', () => {
    expect(() => pairedManifest(1000, 1024, 1024001)).toThrow('equal total bytes');
    expect(() => fileDigests(2, 4, (o, n) => fixtureBytes(o, n - 1))).toThrow('has 3 bytes');
    // Identical small files, but the single file's last byte differs.
    const tampered = (o, n) => { const b = fixtureBytes(o, n); if (n === 1024000) b[n - 1] ^= 1; return b; };
    expect(() => pairedManifest(1000, 1024, 1024000, tampered)).toThrow('not the concatenation');
  });
  it('injects as self-contained source with identical bytes', () => {
    const injected = new Function(`return (${fixtureBytes.toString()})`)();
    expect(sha(injected(1024 * 999, 1024))).toBe(sha(fixtureBytes(1024 * 999, 1024)));
    expect(sha(injected(0, 1024000))).toBe(sha(fixtureBytes(0, 1024000)));
  });
});
