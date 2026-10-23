/** Contracts for the opt-in realtime RELAY diagnostics. No product imports, no
 * network calls, no telemetry. Pure functions only, so every rule here is unit
 * tested (realtime-relay-diagnostics-core.test.mjs).
 *
 * What a diagnostics report may contain, and the only things it may contain:
 * numbers, booleans, null, and strings from the fixed vocabularies below. It
 * never contains a TURN secret, username, credential, URL, address, port,
 * candidate/pair/transport id, SDP, pairing code, file name, file content or
 * file digest. That is enforced twice: reports are BUILT from whitelisted
 * fields only (`checkedReport` refuses any other key or string), and the
 * serialized text is scanned for the run's own secrets and for address/URL
 * shapes (`assertPrivate`) before it is written. */
import { createHmac } from 'node:crypto';
import { RELAY_PROTOCOLS, checkedRole } from './transfer-transport-probe.mjs';
import { checkedSample, SAMPLE_SEMANTICS } from './relay-diagnostics-probe.mjs';

export const REPORT_SCHEMA = 'relayium-realtime-relay-diagnostics/1';
export const CONTROLS = ['direct-fallback', 'wrong-credential', 'bad-hash', 'slow-receiver', 'cancel', 'observer-throws'];
/** What each control must produce. A control that does not is a harness failure. */
export const CONTROL_EXPECTATIONS = {
  'direct-fallback': 'route-not-relay',
  'wrong-credential': 'link-setup-failed',
  'bad-hash': 'file-verification-failed',
  'slow-receiver': 'credit-wait-responded',
  cancel: 'cancelled-no-clean-sample',
  'observer-throws': 'sample-missing-observer-threw',
};
export const FAILURE_REASONS = ['route-not-relay', 'link-setup-failed', 'file-verification-failed', 'sample-missing-observer-threw',
  'sample-missing', 'cancelled-no-clean-sample', 'credit-wait-not-responding', 'turn-counters-do-not-bracket', 'turn-counters-regressed', 'transport-observation-invalid',
  'deadline', 'browser-error', 'harness-error', 'native-counterpart-failed', 'native-file-mismatch'];
export const DIRECTIONS = ['A→B', 'B→A', 'web→native', 'native→web'];

export function options(argv) {
  const o = { samples: 5, warmups: 1, fileMiB: 8, control: null, writeDelayMs: 0 };
  const numbers = { '--samples': ['samples', 1, 50], '--warmups': ['warmups', 0, 5], '--file-mib': ['fileMiB', 1, 64] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (seen.has(key)) throw new Error(`duplicate option ${key}`);
    seen.add(key);
    if (numbers[key]) {
      const [name, min, max] = numbers[key];
      if (!/^\d+$/.test(value ?? '') || Number(value) < min || Number(value) > max) throw new Error(`invalid ${key}`);
      o[name] = Number(value);
    } else if (key === '--out' && value && value.startsWith('/')) o.out = value;
    else if (key === '--bundle' && value && value.startsWith('/')) o.bundle = value;
    else if (key === '--control' && CONTROLS.includes(value)) o.control = value;
    else throw new Error(`unknown or invalid option ${key}`);
  }
  if (!o.out) throw new Error('--out /absolute/new-report.json is required (never overwritten)');
  if (!o.bundle) throw new Error('--bundle /absolute/private-diagnostic-build is required');
  if (o.control === 'slow-receiver') {
    // The credit window is 8 MiB of durable ACK: a smaller batch can finish
    // without ever waiting on credit, and the control would prove nothing.
    if (o.fileMiB < 24) o.fileMiB = 24;
    o.writeDelayMs = 25;
  }
  if (o.control === 'cancel') {
    // The batch must still be in flight when the sender cancels at the first
    // received write: a slowed receiver keeps most of it outstanding.
    if (o.fileMiB < 24) o.fileMiB = 24;
    o.writeDelayMs = 25;
  }
  if (o.control && o.control !== 'slow-receiver') { o.samples = 1; o.warmups = 0; }
  return o;
}

