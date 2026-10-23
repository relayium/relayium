import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { CODE_ROOM_ROUTES } from './code-room-fixture.mjs';
import { TRANSPORT_LABELS } from './transfer-transport-probe.mjs';
import { options, turnRestCredential, relayIceRoutes, checkedRelayRoute, checkedCounters, checkedCounterDelta, quantiles, summarize,
  checkedReport, assertPrivate, classify, assembleNativeReport, endToEndSpans, CONTROLS, CONTROL_EXPECTATIONS, REPORT_SCHEMA, SCOPE } from './realtime-relay-diagnostics-core.mjs';

const SECRET = 'diagnostics-secret-0123456789';
const counters = (to = 0, from = to, over = {}) => ({ version: 1, final: false, authAccepted: 4, authRejected: 0, relaySocketsClosed: 0,
  permissions: 2, channels: 2, allocationErrors: 0, allocations: { udp: 2, tcp: 0, unknown: 0 },
  relayBytesToPeer: { udp: to, tcp: 0, unknown: 0 }, relayBytesFromPeer: { udp: from, tcp: 0, unknown: 0 }, ...over });
const channel = sendBytes => ({ sendCalls: 1, sendBytes, sendThrows: 0, unknownPayloads: 0, atArmBufferedBytes: 0,
  maxAfterSendBufferedBytes: 10, atFinishBufferedBytes: 0, sampled: { count: 3, nonzero: 1, maxBytes: 10, sumBytes: 10 } });
/** A raw transport observation exactly as installTransportProbe(..., {relayProtocol:true}).finish() returns it. */
const observation = (role, { bytes = 1000, local = 'relay', remote = 'relay', hop = 'udp', extraLocal = {} } = {}) => ({
  version: 2, role,
  selection: { method: 'transport.selectedCandidatePairId', local: { candidateType: local, protocol: 'udp', relayProtocol: hop, ...extraLocal },
    remote: { candidateType: remote, protocol: 'udp' } },
  counters: { before: { timestamp: 1, bytesSent: 0, bytesReceived: 0, packetsSent: null, packetsReceived: null, responsesReceived: null, totalRoundTripTime: null, currentRoundTripTime: null },
    after: { timestamp: 2, bytesSent: bytes * 2, bytesReceived: bytes * 2, packetsSent: null, packetsReceived: null, responsesReceived: null, totalRoundTripTime: null, currentRoundTripTime: 0.001 } },
  pairChanges: { before: null, after: null }, sampling: { intervalMs: 10, windowMs: 100, tickCount: 3, maxGapMs: 40 },
  channels: Object.fromEntries(TRANSPORT_LABELS.map(l => [l, channel(l === 'relayium' && role === 'sender' ? bytes : 0)])),
  unboundSendCalls: 0, observationFailures: 0,
});
const taken = (dir, sample) => ({ version: 1, dir, sample, waitedMs: 5, stray: { unarmed: 0, wrongDirection: 0, duplicate: 0, malformed: 0, thrown: 0 } });
const rawNative = (over = {}) => ({ version: 1, fileSize: 1000, sendStartAt: 10, sendDoneAt: 60,
  send: { transport: observation('sender'), transportFailed: false, sample: taken('send', { dir: 'send', bytes: 1000, activeMs: 50, creditWaitMs: 5, bufferWaitMs: 5, finalizeMs: 30 }) },
  recv: { transport: observation('receiver'), transportFailed: false, sample: taken('recv', { dir: 'recv', bytes: 1000, activeMs: 40, creditWaitMs: 0, bufferWaitMs: 0, finalizeMs: 2 }) },
  ...over });
const facts = (over = {}) => ({ nativeLinkOpen: true, nativeLegacyFallback: false, nativeReceivedWebFileVerified: true, webReceivedNativeFileVerified: true,
  nativeReceivedMessage: true, webReceivedMessage: true, nativeReportsRelayedBound: true, iceLoopbackOnly: true,
  iceTurnUrlCount: 2, iceStunUrlCount: 1, browserRole: 'responder', fileBytes: 1000, ...over });
