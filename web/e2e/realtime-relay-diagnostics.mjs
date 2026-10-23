#!/usr/bin/env node
/** Web↔Web realtime RELAY diagnostics (Tier A). Opt-in, local, numeric-only.
 *
 * Run through scripts/realtime-relay-diagnostics.sh, which owns the loopback TURN
 * helper and passes, in the ENVIRONMENT only:
 *   RELAYIUM_DIAG_TURN_SECRET  shared TURN REST secret (never argv, never written)
 *   RELAYIUM_DIAG_TURN_PORT    the helper's loopback port
 *   RELAYIUM_DIAG_TURN_STATUS  absolute path of the helper's counters file
 *   RELAYIUM_DIAG_PRIVATE_LOG  absolute path, inside a 0700 directory, for raw
 *                              error text that must never reach the report
 *
 *   node e2e/realtime-relay-diagnostics.mjs --bundle /private/build --out /new.json
 *     [--samples N] [--warmups N] [--file-mib N] [--control NAME]
 *
 * Two Chrome tabs on the PRIVATE diagnostic bundle (relay-diagnostics-build.mjs)
 * meet in the code-room fixture; its /api/ice carries ONE loopback TURN entry,
 * so the product's own chooseRtcConfig forces relay-only. Every batch is fully
 * SHA-256 verified in an in-memory destination. Per batch the run records, from
 * BOTH tabs: the product's own TransferSample (numeric copy only), the selected
 * pair at both boundaries (must be relay↔relay), and the helper's relay-socket
 * byte counters bracketing the batch. See SCOPE in the core for every non-claim.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTab, startPreview, sleep, VERIFY_DEFAULT } from './harness.mjs';
import { apiFixtureScript } from './a11y-fixtures.mjs';
import { CODE_ROOM_ROUTES, codeRoomSignalingScript } from './code-room-fixture.mjs';
import { installProbe } from './transfer-performance-core.mjs';
import { installTransportProbe, checkedTransport, TRANSPORT_LABELS, TRANSPORT_INTERVAL_MS } from './transfer-transport-probe.mjs';
import { installRelayDiagnosticsProbe, checkedSample, SAMPLE_SEMANTICS } from './relay-diagnostics-probe.mjs';
import { MARKER_FILE } from './relay-diagnostics-build.mjs';
import { CONTROL_EXPECTATIONS, REPORT_SCHEMA, SCOPE, options, turnRestCredential, relayIceRoutes, checkedRelayRoute,
  checkedCounters, checkedCounterDelta, summarize, quantiles, checkedReport, assertPrivate, classify, assembleNativeReport, endToEndSpans } from './realtime-relay-diagnostics-core.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gitIn = (...args) => execFileSync('git', args, { cwd: web, encoding: 'utf8' }).trim();

/** `assemble-native`: the native tier's report, from files the shell wrote into
 * its private run root. Secrets to scan for arrive in RELAYIUM_DIAG_SENTINELS
 * (environment, newline-separated), never argv. */
if (process.argv[2] === 'assemble-native') {
  const args = process.argv.slice(3), got = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--raw', '--facts', '--turn-before', '--turn-mid', '--turn-after', '--out', '--control'].includes(key) || !value || Object.hasOwn(got, key)) {
      console.error('usage: realtime-relay-diagnostics.mjs assemble-native --raw F --facts F --turn-before F --turn-mid F --turn-after F [--control direct-fallback] --out NEW');
      process.exit(2);
    }
    got[key] = value;
  }
  if (!['--raw', '--facts', '--turn-before', '--turn-mid', '--turn-after', '--out'].every(k => got[k]?.startsWith('/'))) { console.error('all paths must be absolute'); process.exit(2); }
  if (existsSync(got['--out'])) { console.error('refusing to overwrite an existing report'); process.exit(2); }
  const read = key => { try { return JSON.parse(readFileSync(got[key], 'utf8')); } catch { return null; } };
  const { report, exitCode } = assembleNativeReport({ raw: read('--raw'), facts: read('--facts'), turnBefore: read('--turn-before'),
    turnMid: read('--turn-mid'), turnAfter: read('--turn-after'), control: got['--control'] ?? null,
    provenance: { sourceCommit: gitIn('rev-parse', 'HEAD'), node: process.version } });
  report.startedAt = report.finishedAt = new Date().toISOString();
  report.semantics = SAMPLE_SEMANTICS;
  let text, code = exitCode;
  try {
    checkedReport(report);
    text = JSON.stringify(report, null, 2) + '\n';
    assertPrivate(text, (process.env.RELAYIUM_DIAG_SENTINELS ?? '').split('\n').filter(Boolean));
  } catch {
    text = JSON.stringify({ schema: REPORT_SCHEMA, status: 'FAIL', failureReason: 'harness-error', privacyRefused: true }, null, 2) + '\n';
    code = 1;
    report.status = 'FAIL'; report.failureReason = 'harness-error (report privacy check refused)';
  }
  writeFileSync(got['--out'], text, { flag: 'wx' });
  console.log(`${report.status}${report.failureReason ? ` (${report.failureReason})` : ''}${report.controlOutcome ? ` control ${report.controlOutcome.verdict}` : ''}: ${got['--out']}`);
  process.exit(code);
}

