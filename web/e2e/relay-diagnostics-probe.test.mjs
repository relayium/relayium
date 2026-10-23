import { describe, it, expect } from 'vitest';
import { installRelayDiagnosticsProbe, checkedSample, SAMPLE_FIELDS } from './relay-diagnostics-probe.mjs';

function page(config) {
  let now = 0;
  const env = { performance: { now: () => now } };
  installRelayDiagnosticsProbe(env, config);
  return { probe: env.__relayiumRelayDiagnostics, env, advance: ms => { now += ms; } };
}
const send = (over = {}) => ({ dir: 'send', bytes: 1000, activeMs: 100, creditWaitMs: 30, bufferWaitMs: 20, finalizeMs: 40, ...over });
const recv = (over = {}) => ({ dir: 'recv', bytes: 1000, activeMs: 100, creditWaitMs: 0, bufferWaitMs: 0, finalizeMs: 7, ...over });

describe('relay diagnostics page probe', () => {
  it('keeps exactly the six fields of an armed, matching sample', () => {
    const { probe } = page();
    probe.arm('send'); probe.sample(send());
    const taken = probe.take();
    expect(Object.keys(taken.sample).sort()).toEqual([...SAMPLE_FIELDS].sort());
    expect(checkedSample(taken, { dir: 'send', bytes: 1000 })).toEqual({ present: true, dir: 'send', bytes: 1000, activeMs: 100,
      creditWaitMs: 30, bufferPacingWaitMs: 20, finalizeRoundTripMs: 40, senderLoopOtherMs: 10 });
  });
  it('a missing sample is missing, never zeros', () => {
    const { probe } = page();
    probe.arm('recv');
    expect(checkedSample(probe.take(), { dir: 'recv', bytes: 1000 })).toEqual({ present: false, reason: 'no-clean-sample-emitted' });
  });
  it('the receiver has no credit or buffer measurement: null, and nonzero values are refused', () => {
    const { probe } = page();
    probe.arm('recv'); probe.sample(recv());
    expect(checkedSample(probe.take(), { dir: 'recv', bytes: 1000 })).toEqual({ present: true, dir: 'recv', bytes: 1000, activeMs: 100,
      creditWaitMs: null, bufferPacingWaitMs: null, receiverFinalizeMs: 7 });
    probe.arm('recv'); probe.sample(recv({ creditWaitMs: 1 }));
    expect(() => checkedSample(probe.take(), { dir: 'recv', bytes: 1000 })).toThrow('sender-only');
  });
  it('refuses sender waits that exceed its own active time (they are sequential, same clock)', () => {
    const { probe } = page();
    probe.arm('send'); probe.sample(send({ creditWaitMs: 60, bufferWaitMs: 30, finalizeMs: 40 }));
    expect(() => checkedSample(probe.take(), { dir: 'send', bytes: 1000 })).toThrow('exceed');
  });
  it('an object carrying anything else (the live link) is refused and not stored', () => {
    const { probe } = page();
    probe.arm('send'); probe.sample({ ...send(), link: { conn: {} } });
    const taken = probe.take();
    expect(taken.sample).toBeNull(); expect(taken.stray.malformed).toBe(1);
    expect(() => checkedSample(taken, { dir: 'send', bytes: 1000 })).toThrow('malformed');
    for (const bad of [send({ bytes: -1 }), send({ activeMs: NaN }), send({ dir: 'up' }), send({ finalizeMs: '4' }), null]) {
      const p = page().probe; p.arm('send'); p.sample(bad); expect(p.take().stray.malformed).toBe(1);
    }
  });
  it('wrong direction and duplicates refuse the batch', () => {
    const { probe } = page();
    probe.arm('send'); probe.sample(recv()); probe.sample(send());
    expect(() => checkedSample(probe.take(), { dir: 'send', bytes: 1000 })).toThrow('other direction');
    const second = page().probe;
    second.arm('send'); second.sample(send()); second.sample(send());
    expect(() => checkedSample(second.take(), { dir: 'send', bytes: 1000 })).toThrow('more than one');
  });
  it('a stale or unrequested sample of the SAME size is refused, never attributed to the armed batch', () => {
    // Unarmed before arming (root's reproduction): identical bytes, then the real one.
    const before = page().probe;
    before.sample(send()); before.arm('send'); before.sample(send());
    expect(() => checkedSample(before.take(), { dir: 'send', bytes: 1000 })).toThrow('nothing was armed');
    // Late: a sample that lands after its slot was taken poisons the next slot.
    const late = page().probe;
    late.arm('send'); late.sample(send());
    expect(checkedSample(late.take(), { dir: 'send', bytes: 1000 }).present).toBe(true);
    late.sample(send());
    late.arm('send'); late.sample(send());
    expect(() => checkedSample(late.take(), { dir: 'send', bytes: 1000 })).toThrow('nothing was armed');
    // A stale sample with NO current one is refused too, not reported as missing.
    const lone = page().probe;
    lone.sample(recv()); lone.arm('recv');
    expect(() => checkedSample(lone.take(), { dir: 'recv', bytes: 1000 })).toThrow('nothing was armed');
  });
  it('a sample for the wrong role is refused even when it is the only one', () => {
    const { probe } = page();
    probe.arm('recv'); probe.sample(send());
    expect(() => checkedSample(probe.take(), { dir: 'recv', bytes: 1000 })).toThrow('other direction');
  });
  it('a sample for a different batch size is refused', () => {
    const { probe } = page();
    probe.arm('send'); probe.sample(send({ bytes: 999 }));
    expect(() => checkedSample(probe.take(), { dir: 'send', bytes: 1000 })).toThrow('does not describe');
  });
  it('the observer-fault control throws from the hand-off and records the sample as missing', () => {
    const { probe } = page({ throwOnSample: true });
    probe.arm('send');
    expect(() => probe.sample(send())).toThrow('observer fault');
    expect(checkedSample(probe.take(), { dir: 'send', bytes: 1000 })).toEqual({ present: false, reason: 'observer-threw' });
  });
  it('lifecycle is strict', () => {
    const { probe, env } = page();
    expect(() => installRelayDiagnosticsProbe(env)).toThrow('already installed');
    expect(() => probe.take()).toThrow('not armed');
    expect(() => probe.arm('sideways')).toThrow('invalid');
    probe.arm('send');
    expect(() => probe.arm('send')).toThrow('already armed');
    expect(() => checkedSample(probe.take(), { dir: 'recv', bytes: 1 })).toThrow('another direction');
    expect(() => checkedSample(null, { dir: 'send', bytes: 1 })).toThrow();
  });
});