/** TURN REST credential exactly as the central server mints it (account/turn.go). */
export function turnRestCredential(secret, { token = 'diagnostics.local', ttlSecs = 3600, nowSecs = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('TURN secret must be at least 16 bytes');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(token) || !Number.isInteger(ttlSecs) || ttlSecs < 60 || ttlSecs > 86_400) throw new Error('invalid credential parameters');
  const username = `${nowSecs + ttlSecs}:${token}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}

/** The code-room fixture's GET routes with ONE loopback TURN entry in /api/ice.
 * The product's own chooseRtcConfig then forces relay-only; nothing else does. */
export function relayIceRoutes(baseRoutes, { port, username, credential }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid loopback TURN port');
  if (typeof username !== 'string' || typeof credential !== 'string' || !username || !credential) throw new Error('missing TURN credential');
  if (!baseRoutes?.['/api/ice'] || baseRoutes['/api/ice'].iceServers?.length) throw new Error('base routes must carry the empty default /api/ice');
  const urls = [`turn:127.0.0.1:${port}?transport=udp`, `turn:127.0.0.1:${port}?transport=tcp`];
  return { ...baseRoutes, '/api/ice': { iceServers: [{ urls, username, credential }], relays: [] } };
}

/** Route proof for one side: both selected candidates are relay candidates.
 * `side` is checkedRole() output; its identity was already required to be the
 * same at both transfer boundaries by the transport probe. */
export function checkedRelayRoute(side) {
  const local = side?.selection?.local, remote = side?.selection?.remote;
  if (!local || !remote) throw new Error('transport-observation-invalid');
  if (local.candidateType !== 'relay' || remote.candidateType !== 'relay') {
    const error = new Error('route-not-relay');
    error.route = { local: local.candidateType, remote: remote.candidateType };
    throw error;
  }
  if (!Object.hasOwn(local, 'relayProtocol')) throw new Error('transport-observation-invalid');
  const hop = local.relayProtocol;
  if (hop !== null && !RELAY_PROTOCOLS.includes(hop)) throw new Error('transport-observation-invalid');
  return { localCandidateType: 'relay', remoteCandidateType: 'relay', selectedAtBothBoundaries: true,
    relayProtocol: hop, relayProtocolSource: hop === null ? 'not-supplied-by-browser' : 'browser-local-candidate-stats' };
}

const COUNTER_KEYS = ['authAccepted', 'authRejected', 'relaySocketsClosed', 'permissions', 'channels', 'allocationErrors'];
const PROTO_KEYS = ['udp', 'tcp', 'unknown'];

/** Validate one counters file read from the local TURN helper. */
export function checkedCounters(raw) {
  if (raw?.version !== 1 || typeof raw.final !== 'boolean') throw new Error('turn counters malformed');
  const out = { final: raw.final };
  for (const k of COUNTER_KEYS) {
    if (!Number.isSafeInteger(raw[k]) || raw[k] < 0) throw new Error(`turn counter ${k} malformed`);
    out[k] = raw[k];
  }
  for (const group of ['allocations', 'relayBytesToPeer', 'relayBytesFromPeer']) {
    if (!raw[group] || !PROTO_KEYS.every(k => Number.isSafeInteger(raw[group][k]) && raw[group][k] >= 0)) throw new Error(`turn counter ${group} malformed`);
    out[group] = Object.fromEntries(PROTO_KEYS.map(k => [k, raw[group][k]]));
  }
  return out;
}

/** The relay helper must have carried at least the batch's bytes in BOTH relay
 * socket directions between two counter reads that bracket the batch.
 *
 * Every counter, and every per-transport component, must be monotonic between
 * the two reads: a component that went DOWN means a restarted helper or reads
 * of two different helpers, and a sum must never be allowed to hide that
 * (unknown 100→0 with udp 0→200 is a reset, not +100). Both inputs are
 * validated here, so a caller cannot hand in an unchecked file. */
export function checkedCounterDelta(rawBefore, rawAfter, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('harness-error');
  const before = checkedCounters(rawBefore), after = checkedCounters(rawAfter);
  if (before.final) throw new Error('turn-counters-regressed');
  for (const k of COUNTER_KEYS) if (after[k] < before[k]) throw new Error('turn-counters-regressed');
  const delta = {};
  for (const g of ['allocations', 'relayBytesToPeer', 'relayBytesFromPeer']) {
    delta[g] = {};
    for (const k of PROTO_KEYS) {
      if (after[g][k] < before[g][k]) throw new Error('turn-counters-regressed');
      delta[g][k] = after[g][k] - before[g][k];
    }
  }
  const total = g => {
    const n = PROTO_KEYS.reduce((sum, k) => sum + delta[g][k], 0);
    if (!Number.isSafeInteger(n)) throw new Error('turn-counters-do-not-bracket');
    return n;
  };
  const toPeer = total('relayBytesToPeer'), fromPeer = total('relayBytesFromPeer');
  if (toPeer < bytes || fromPeer < bytes) throw new Error('turn-counters-do-not-bracket');
  return { relayBytesToPeerDelta: toPeer, relayBytesFromPeerDelta: fromPeer,
    unknownTransportBytes: delta.relayBytesToPeer.unknown + delta.relayBytesFromPeer.unknown };
}

/**
 * End-to-end spans of one Web↔Web batch, with no cross-page clock arithmetic.
 *
 * The controller (this Node process) measures the only cross-side interval on
 * its OWN monotonic clock: from just before it dispatches the selection to just
 * after it observes the receiver's verified-ready state. That is an UPPER
 * BOUND: it includes CDP round trips and the polling interval. The receiver's
 * milestones (consent, first write, close, verified, ready) are subtracted only
 * from each other, on the receiver page's clock. No page clock is ever
 * subtracted from another page's or from the controller's, so no alignment of
 * clocks is assumed, and nothing here is a network or WAN measurement.
 */
export function endToEndSpans({ controllerStartMs, controllerEndMs, receiver }) {
  const c = [controllerStartMs, controllerEndMs], r = receiver ?? {};
  const marks = [r.consentAt, r.firstWriteAt, r.closedAt, r.verifiedAt, r.readyAt];
  if (!c.every(Number.isFinite) || c[1] < c[0] || !marks.every(Number.isFinite) || marks.some((v, i) => i && v < marks[i - 1])) {
    throw new Error('harness-error');
  }
  return { controllerSelectionToVerifiedUpperBoundMs: c[1] - c[0],
    receiverConsentToFirstWriteMs: r.firstWriteAt - r.consentAt, receiverFirstWriteToClosedMs: r.closedAt - r.firstWriteAt,
    receiverVerificationTailMs: r.verifiedAt - r.closedAt, receiverConsentToReadyMs: r.readyAt - r.consentAt };
}

/** Explicit units and nulls; P95 only for n >= 20 (nearest rank). */
export function quantiles(values, unit) {
  if (!['ms', 'bytes', 'count'].includes(unit)) throw new Error('invalid unit');
  const present = values.filter(v => v !== null && v !== undefined);
  if (present.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('invalid summary value');
  const a = [...present].sort((x, y) => x - y), n = a.length;
  return { unit, count: n, nullCount: values.length - n, median: n ? (n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2) : null,
    p95: n >= 20 ? a[Math.ceil(n * 0.95) - 1] : null, min: n ? a[0] : null, max: n ? a[n - 1] : null };
}

export const SUMMARY_FIELDS = {
  sender: ['activeMs', 'creditWaitMs', 'bufferPacingWaitMs', 'finalizeRoundTripMs', 'senderLoopOtherMs'],
  receiver: ['activeMs', 'receiverFinalizeMs'],
};

/** Summaries only over formal, complete rows; any incomplete row poisons it. */
export function summarize(rows) {
  const out = {};
  for (const direction of DIRECTIONS) {
    const group = rows.filter(r => !r.warmup && r.direction === direction);
    if (!group.length) continue;
    if (group.some(r => r.outcome !== 'clean')) throw new Error(`incomplete rows in ${direction}`);
    out[direction] = { samples: group.length };
    for (const role of ['sender', 'receiver']) {
      const present = group.filter(r => r.timing[role]);
      out[direction][role] = { coverage: { present: present.length, missing: group.length - present.length } };
      for (const field of SUMMARY_FIELDS[role]) {
        out[direction][role][field] = quantiles(group.map(r => r.timing[role]?.[field] ?? null), 'ms');
      }
    }
    out[direction].controllerSelectionToVerifiedUpperBoundMs = quantiles(group.map(r => r.endToEnd?.controllerSelectionToVerifiedUpperBoundMs ?? null), 'ms');
  }
  return out;
}

// ── privacy ──────────────────────────────────────────────────────────────────

export const SCOPE = {
  claim: 'controlled local diagnostics: two endpoints on ONE host relayed through a loopback TURN helper; proves the relay code path and per-phase attribution only',
  notClaimed: 'not WAN, not production relay equivalence, not physical-disk durability, not throughput tuning, not a speedup',
  turnHelper: 'repository pion/turn (server/third_party/pion-turn) on IPv4 loopback only, UDP and TCP on one port, TURN REST credentials',
  route: 'selected candidate pair local AND remote candidateType relay, identical at both transfer boundaries (transport probe), plus TURN helper relay-socket byte counters bracketing each batch separately (native tier: before the browser send, after it completed and the receive observation was armed, after the native send; each bracket also covers that interval text messages and control traffic, so it is a lower-bound corroboration, not a per-batch byte count)',
  relayProtocol: 'client-to-TURN hop protocol from the browser local-candidate relayProtocol stat when supplied; null when not supplied (never inferred)',
  timing: 'TransferSample fields per side on that side clock; bufferPacingWaitMs combines buffer and pacing waits; receiver credit/buffer are null (zero by construction); no cross-side subtraction; no overlapping API wall time is added or subtracted; senderLoopOtherMs is not network time',
  endToEnd: 'controller* fields are upper bounds on the Node controller monotonic clock including CDP round trips and polling; receiver* fields subtract receiver-page milestones from each other only; no page clock is subtracted from another clock',
  native: 'native phase detail is not exposed by the native app model: native timings are null with a reason; native completion is an internal full-SHA match reported as a boolean',
  destination: 'web receiver writes to an in-memory picker replacement; native receiver writes through the app model to a private run directory; neither is a durability claim',
};

const NULL_REASONS = ['native-phase-not-exposed', 'receiver-zero-by-construction', 'not-supplied-by-browser', 'browser-local-candidate-stats',
  'no-clean-sample-emitted', 'observer-threw'];
const STRING_VOCABULARY = new Set([REPORT_SCHEMA, 'PASS', 'FAIL', 'IN_PROGRESS', 'clean', 'cancelled', 'failed', 'missing',
  'web-web', 'native-web', 'ms', 'bytes', 'count', 'send', 'recv', 'relay', 'udp', 'tcp', 'tls', 'initiator', 'responder',
  'CONTROL_EXPECTED', 'CONTROL_UNEXPECTED', ...DIRECTIONS, ...CONTROLS, ...FAILURE_REASONS, ...NULL_REASONS,
  ...Object.values(CONTROL_EXPECTATIONS), ...Object.values(SCOPE), ...Object.values(SAMPLE_SEMANTICS)]);
/** Every key a report may contain, anywhere. Fixed: a new field is a code
 * change here, never something a report can carry by looking plausible. */
export const REPORT_KEYS = new Set([
  'schema', 'status', 'tier', 'control', 'startedAt', 'finishedAt', 'scope', 'configuration', 'provenance', 'setup', 'rows', 'summary',
  'semantics', 'failureReason', 'privacyRefused', 'controlOutcome', 'controlEvidence', 'native',
  // scope / semantics
  ...Object.keys(SCOPE), ...Object.keys(SAMPLE_SEMANTICS),
  // configuration / provenance
  'samples', 'warmups', 'fileMiB', 'receiverWriteDelayMs', 'transportSamplingIntervalMs',
  'sourceCommit', 'node', 'bundleTreeSha256', 'dirtyInputCount', 'browserMajor',
  // setup
  'controllerOpenToBothWorkspacesUpperBoundMs', 'turnAllocations', 'turnAuthRejected', 'udp', 'tcp', 'unknown',
  'iceTurnUrlCount', 'iceStunUrlCount', 'iceLoopbackOnly', 'browserRole',
  // rows
  'direction', 'iteration', 'warmup', 'bytes', 'files', 'outcome', 'verified', 'route', 'turn', 'endToEnd', 'timing', 'missing', 'transport',
  'sender', 'receiver', 'browser', 'nativeReportsRelayedBound',
  'localCandidateType', 'remoteCandidateType', 'selectedAtBothBoundaries', 'relayProtocol', 'relayProtocolSource',
  'relayBytesToPeerDelta', 'relayBytesFromPeerDelta', 'unknownTransportBytes',
  'controllerSelectionToVerifiedUpperBoundMs', 'receiverConsentToFirstWriteMs', 'receiverFirstWriteToClosedMs', 'receiverVerificationTailMs',
  'receiverConsentToReadyMs', 'browserSelectionToSenderCompleteUpperBoundMs',
  'activeMs', 'creditWaitMs', 'bufferPacingWaitMs', 'finalizeRoundTripMs', 'senderLoopOtherMs', 'receiverFinalizeMs',
  'senderCandidatePairBytesSent', 'receiverCandidatePairBytesReceived', 'senderLatestStunRttMs', 'senderFileChannelMaxBufferedAfterSendBytes',
  'senderFileChannelSampledMaxBufferedBytes', 'senderSamplingMaxGapMs',
  // native
  'linkOpen', 'legacyFallback', 'reportsRelayedBound', 'receivedWebFileVerified', 'receivedMessage', 'phaseDetail', 'phaseDetailReason',
  // summary
  ...DIRECTIONS, 'coverage', 'present', 'unit', 'count', 'nullCount', 'median', 'p95', 'min', 'max',
  // controls
  'expected', 'observed', 'verdict', 'turnAuthRejectedTotal', 'fastSenderCreditWaitMedianMs', 'slowSenderCreditWaitMedianMs', 'requiredIncreaseMs',
]);
/** The only places a non-vocabulary string may appear, and its exact shape. */
const PROVENANCE = {
  '$.provenance.sourceCommit': /^[0-9a-f]{40}$/,
  '$.provenance.bundleTreeSha256': /^[0-9a-f]{64}$/,
  '$.provenance.node': /^v\d+\.\d+\.\d+$/,
  '$.startedAt': /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/,
  '$.finishedAt': /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/,
};

/** Refuse any key outside REPORT_KEYS and any string outside the vocabulary
 * (or its one provenance path). Returns the report. */
export function checkedReport(report) {
  const walk = (value, path) => {
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`); return; }
    if (typeof value === 'string') {
      if (STRING_VOCABULARY.has(value)) return;
      if (PROVENANCE[path]?.test(value)) return;
      throw new Error(`string outside the report vocabulary at ${path}`);
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[]`)); return; }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (!REPORT_KEYS.has(k)) throw new Error(`key outside the report schema at ${path}`);
        walk(v, `${path}.${k}`);
      }
      return;
    }
    throw new Error(`unexportable value at ${path}`);
  };
  walk(report, '$');
  return report;
}

/** Final text scan: the run's own secrets, and any address/URL/SDP shape. */
export function assertPrivate(text, sentinels = []) {
  for (const s of sentinels) {
    if (typeof s !== 'string' || s.length < 4) throw new Error('privacy sentinel too short to be meaningful');
    if (text.includes(s)) throw new Error('report contains a run secret or identifier');
  }
  const shapes = [/\b\d{1,3}(\.\d{1,3}){3}\b/, /\b(turns?|stuns?):/i, /\bcandidate:/i, /\ba=(ice|fingerprint|candidate)/i,
    /https?:\/\//i, /\bufrag\b/i, /\bcredential\b"?\s*:/i, /\busername\b"?\s*:/i];
  for (const shape of shapes) if (shape.test(text)) throw new Error(`report contains an address/URL/credential shape (${shape})`);
  return text;
}

/** Classify any thrown error into the fixed vocabulary; raw text never exported. */
export function classify(error) {
  const message = String(error?.message ?? error);
  if (FAILURE_REASONS.includes(message)) return message;
  if (/selected candidate pair|transport observation|candidate-pair|selectedCandidatePair/i.test(message)) return 'transport-observation-invalid';
  if (/hash|size mismatch|unverified|destination aborted|product receive failed/i.test(message)) return 'file-verification-failed';
  if (/workspace link|pair-room peer|connected peer|open .* channel/i.test(message)) return 'link-setup-failed';
  if (/deadline/i.test(message)) return 'deadline';
  if (/browser errors/i.test(message)) return 'browser-error';
  return 'harness-error';
}

// ── native tier ──────────────────────────────────────────────────────────────

const FACT_BOOLEANS = ['nativeLinkOpen', 'nativeLegacyFallback', 'nativeReceivedWebFileVerified', 'webReceivedNativeFileVerified',
  'nativeReceivedMessage', 'webReceivedMessage', 'nativeReportsRelayedBound', 'iceLoopbackOnly'];

function checkedFacts(facts) {
  if (!facts || !FACT_BOOLEANS.every(k => typeof facts[k] === 'boolean')
    || !Number.isSafeInteger(facts.fileBytes) || facts.fileBytes < 1
    || !Number.isSafeInteger(facts.iceTurnUrlCount) || !Number.isSafeInteger(facts.iceStunUrlCount)
    || ![null, 'initiator', 'responder'].includes(facts.browserRole)) throw new Error('harness-error');
  return facts;
}

/**
 * The native↔Web report, from the browser half's RAW observation, the shell's
 * internally derived native facts (booleans only) and two TURN counter reads
 * that bracket both batches. Only the browser side has phase detail; native
 * phases are null with a reason. Returns { report, exitCode }.
 */
export function assembleNativeReport({ raw, facts, turnBefore, turnMid, turnAfter, control = null, provenance = {} }) {
  if (control !== null && control !== 'direct-fallback') throw new Error('invalid native control');
  const report = { schema: REPORT_SCHEMA, status: 'IN_PROGRESS', tier: 'native-web', control, scope: SCOPE,
    configuration: {}, provenance, native: null, setup: null, rows: [], summary: null };
  try {
    const f = checkedFacts(facts), bytes = f.fileBytes;
    report.configuration = { fileMiB: bytes / 1048576 };
    report.native = { linkOpen: f.nativeLinkOpen, legacyFallback: f.nativeLegacyFallback, reportsRelayedBound: f.nativeReportsRelayedBound,
      receivedWebFileVerified: f.nativeReceivedWebFileVerified, receivedMessage: f.nativeReceivedMessage,
      phaseDetail: null, phaseDetailReason: 'native-phase-not-exposed' };
    report.setup = { iceTurnUrlCount: f.iceTurnUrlCount, iceStunUrlCount: f.iceStunUrlCount, iceLoopbackOnly: f.iceLoopbackOnly,
      browserRole: f.browserRole };
    if (!f.nativeLinkOpen || f.nativeLegacyFallback) throw new Error('native-counterpart-failed');
    if (!f.nativeReceivedWebFileVerified || !f.webReceivedNativeFileVerified || !f.nativeReceivedMessage || !f.webReceivedMessage) throw new Error('native-file-mismatch');
    // No TURN issued for the code, or a native model with no relayed bound, is
    // not a relayed run whatever the browser saw: refuse before the transport.
    if (f.iceTurnUrlCount < 1 || !f.nativeReportsRelayedBound) throw new Error('route-not-relay');
    if (raw?.version !== 1 || raw.fileSize !== bytes || !raw.send || !raw.recv
      || raw.send.transportFailed !== false || raw.recv.transportFailed !== false) throw new Error('transport-observation-invalid');
    const sender = checkedRole(raw.send.transport, 'sender'), receiver = checkedRole(raw.recv.transport, 'receiver');
    if (sender.channels.relayium.sendBytes < bytes || receiver.candidatePair.bytesReceived < bytes) throw new Error('transport-observation-invalid');
    const route = { browserAsSender: checkedRelayRoute(sender), browserAsReceiver: checkedRelayRoute(receiver) };
    // One bracket per batch: before the browser's send .. after it completed and
    // the receive observation was armed (the shell's barrier) .. after the
    // native send. Each also covers that interval's text and control traffic.
    const turnToNative = checkedCounterDelta(turnBefore, turnMid, bytes), turnToWeb = checkedCounterDelta(turnMid, turnAfter, bytes);
    const send = checkedSample(raw.send.sample, { dir: 'send', bytes }), recv = checkedSample(raw.recv.sample, { dir: 'recv', bytes });
    const strip = x => { const { present, dir, ...rest } = x; return rest; };
    const spanMs = raw.sendDoneAt - raw.sendStartAt;
    if (!Number.isFinite(spanMs) || spanMs < 0) throw new Error('harness-error');
    report.rows.push({ direction: 'web→native', iteration: 0, warmup: false, bytes, files: 1, verified: true,
      outcome: send.present ? 'clean' : 'missing', route: { browser: route.browserAsSender, nativeReportsRelayedBound: true }, turn: turnToNative,
      timing: { sender: send.present ? strip(send) : null, receiver: null },
      missing: { sender: send.present ? null : send.reason, receiver: 'native-phase-not-exposed' },
      endToEnd: { browserSelectionToSenderCompleteUpperBoundMs: spanMs } });
    report.rows.push({ direction: 'native→web', iteration: 0, warmup: false, bytes, files: 1, verified: true,
      outcome: recv.present ? 'clean' : 'missing', route: { browser: route.browserAsReceiver, nativeReportsRelayedBound: true }, turn: turnToWeb,
      timing: { sender: null, receiver: recv.present ? strip(recv) : null },
      missing: { sender: 'native-phase-not-exposed', receiver: recv.present ? null : recv.reason } });
    if (report.rows.some(r => r.outcome !== 'clean')) throw new Error('sample-missing');
    report.summary = summarize(report.rows);
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.summary = null;
    report.failureReason = classify(error);
  }
  let exitCode = report.status === 'PASS' ? 0 : 1;
  if (control) {
    const expected = CONTROL_EXPECTATIONS[control];
    const observed = report.status === 'PASS' ? null : report.failureReason;
    report.controlOutcome = { expected, observed, verdict: observed === expected ? 'CONTROL_EXPECTED' : 'CONTROL_UNEXPECTED' };
    exitCode = observed === expected ? 0 : 1;
  }
  return { report, exitCode };
}