const opts = options(process.argv.slice(2));
const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set by the owning runner`);
  return value;
};
const secret = env('RELAYIUM_DIAG_TURN_SECRET');
const turnPort = Number(env('RELAYIUM_DIAG_TURN_PORT'));
const statusPath = env('RELAYIUM_DIAG_TURN_STATUS');
const privateLog = env('RELAYIUM_DIAG_PRIVATE_LOG');
if ((statSync(dirname(privateLog)).mode & 0o077) !== 0) throw new Error('RELAYIUM_DIAG_PRIVATE_LOG must live in a 0700 directory');
if (existsSync(opts.out)) throw new Error('refusing to overwrite an existing report');
if (!existsSync(join(opts.bundle, MARKER_FILE))) throw new Error('--bundle is not a private relay diagnostics build');
const ROOM_CODE = '581937';
const credential = turnRestCredential(opts.control === 'wrong-credential' ? `${secret}-not-the-helper-secret` : secret);
const routes = opts.control === 'direct-fallback' ? CODE_ROOM_ROUTES : relayIceRoutes(CODE_ROOM_ROUTES, { port: turnPort, ...credential });
const privately = (label, error) => appendFileSync(privateLog, `${new Date().toISOString()} ${label}: ${error?.stack ?? error}\n`, { mode: 0o600 });

const report = { schema: REPORT_SCHEMA, status: 'IN_PROGRESS', tier: 'web-web', control: opts.control,
  startedAt: new Date().toISOString(), scope: SCOPE,
  configuration: { samples: opts.samples, warmups: opts.warmups, fileMiB: opts.fileMiB, receiverWriteDelayMs: opts.writeDelayMs,
    transportSamplingIntervalMs: TRANSPORT_INTERVAL_MS },
  provenance: {}, setup: {}, rows: [], summary: null };
let browser, closeBrowser, preview, deadline, timedOut = false;

async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const { port } = server.address();
  await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  return port;
}
/** The raw counters file, validated; the RAW object is returned so that every
 * consumer (checkedCounterDelta) validates it again rather than trusting us. */
function counters() {
  const raw = JSON.parse(readFileSync(statusPath, 'utf8'));
  checkedCounters(raw);
  return raw;
}
/** The controller's own monotonic clock: the only clock any cross-side span uses. */
const controllerNow = () => performance.now();
/** The helper rewrites its counters every 100 ms; wait for a fresh, settled read. */
async function settledCounters() {
  let last = JSON.stringify(counters());
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const now = JSON.stringify(counters());
    if (now === last) return JSON.parse(now);
    last = now;
  }
  throw new Error('turn-counters-do-not-bracket');
}
function payload(bytes, index) {
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) body[i] = (i * 37 + index * 13 + 11) % 251;
  return body;
}
const pageFile = (name, bytes, index) => `(() => {
  const dt = new DataTransfer(), body = new Uint8Array(${bytes});
  for (let i = 0; i < body.length; i++) body[i] = (i * 37 + ${index} * 13 + 11) % 251;
  dt.items.add(new File([body], ${JSON.stringify(name)}));
  window.__baselineFiles = dt;
})()`;

async function oneBatch(sender, receiver, direction, iteration, warmup, writeDelayMs) {
  if (timedOut) throw new Error('deadline');
  const bytes = opts.fileMiB * 1024 * 1024, index = iteration % 7;
  const name = `relay-diagnostics-${direction === 'A→B' ? 'ab' : 'ba'}-${warmup ? 'w' : 'm'}${iteration}.bin`;
  const expected = { [name]: { bytes, sha256: opts.control === 'bad-hash' ? '0'.repeat(64) : sha(payload(bytes, index)) } };
  await receiver.evaluate(`window.__transferBaseline.arm(${JSON.stringify({ kind: 'file', expected, text: '', expectedTextBytes: 0, expectedTextHash: '', writeDelayMs })})`);
  await sender.evaluate(pageFile(name, bytes, index));
  await sender.waitFor("document.querySelector('.msgpanel .attach-file')?.disabled === false", 'file selection enabled');
  const before = await settledCounters();
  await sender.evaluate("window.__transferTransport.arm('sender')");
  await receiver.evaluate("window.__transferTransport.arm('receiver')");
  await sender.evaluate("window.__relayiumRelayDiagnostics.arm('send')");
  await receiver.evaluate("window.__relayiumRelayDiagnostics.arm('recv')");
  const controllerStartMs = controllerNow();
  await sender.evaluate(`(() => {
    const input = document.querySelector('.msgpanel .attach-file');
    input.files = window.__baselineFiles.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    window.__baselineFiles = null; return true;
  })()`);
  const row = { direction, iteration, warmup, bytes, files: 1 };

  if (opts.control === 'cancel') {
    await receiver.waitFor('!!window.__transferBaseline.snapshot().firstWriteAt', 'first received bytes', 60_000);
    await sender.evaluate(`(() => {
      const button = document.querySelector('#xfer-label-send')?.closest('.xfer')?.querySelector('button.cancel');
      if (!button) throw new Error('no cancel control');
      button.click(); return true;
    })()`);
    await sleep(3_000); // a late clean sample would have to arrive inside this grace
    const sent = await sender.evaluate('window.__relayiumRelayDiagnostics.take()');
    const got = await receiver.evaluate('window.__relayiumRelayDiagnostics.take()');
    const snap = await receiver.evaluate('window.__transferBaseline.snapshot()');
    const s = checkedSample(sent, { dir: 'send', bytes }), r = checkedSample(got, { dir: 'recv', bytes });
    await sender.evaluate('window.__transferTransport.abort()');
    await receiver.evaluate('window.__transferTransport.abort()');
    if (s.present || r.present || snap.verified) throw new Error('a cancelled batch produced a clean sample or a verified file');
    return { ...row, outcome: 'cancelled', verified: false, timing: { sender: null, receiver: null },
      missing: { sender: s.reason, receiver: r.reason } };
  }

  await receiver.waitFor('window.__transferBaseline.snapshot().ready || !!window.__transferBaseline.snapshot().error', 'verified receiver completion', 180_000);
  const controllerEndMs = controllerNow();
  const observation = await receiver.evaluate('window.__transferBaseline.snapshot()');
  if (observation.error || !observation.verified || observation.bytes !== bytes || observation.closedFiles !== 1 || observation.verifiedFiles !== 1) {
    throw new Error('file-verification-failed');
  }
  await sender.waitFor("document.querySelector('#xfer-label-send')?.closest('.xfer').classList.contains('ok')", 'sender completion', 60_000);
  // The sample is emitted synchronously with the COMPLETE step; allow the CDP
  // round trip, never a protocol wait.
  for (let i = 0; i < 20; i++) {
    const [a, b] = [await sender.evaluate('window.__relayiumRelayDiagnostics.peek()'), await receiver.evaluate('window.__relayiumRelayDiagnostics.peek()')];
    if ((a.hasSample && b.hasSample) || a.stray.thrown || b.stray.thrown) break;
    await sleep(100);
  }
  const transport = checkedTransport(await sender.evaluate('window.__transferTransport.finish()'),
    await receiver.evaluate('window.__transferTransport.finish()'), bytes);
  const route = { sender: checkedRelayRoute(transport.sender), receiver: checkedRelayRoute(transport.receiver) };
  const after = await settledCounters();
  const turn = checkedCounterDelta(before, after, bytes);
  const sendSample = checkedSample(await sender.evaluate('window.__relayiumRelayDiagnostics.take()'), { dir: 'send', bytes });
  const recvSample = checkedSample(await receiver.evaluate('window.__relayiumRelayDiagnostics.take()'), { dir: 'recv', bytes });
  const endToEnd = endToEndSpans({ controllerStartMs, controllerEndMs, receiver: observation });
  const missing = !sendSample.present || !recvSample.present;
  const strip = s => { if (!s.present) return null; const { present, dir, ...rest } = s; return rest; };
  return { ...row, outcome: missing ? 'missing' : 'clean', verified: true, route, turn, endToEnd,
    timing: { sender: strip(sendSample), receiver: strip(recvSample) },
    missing: { sender: sendSample.present ? null : sendSample.reason, receiver: recvSample.present ? null : recvSample.reason },
    transport: { senderCandidatePairBytesSent: transport.sender.candidatePair.bytesSent,
      receiverCandidatePairBytesReceived: transport.receiver.candidatePair.bytesReceived,
      senderLatestStunRttMs: transport.sender.candidatePair.latestStunRttMs,
      senderFileChannelMaxBufferedAfterSendBytes: transport.sender.channels.relayium.maxAfterSendBufferedBytes,
      senderFileChannelSampledMaxBufferedBytes: transport.sender.channels.relayium.sampled.maxBytes,
      senderSamplingMaxGapMs: transport.sender.sampling.maxGapMs } };
}

async function run() {
  const git = gitIn;
  report.provenance = { sourceCommit: git('rev-parse', 'HEAD'), node: process.version,
    bundleTreeSha256: JSON.parse(readFileSync(join(opts.bundle, MARKER_FILE), 'utf8')).fingerprint.sha256,
    dirtyInputCount: git('status', '--porcelain').split('\n').filter(Boolean).length };
  const previewPort = await freePort(), debugPort = await freePort();
  preview = await startPreview({ port: previewPort, distDir: opts.bundle, cwd: web });
  const launched = await launchBrowser({ debugPort });
  browser = launched.browser; closeBrowser = launched.close;
  const version = (await browser.send('Browser.getVersion')).product ?? '';
  report.provenance.browserMajor = Number(/\/(\d+)\./.exec(version)?.[1] ?? NaN) || null;
  const common = VERIFY_DEFAULT + apiFixtureScript(routes) + `;(${installProbe.toString()})();`
    + `;(${installTransportProbe.toString()})(window, ${JSON.stringify({ labels: TRANSPORT_LABELS, intervalMs: TRANSPORT_INTERVAL_MS, relayProtocol: true })});`
    + `;(${installRelayDiagnosticsProbe.toString()})(window, ${JSON.stringify({ throwOnSample: opts.control === 'observer-throws' })});`;
  const room = `${preview.base}/cross-network#c=${ROOM_CODE}`;
  const a = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: 'aaaa1111', name: 'Relay A' }));
  const b = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: 'bbbb2222', name: 'Relay B' }));
  const setupBefore = counters();
  await a.waitFor("!!document.querySelector('.open-workspace')", 'pair-room peer');
  const setupStart = controllerNow();
  await a.evaluate("(() => { document.querySelector('.open-workspace').click(); return true; })()");
  try {
    for (const tab of [a, b]) {
      await tab.waitFor("!!document.querySelector('.workspace-head') && document.querySelector('.msgpanel .attach-file')?.disabled === false", 'workspace link', 45_000);
    }
  } catch (error) { privately('setup', error); throw new Error('link-setup-failed'); }
  const setupEnd = controllerNow();
  const setupAfter = await settledCounters();
  checkedCounterDelta(setupBefore, setupAfter, 0); // monotonic, same helper, before any delta is read
  report.setup = { controllerOpenToBothWorkspacesUpperBoundMs: setupEnd - setupStart,
    turnAllocations: { udp: setupAfter.allocations.udp - setupBefore.allocations.udp, tcp: setupAfter.allocations.tcp - setupBefore.allocations.tcp,
      unknown: setupAfter.allocations.unknown - setupBefore.allocations.unknown },
    turnAuthRejected: setupAfter.authRejected - setupBefore.authRejected };
  for (const tab of [a, b]) {
    await tab.evaluate(`(() => { const ask=document.querySelector('.msgpanel .req'); if (ask) document.querySelector('.msgpanel .act button.btn-primary').click(); })()`);
    await tab.waitFor("!!document.querySelector('.msgpanel textarea')", 'message consent settled');
  }
  if (opts.control === 'slow-receiver') {
    const fast = [], slow = [];
    // Warmups first and excluded: the first batch on a fresh link has been
    // seen to take seconds regardless of the receiver (cause not established).
    for (let i = 0; i < opts.warmups; i++) report.rows.push(await oneBatch(a, b, 'A→B', i, true, 0));
    for (let i = 0; i < opts.samples; i++) fast.push(await oneBatch(a, b, 'A→B', i, false, 0));
    for (let i = 0; i < opts.samples; i++) slow.push(await oneBatch(a, b, 'A→B', opts.samples + i, false, opts.writeDelayMs));
    report.rows.push(...fast, ...slow);
    if (report.rows.some(r => r.outcome !== 'clean')) throw new Error('sample-missing');
    const median = rows => quantiles(rows.map(r => r.timing.sender.creditWaitMs), 'ms').median;
    report.controlEvidence = { fastSenderCreditWaitMedianMs: median(fast), slowSenderCreditWaitMedianMs: median(slow),
      requiredIncreaseMs: 500 };
    if (!(median(slow) - median(fast) >= 500)) throw new Error('credit-wait-not-responding');
    report.status = 'PASS';
    report.controlOutcome = { observed: 'credit-wait-responded' };
    return;
  }
  for (let round = -opts.warmups; round < opts.samples; round++) {
    for (const [direction, from, to] of [['A→B', a, b], ['B→A', b, a]]) {
      const row = await oneBatch(from, to, direction, Math.abs(round), round < 0, opts.writeDelayMs);
      report.rows.push(row);
      if (row.outcome === 'cancelled') { report.controlOutcome = { observed: 'cancelled-no-clean-sample' }; throw new Error('cancelled-no-clean-sample'); }
      if (row.outcome === 'missing') {
        const reason = row.missing.sender === 'observer-threw' || row.missing.receiver === 'observer-threw' ? 'sample-missing-observer-threw' : 'sample-missing';
        throw new Error(reason);
      }
      if (opts.control) break;
    }
    if (opts.control) break;
  }
  if (a.errors.length || b.errors.length) { privately('browser', [...a.errors, ...b.errors].join('; ')); throw new Error('browser-error'); }
  report.summary = summarize(report.rows);
  report.status = 'PASS';
}