const assemble = (over = {}) => assembleNativeReport({ raw: rawNative(), facts: facts(), turnBefore: counters(0), turnMid: counters(2500), turnAfter: counters(5000),
  provenance: { sourceCommit: 'a'.repeat(40), node: 'v24.22.0' }, ...over });

describe('options', () => {
  const base = ['--out', '/tmp/r.json', '--bundle', '/tmp/b'];
  it('defaults and bounds', () => {
    expect(options(base)).toMatchObject({ samples: 5, warmups: 1, fileMiB: 8, control: null, writeDelayMs: 0 });
    for (const bad of [['--samples', '0'], ['--samples', '51'], ['--file-mib', '65'], ['--warmups', 'x'], ['--control', 'nope'], ['--extra', '1']]) {
      expect(() => options([...base, ...bad])).toThrow();
    }
    expect(() => options([...base, '--samples', '2', '--samples', '3'])).toThrow('duplicate');
    expect(() => options(['--out', 'relative.json', '--bundle', '/tmp/b'])).toThrow();
    expect(() => options(['--out', '/tmp/r.json'])).toThrow('--bundle');
  });
  it('controls force the configuration they need to mean anything', () => {
    expect(options([...base, '--control', 'slow-receiver'])).toMatchObject({ fileMiB: 24, writeDelayMs: 25, samples: 5 });
    expect(options([...base, '--control', 'cancel'])).toMatchObject({ fileMiB: 24, writeDelayMs: 25, samples: 1, warmups: 0 });
    expect(options([...base, '--control', 'bad-hash'])).toMatchObject({ samples: 1, warmups: 0, writeDelayMs: 0 });
    expect(Object.keys(CONTROL_EXPECTATIONS).sort()).toEqual([...CONTROLS].sort());
  });
});

describe('TURN credential and ICE routes', () => {
  it('mints the central server REST credential (account/turn.go)', () => {
    const c = turnRestCredential(SECRET, { nowSecs: 1000, ttlSecs: 600, token: 'diagnostics.local' });
    expect(c.username).toBe('1600:diagnostics.local');
    expect(c.credential).toBe(createHmac('sha1', SECRET).update('1600:diagnostics.local').digest('base64'));
    expect(() => turnRestCredential('short')).toThrow();
    expect(() => turnRestCredential(SECRET, { token: 'has space' })).toThrow();
  });
  it('adds ONE loopback TURN entry and leaves the default fixture empty', () => {
    const before = JSON.stringify(CODE_ROOM_ROUTES);
    const routes = relayIceRoutes(CODE_ROOM_ROUTES, { port: 3478, username: 'u', credential: 'c' });
    expect(CODE_ROOM_ROUTES['/api/ice']).toEqual({ iceServers: [], relays: [] });
    expect(JSON.stringify(CODE_ROOM_ROUTES)).toBe(before);
    expect(routes['/api/ice'].iceServers).toEqual([{ urls: ['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:3478?transport=tcp'], username: 'u', credential: 'c' }]);
    expect(routes['/api/ice'].relays).toEqual([]);
    expect(() => relayIceRoutes(routes, { port: 3478, username: 'u', credential: 'c' })).toThrow('empty default');
    for (const port of [0, 80, 70000, 1.5]) expect(() => relayIceRoutes(CODE_ROOM_ROUTES, { port, username: 'u', credential: 'c' })).toThrow();
  });
});

