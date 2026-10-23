/** Opt-in page-side receiver for the PRIVATE diagnostic bundle's TransferSample
 * hand-off (see relay-diagnostics-build.mjs). Never imported by the product.
 *
 * The private bundle calls `globalThis.__relayiumRelayDiagnostics.sample(copy)`
 * after the product's own relay-history observer, with a plain copy of six
 * fields. This probe keeps ONLY those six fields, after validating them, for the
 * one direction it was armed for, and counts everything else (unarmed, wrong
 * direction, duplicate, malformed) so a run can refuse instead of guessing.
 *
 * Product semantics it must not paper over (mixed-file-session.svelte.ts):
 *   - a sample exists only for a CLEAN batch (COMPLETE seen/sent); a cancelled,
 *     declined, integrity-failed or gap-interrupted batch never emits one, so a
 *     missing sample is recorded as missing, never as zeros;
 *   - `bufferWaitMs` is the DataChannel buffer wait AND the pacing wait, measured
 *     together after the credit wait, so it is reported as bufferPacingWaitMs;
 *   - on the receiver, creditWaitMs and bufferWaitMs are 0 by construction (the
 *     receiver has no such loop): they are not measurements and become null;
 *   - sender and receiver clocks start at different points (sender: after
 *     consent; receiver: its own batch start), so no cross-side subtraction.
 *
 * `throwAfterCalls` exists only for the observer-fault control: the hand-off
 * throws, and the transfer must still complete with the sample recorded as
 * missing. */
export const PROBE_VERSION = 1;
export const SAMPLE_FIELDS = ['dir', 'bytes', 'activeMs', 'creditWaitMs', 'bufferWaitMs', 'finalizeMs'];

/** Self-contained: injected as `(${installRelayDiagnosticsProbe})(window, cfg)`. */
export function installRelayDiagnosticsProbe(env = globalThis, config = {}) {
  if (env.__relayiumRelayDiagnostics) throw new Error('relay diagnostics probe already installed');
  const throwOnSample = config.throwOnSample === true;
  const FIELDS = ['dir', 'bytes', 'activeMs', 'creditWaitMs', 'bufferWaitMs', 'finalizeMs'];
  const clock = () => env.performance.now();
  let armed = null;
  const stray = { unarmed: 0, wrongDirection: 0, duplicate: 0, malformed: 0, thrown: 0 };
  const valid = raw => raw && typeof raw === 'object'
    && Object.keys(raw).sort().join() === [...FIELDS].sort().join()
    && (raw.dir === 'send' || raw.dir === 'recv')
    && Number.isSafeInteger(raw.bytes) && raw.bytes >= 0
    && FIELDS.slice(2).every(k => typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k] >= 0);
  env.__relayiumRelayDiagnostics = {
    sample(raw) {
      if (throwOnSample) { stray.thrown++; throw new Error('relay diagnostics observer fault (control)'); }
      if (!valid(raw)) { stray.malformed++; return; }
      if (!armed) { stray.unarmed++; return; }
      if (raw.dir !== armed.dir) { stray.wrongDirection++; return; }
      if (armed.sample) { stray.duplicate++; return; }
      const copy = {};
      for (const k of FIELDS) copy[k] = raw[k];
      armed.sample = copy;
      armed.sampleAt = clock();
    },
    arm(dir) {
      if (dir !== 'send' && dir !== 'recv') throw new Error('invalid relay diagnostics direction');
      if (armed) throw new Error('relay diagnostics probe already armed');
      armed = { dir, armedAt: clock(), sample: null, sampleAt: null };
    },
    /** Returns the armed slot (sample or null) and the stray counters; disarms. */
    take() {
      if (!armed) throw new Error('relay diagnostics probe not armed');
      const out = { version: 1, dir: armed.dir, sample: armed.sample, waitedMs: (armed.sampleAt ?? clock()) - armed.armedAt,
        stray: { ...stray } };
      armed = null;
      return out;
    },
    peek: () => ({ armed: !!armed, hasSample: !!armed?.sample, stray: { ...stray } }),
  };
}

