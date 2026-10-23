import { describe, it, expect } from 'vitest';
import { installTransportProbe, checkedTransport, checkedRole, quantiles, summarizeTransport, TRANSPORT_LABELS, TRANSPORT_PROBE_VERSION } from './transfer-transport-probe.mjs';
import { options } from './transfer-performance-core.mjs';

const pairRow = (over = {}) => ({ id: 'CP1', type: 'candidate-pair', state: 'succeeded', nominated: true,
  localCandidateId: 'L1', remoteCandidateId: 'R1', timestamp: 1000, bytesSent: 100, bytesReceived: 100,
  packetsSent: 1, packetsReceived: 1, responsesReceived: 1, totalRoundTripTime: 0.001, currentRoundTripTime: 0.001, ...over });
function report({ pair = {}, transport = true, changes, local = {}, extra = [] } = {}) {
  const rows = [pairRow(pair),
    { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '10.0.0.1', port: 5000, ...local },
    { id: 'R1', type: 'remote-candidate', candidateType: 'prflx', protocol: 'udp', address: '10.0.0.2', port: 6000 }, ...extra];
  if (transport) rows.push({ id: 'T1', type: 'transport', selectedCandidatePairId: pair.id ?? 'CP1',
    ...(changes === undefined ? {} : { selectedCandidatePairChanges: changes }) });
  return new Map(rows.map(r => [r.id, r]));
}

function fixture(extra = {}) {
  let now = 0, interval = null;
  const sent = [];
  class Channel {
    constructor(label) { this.label = label; this.readyState = 'open'; this.queue = 0; }
    get bufferedAmount() { if (this.queueFail) throw new Error('queue getter failure'); return this.queue; }
    set bufferedAmount(value) { this.queue = value; }
    send(data) {
      if (this.fail) throw this.fail;
      // The native side never reads through the observed getter.
      sent.push({ self: this, data }); this.queue += typeof data === 'string' ? data.length : data.byteLength ?? 0;
      return 'native-return';
    }
  }
  class Peer extends EventTarget {
    constructor(config) { super(); this.config = config; this.connectionState = 'connected'; this.stats = [report()]; }
    createDataChannel(label) { if (label === 'throw') throw new Error('native create'); return new Channel(label); }
    async getStats() { const next = this.stats.length > 1 ? this.stats.shift() : this.stats[0]; return typeof next === 'function' ? next() : next; }
  }
  Peer.generateCertificate = () => 'static';
  const env = { RTCPeerConnection: Peer, RTCDataChannel: Channel, Blob, performance: { now: () => now },
    setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; } };
  installTransportProbe(env, { labels: TRANSPORT_LABELS, intervalMs: 10, ...extra });
  const probe = env.__transferTransport;
  const connect = (initiator = true) => {
    const pc = new env.RTCPeerConnection({ iceServers: [] });
    if (initiator) return { pc, lanes: TRANSPORT_LABELS.map(l => pc.createDataChannel(l)) };
    const lanes = TRANSPORT_LABELS.map(l => new Channel(l));
    for (const channel of lanes) { const e = new Event('datachannel'); e.channel = channel; pc.dispatchEvent(e); }
    return { pc, lanes };
  };
  return { env, probe, Peer, Channel, sent, connect, advance: ms => { now += ms; }, tick: () => interval?.(), hasTimer: () => !!interval };
}

/** A complete sender observation: 100 file bytes, 20 queued after send. */
async function observed(f, role = 'sender', { bytes = 100 } = {}) {
  const { pc, lanes } = f.connect(role === 'sender');
  pc.stats = [report(), report({ pair: { timestamp: 2000, bytesSent: 100 + bytes * 2, bytesReceived: 100 + bytes * 2, responsesReceived: 3, totalRoundTripTime: 0.005, currentRoundTripTime: null } })];
  await f.probe.arm(role);
  lanes[0].send(new Uint8Array(bytes));
  f.advance(5); f.tick(); lanes[0].bufferedAmount = 0; f.advance(5); f.tick(); f.advance(30);
  return f.probe.finish();
}