describe('route proof', () => {
  it('requires relay at both ends and reports the hop protocol only as supplied', () => {
    expect(checkedRelayRoute(observation('sender'))).toEqual({ localCandidateType: 'relay', remoteCandidateType: 'relay', selectedAtBothBoundaries: true,
      relayProtocol: 'udp', relayProtocolSource: 'browser-local-candidate-stats' });
    expect(checkedRelayRoute(observation('sender', { hop: null })).relayProtocolSource).toBe('not-supplied-by-browser');
    for (const [local, remote] of [['host', 'relay'], ['relay', 'host'], ['srflx', 'srflx'], ['prflx', 'relay']]) {
      expect(() => checkedRelayRoute(observation('sender', { local, remote }))).toThrow('route-not-relay');
    }
    const noOption = observation('sender'); delete noOption.selection.local.relayProtocol;
    expect(() => checkedRelayRoute(noOption)).toThrow('transport-observation-invalid');
    expect(() => checkedRelayRoute(observation('sender', { hop: 'quic' }))).toThrow('transport-observation-invalid');
    expect(() => checkedRelayRoute({})).toThrow('transport-observation-invalid');
  });
});

describe('TURN helper counters', () => {
  it('validates the counters file strictly', () => {
    expect(checkedCounters(counters(5)).relayBytesToPeer.udp).toBe(5);
    for (const bad of [{ ...counters(), version: 2 }, { ...counters(), authRejected: -1 }, { ...counters(), allocations: { udp: 1 } },
      { ...counters(), relayBytesToPeer: { udp: 1.5, tcp: 0, unknown: 0 } }, null]) expect(() => checkedCounters(bad)).toThrow();
  });
  it('the relay must carry at least the batch in both relay-socket directions', () => {
    expect(checkedCounterDelta(counters(10), counters(1010), 1000))
      .toEqual({ relayBytesToPeerDelta: 1000, relayBytesFromPeerDelta: 1000, unknownTransportBytes: 0 });
    expect(() => checkedCounterDelta(counters(10), counters(1009), 1000)).toThrow('turn-counters-do-not-bracket');
    expect(() => checkedCounterDelta(counters(10, 10), counters(5000, 10), 1000)).toThrow('turn-counters-do-not-bracket');
    expect(() => checkedCounterDelta(counters(9000), counters(10), 1)).toThrow('turn-counters-regressed');
  });
  it("every component must be monotonic: a sum cannot hide a reset (root's 100→0 control)", () => {
    const proto = (udp, unknown) => ({ udp, tcp: 0, unknown });
    const before = counters(0, 0, { relayBytesToPeer: proto(0, 100), relayBytesFromPeer: proto(0, 100) });
    const after = counters(0, 0, { relayBytesToPeer: proto(200, 0), relayBytesFromPeer: proto(200, 0) });
    expect(() => checkedCounterDelta(before, after, 100)).toThrow('turn-counters-regressed');
    for (const over of [{ authAccepted: 3 }, { relaySocketsClosed: -1 }, { allocations: { udp: 1, tcp: 0, unknown: 0 } }]) {
      expect(() => checkedCounterDelta(counters(0), counters(5000, 5000, over), 1)).toThrow();
    }
    expect(() => checkedCounterDelta(counters(0, 0, { final: true }), counters(5000), 1)).toThrow('turn-counters-regressed');
    const huge = counters(0, 0, { relayBytesToPeer: { udp: Number.MAX_SAFE_INTEGER, tcp: Number.MAX_SAFE_INTEGER, unknown: 0 } });
    expect(() => checkedCounterDelta(counters(0), huge, 1)).toThrow();
    expect(() => checkedCounterDelta({ ...counters(0), version: 2 }, counters(5000), 1)).toThrow('malformed');
    const unknownBoth = checkedCounterDelta(counters(0), counters(0, 0, { relayBytesToPeer: proto(1000, 5), relayBytesFromPeer: proto(1000, 7) }), 1000);
    expect(unknownBoth.unknownTransportBytes).toBe(12);
  });
});