const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Node side: turn one taken slot into the exported, numeric-only row.
 * `expected.bytes` is the verified plaintext size of the batch.
 *
 * Returns { present: false, reason } when no sample arrived (never zeros), and
 * throws on anything malformed, mismatched or stray.
 */
export function checkedSample(taken, expected) {
  if (taken?.version !== PROBE_VERSION || !['send', 'recv'].includes(taken.dir) || taken.dir !== expected?.dir) throw new Error('relay diagnostics slot missing or for another direction');
  const s = taken.stray;
  if (!s || !['unarmed', 'wrongDirection', 'duplicate', 'malformed', 'thrown'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0)) throw new Error('relay diagnostics stray counters malformed');
  if (s.malformed) throw new Error('the bundle handed over a malformed sample');
  if (s.duplicate) throw new Error('more than one sample for one armed batch');
  if (s.wrongDirection) throw new Error('a sample arrived for the other direction while armed');
  // The counters are cumulative for the page's lifetime, so ONE sample that
  // arrived while nothing was armed (a late sample of an earlier batch, or a
  // batch nobody asked about) poisons every later slot: with equal batch sizes
  // a stale sample is indistinguishable from the current one, so it is refused
  // rather than attributed. A clean run never produces an unarmed sample.
  if (s.unarmed) throw new Error('a sample arrived while nothing was armed (stale or unrequested batch)');
  if (!taken.sample) return { present: false, reason: s.thrown ? 'observer-threw' : 'no-clean-sample-emitted' };
  const x = taken.sample;
  if (x.dir !== expected.dir || !Number.isSafeInteger(x.bytes) || x.bytes !== expected.bytes) throw new Error('sample does not describe this batch (direction/bytes)');
  if (!['activeMs', 'creditWaitMs', 'bufferWaitMs', 'finalizeMs'].every(k => finite(x[k]))) throw new Error('sample timings malformed');
  if (x.dir === 'send') {
    // creditWait, buffer+pacing wait and finalize are sequential, non-overlapping
    // intervals of the sender's own loop on one clock, all after its start: their
    // sum cannot exceed activeMs (1 ms slack for clock granularity).
    const waited = x.creditWaitMs + x.bufferWaitMs + x.finalizeMs;
    if (waited > x.activeMs + 1) throw new Error('sender waits exceed its active time');
    return { present: true, dir: 'send', bytes: x.bytes, activeMs: x.activeMs, creditWaitMs: x.creditWaitMs,
      bufferPacingWaitMs: x.bufferWaitMs, finalizeRoundTripMs: x.finalizeMs,
      senderLoopOtherMs: Math.max(0, x.activeMs - waited) };
  }
  if (x.creditWaitMs !== 0 || x.bufferWaitMs !== 0) throw new Error('receiver sample carried sender-only waits');
  if (x.finalizeMs > x.activeMs + 1) throw new Error('receiver finalize exceeds its active time');
  return { present: true, dir: 'recv', bytes: x.bytes, activeMs: x.activeMs, creditWaitMs: null, bufferPacingWaitMs: null,
    receiverFinalizeMs: x.finalizeMs };
}

export const SAMPLE_SEMANTICS = {
  activeMs: 'this side only: sender = consent to COMPLETE received; receiver = its batch start to COMPLETE sent. Different start points: never subtract one side from the other',
  creditWaitMs: 'sender only: time parked on the receiver durable-ACK credit window. Receiver: null (zero by construction, not measured)',
  bufferPacingWaitMs: 'sender only: DataChannel buffer drain wait PLUS pacing wait, measured together after credit. Receiver: null (zero by construction)',
  finalizeRoundTripMs: 'sender only: last frame QUEUED (not delivered) to COMPLETE received; includes draining every still-buffered byte across the relay, the receiver verify/finalize and the return path, so with a deep send buffer most transfer time lands here',
  senderLoopOtherMs: 'sender only: activeMs minus the three sequential waits above (same loop, same clock, non-overlapping by construction): frame production (read+AEAD), send calls, UI ticks and scheduling. NOT network time',
  receiverFinalizeMs: 'receiver only: save-target finalize (in the diagnostics, an in-memory or app destination; not physical-disk durability)',
};