describe('opt-in WebRTC transport probe', () => {
  it('preserves constructor, statics, method receiver, arguments, return values and throws', () => {
    const f = fixture();
    const pc = new f.env.RTCPeerConnection({ iceServers: ['x'] });
    expect(pc).toBeInstanceOf(f.env.RTCPeerConnection); expect(pc).toBeInstanceOf(f.Peer);
    expect(pc.config).toEqual({ iceServers: ['x'] }); expect(f.env.RTCPeerConnection.generateCertificate()).toBe('static');
    expect(() => pc.createDataChannel('throw')).toThrow('native create');
    const lane = pc.createDataChannel('relayium'), data = new Uint8Array(3);
    expect(lane.send(data)).toBe('native-return');
    expect(f.sent.at(-1)).toEqual({ self: lane, data });
    const failure = new Error('native send'); lane.fail = failure;
    expect(() => lane.send(data)).toThrow(failure);
  });
  it('binds one connected peer, counts sends and occupancy, and exports no identities or addresses', async () => {
    const f = fixture(); // a second, never-connected peer must not confuse binding
    const stray = new f.env.RTCPeerConnection(); stray.connectionState = 'new';
    const out = await observed(f);
    expect(out.channels.relayium).toMatchObject({ sendCalls: 1, sendBytes: 100, maxAfterSendBufferedBytes: 100, atFinishBufferedBytes: 0,
      sampled: { count: 2, nonzero: 1, maxBytes: 100, sumBytes: 100 } });
    expect(out.sampling).toEqual({ intervalMs: 10, windowMs: 40, tickCount: 2, maxGapMs: 30 });
    expect(out.selection).toEqual({ method: 'transport.selectedCandidatePairId', local: { candidateType: 'host', protocol: 'udp' }, remote: { candidateType: 'prflx', protocol: 'udp' } });
    const text = JSON.stringify(out);
    for (const secret of ['CP1', 'L1', 'R1', 'T1', '10.0.0', '5000', '6000']) expect(text).not.toContain(secret);
    expect(f.probe.state()).toBe('idle');
  });
  it('rethrows the original send failure while observing and does not count its bytes', async () => {
    const f = fixture(), { pc, lanes } = f.connect();
    pc.stats = [report(), report({ pair: { timestamp: 2000 } })];
    await f.probe.arm('sender');
    const failure = new DOMException('queue full', 'OperationError'); lanes[0].fail = failure;
    expect(() => lanes[0].send(new Uint8Array(9))).toThrow(failure);
    expect((await f.probe.finish()).channels.relayium).toMatchObject({ sendCalls: 1, sendThrows: 1, sendBytes: 0 });
  });
  it('learns inbound channels from the datachannel event without replacing the product handler', async () => {
    const f = fixture(), { pc, lanes } = f.connect(false);
    pc.stats = [report(), report({ pair: { timestamp: 1500, bytesSent: 200 } })];
    await f.probe.arm('receiver');
    lanes[1].send('你好');
    expect((await f.probe.finish()).channels['relayium-text']).toMatchObject({ sendCalls: 1, sendBytes: 6 });
  });
  it('does not observe outside the window and counts sends on unbound channels', async () => {
    const f = fixture(), { pc, lanes } = f.connect();
    lanes[0].send(new Uint8Array(4));
    pc.stats = [report(), report({ pair: { timestamp: 2000, bytesSent: 900 } })];
    await f.probe.arm('sender');
    new f.Channel('relayium').send(new Uint8Array(1));
    const out = await f.probe.finish();
    expect(out.channels.relayium.sendCalls).toBe(0); expect(out.unboundSendCalls).toBe(1);
    expect(f.hasTimer()).toBe(false);
  });
  it('falls back only to a single nominated succeeded pair and refuses ambiguity', async () => {
    const f = fixture(), { pc } = f.connect();
    pc.stats = [report({ transport: false })];
    await f.probe.arm('sender');
    expect((await f.probe.finish()).selection.method).toBe('unique-nominated-succeeded');
    // An outstanding consent check leaves the in-use pair in-progress; the
    // transport's own selection still names it.
    pc.stats = [report({ pair: { state: 'in-progress', nominated: false } })];  // also: no state rule
    await f.probe.arm('sender');
    expect((await f.probe.finish()).selection.method).toBe('transport.selectedCandidatePairId');
    for (const stats of [report({ transport: false, extra: [pairRow({ id: 'CP2' })] }),
      report({ extra: [{ id: 'T2', type: 'transport', selectedCandidatePairId: 'CP1' }] }),
      report({ transport: false, pair: { state: 'in-progress' } }), report({ pair: { bytesSent: undefined } }),
      report({ transport: false, extra: [{ id: 'T9', type: 'transport', selectedCandidatePairId: 'missing' }] }),
      report({ local: { candidateType: 'weird' } }), report({ local: { protocol: undefined } }),
      // An explicit but malformed selection never falls back to the nominated pair.
      report({ transport: false, extra: [{ id: 'T3', type: 'transport', selectedCandidatePairId: '' }] }),
      report({ transport: false, extra: [{ id: 'T4', type: 'transport', selectedCandidatePairId: 7 }] })]) {
      const g = fixture(), { pc: peer } = g.connect(); peer.stats = [stats];
      await expect(g.probe.arm('sender')).rejects.toThrow();
      expect(g.probe.state()).toBe('failed');
      await expect(g.probe.arm('sender')).rejects.toThrow('failed');
    }
  });
  it('fails when the pair, transport or connection changes during a sample', async () => {
    for (const after of [report({ pair: { id: 'CP9' } }), report({ pair: { localCandidateId: 'L2' }, extra: [{ id: 'L2', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }] })]) {
      const f = fixture(), { pc } = f.connect(); pc.stats = [report(), after];
      await f.probe.arm('sender');
      await expect(f.probe.finish()).rejects.toThrow('changed');
    }
    const f = fixture(), { pc } = f.connect();
    await f.probe.arm('sender'); pc.connectionState = 'disconnected';
    await expect(f.probe.finish()).rejects.toThrow('connected');
    expect(f.probe.state()).toBe('failed');
  });
  it('refuses missing peers, missing or duplicate lanes and out-of-order lifecycle', async () => {
    const empty = fixture();
    await expect(empty.probe.arm('sender')).rejects.toThrow('exactly one');
    await expect(empty.probe.finish()).rejects.toThrow('failed');
    const two = fixture(); two.connect(); two.connect();
    await expect(two.probe.arm('sender')).rejects.toThrow('exactly one');
    const dup = fixture(), { pc } = dup.connect(); pc.createDataChannel('relayium');
    await expect(dup.probe.arm('sender')).rejects.toThrow('one open relayium');
    const closed = fixture(), { lanes } = closed.connect(); lanes[1].readyState = 'closed';
    await expect(closed.probe.arm('sender')).rejects.toThrow('relayium-text');
    const f = fixture(); f.connect();
    await expect(f.probe.arm('peer')).rejects.toThrow('role');
    await f.probe.arm('sender');
    await expect(f.probe.arm('sender')).rejects.toThrow('armed');
    expect(() => installTransportProbe(f.env, { labels: TRANSPORT_LABELS, intervalMs: 10 })).toThrow('already installed');
    expect(() => installTransportProbe({}, { labels: TRANSPORT_LABELS, intervalMs: 10 })).toThrow('missing observed');
    expect(() => installTransportProbe({}, { labels: TRANSPORT_LABELS, intervalMs: 0 })).toThrow('configuration');
  });
  it('discards stale asynchronous snapshots after abort', async () => {
    const f = fixture(), { pc, lanes } = f.connect(); let release;
    pc.stats = [() => new Promise(resolve => { release = resolve; })];
    const arming = f.probe.arm('sender');
    f.probe.abort(); release(report());
    await expect(arming).rejects.toThrow('stale');
    expect(f.hasTimer()).toBe(false);
    lanes[0].send(new Uint8Array(2)); // no window was installed by the late result
    expect(f.probe.state()).toBe('failed');
    const g = fixture(), { pc: peer } = g.connect();
    await g.probe.arm('sender');
    peer.stats = [() => new Promise(resolve => { release = resolve; })];
    const finishing = g.probe.finish(); g.probe.abort(); release(report());
    await expect(finishing).rejects.toThrow('stale');
  });
});

