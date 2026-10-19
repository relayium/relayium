/** Opt-in benchmark-only WebRTC transport observation; never imported by the
 * product bundle. It records counts, byte totals, sampled queue occupancy and
 * numeric candidate-pair counters. It never records payloads, SDP, addresses,
 * ports, candidate/pair/transport IDs, keys, credentials or URLs.
 *
 * What it does NOT measure: time spent waiting on application credit, time a
 * frame spent queued, network-exclusive time, CPU or physical disk. getStats()
 * returns asynchronous snapshots (a browser may serve a recently cached
 * report). Candidate-pair bytesSent/bytesReceived are that pair's payload
 * bytes, excluding packet headers, padding and ICE connectivity checks; they
 * may include DTLS/SCTP and application control traffic and are not file
 * bytes. Sampling runs on the page's event loop and may perturb timing. */

export const TRANSPORT_PROBE_VERSION = 2;
export const TRANSPORT_LABELS = ['relayium', 'relayium-text'];
export const TRANSPORT_INTERVAL_MS = 10;
const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'];
const PROTOCOLS = ['udp', 'tcp'];
const REQUIRED_COUNTERS = ['timestamp', 'bytesSent', 'bytesReceived'];
const OPTIONAL_COUNTERS = ['packetsSent', 'packetsReceived', 'responsesReceived', 'totalRoundTripTime', 'currentRoundTripTime'];

/** Injected into each page before the product loads, as
 * `(${installTransportProbe})(window, { labels, intervalMs })`, so it must stay
 * self-contained: no closure over this module's constants. */
