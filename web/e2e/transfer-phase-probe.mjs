/** Opt-in browser API observation; never imported by the product bundle.
 * Durations are async wall time, may overlap, and include instrumentation and
 * scheduling. Crypto counts include AES-GCM control frames, not just file data. */
export function installPhaseProbe(env = globalThis) {
  if (env.__transferPhases) throw new Error('phase probe already installed');
  let active;
  const clock = () => env.performance.now();
  const empty = () => ({ calls: 0, inputBytes: 0, completed: 0, failed: 0, pending: 0,
    totalMs: 0, maxMs: 0, delayCalls: 0, delayElapsedMs: 0 });
  const wrap = (owner, name, phase, select, size) => {
    const original = owner[name];
    if (typeof original !== 'function') throw new Error(`missing observed API ${name}`);
    owner[name] = function (...args) {
      const sample = active;
      if (!sample || !select(sample, args)) return original.apply(this, args);
      const row = sample[phase], start = clock(), receiver = this;
      row.calls++; row.pending++; row.inputBytes += size(this, args);
      const invoke = async () => {
        if (sample.delay?.phase === phase && !row.delayCalls) {
          row.delayCalls++;
          const before = clock();
          await new Promise(resolve => env.setTimeout(resolve, sample.delay.ms));
          row.delayElapsedMs += clock() - before;
        }
        return original.apply(receiver, args);
      };
      return invoke().then(value => { row.completed++; return value; }, error => {
        row.failed++; throw error;
      }).finally(() => {
        const elapsed = clock() - start;
        row.pending--; row.totalMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed);
      });
    };
  };
  wrap(env.Blob.prototype, 'arrayBuffer', 'read', sample => sample.role === 'sender', blob => blob.size);
  for (const phase of ['encrypt', 'decrypt']) {
    wrap(env.crypto.subtle, phase, phase, (_sample, args) =>
      String(typeof args[0] === 'string' ? args[0] : args[0]?.name).toUpperCase() === 'AES-GCM',
    (_self, args) => args[2]?.byteLength ?? 0);
  }
  const settled = () => {
    if (active && ['read', 'encrypt', 'decrypt'].some(k => active[k].pending)) throw new Error('phase operations still pending');
  };
  env.__transferPhases = {
    snapshot() {
      if (!active) throw new Error('phase probe not armed');
      const { delay, ...snapshot } = active;
      return structuredClone(snapshot);
    },
    arm(role, delay = null) {
      settled();
      if (!['sender', 'receiver'].includes(role)) throw new Error('invalid phase role');
      if (delay && (!['read', 'encrypt'].includes(delay.phase) || !Number.isInteger(delay.ms) || delay.ms < 1 || delay.ms > 1000)) throw new Error('invalid phase delay');
      active = { role, delay: role === 'sender' ? delay : null, read: empty(), encrypt: empty(), decrypt: empty() };
    },
    finish() {
      settled();
      if (!active) throw new Error('phase probe not armed');
      const snapshot = this.snapshot();
      active = null;
      return snapshot;
    },
  };
}

/** Fail closed on absent hooks, failures, uncompleted work or malformed metrics. */
export function checkedPhases(sender, receiver, bytes) {
  for (const [sample, role] of [[sender, 'sender'], [receiver, 'receiver']]) {
    if (sample?.role !== role) throw new Error('missing phase role');
    for (const phase of ['read', 'encrypt', 'decrypt']) {
      const row = sample[phase];
      if (!row || !['calls', 'inputBytes', 'completed', 'failed', 'pending', 'totalMs', 'maxMs', 'delayCalls', 'delayElapsedMs'].every(k => Number.isFinite(row[k]) && row[k] >= 0)
        || !['calls', 'inputBytes', 'completed', 'failed', 'pending', 'delayCalls'].every(k => Number.isSafeInteger(row[k]))
        || row.failed || row.pending || row.completed !== row.calls || row.delayCalls > 1
        || row.maxMs > row.totalMs || row.delayElapsedMs > row.totalMs) throw new Error(`invalid ${role}/${phase} metrics`);
    }
  }
  if (sender.read.inputBytes !== bytes || !sender.read.calls || !sender.encrypt.calls || !receiver.decrypt.calls || receiver.read.calls) throw new Error('phase coverage mismatch');
  return { sender, receiver };
}