describe('R2 regressions on the installed probe', () => {
  const arming = async stats => { const f = fixture(), { pc, lanes } = f.connect(); pc.stats = stats; await f.probe.arm('sender'); return { f, pc, lanes }; };
  it('refuses supplied malformed optional and required counters instead of treating them as absent', async () => {
    for (const bad of [{ currentRoundTripTime: 'malformed' }, { currentRoundTripTime: NaN }, { currentRoundTripTime: Infinity },
      { currentRoundTripTime: -0.001 }, { packetsSent: '5' }, { totalRoundTripTime: {} }, { responsesReceived: true }, { bytesSent: '100' }]) {
      const f = fixture(), { pc } = f.connect(); pc.stats = [report({ pair: bad })];
      await expect(f.probe.arm('sender')).rejects.toThrow(/malformed|missing/);
      const g = fixture(), { pc: peer } = g.connect(); peer.stats = [report(), report({ pair: bad })];
      await g.probe.arm('sender');
      await expect(g.probe.finish()).rejects.toThrow(/malformed|missing/);
      expect(g.probe.state()).toBe('failed');
    }
  });
  it('keeps undefined/null optionals as null and a supplied zero RTT as zero', async () => {
    const { f } = await arming([report({ pair: { currentRoundTripTime: undefined, packetsSent: null, packetsReceived: undefined } }),
      report({ pair: { timestamp: 2000, currentRoundTripTime: 0, packetsSent: null, packetsReceived: undefined } })]);
    const out = await f.probe.finish();
    expect(out.counters.before).toMatchObject({ currentRoundTripTime: null, packetsSent: null, packetsReceived: null });
    expect(out.counters.after.currentRoundTripTime).toBe(0);
    const r = await observed(fixture(), 'receiver', { bytes: 0 });
    expect(checkedTransport(out, r, 0).sender.candidatePair).toMatchObject({ latestStunRttMs: 0, packetsSent: null });
  });
  it('preserves the native return value when a post-send observation fails, then fails the sample', async () => {
    const { f, lanes } = await arming([report(), report({ pair: { timestamp: 2000 } })]);
    lanes[0].queueFail = true;
    expect(lanes[0].send(new Uint8Array(4))).toBe('native-return');
    expect(f.sent).toHaveLength(1);
    lanes[0].queueFail = false;
    await expect(f.probe.finish()).rejects.toThrow('observation failed');
    expect(f.probe.state()).toBe('failed');
  });
  it('preserves the original native exception when observation is also broken', async () => {
    const { f, lanes } = await arming([report()]);
    const failure = new DOMException('native', 'OperationError');
    lanes[0].fail = failure; lanes[0].queueFail = true;
    let caught; try { lanes[0].send(new Uint8Array(4)); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });
  it('a payload whose size cannot be read still reaches the native send unchanged', async () => {
    const { f, lanes } = await arming([report(), report({ pair: { timestamp: 2000 } })]);
    class Hostile extends Blob { get size() { throw new Error('size getter'); } }
    const payload = new Hostile(['x']);
    expect(lanes[0].send(payload)).toBe('native-return');
    expect(f.sent.at(-1).data).toBe(payload);
    await expect(f.probe.finish()).rejects.toThrow('observation failed');
  });
  it('a failing sampler stops its own timer and fails the sample; abort always clears', async () => {
    const { f, lanes } = await arming([report(), report({ pair: { timestamp: 2000 } })]);
    lanes[1].queueFail = true; f.advance(10); f.tick();
    expect(f.hasTimer()).toBe(false);
    lanes[1].queueFail = false;
    await expect(f.probe.finish()).rejects.toThrow('observation failed');
    const g = (await arming([report()])).f;
    expect(g.hasTimer()).toBe(true); g.probe.abort();
    expect(g.hasTimer()).toBe(false); expect(g.probe.state()).toBe('failed');
  });
  it('rejects a same-ID selection whose pair-change count moved', async () => {
    const { f } = await arming([report({ changes: 0 }), report({ changes: 2, pair: { timestamp: 2000 } })]);
    await expect(f.probe.finish()).rejects.toThrow('selectedCandidatePairChanges');
  });
  it('accepts an unchanged count or absence at both boundaries, refuses partial or malformed counts', async () => {
    const same = (await arming([report({ changes: 3 }), report({ changes: 3, pair: { timestamp: 2000 } })])).f;
    expect((await same.probe.finish()).pairChanges).toEqual({ before: 3, after: 3 });
    const absent = (await arming([report(), report({ pair: { timestamp: 2000 } })])).f;
    expect((await absent.probe.finish()).pairChanges).toEqual({ before: null, after: null });
    for (const stats of [[report({ changes: 1 }), report({ pair: { timestamp: 2000 } })], [report(), report({ changes: 0, pair: { timestamp: 2000 } })]]) {
      const { f } = await arming(stats);
      await expect(f.probe.finish()).rejects.toThrow('only one boundary');
    }
    for (const bad of [-1, 1.5, '0', NaN]) {
      const f = fixture(), { pc } = f.connect(); pc.stats = [report({ changes: bad })];
      await expect(f.probe.arm('sender')).rejects.toThrow('malformed selectedCandidatePairChanges');
    }
  });
});

describe('transport acceptance', () => {
  async function pair() { return [await observed(fixture(), 'sender'), await observed(fixture(), 'receiver')]; }
  it('derives candidate-pair deltas and keeps unavailable RTT as null, not zero', async () => {
    const [s, r] = await pair(), out = checkedTransport(s, r, 100);
    expect(s.version).toBe(TRANSPORT_PROBE_VERSION);
    expect(out.sender.candidatePair).toEqual({ statsIntervalMs: 1000, bytesSent: 200, bytesReceived: 200, packetsSent: 0, packetsReceived: 0,
      stunResponsesReceived: 2, meanStunRttMs: 2, latestStunRttMs: null, selectedPairChanges: null });
    const absent = structuredClone(s);
    for (const side of ['before', 'after']) absent.counters[side].responsesReceived = absent.counters[side].totalRoundTripTime = null;
    expect(checkedTransport(absent, r, 100).sender.candidatePair).toMatchObject({ stunResponsesReceived: null, meanStunRttMs: null });
  });
  it('refuses resets, partial/malformed counters, coverage gaps and unbracketed sends', async () => {
    const [s, r] = await pair();
    const mutations = [
      x => { x.counters.after.bytesSent = 50; }, x => { x.counters.after.timestamp = 1; },
      x => { x.counters.before.packetsSent = null; }, x => { x.counters.after.bytesReceived = NaN; },
      x => { x.counters.after.bytesSent = 300.5; }, x => { x.counters.before.bytesSent = -1; },
      x => { x.counters.after.bytesSent = 150; }, // fewer pair bytes than own sends
      x => { x.unboundSendCalls = 1; }, x => { x.channels.relayium.unknownPayloads = 1; },
      x => { delete x.channels['relayium-text']; }, x => { x.channels.extra = x.channels.relayium; },
      x => { x.channels.relayium.sampled.count = 9; }, x => { x.channels.relayium.sampled.maxBytes = 0; },
      x => { x.sampling.intervalMs = 5; }, x => { x.sampling.maxGapMs = 41; }, x => { x.sampling.tickCount = 0; x.channels.relayium.sampled.count = 0; x.channels['relayium-text'].sampled.count = 0; },
      x => { x.selection.local.candidateType = 'unknown'; }, x => { x.selection.method = 'guess'; },
      x => { x.version = 1; }, x => { x.role = 'receiver'; }, x => { x.observationFailures = 1; }, x => { delete x.observationFailures; },
      x => { x.pairChanges = { before: 0, after: 2 }; }, x => { x.pairChanges = { before: 0, after: null }; },
      x => { x.pairChanges = { before: -1, after: -1 }; }, x => { x.pairChanges = { before: 1.5, after: 1.5 }; }, x => { delete x.pairChanges; },
      x => { x.selection.method = 'unique-nominated-succeeded'; x.pairChanges = { before: 1, after: 1 }; },
    ];
    for (const mutate of mutations) { const bad = structuredClone(s); mutate(bad); expect(() => checkedTransport(bad, r, 100)).toThrow(); }
    expect(() => checkedTransport(s, r, 101)).toThrow('fewer bytes');
    // The receiver's wire must have received at least everything the sender sent.
    const edge = structuredClone(r); edge.counters.after.bytesReceived = 200;
    expect(() => checkedTransport(s, edge, 100)).not.toThrow();
    edge.counters.after.bytesReceived = 199;
    expect(() => checkedTransport(s, edge, 100)).toThrow('bracket');
    expect(() => checkedTransport(null, r, 100)).toThrow('sender');
  });
  it('labels summary units and counts nulls instead of zero-filling them', async () => {
    expect(quantiles([3, null, 1], 'ms')).toEqual({ unit: 'ms', count: 2, nullCount: 1, median: 2, p95: null, min: 1, max: 3 });
    expect(quantiles([null], 'ms')).toMatchObject({ count: 0, median: null });
    expect(() => quantiles([-1], 'bytes')).toThrow(); expect(() => quantiles([1], 'seconds')).toThrow();
    const [s, r] = await pair(), row = { transport: checkedTransport(s, r, 100) };
    const summary = summarizeTransport([row]);
    expect(summary.senderCandidatePairBytesSent).toMatchObject({ unit: 'bytes', median: 200 });
    expect(summary.senderLatestStunRttMs).toMatchObject({ unit: 'ms', count: 0, nullCount: 1 });
    expect(JSON.stringify(summary)).not.toContain('medianMs');
  });
  it('is opt-in and needs a file case', () => {
    expect(options(['--out', '/x']).transport).toBeUndefined();
    expect(options(['--out', '/x', '--transport', 'on', '--phases', 'on'])).toMatchObject({ transport: true, phases: true });
    for (const args of [['--transport', 'off'], ['--transport'], ['--transport', 'on', '--case', 'text']]) expect(() => options(['--out', '/x', ...args])).toThrow();
  });
});

describe('opt-in TURN-hop relayProtocol (relay diagnostics only)', () => {
  const relayStats = (local = {}, remote = {}) => report({ local: { candidateType: 'relay', ...local } });
  async function relayObserved(f, role, local) {
    const { pc, lanes } = f.connect(role === 'sender');
    pc.stats = [relayStats(local), report({ local: { candidateType: 'relay', ...local }, pair: { timestamp: 2000, bytesSent: 400, bytesReceived: 400 } })];
    await f.probe.arm(role);
    lanes[0].send(new Uint8Array(100));
    f.advance(10); f.tick(); lanes[0].bufferedAmount = 0;
    return f.probe.finish();
  }
  it('without the option the selection shape is exactly what it always was', async () => {
    const out = await relayObserved(fixture(), 'sender', { relayProtocol: 'tcp' });
    expect(out.selection.local).toEqual({ candidateType: 'relay', protocol: 'udp' });
    expect(JSON.stringify(out)).not.toContain('relayProtocol');
  });
  it('reports the browser-supplied hop protocol on the local candidate only', async () => {
    for (const hop of ['udp', 'tcp', 'tls']) {
      const out = await relayObserved(fixture({ relayProtocol: true }), 'sender', { relayProtocol: hop });
      expect(out.selection.local).toEqual({ candidateType: 'relay', protocol: 'udp', relayProtocol: hop });
      expect(Object.hasOwn(out.selection.remote, 'relayProtocol')).toBe(false);
      expect(checkedRole(out, 'sender').selection.local.relayProtocol).toBe(hop);
    }
  });
  it('an absent stat is null, never guessed from the candidate protocol', async () => {
    const out = await relayObserved(fixture({ relayProtocol: true }), 'sender', {});
    expect(out.selection.local.relayProtocol).toBeNull();
    expect(out.selection.local.protocol).toBe('udp');
  });
  it('refuses a malformed hop protocol and a malformed option', async () => {
    const f = fixture({ relayProtocol: true }), { pc } = f.connect();
    pc.stats = [relayStats({ relayProtocol: 'quic' })];
    await expect(f.probe.arm('sender')).rejects.toThrow('relayProtocol');
    expect(() => fixture({ relayProtocol: 'yes' })).toThrow('invalid transport probe configuration');
  });
  it('validation rejects a remote hop protocol or an unknown value', async () => {
    const good = await relayObserved(fixture({ relayProtocol: true }), 'sender', { relayProtocol: 'udp' });
    const remote = structuredClone(good); remote.selection.remote.relayProtocol = 'udp';
    expect(() => checkedRole(remote, 'sender')).toThrow('relayProtocol');
    const unknown = structuredClone(good); unknown.selection.local.relayProtocol = 'sctp';
    expect(() => checkedRole(unknown, 'sender')).toThrow('relayProtocol');
  });
});