export function installTransportProbe(env = globalThis, config = {}) {
  if (env.__transferTransport) throw new Error('transport probe already installed');
  const labels = config.labels, intervalMs = config.intervalMs;
  if (!Array.isArray(labels) || !labels.length || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) throw new Error('invalid transport probe configuration');
  const Peer = env.RTCPeerConnection, Channel = env.RTCDataChannel;
  if (typeof Peer !== 'function' || typeof Peer.prototype?.createDataChannel !== 'function'
    || typeof Channel?.prototype?.send !== 'function') throw new Error('missing observed WebRTC API');
  // Repeated here (not closed over) so the function survives toString injection.
  const VERSION = 2;
  const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'], PROTOCOLS = ['udp', 'tcp'];
  const REQUIRED_COUNTERS = ['timestamp', 'bytesSent', 'bytesReceived'];
  const OPTIONAL_COUNTERS = ['packetsSent', 'packetsReceived', 'responsesReceived', 'totalRoundTripTime', 'currentRoundTripTime'];
  const clock = () => env.performance.now();
  const encoder = new TextEncoder();
  const peers = new Set();
  const lanes = new WeakMap(); // peer -> Set<channel>, never exported
  const own = (peer, channel) => {
    if (!channel) return;
    if (!lanes.has(peer)) lanes.set(peer, new Set());
    lanes.get(peer).add(channel);
  };
  env.RTCPeerConnection = new Proxy(Peer, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      peers.add(peer);
      // A listener, not the on-handler: the product's own ondatachannel stays
      // the product's, and this only learns which peer owns the inbound lane.
      peer.addEventListener('datachannel', event => own(peer, event.channel));
      return peer;
    },
  });
  const create = Peer.prototype.createDataChannel;
  Peer.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args);
    own(this, channel);
    return channel;
  };
  const size = data => typeof data === 'string' ? encoder.encode(data).byteLength
    : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data.byteLength
    : typeof env.Blob === 'function' && data instanceof env.Blob ? data.size : null;
  const queued = channel => {
    const value = channel.bufferedAmount;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid bufferedAmount');
    return value;
  };

  let state = 'idle', token = null, active = null, timer = null;
  const stopTimer = () => { if (timer !== null) env.clearInterval(timer); timer = null; };
  const send = Channel.prototype.send;
  Channel.prototype.send = function (...args) {
    const w = active;
    if (!w) return send.apply(this, args);
    // Every observation is fenced off: a failing size/queue read is counted
    // and fails the sample later, but never replaces the native call's
    // result or exception, and never prevents the native call.
    let row, bytes = null;
    try {
      row = w.rows.get(this);
      if (!row) w.unboundSendCalls++;
      else { row.sendCalls++; bytes = size(args[0]); }
    } catch { w.observationFailures++; row = undefined; }
    if (!row) return send.apply(this, args);
    let result;
    try { result = send.apply(this, args); }
    catch (error) {
      try { row.sendThrows++; } catch { /* plain counter */ }
      throw error;
    }
    try {
      if (bytes === null) row.unknownPayloads++; else row.sendBytes += bytes;
      // Read in the same task as the enqueue: the JS-visible occupancy only
      // falls between sends, so this is the peak of that value; it is still
      // not the SCTP/socket queue and says nothing about how long bytes waited.
      const value = queued(this);
      if (value > row.maxAfterSendBufferedBytes) row.maxAfterSendBufferedBytes = value;
    } catch { w.observationFailures++; }
    return result;
  };
  const tick = () => {
    const w = active;
    if (!w) return;
    try {
      const now = clock();
      w.maxGapMs = Math.max(w.maxGapMs, now - w.lastTickAt);
      w.lastTickAt = now; w.tickCount++;
      for (const [channel, row] of w.rows) {
        const value = queued(channel);
        row.sampled.count++; row.sampled.sumBytes += value;
        if (value > 0) row.sampled.nonzero++;
        if (value > row.sampled.maxBytes) row.sampled.maxBytes = value;
      }
    } catch {
      // A broken sampler stops itself; finish() then refuses the sample.
      w.observationFailures++; w.samplerStopped = true; stopTimer();
    }
  };
  /** Absent (undefined/null) supported optionals are null; anything supplied
   * must be a finite non-negative number — never coerced to "absent". */
  const metric = (row, key, required) => {
    const value = row[key];
    if (value === undefined || value === null) {
      if (required) throw new Error(`missing candidate-pair ${key}`);
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`malformed candidate-pair ${key}`);
    return value;
  };
  const pick = stats => {
    const rows = [];
    stats.forEach(row => rows.push(row));
    // Any transport that states a selection field takes part; a malformed or
    // dangling explicit selection refuses instead of falling back to a guess.
    const transports = rows.filter(r => r.type === 'transport' && r.selectedCandidatePairId !== undefined && r.selectedCandidatePairId !== null);
    let pair, method, transportRow = null;
    if (transports.length > 1) throw new Error('ambiguous selected transports');
    if (transports.length === 1) {
      transportRow = transports[0];
      const id = transportRow.selectedCandidatePairId;
      if (typeof id !== 'string' || id === '') throw new Error('malformed selectedCandidatePairId');
      pair = stats.get(id);
      method = 'transport.selectedCandidatePairId';
    } else {
      // A report without any transport selection: accept only the single
      // nominated succeeded pair, never a choice among several.
      const qualifying = rows.filter(r => r.type === 'candidate-pair' && r.nominated === true && r.state === 'succeeded');
      if (qualifying.length !== 1) throw new Error('no uniquely selected candidate pair');
      pair = qualifying[0]; method = 'unique-nominated-succeeded';
    }
    // The transport's own selection is authoritative whatever the pair's
    // `state` says. R1 saw one real run refuse a selected pair on state; the
    // exact state was not captured, so no cause is claimed here.
    if (pair?.type !== 'candidate-pair') throw new Error('selected candidate pair missing');
    const end = (id, type) => {
      const c = stats.get(id);
      if (c?.type !== type || !CANDIDATE_TYPES.includes(c.candidateType) || !PROTOCOLS.includes(c.protocol)) throw new Error(`invalid ${type}`);
      return { candidateType: c.candidateType, protocol: c.protocol };
    };
    const counters = {};
    for (const key of REQUIRED_COUNTERS) counters[key] = metric(pair, key, true);
    for (const key of OPTIONAL_COUNTERS) counters[key] = metric(pair, key, false);
    let pairChanges = null;
    if (transportRow) {
      const value = transportRow.selectedCandidatePairChanges;
      if (value !== undefined && value !== null) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('malformed selectedCandidatePairChanges');
        pairChanges = value;
      }
    }
    return { identity: [transportRow?.id ?? null, pair.id, pair.localCandidateId, pair.remoteCandidateId].join('\n'),
      selection: { method, local: end(pair.localCandidateId, 'local-candidate'), remote: end(pair.remoteCandidateId, 'remote-candidate') },
      counters, pairChanges };
  };
  const poison = mine => { if (token === mine) { state = 'failed'; active = null; stopTimer(); } };

  env.__transferTransport = {
    async arm(role) {
      if (state !== 'idle') throw new Error(`transport probe cannot arm while ${state}`);
      if (!['sender', 'receiver'].includes(role)) throw new Error('invalid transport role');
      const mine = {}; token = mine; state = 'arming';
      try {
        const live = [...peers].filter(p => p.connectionState === 'connected');
        if (live.length !== 1) throw new Error(`expected exactly one connected peer, found ${live.length}`);
        const peer = live[0], rows = new Map();
        for (const label of labels) {
          const found = [...(lanes.get(peer) ?? [])].filter(c => c.label === label && c.readyState === 'open');
          if (found.length !== 1) throw new Error(`expected one open ${label} channel`);
          rows.set(found[0], { label, sendCalls: 0, sendBytes: 0, sendThrows: 0, unknownPayloads: 0,
            atArmBufferedBytes: queued(found[0]), maxAfterSendBufferedBytes: 0, atFinishBufferedBytes: null,
            sampled: { count: 0, nonzero: 0, maxBytes: 0, sumBytes: 0 } });
        }
        const before = pick(await peer.getStats());
        if (token !== mine || state !== 'arming') throw new Error('stale transport arm');
        const now = clock();
        active = { role, peer, rows, before, armedAt: now, lastTickAt: now, maxGapMs: 0, tickCount: 0,
          unboundSendCalls: 0, observationFailures: 0, samplerStopped: false };
        timer = env.setInterval(tick, intervalMs);
        state = 'armed';
      } catch (error) { poison(mine); throw error; }
    },
    async finish() {
      if (state !== 'armed') throw new Error(`transport probe cannot finish while ${state}`);
      const w = active, mine = token;
      // Stop observing before the asynchronous snapshot, whatever happens next;
      // the after-snapshot still brackets every observed send.
      stopTimer(); active = null; state = 'finishing';
      try {
        const finishedAt = clock();
        w.maxGapMs = Math.max(w.maxGapMs, finishedAt - w.lastTickAt);
        for (const [channel, row] of w.rows) row.atFinishBufferedBytes = queued(channel);
        if (w.observationFailures || w.samplerStopped) throw new Error(`transport observation failed ${w.observationFailures} time(s)`);
        if (w.peer.connectionState !== 'connected') throw new Error('peer left connected state during sample');
        const after = pick(await w.peer.getStats());
        if (token !== mine || state !== 'finishing') throw new Error('stale transport finish');
        if (after.identity !== w.before.identity) throw new Error('selected candidate pair changed during sample');
        if ((w.before.pairChanges === null) !== (after.pairChanges === null)) throw new Error('selectedCandidatePairChanges present at only one boundary');
        if (after.pairChanges !== w.before.pairChanges) throw new Error('selected candidate pair changed during sample (selectedCandidatePairChanges)');
        const channels = {};
        for (const row of w.rows.values()) { const { label, ...rest } = row; channels[label] = rest; }
        state = 'idle'; token = null;
        return { version: VERSION, role: w.role, selection: w.before.selection,
          counters: { before: w.before.counters, after: after.counters },
          pairChanges: { before: w.before.pairChanges, after: after.pairChanges },
          sampling: { intervalMs, windowMs: finishedAt - w.armedAt, tickCount: w.tickCount, maxGapMs: w.maxGapMs },
          channels, unboundSendCalls: w.unboundSendCalls, observationFailures: w.observationFailures };
      } catch (error) { poison(mine); throw error; }
    },
    /** Invalidates any pending arm/finish and stops sampling; stays poisoned. */
    abort() { token = null; state = 'failed'; active = null; stopTimer(); },
    state: () => state,
  };
}

