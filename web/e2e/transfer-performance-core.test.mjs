import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedSample, distribution, options, summarize, installProbe } from './transfer-performance-core.mjs';

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
