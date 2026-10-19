#!/usr/bin/env node
/** Local Chrome/real WebRTC baseline, not a WAN or physical-disk benchmark.
 * npm run build && npm run bench:transfer -- --out /absolute/new-report.json
 * No signed-in account, provider, production endpoint or product flag. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newTab, startPreview, sleep, VERIFY_ON } from './harness.mjs';
import { apiFixtureScript } from './a11y-fixtures.mjs';
import { CODE_ROOM_ROUTES, codeRoomSignalingScript } from './code-room-fixture.mjs';
import { CASES, options, installProbe, checkedSample, summarize, distribution } from './transfer-performance-core.mjs';
import { fixtureBytes, pairedManifest } from './transfer-fixture.mjs';
import { installPhaseProbe, checkedPhases } from './transfer-phase-probe.mjs';
import { installTransportProbe, checkedTransport, summarizeTransport, TRANSPORT_LABELS, TRANSPORT_INTERVAL_MS, TRANSPORT_PROBE_VERSION } from './transfer-transport-probe.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const opts = options(process.argv.slice(2));
opts.out = resolve(opts.out);
if (existsSync(opts.out)) throw new Error(`refusing to overwrite ${opts.out}`);
const report = { schema: 'relayium-browser-transfer-baseline/1', status: 'IN_PROGRESS', startedAt: new Date().toISOString(),
  scope: { transport: 'Chrome host-candidate loopback WebRTC', signaling: 'code-room BroadcastChannel fixture; empty ICE',
    destination: 'in-memory picker replacement; no physical disk/fsync/export', clock: 'performance.timeOrigin + performance.now across same-browser contexts',
    start: 'file selection change dispatch / text send click; fixture preparation excluded',
    end: 'all files closed + full SHA-256 verified + receiver success UI; text rendered byte-exact + SHA-256',
    consent: 'automatic consent at observed request; no human think time',
    hash: 'async observer runs alongside product; its latency and CPU are included in verified-ready time',
    percentiles: 'empirical nearest-rank P95, emitted only for n >= 20; no confidence interval or speedup claim',
    exclusions: ['WAN/TURN', 'server admission', 'physical persistence', 'native clients', 'stored upload', 'separate read/encrypt/network CPU attribution'] },
  configuration: opts, provenance: {}, setup: {}, samples: [], summary: null };
if (opts.phases) {
  report.schema = 'relayium-browser-transfer-baseline/2';
  report.scope.phases = 'instrumented Blob reads on sender only; AES-GCM encrypt/decrypt on both peers including control frames; async API wall time including scheduling/wrapper cost, not CPU; overlapping totals must not be added or subtracted from end-to-end time; no network/wait attribution';
}
if (opts.transport) {
  report.schema = 'relayium-browser-transfer-baseline/3';
  report.scope.transportProbe = { version: TRANSPORT_PROBE_VERSION, labels: TRANSPORT_LABELS, samplingIntervalMs: TRANSPORT_INTERVAL_MS,
    queue: 'RTCDataChannel.bufferedAmount read in the same task after each observed send (peak of the JS-visible value only) and by setInterval polling; poll maxGapMs is the largest observed gap including arm→first and last→finish, so sampled maxima are lower bounds; background-tab timer throttling can widen gaps; any failed observation fails the run without altering the native send',
    candidatePair: 'numeric deltas of one selected candidate pair (transport.selectedCandidatePairId; only when no transport states a selection, the single nominated succeeded pair) between getStats() snapshots taken before the measured start and after completion; bytesSent/bytesReceived are candidate-pair payload bytes excluding packet headers, padding and ICE connectivity checks, which may include DTLS/SCTP and application control traffic, not file bytes; snapshots may be cached and bracket more than the transfer',
    selectionIdentity: 'the same transport, pair and local/remote candidates are required at both boundaries; when the browser supplies transport.selectedCandidatePairChanges it must be equal at both boundaries, otherwise (absent at both) only boundary identity is checked and a switch away and back between the snapshots would not be detected; any mismatch, partial or malformed value FAILS the run',
    rtt: 'latestStunRttMs is currentRoundTripTime of the latest STUN connectivity/consent check at the after snapshot, converted to ms; it may predate the file and is null when not supplied (a supplied 0 is kept); meanStunRttMs uses only responses received between the snapshots, else null',
    meaning: 'No credit-wait, queueing-time, network-exclusive, CPU, capacity or physical-disk attribution; statistics are asynchronous snapshots, not causal bottleneck proof; observation and polling can perturb timing; local loopback only, no WAN claim' };
}
// Built once, before any browser starts; refuses collisions/unequal totals/non-concatenation.
const paired = opts.cases.some(kind => CASES[kind].fixture)
  ? pairedManifest(CASES.small1000.files, CASES.small1000.bytes, CASES.concat1000.bytes) : null;
if (paired) {
  const { many, single, ...identity } = paired;
  report.fixture = { ...identity, generator: 'byte k of the workload = low byte of a fixture-specific 32-bit mix (not canonical murmur3 fmix32): x = imul(k XOR 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = imul(x, 0xc2b2ae35); x ^= x >>> 16; small1000 file i = bytes [1024i, 1024i+1024); concat1000 = bytes [0, 1024000)' };
  report.scope.smallFiles = 'small1000 (1000 x 1024 B, exactly the product MAX_FILES) vs concat1000 (1 x 1,024,000 B, their exact concatenation) over the same reused link; every file is fully SHA-256 verified, so observer/hash/UI overhead grows with file count and is INCLUDED: workload evidence only, not per-file product cost, setup, CPU, disk or WAN attribution';
}
let browser, closeBrowser, preview, deadline, timedOut = false;

async function freePort(port) {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
}
function buildFingerprint(root) {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else { hash.update(path.slice(root.length + 1)); hash.update('\0'); hash.update(sha(readFileSync(path))); hash.update('\n'); }
    }
  }
  walk(root); return hash.digest('hex');
}
function specification(kind, token) {
  const { files, bytes, fixture } = CASES[kind], expected = {};
  for (let index = 0; index < files; index++) {
    const name = `baseline-${token}-${String(index).padStart(3, '0')}.bin`;
    if (fixture) {
      const row = kind === 'concat1000' ? paired.single : paired.many[index];
      expected[name] = { bytes: row.bytes, sha256: row.sha256 };
      continue;
    }
    const body = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) body[i] = (i * 37 + index * 13 + 11) % 251;
    expected[name] = { bytes, sha256: sha(body) };
  }
  const names = Object.keys(expected);
  if (opts.control) expected[names[opts.control === 'last' ? names.length - 1 : 0]].sha256 = '0'.repeat(64);
  const text = `baseline ${token}: 你好 🌍  \t\n`;
  return { kind, expected, text, expectedTextBytes: Buffer.byteLength(text), expectedTextHash: sha(text), writeDelayMs: opts.writeDelayMs };
}
async function oneSample(sender, receiver, kind, direction, iteration, warmup) {
  if (timedOut) throw new Error('benchmark deadline reached');
  const token = `${kind}-${direction === 'A→B' ? 'ab' : 'ba'}-${warmup ? 'w' : 'm'}${String(iteration).padStart(3, '0')}`;
  const spec = specification(kind, token);
  await receiver.evaluate(`window.__transferBaseline.arm(${JSON.stringify(spec)})`);
  if (kind === 'text') {
    // Two alternating peers stay below the unchanged 5/s receiver flood guard.
    // Experiment cadence is outside the measured send-click → verified interval.
    await sleep(opts.textSpacingMs);
    await sender.evaluate(`(() => {
      const input = document.querySelector('.msgpanel textarea');
      if (!input) throw new Error('missing text composer');
      input.value = ${JSON.stringify(spec.text)};
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sender.waitFor("document.querySelector('.msgpanel button.send')?.disabled === false", 'text send enabled');
  } else {
    // Construct synthetic Files before the measured selection event.
    await sender.evaluate(CASES[kind].fixture ? `(() => {
      const dt = new DataTransfer(), fixtureBytes = ${fixtureBytes.toString()};
      Object.keys(${JSON.stringify(spec.expected)}).forEach((name, index) => {
        dt.items.add(new File([fixtureBytes(index * ${CASES[kind].bytes}, ${CASES[kind].bytes})], name));
      });
      window.__baselineFiles = dt;
    })()` : `(() => {
      const dt = new DataTransfer();
      Object.keys(${JSON.stringify(spec.expected)}).forEach((name, index) => {
        const bytes = new Uint8Array(${CASES[kind].bytes});
        for (let i=0; i<bytes.length; i++) bytes[i]=(i*37+index*13+11)%251;
        dt.items.add(new File([bytes], name));
      });
      window.__baselineFiles = dt;
    })()`);
    await sender.waitFor("document.querySelector('.msgpanel .attach-file')?.disabled === false", 'file selection enabled');
  }
  if (opts.phases && kind !== 'text') {
    await sender.evaluate(`window.__transferPhases.arm('sender', ${JSON.stringify(opts.phaseDelay ?? null)})`);
    await receiver.evaluate("window.__transferPhases.arm('receiver')");
  }
  if (opts.transport && kind !== 'text') {
    await sender.evaluate("window.__transferTransport.arm('sender')");
    await receiver.evaluate("window.__transferTransport.arm('receiver')");
  }
  const startAt = await sender.evaluate(kind === 'text' ? `(() => {
    const start = performance.timeOrigin + performance.now();
    document.querySelector('.msgpanel button.send').click(); return start;
  })()` : `(() => {
    const input = document.querySelector('.msgpanel .attach-file');
    const start = performance.timeOrigin + performance.now();
    input.files = window.__baselineFiles.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    window.__baselineFiles = null; return start;
  })()`);
  await receiver.waitFor('window.__transferBaseline.snapshot().ready || !!window.__transferBaseline.snapshot().error', `${kind} verified receiver completion`, 90_000);
  const observation = await receiver.evaluate('window.__transferBaseline.snapshot()');
  // Sender completion is an extra assertion, never a substitute for file hashes.
  if (kind !== 'text') await sender.waitFor("document.querySelector('#xfer-label-send')?.closest('.xfer').classList.contains('ok')", 'sender completion');
  let phaseObservation, transportObservation;
  try {
    const sample = checkedSample({ kind, direction, iteration, warmup, startAt, observation });
    if (opts.phases && kind !== 'text') {
      phaseObservation = { sender: await sender.evaluate('window.__transferPhases.snapshot()'),
        receiver: await receiver.evaluate('window.__transferPhases.snapshot()') };
      sample.phases = checkedPhases(await sender.evaluate('window.__transferPhases.finish()'),
        await receiver.evaluate('window.__transferPhases.finish()'), sample.bytes);
      if (opts.phaseDelay) {
        const row = sample.phases.sender[opts.phaseDelay.phase];
        if (row.delayCalls !== 1 || row.delayElapsedMs < opts.phaseDelay.ms - 1) throw new Error('phase delay control not observed');
      }
    }
    if (opts.transport && kind !== 'text') {
      transportObservation = { sender: await sender.evaluate('window.__transferTransport.finish()') };
      transportObservation.receiver = await receiver.evaluate('window.__transferTransport.finish()');
      sample.transport = checkedTransport(transportObservation.sender, transportObservation.receiver, sample.bytes);
      sample.transportRaw = transportObservation;
    }
    return sample;
  }
  catch (error) {
    report.failedSample = { kind, direction, iteration, warmup, startAt, observation, phaseObservation, transportObservation };
    throw error;
  }
}
async function run() {
  if (!existsSync(join(web, 'dist/index.html'))) throw new Error('missing default build; run npm run build first');
  const git = (...args) => execFileSync('git', args, { cwd: web, encoding: 'utf8' }).trim();
  const changed = git('ls-files', '-m', '-o', '--exclude-standard').split('\n').filter(Boolean);
  report.provenance = { sourceCommit: git('rev-parse', 'HEAD'), dirtyInputs: Object.fromEntries(changed.map(p => [p, sha(readFileSync(join(web, p)))])),
    distSha256: buildFingerprint(join(web, 'dist')), node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length };
  // Never run the harness's stale-process cleanup against an occupied port.
  await freePort(9476); await freePort(4196);
  preview = await startPreview({ port: 4196, cwd: web });
  const launched = await launchBrowser({ debugPort: 9476 });
  browser = launched.browser; closeBrowser = launched.close;
  report.provenance.browser = await browser.send('Browser.getVersion');
  const common = VERIFY_ON + apiFixtureScript(CODE_ROOM_ROUTES) + `;(${installProbe.toString()})();`
    + (opts.phases ? `;(${installPhaseProbe.toString()})();` : '')
    + (opts.transport ? `;(${installTransportProbe.toString()})(window, ${JSON.stringify({ labels: TRANSPORT_LABELS, intervalMs: TRANSPORT_INTERVAL_MS })});` : '');
  const room = `${preview.base}/cross-network#c=927461`;
  const a = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: 'aaaa1111', name: 'Baseline A' }));
  const b = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: 'bbbb2222', name: 'Baseline B' }));
  await a.waitFor("!!document.querySelector('.open-workspace')", 'pair-room peer');
  const setupStart = await a.evaluate("(() => { const start = performance.timeOrigin + performance.now(); document.querySelector('.open-workspace').click(); return start; })()");
  for (const tab of [a, b]) await tab.waitFor('!!window.__transferBaseline.linkReadyAt', 'workspace link');
  report.setup = { count: 1, scope: 'open-workspace click to both observed SAS headers, before message consent; not page load or code mint',
    openToBothHeadersMs: Math.max(await a.evaluate('window.__transferBaseline.linkReadyAt'), await b.evaluate('window.__transferBaseline.linkReadyAt')) - setupStart };
  for (const tab of [a, b]) {
    await tab.evaluate(`(() => { const ask=document.querySelector('.msgpanel .req'); if (ask) document.querySelector('.msgpanel .act button.btn-primary').click(); })()`);
    await tab.waitFor("!!document.querySelector('.msgpanel textarea')", 'message consent settled');
  }
  const sas = [];
  for (const tab of [a, b]) sas.push(await tab.evaluate("document.querySelector('.workspace-head .sas code').textContent"));
  if (sas[0] !== sas[1]) throw new Error('link verification codes differ');
  for (const kind of opts.cases) {
    for (let round = -opts.warmups; round < opts.samples; round++) {
      for (const [direction, from, to] of [['A→B', a, b], ['B→A', b, a]]) {
        report.samples.push(await oneSample(from, to, kind, direction, Math.abs(round), round < 0));
      }
      if (round % 5 === 0) console.log(`${kind}: ${round < 0 ? 'warmup' : `${round + 1}/${opts.samples}`} both directions verified`);
    }
  }
  if (a.errors.length || b.errors.length) throw new Error(`browser errors: ${[...a.errors, ...b.errors].join('; ')}`);
  report.summary = summarize(report.samples, opts.cases, opts.samples);
  if (opts.phases) {
    report.phaseSummary = {};
    for (const kind of opts.cases.filter(k => k !== 'text')) for (const direction of ['A→B', 'B→A']) {
      const rows = report.samples.filter(s => !s.warmup && s.kind === kind && s.direction === direction);
      report.phaseSummary[`${kind}/${direction}`] = Object.fromEntries(['sender', 'receiver'].map(role => [role,
        Object.fromEntries(['read', 'encrypt', 'decrypt'].map(phase => [phase,
          distribution(rows.map(s => s.phases[role][phase].totalMs))]))]));
    }
  }
  if (opts.transport) {
    report.transportSummary = {};
    for (const kind of opts.cases.filter(k => k !== 'text')) for (const direction of ['A→B', 'B→A']) {
      report.transportSummary[`${kind}/${direction}`] = summarizeTransport(report.samples.filter(s => !s.warmup && s.kind === kind && s.direction === direction));
    }
  }
  report.status = 'PASS';
}

try {
  // Race throws into finally so the owned browser/preview close on failure too.
  await Promise.race([run(), new Promise((_, reject) => {
    deadline = setTimeout(() => { timedOut = true; reject(new Error('15 minute benchmark deadline')); }, 15 * 60_000);
  })]);
} catch (error) {
  report.status = 'FAIL'; report.summary = null; report.failure = error.message;
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { if (closeBrowser) await closeBrowser(); } catch (error) { report.status = 'FAIL'; report.failure = `browser close: ${error.message}`; process.exitCode = 1; }
  try { if (preview) await preview.stop(); } catch (error) { report.status = 'FAIL'; report.failure = `preview close: ${error.message}`; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  if (report.status !== 'PASS') { report.summary = null; if (opts.phases) report.phaseSummary = null; if (opts.transport) report.transportSummary = null; }
  writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`${report.status}: ${opts.out}${report.failure ? ` (${report.failure})` : ''}`);
}
// CDP evaluate watchdog promises need not keep a completed, closed run alive.
process.exit(process.exitCode ?? 0);