let exitCode = 1;
try {
  await Promise.race([run(), new Promise((_, reject) => {
    deadline = setTimeout(() => { timedOut = true; reject(new Error('deadline')); }, 20 * 60_000);
  })]);
} catch (error) {
  privately('run', error);
  report.status = 'FAIL'; report.summary = null;
  report.failureReason = classify(error);
} finally {
  clearTimeout(deadline);
  try { if (closeBrowser) await closeBrowser(); } catch (error) { privately('browser-close', error); report.status = 'FAIL'; report.failureReason = 'harness-error'; }
  try { if (preview) await preview.stop(); } catch (error) { privately('preview-close', error); report.status = 'FAIL'; report.failureReason = 'harness-error'; }
  report.finishedAt = new Date().toISOString();
  if (report.status !== 'PASS') report.summary = null;
  if (opts.control) {
    const expected = CONTROL_EXPECTATIONS[opts.control];
    const observed = report.status === 'PASS' ? report.controlOutcome?.observed ?? null : report.failureReason;
    report.controlOutcome = { expected, observed, verdict: observed === expected ? 'CONTROL_EXPECTED' : 'CONTROL_UNEXPECTED' };
    if (opts.control === 'wrong-credential' && observed === expected) {
      const final = counters();
      report.controlOutcome.turnAuthRejectedTotal = final.authRejected;
      if (!(final.authRejected > 0)) report.controlOutcome.verdict = 'CONTROL_UNEXPECTED';
    }
    exitCode = report.controlOutcome.verdict === 'CONTROL_EXPECTED' ? 0 : 1;
  } else exitCode = report.status === 'PASS' ? 0 : 1;
  report.semantics = SAMPLE_SEMANTICS;
  let text;
  try {
    checkedReport(report);
    text = JSON.stringify(report, null, 2) + '\n';
    assertPrivate(text, [secret, credential.username, credential.credential, ROOM_CODE]);
  } catch (error) {
    privately('report-privacy', error);
    text = JSON.stringify({ schema: REPORT_SCHEMA, status: 'FAIL', failureReason: 'harness-error', privacyRefused: true }, null, 2) + '\n';
    exitCode = 1;
    report.status = 'FAIL'; report.failureReason = 'harness-error (report privacy check refused)'; report.controlOutcome = undefined;
  }
  writeFileSync(opts.out, text, { flag: 'wx' });
  console.log(`${report.status}${report.failureReason ? ` (${report.failureReason})` : ''}${report.controlOutcome ? ` control ${report.controlOutcome.verdict}` : ''}: ${opts.out}`);
}
process.exit(exitCode);