const int = v => Number.isSafeInteger(v) && v >= 0;
const finite = v => Number.isFinite(v) && v >= 0;

function checkedRole(value, role, intervalMs) {
  if (value?.version !== TRANSPORT_PROBE_VERSION || value.role !== role) throw new Error(`missing ${role} transport observation`);
  const s = value.selection;
  if (!['transport.selectedCandidatePairId', 'unique-nominated-succeeded'].includes(s?.method)
    || ![s.local, s.remote].every(e => CANDIDATE_TYPES.includes(e?.candidateType) && PROTOCOLS.includes(e?.protocol))) throw new Error(`invalid ${role} selection`);
  const { before, after } = value.counters ?? {};
  const delta = {};
  // currentRoundTripTime is a gauge, read from the after snapshot only below.
  for (const key of [...REQUIRED_COUNTERS, ...OPTIONAL_COUNTERS].filter(k => k !== 'currentRoundTripTime')) {
    const a = before?.[key], b = after?.[key], required = REQUIRED_COUNTERS.includes(key);
    if (a === null && b === null && !required) { delta[key] = null; continue; }
    if (!finite(a) || !finite(b)) throw new Error(`invalid or partially absent ${role} counter ${key}`);
    if (b < a) throw new Error(`${role} counter ${key} went backwards (reset or different pair)`);
    if (['bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'responsesReceived'].includes(key) && !(int(a) && int(b))) throw new Error(`non-integer ${role} counter ${key}`);
    delta[key] = b - a;
  }
  const changes = value.pairChanges;
  if (!changes || !(changes.before === null && changes.after === null) && !(int(changes.before) && changes.after === changes.before)) throw new Error(`invalid or changed ${role} selectedCandidatePairChanges`);
  if (changes.before !== null && s.method !== 'transport.selectedCandidatePairId') throw new Error(`${role} pair-change count without a transport selection`);
  const p = value.sampling;
  if (p?.intervalMs !== intervalMs || !int(p.tickCount) || !finite(p.windowMs) || !finite(p.maxGapMs) || p.maxGapMs > p.windowMs + 1e-6
    || (p.tickCount === 0 && Math.abs(p.maxGapMs - p.windowMs) > 1e-6)) throw new Error(`invalid ${role} sampling`);
  if (!int(value.unboundSendCalls) || value.unboundSendCalls) throw new Error(`${role} sent on an unobserved channel`);
  if (value.observationFailures !== 0) throw new Error(`${role} transport observation failed`);
  const labels = Object.keys(value.channels ?? {});
  if (labels.sort().join() !== [...TRANSPORT_LABELS].sort().join()) throw new Error(`invalid ${role} channel coverage`);
  let sendBytes = 0;
  for (const label of TRANSPORT_LABELS) {
    const c = value.channels[label], q = c.sampled;
    if (!['sendCalls', 'sendBytes', 'sendThrows', 'unknownPayloads', 'atArmBufferedBytes', 'maxAfterSendBufferedBytes', 'atFinishBufferedBytes'].every(k => int(c[k]))
      || !q || !['count', 'nonzero', 'maxBytes', 'sumBytes'].every(k => int(q[k]))
      || q.count !== p.tickCount || q.nonzero > q.count || q.maxBytes > q.sumBytes || (q.nonzero === 0) !== (q.maxBytes === 0)) throw new Error(`invalid ${role}/${label} channel counters`);
    if (c.unknownPayloads) throw new Error(`${role}/${label} sent an unmeasured payload type`);
    sendBytes += c.sendBytes;
  }
  const rtt = after.currentRoundTripTime;
  if (rtt !== null && !finite(rtt)) throw new Error(`invalid ${role} currentRoundTripTime`);
  // Field names say "candidatePair": these are pair payload counters, not
  // complete wire bytes. A supplied 0 RTT is a legitimate value; absence is null.
  const candidatePair = { statsIntervalMs: delta.timestamp, bytesSent: delta.bytesSent, bytesReceived: delta.bytesReceived,
    packetsSent: delta.packetsSent, packetsReceived: delta.packetsReceived, stunResponsesReceived: delta.responsesReceived,
    meanStunRttMs: delta.responsesReceived > 0 && delta.totalRoundTripTime !== null ? delta.totalRoundTripTime / delta.responsesReceived * 1000 : null,
    latestStunRttMs: rtt === null ? null : rtt * 1000, selectedPairChanges: changes.before };
  if (candidatePair.bytesSent < sendBytes) throw new Error(`${role} candidate-pair bytes do not bracket its own sends`);
  return { selection: s, candidatePair, sampling: p, channels: value.channels, sendBytes };
}

/** Fail closed on absent hooks, partial states, resets and counters that do not
 * bracket the observed sends. `fileBytes` is the verified plaintext size. */
export function checkedTransport(sender, receiver, fileBytes, intervalMs = TRANSPORT_INTERVAL_MS) {
  const out = { sender: checkedRole(sender, 'sender', intervalMs), receiver: checkedRole(receiver, 'receiver', intervalMs) };
  if (out.sender.channels.relayium.sendBytes < fileBytes) throw new Error('sender file channel carried fewer bytes than the file');
  if (out.receiver.candidatePair.bytesReceived < out.sender.sendBytes || out.sender.candidatePair.bytesReceived < out.receiver.sendBytes) throw new Error('peer candidate-pair counters do not bracket the other side\'s sends');
  return out;
}

/** Explicit units: never reuse the millisecond `distribution` field names. */
export function quantiles(values, unit) {
  if (!['bytes', 'ms', 'count'].includes(unit)) throw new Error('invalid unit');
  const present = values.filter(v => v !== null);
  if (present.some(v => !Number.isFinite(v) || v < 0)) throw new Error('invalid transport summary value');
  const a = present.sort((x, y) => x - y), n = a.length;
  return { unit, count: n, nullCount: values.length - n,
    median: n ? (n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2) : null,
    p95: n >= 20 ? a[Math.ceil(n * .95) - 1] : null, min: n ? a[0] : null, max: n ? a[n - 1] : null };
}

export function summarizeTransport(rows) {
  const s = rows.map(r => r.transport.sender), q = s.map(x => x.channels.relayium);
  return {
    senderCandidatePairBytesSent: quantiles(s.map(x => x.candidatePair.bytesSent), 'bytes'),
    senderFileChannelSendBytes: quantiles(q.map(x => x.sendBytes), 'bytes'),
    senderFileChannelMaxBufferedAfterSendBytes: quantiles(q.map(x => x.maxAfterSendBufferedBytes), 'bytes'),
    senderFileChannelSampledMaxBufferedBytes: quantiles(q.map(x => x.sampled.maxBytes), 'bytes'),
    senderFileChannelSampledNonzeroCount: quantiles(q.map(x => x.sampled.nonzero), 'count'),
    senderSamplingMaxGapMs: quantiles(s.map(x => x.sampling.maxGapMs), 'ms'),
    senderLatestStunRttMs: quantiles(s.map(x => x.candidatePair.latestStunRttMs), 'ms'),
  };
}