describe('clocks', () => {
  const receiver = { consentAt: 10, firstWriteAt: 15, closedAt: 40, verifiedAt: 45, readyAt: 47 };
  it('cross-side spans use only the controller clock; receiver spans only the receiver clock', () => {
    expect(endToEndSpans({ controllerStartMs: 1000, controllerEndMs: 1100, receiver })).toEqual({
      controllerSelectionToVerifiedUpperBoundMs: 100, receiverConsentToFirstWriteMs: 5, receiverFirstWriteToClosedMs: 25,
      receiverVerificationTailMs: 5, receiverConsentToReadyMs: 37 });
  });
  it('arbitrary peer clock offsets cannot change any reported span', () => {
    const base = endToEndSpans({ controllerStartMs: 1000, controllerEndMs: 1100, receiver });
    for (const offset of [-1e12, -3600000, -0.5, 0.25, 7, 86400000, 1e12]) {
      const shifted = Object.fromEntries(Object.entries(receiver).map(([k, v]) => [k, v + offset]));
      expect(endToEndSpans({ controllerStartMs: 1000, controllerEndMs: 1100, receiver: shifted })).toEqual(base);
    }
  });
  it('refuses non-monotonic or missing marks rather than inventing a span', () => {
    for (const bad of [{ ...receiver, firstWriteAt: 9 }, { ...receiver, readyAt: undefined }, { ...receiver, closedAt: NaN }]) {
      expect(() => endToEndSpans({ controllerStartMs: 0, controllerEndMs: 1, receiver: bad })).toThrow();
    }
    expect(() => endToEndSpans({ controllerStartMs: 5, controllerEndMs: 4, receiver })).toThrow();
  });
});

describe('summaries', () => {
  it('quantiles keep nulls as nulls and P95 needs twenty values', () => {
    expect(quantiles([3, null, 1, 2], 'ms')).toEqual({ unit: 'ms', count: 3, nullCount: 1, median: 2, p95: null, min: 1, max: 3 });
    expect(quantiles(Array.from({ length: 20 }, (_, i) => i), 'ms').p95).toBe(18);
    expect(() => quantiles([-1], 'ms')).toThrow(); expect(() => quantiles([1], 'seconds')).toThrow();
  });
  it('any incomplete formal row poisons the summary; warmups are excluded', () => {
    const row = (outcome, warmup = false) => ({ direction: 'A→B', warmup, outcome, timing: { sender: { activeMs: 5, creditWaitMs: 1, bufferPacingWaitMs: 1, finalizeRoundTripMs: 1, senderLoopOtherMs: 2 }, receiver: null }, endToEnd: { controllerSelectionToVerifiedUpperBoundMs: 9 } });
    const s = summarize([row('clean'), row('missing', true)]);
    expect(s['A→B'].sender.coverage).toEqual({ present: 1, missing: 0 });
    expect(s['A→B'].receiver.coverage).toEqual({ present: 0, missing: 1 });
    expect(s['A→B'].receiver.activeMs.nullCount).toBe(1);
    expect(() => summarize([row('clean'), row('missing')])).toThrow('incomplete');
  });
});

