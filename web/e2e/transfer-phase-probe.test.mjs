import { describe, it, expect, vi } from 'vitest';
import { installPhaseProbe, checkedPhases } from './transfer-phase-probe.mjs';
import { options } from './transfer-performance-core.mjs';

function fixture() {
  let tick = 0;
  const result = new ArrayBuffer(8), rejection = new Error('native rejection');
  class Blob { size = 8; arrayBuffer() { expect(this).toBeInstanceOf(Blob); return Promise.resolve(result); } }
  const subtle = { encrypt: vi.fn(function (algorithm, key, bytes) {
    expect(this).toBe(subtle); expect(key).toBe('opaque key'); expect(bytes.byteLength).toBe(8);
    if (algorithm.fail) throw rejection;
    return Promise.resolve(result);
  }), decrypt: vi.fn(() => Promise.resolve(result)) };
  const nativeEncrypt = subtle.encrypt;
  const env = { Blob, crypto: { subtle }, performance: { now: () => tick }, setTimeout: resolve => { tick += 20; resolve(); } };
  installPhaseProbe(env);
  return { env, nativeEncrypt, probe: env.__transferPhases, result, rejection, advance: n => { tick += n; } };
}
const algorithm = { name: 'AES-GCM' };
async function observed(f, role) {
  f.probe.arm(role);
  await new f.env.Blob().arrayBuffer();
  await f.env.crypto.subtle.encrypt(algorithm, 'opaque key', new Uint8Array(8));
  await f.env.crypto.subtle.decrypt(algorithm, 'opaque key', new Uint8Array(8));
  return f.probe.finish();
}

describe('opt-in browser operation probe', () => {
  it('retains receiver binding, arguments, results and inactive promise identity', async () => {
    const f = fixture(), promise = Promise.resolve(f.result);
    f.nativeEncrypt.mockReturnValue(promise);
    expect(f.env.crypto.subtle.encrypt(algorithm, 'opaque key', new Uint8Array(8))).toBe(promise);
    f.probe.arm('sender');
    await expect(new f.env.Blob().arrayBuffer()).resolves.toBe(f.result);
    await expect(f.env.crypto.subtle.encrypt(algorithm, 'opaque key', new Uint8Array(8))).resolves.toBe(f.result);
    expect(f.probe.finish()).toMatchObject({ read: { calls: 1, inputBytes: 8, completed: 1 }, encrypt: { calls: 1, completed: 1 } });
  });
  it('rejects reset/finish while outstanding; concurrent totals are explicitly overlapping', async () => {
    const f = fixture(); let release;
    f.nativeEncrypt.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    f.probe.arm('sender');
    const encrypt = f.env.crypto.subtle.encrypt(algorithm, 'opaque key', new Uint8Array(8));
    const read = new f.env.Blob().arrayBuffer(); f.advance(10); await read;
    expect(() => f.probe.arm('receiver')).toThrow('pending');
    expect(() => f.probe.finish()).toThrow('pending');
    release(f.result); await encrypt;
    const sample = f.probe.finish();
    expect(sample.read.totalMs + sample.encrypt.totalMs).toBe(20);
    f.probe.arm('receiver'); expect(f.probe.finish().encrypt.calls).toBe(0);
    expect(sample.encrypt.completed).toBe(1);
  });
  it('preserves the original synchronous and asynchronous rejection and counts failure', async () => {
    for (const asyncFailure of [false, true]) {
      const f = fixture(); f.probe.arm('sender');
      if (asyncFailure) f.nativeEncrypt.mockRejectedValue(f.rejection);
      await expect(f.env.crypto.subtle.encrypt({ ...algorithm, fail: true }, 'opaque key', new Uint8Array(8))).rejects.toBe(f.rejection);
      expect(f.probe.finish().encrypt).toMatchObject({ calls: 1, failed: 1, pending: 0, completed: 0 });
    }
  });
  it('excludes receiver verification reads and non AES-GCM operations', async () => {
    const f = fixture(); f.probe.arm('receiver');
    await new f.env.Blob().arrayBuffer();
    await f.env.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, 'opaque key', new Uint8Array(8));
    const sample = f.probe.finish(); expect(sample.read.calls).toBe(0); expect(sample.encrypt.calls).toBe(0);
    expect(sample).not.toHaveProperty('delay'); expect(JSON.stringify(sample)).not.toContain('opaque key');
  });
  it('delays only one requested sender operation and records actual elapsed time', async () => {
    for (const phase of ['read', 'encrypt']) {
      const f = fixture(); f.probe.arm('sender', { phase, ms: 20 });
      for (let i = 0; i < 2; i++) await (phase === 'read' ? new f.env.Blob().arrayBuffer() : f.env.crypto.subtle.encrypt(algorithm, 'opaque key', new Uint8Array(8)));
      expect(f.probe.finish()[phase]).toMatchObject({ calls: 2, delayCalls: 1, delayElapsedMs: 20, totalMs: 20, maxMs: 20 });
    }
  });
  it('refuses missing hooks, failed/pending/malformed counters and mismatched coverage', async () => {
    const sender = await observed(fixture(), 'sender'), receiver = await observed(fixture(), 'receiver');
    expect(checkedPhases(sender, receiver, 8)).toEqual({ sender, receiver });
    for (const patch of [{ pending: 1 }, { failed: 1 }, { completed: 0 }, { calls: 1.5 }, { maxMs: NaN }, { maxMs: undefined }, { inputBytes: -1 }, { totalMs: -1 }, { delayCalls: 2 }, { maxMs: 1 }]) {
      const bad = structuredClone(sender); Object.assign(bad.read, patch);
      expect(() => checkedPhases(bad, receiver, 8)).toThrow();
    }
    expect(() => checkedPhases(sender, receiver, 7)).toThrow('coverage');
    expect(() => checkedPhases(null, receiver, 8)).toThrow('role');
    expect(() => checkedPhases(receiver, sender, 8)).toThrow('role');
  });
  it('requires explicit profiling for causal controls and validates probe lifecycle', () => {
    expect(options(['--out', '/x', '--phases', 'on', '--case', 'small', '--phase-delay', 'encrypt:20'])).toMatchObject({ phases: true, phaseDelay: { phase: 'encrypt', ms: 20 } });
    for (const args of [['--phases', 'off'], ['--phase-delay', 'read:0'], ['--phase-delay', 'read:1001'], ['--phase-delay', 'read:20'], ['--phases', 'on', '--phase-delay', 'read:20']]) expect(() => options(['--out', '/x', ...args])).toThrow();
    const f = fixture(); expect(() => f.probe.finish()).toThrow('not armed');
    expect(() => f.probe.arm('unknown')).toThrow('role');
    expect(() => f.probe.arm('sender', { phase: 'decrypt', ms: 1 })).toThrow('delay');
    expect(() => installPhaseProbe(f.env)).toThrow('already installed');
  });
});
