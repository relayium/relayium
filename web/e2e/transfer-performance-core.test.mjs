import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CASES, DEFAULT_CASES, checkedSample, distribution, options, summarize, installProbe } from './transfer-performance-core.mjs';
import { fixtureBytes, pairedManifest } from './transfer-fixture.mjs';

const valid = () => ({ kind: 'small', direction: 'A→B', iteration: 0, warmup: false, startAt: 100,
  observation: { ready: true, verified: true, bytes: 10240, closedFiles: 1, verifiedFiles: 1,
    consentAt: 110, firstWriteAt: 120, closedAt: 150, verifiedAt: 155, readyAt: 160 } });

describe('benchmark statistics and acceptance', () => {
  it('uses nearest-rank P95 and an interpolated middle pair for the median', () => {
    expect(distribution(Array.from({ length: 20 }, (_, i) => 20 - i))).toEqual({ count: 20, medianMs: 10.5, p95Ms: 19, minMs: 1, maxMs: 20 });
    expect(distribution([9, 1, 2])).toMatchObject({ medianMs: 2, p95Ms: null });
  });
  it('refuses empty, NaN, infinity and negative durations', () => {
    for (const values of [[], [NaN], [Infinity], [-1]]) expect(() => distribution(values)).toThrow();
  });
  it('defaults to 20 measured samples plus separate warmup and refuses malformed flags', () => {
    expect(options(['--out', '/new.json'])).toMatchObject({ samples: 20, warmups: 1, writeDelayMs: 0, textSpacingMs: 250 });
    expect(() => options([])).toThrow('--out');
    for (const args of [['--out'], ['--samples', '0'], ['--samples', 'Infinity'], ['--samples', '1.5'], ['--case', 'unknown'], ['--write-delay-ms', '-1'], ['--control', 'bad-hash'], ['--ignored', '1']]) expect(() => options([...args, '--out', '/x'])).toThrow();
  });
  it('keeps the four default cases and selects the 1000-file workload only on request', () => {
    expect(DEFAULT_CASES).toEqual(['text', 'small', 'large', 'batch']);
    expect(options(['--out', '/x']).cases).toEqual(DEFAULT_CASES);
    expect(options(['--out', '/x', '--case', 'small-files']).cases).toEqual(['small1000', 'concat1000']);
    expect(options(['--out', '/x', '--case', 'small1000']).cases).toEqual(['small1000']);
    expect(options(['--out', '/x', '--case', 'concat1000', '--control', 'bad-hash'])).toMatchObject({ cases: ['concat1000'], control: true });
    expect(options(['--out', '/x', '--case', 'small1000', '--control', 'bad-hash-last']).control).toBe('last');
    expect(options(['--out', '/x', '--case', 'small-files', '--transport', 'on', '--phases', 'on'])).toMatchObject({ transport: true, phases: true });
    expect(CASES.small1000.files * CASES.small1000.bytes).toBe(CASES.concat1000.bytes);
    for (const args of [['--case', 'small-files', '--case', 'small'], ['--case', 'small', '--case', 'small'], ['--samples', '2', '--samples', '3'],
      ['--case', 'small-file'], ['--case', 'smallfiles'], ['--control', 'bad-hash-first', '--case', 'small1000'], ['--control', 'bad-hash-last'],
      ['--control', 'bad-hash', '--case', 'text']]) expect(() => options([...args, '--out', '/x'])).toThrow();
    expect(() => options(['--out', '/x', '--out', '/y'])).toThrow('duplicate option --out');
  });
  it('requires every one of the 1000 small files and their total bytes', () => {
    const many = { kind: 'small1000', direction: 'B→A', iteration: 19, warmup: false, startAt: 100,
      observation: { ...valid().observation, bytes: 1024000, closedFiles: 1000, verifiedFiles: 1000 } };
    expect(checkedSample(many)).toMatchObject({ files: 1000, bytes: 1024000 });
    for (const patch of [{ closedFiles: 999 }, { verifiedFiles: 999 }, { closedFiles: 1001, verifiedFiles: 1001 }, { bytes: 1023999 }, { bytes: 1024 }]) {
      const input = structuredClone(many); Object.assign(input.observation, patch);
      expect(() => checkedSample(input)).toThrow();
    }
    const single = { ...many, kind: 'concat1000', observation: { ...many.observation, closedFiles: 1, verifiedFiles: 1 } };
    expect(checkedSample(single)).toMatchObject({ files: 1, bytes: 1024000 });
    expect(() => checkedSample({ ...single, observation: { ...single.observation, closedFiles: 1000, verifiedFiles: 1000 } })).toThrow();
  });
  it('emits P95 only when each case AND direction has 20 measured rows', () => {
    const row = (kind, direction, iteration, ms) => ({ kind, direction, iteration, warmup: false, verified: true, files: 1, bytes: 1, durations: { verifiedReadyMs: ms } });
    const rows = [];
    for (const kind of ['small1000', 'concat1000']) for (const direction of ['A→B', 'B→A']) for (let i = 0; i < 20; i++) rows.push(row(kind, direction, i, i + 1));
    const out = summarize(rows, ['small1000', 'concat1000'], 20);
    expect(Object.keys(out)).toEqual(['small1000/A→B', 'small1000/B→A', 'concat1000/A→B', 'concat1000/B→A']);
    for (const group of Object.values(out)) expect(group.verifiedReadyMs).toMatchObject({ count: 20, p95Ms: 19 });
    // 40 small1000 rows in ONE direction do not stand in for the other.
    const lopsided = rows.filter(r => !(r.kind === 'small1000' && r.direction === 'B→A')).concat(rows.filter(r => r.kind === 'small1000' && r.direction === 'A→B').map(r => ({ ...r, iteration: r.iteration + 20 })));
    expect(() => summarize(lopsided, ['small1000', 'concat1000'], 20)).toThrow('small1000/A→B');
    const few = summarize(rows.filter(r => r.iteration < 19), ['small1000', 'concat1000'], 19);
    for (const group of Object.values(few)) expect(group.verifiedReadyMs.p95Ms).toBeNull();
  });
  it('derives disjoint observable milestones without attributing crypto/network CPU', () => {
    expect(checkedSample(valid()).durations).toEqual({ verifiedReadyMs: 60, verificationTailMs: 5, selectionToConsentMs: 10, consentToFirstWriteMs: 10, firstWriteToClosedMs: 30 });
  });
  it('refuses hash errors, missing closes, wrong bytes, early UI and invalid clocks', () => {
    for (const patch of [{ error: 'hash mismatch' }, { closedFiles: 0 }, { verifiedFiles: 0 }, { bytes: 10239 }, { ready: false }, { verified: false }, { consentAt: 99 }, { closedAt: 119 }, { readyAt: 154 }, { verifiedAt: NaN }]) {
      const input = valid(); Object.assign(input.observation, patch);
      expect(() => checkedSample(input)).toThrow();
    }
  });
  it('excludes explicit warmup but refuses incomplete or duplicate measured groups', () => {
    const a = checkedSample(valid()), b = { ...a, direction: 'B→A' };
    const warmup = { ...a, warmup: true, durations: Object.fromEntries(Object.keys(a.durations).map(k => [k, 999])) };
    expect(summarize([a, b, warmup], ['small'], 1)['small/A→B'].verifiedReadyMs).toMatchObject({ medianMs: 60, count: 1, p95Ms: null });
    expect(() => summarize([a], ['small'], 1)).toThrow('incomplete');
    expect(() => summarize([a, a, b, b], ['small'], 2)).toThrow('duplicate');
    expect(() => summarize([a, { ...b, verified: false }], ['small'], 1)).toThrow();
    expect(() => summarize([a, b, { ...warmup, verified: false }], ['small'], 1)).toThrow('warmup');
  });
});

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });
describe('injected destination observer', () => {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  function init(expected) {
    vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob);
    document.body.innerHTML = '<section class="xfer"><span id="xfer-label-recv"></span></section>';
    installProbe();
    window.__transferBaseline.arm({ kind: 'batch', expected, writeDelayMs: 0 });
    return window.__transferBaseline;
  }
  it('waits for every distinct file close/hash AND receiver success UI', async () => {
    const body = Buffer.from('two independently hashed destinations');
    const expected = { bytes: body.length, sha256: digest(body) };
    const probe = init({ a: expected, b: expected });
    const directory = await window.showDirectoryPicker();
    const a = await (await directory.getFileHandle('a', { create: true })).createWritable();
    const b = await (await directory.getFileHandle('b', { create: true })).createWritable();
    await a.write(body); await a.close();
    await vi.waitFor(() => expect(probe.snapshot().verifiedFiles).toBe(1));
    expect(probe.snapshot()).toMatchObject({ ready: false, verified: false, closedFiles: 1 });
    await b.write(body); await b.close();
    await vi.waitFor(() => expect(probe.snapshot().verified).toBe(true));
    expect(probe.snapshot().ready).toBe(false);
    document.querySelector('.xfer').classList.add('ok');
    await vi.waitFor(() => expect(probe.snapshot().ready).toBe(true));
    expect(probe.snapshot().bytes).toBe(body.length * 2);
    await expect(a.close()).rejects.toThrow('duplicate close');
    await expect((await directory.getFileHandle('a', { create: true })).createWritable()).rejects.toThrow('duplicate destination');
    expect(probe.snapshot()).not.toHaveProperty('expected');
    expect(probe.snapshot()).not.toHaveProperty('destinations');
  });
  describe('1000 distinct small files', () => {
    const fixture = pairedManifest(1000, 1024, 1024000);
    const names = fixture.many.map((_, i) => `baseline-t-${String(i).padStart(3, '0')}.bin`);
    const expected = Object.fromEntries(names.map((name, i) => [name, { bytes: 1024, sha256: fixture.many[i].sha256 }]));
    // Delivers file `source(i)`'s bytes under name i, for i in `indices`.
    async function deliver(indices, source = i => i) {
      const probe = init(expected), directory = await window.showDirectoryPicker();
      for (const i of indices) {
        const sink = await (await directory.getFileHandle(names[i], { create: true })).createWritable();
        await sink.write(fixtureBytes(source(i) * 1024, 1024)); await sink.close();
      }
      document.querySelector('.xfer').classList.add('ok');
      return probe;
    }
    const all = Array.from({ length: 1000 }, (_, i) => i);
    it('verifies the complete batch only after the 1000th file', async () => {
      const probe = await deliver(all.slice(0, 999));
      await vi.waitFor(() => expect(probe.snapshot().verifiedFiles).toBe(999));
      expect(probe.snapshot()).toMatchObject({ closedFiles: 999, verified: false, ready: false, error: null });
      const complete = await deliver(all);
      await vi.waitFor(() => expect(complete.snapshot().ready).toBe(true));
      expect(complete.snapshot()).toMatchObject({ bytes: 1024000, closedFiles: 1000, verifiedFiles: 1000, verified: true, error: null });
    });
    for (const [a, b] of [[0, 251], [0, 999], [251, 999]]) it(`catches files ${a} and ${b} swapped`, async () => {
      const probe = await deliver(all, i => i === a ? b : i === b ? a : i);
      // The first wrong digest can settle before the other 998 good ones; join both.
      await vi.waitFor(() => expect(probe.snapshot()).toMatchObject({ error: expect.stringContaining('hash/size'), verifiedFiles: 998 }));
      expect(probe.snapshot()).toMatchObject({ verified: false, ready: false, closedFiles: 1000, verifiedFiles: 998 });
    });
    it('catches a wrong final byte of the 1000th file and a duplicated file', async () => {
      const probe = init(expected), directory = await window.showDirectoryPicker();
      for (const i of all) {
        const body = fixtureBytes(i * 1024, 1024); if (i === 999) body[1023] ^= 1;
        const sink = await (await directory.getFileHandle(names[i], { create: true })).createWritable();
        await sink.write(body); await sink.close();
      }
      await vi.waitFor(() => expect(probe.snapshot().error).toContain('hash/size'));
      expect(probe.snapshot().verified).toBe(false);
      const duplicate = await deliver(all.slice(0, 2), i => 0);
      await vi.waitFor(() => expect(duplicate.snapshot().error).toContain('hash/size'));
      await expect((await window.showDirectoryPicker()).getFileHandle(names[0], { create: true }).then(h => h.createWritable())).rejects.toThrow('duplicate destination');
    });
  });
  it('rejects a wrong full digest even when the file closes and UI says success', async () => {
    const body = Buffer.from('original bytes');
    const probe = init({ a: { bytes: body.length, sha256: '0'.repeat(64) } });
    const sink = await (await window.showSaveFilePicker({ suggestedName: 'a' })).createWritable();
    await sink.write(body); await sink.close();
    document.querySelector('.xfer').classList.add('ok');
    await vi.waitFor(() => expect(probe.snapshot().error).toContain('hash/size'));
    expect(probe.snapshot().ready).toBe(false);
  });
});