describe('privacy', () => {
  it('report schema: a fixed key allowlist; numbers, booleans, null and fixed strings only', () => {
    expect(() => checkedReport({ schema: REPORT_SCHEMA, status: 'PASS', scope: SCOPE, rows: [{ bytes: 1, verified: true, missing: null, relayProtocol: 'udp' }] })).not.toThrow();
    for (const bad of [{ bytes: '127.0.0.1:3478' }, { bytes: 'turn:127.0.0.1' }, { bytes: 'web-to-native.bin' }, { 'bad key': 1 }, { bytes: NaN },
      { bytes: () => 1 }, { bytes: undefined }, { bytes: 'ff'.repeat(16) }]) expect(() => checkedReport(bad)).toThrow();
  });
  it("an unknown key is refused even when its value looks harmless (root's control)", () => {
    expect(() => checkedReport({ unrecognizedSensitiveField: 'udp' })).toThrow('schema');
    expect(() => checkedReport({ rows: [{ fileName: 1 }] })).toThrow('schema');
    expect(() => checkedReport({ provenance: { sourceCommit: 'a'.repeat(40), credential: 'udp' } })).toThrow('schema');
  });
  it('hash/timestamp-shaped strings pass only at their one provenance path', () => {
    const ok = { provenance: { sourceCommit: 'a'.repeat(40), bundleTreeSha256: 'b'.repeat(64), node: 'v24.22.0' },
      startedAt: '2026-10-23T10:00:00.000Z', finishedAt: '2026-10-23T10:00:01Z' };
    expect(() => checkedReport(ok)).not.toThrow();
    const fileSha = 'c'.repeat(64);
    for (const bad of [{ rows: [{ bytes: fileSha }] }, { provenance: { sourceCommit: fileSha } }, { provenance: { node: fileSha } },
      { setup: { browserRole: 'a'.repeat(40) } }, { rows: [{ outcome: '2026-10-23T10:00:00Z' }] }, { native: { linkOpen: 'v1.2.3' } },
      { provenance: { bundleTreeSha256: 'a'.repeat(40) } }]) expect(() => checkedReport(bad)).toThrow('vocabulary');
  });
  it("the run's own sentinels are caught even inside allowed keys", () => {
    const code = '581937', secret = 'f'.repeat(64);
    const text = JSON.stringify({ rows: [{ bytes: 581937 }], provenance: { bundleTreeSha256: secret } });
    expect(() => assertPrivate(text, [code])).toThrow('secret');
    expect(() => assertPrivate(text, [secret])).toThrow('secret');
  });
  it('the final text scan catches the run secrets and address/URL/credential shapes', () => {
    expect(assertPrivate('{"a":1}', [SECRET])).toBe('{"a":1}');
    for (const text of [`{"x":"${SECRET}"}`, '{"x":"10.1.2.3"}', '{"x":"turn:h"}', '{"x":"candidate:1 1 udp"}', '{"x":"a=ice-ufrag:abc"}',
      '{"x":"http://h"}', '{"username": "1:u"}', '{"credential": "c"}']) expect(() => assertPrivate(text, [SECRET])).toThrow();
    expect(() => assertPrivate('{}', ['ab'])).toThrow('too short');
  });
  it('errors are exported only as fixed reasons', () => {
    expect(classify(new Error('route-not-relay'))).toBe('route-not-relay');
    expect(classify(new Error('evaluate failed: selected candidate pair changed during sample'))).toBe('transport-observation-invalid');
    expect(classify(new Error('file hash/size mismatch at 10.0.0.1'))).toBe('file-verification-failed');
    expect(classify(new Error('something at http://127.0.0.1:1234/x'))).toBe('harness-error');
  });
});

describe('native report assembly', () => {
  it('passes on relay↔relay with verified files and native phases null with a reason', () => {
    const { report, exitCode } = assemble();
    expect(exitCode).toBe(0); expect(report.status).toBe('PASS');
    expect(report.native).toMatchObject({ reportsRelayedBound: true, phaseDetail: null, phaseDetailReason: 'native-phase-not-exposed' });
    const [toNative, toWeb] = report.rows;
    expect(toNative.timing).toEqual({ sender: { bytes: 1000, activeMs: 50, creditWaitMs: 5, bufferPacingWaitMs: 5, finalizeRoundTripMs: 30, senderLoopOtherMs: 10 }, receiver: null });
    expect(toNative.missing.receiver).toBe('native-phase-not-exposed');
    expect(toWeb.timing.sender).toBeNull();
    expect(toWeb.timing.receiver).toMatchObject({ creditWaitMs: null, bufferPacingWaitMs: null, receiverFinalizeMs: 2 });
    expect(() => checkedReport(report)).not.toThrow();
  });
  it('native counters bracket each batch separately', () => {
    const { report } = assemble();
    expect(report.rows[0].turn).toEqual({ relayBytesToPeerDelta: 2500, relayBytesFromPeerDelta: 2500, unknownTransportBytes: 0 });
    expect(report.rows[1].turn).toEqual({ relayBytesToPeerDelta: 2500, relayBytesFromPeerDelta: 2500, unknownTransportBytes: 0 });
    expect(report).not.toHaveProperty('turnBothBatches');
    // The web→native batch alone did not cross the relay: refused, though the total would have covered both.
    expect(assemble({ turnMid: counters(500) }).report.failureReason).toBe('turn-counters-do-not-bracket');
    expect(assemble({ turnMid: counters(4600) }).report.failureReason).toBe('turn-counters-do-not-bracket');
    expect(assemble({ turnMid: undefined }).report.failureReason).toBe('harness-error'); // an unreadable bracket is never a pass
    expect(assemble({ turnAfter: counters(2000) }).report.failureReason).toBe('turn-counters-regressed');
  });
  it('never copies a field it did not whitelist, even if the raw observation carries one', () => {
    const raw = rawNative();
    raw.send.transport = observation('sender', { extraLocal: { address: '10.9.8.7', port: 54321, url: 'turn:10.9.8.7:3478' } });
    raw.send.sample.sample.extra = 'web-to-native.bin';
    const { report } = assemble({ raw });
    const text = JSON.stringify(report);
    for (const leak of ['10.9.8.7', '54321', 'web-to-native.bin']) expect(text).not.toContain(leak);
  });
  it('refuses every way the run might not be what it claims', () => {
    const cases = [
      [{ facts: facts({ iceTurnUrlCount: 0 }) }, 'route-not-relay'],
      [{ facts: facts({ nativeReportsRelayedBound: false }) }, 'route-not-relay'],
      [{ raw: rawNative({ send: { ...rawNative().send, transport: observation('sender', { local: 'host', remote: 'host' }) } }) }, 'route-not-relay'],
      [{ raw: rawNative({ recv: { ...rawNative().recv, transport: null, transportFailed: true } }) }, 'transport-observation-invalid'],
      [{ raw: rawNative({ fileSize: 999 }) }, 'transport-observation-invalid'],
      [{ facts: facts({ nativeReceivedWebFileVerified: false }) }, 'native-file-mismatch'],
      [{ facts: facts({ webReceivedNativeFileVerified: false }) }, 'native-file-mismatch'],
      [{ facts: facts({ nativeLinkOpen: false }) }, 'native-counterpart-failed'],
      [{ facts: facts({ nativeLegacyFallback: true }) }, 'native-counterpart-failed'],
      [{ turnAfter: counters(3000) }, 'turn-counters-do-not-bracket'],
      [{ raw: rawNative({ recv: { ...rawNative().recv, sample: taken('recv', null) } }) }, 'sample-missing'],
      [{ facts: { ...facts(), nativeLinkOpen: 'yes' } }, 'harness-error'],
      [{ raw: null }, 'transport-observation-invalid'],
    ];
    for (const [over, reason] of cases) {
      const { report, exitCode } = assemble(over);
      expect([report.status, report.failureReason, exitCode]).toEqual(['FAIL', reason, 1]);
      expect(report.summary).toBeNull();
    }
  });
  it('the direct-fallback control passes only when refused as not relayed', () => {
    const refused = assemble({ facts: facts({ iceTurnUrlCount: 0, nativeReportsRelayedBound: false }), control: 'direct-fallback' });
    expect(refused.exitCode).toBe(0);
    expect(refused.report.controlOutcome).toEqual({ expected: 'route-not-relay', observed: 'route-not-relay', verdict: 'CONTROL_EXPECTED' });
    const unexpected = assemble({ control: 'direct-fallback' });
    expect(unexpected.exitCode).toBe(1);
    expect(unexpected.report.controlOutcome.verdict).toBe('CONTROL_UNEXPECTED');
    expect(() => assemble({ control: 'bad-hash' })).toThrow('invalid native control');
  });
});
