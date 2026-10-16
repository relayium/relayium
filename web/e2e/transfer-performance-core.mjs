/** Opt-in benchmark contracts. No product imports, network calls or telemetry. */
export const CASES = {
  text: { files: 0, bytes: 0 },
  small: { files: 1, bytes: 10 * 1024 },
  large: { files: 1, bytes: 8 * 1024 * 1024 },
  batch: { files: 100, bytes: 10 * 1024 },
};

export function options(argv) {
  const o = { samples: 20, warmups: 1, writeDelayMs: 0, textSpacingMs: 250, cases: Object.keys(CASES), control: false };
  const numbers = { '--samples': ['samples', 1, 100], '--warmups': ['warmups', 0, 10], '--write-delay-ms': ['writeDelayMs', 0, 1000] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (numbers[key]) {
      const [name, min, max] = numbers[key];
      if (!/^\d+$/.test(value ?? '') || Number(value) < min || Number(value) > max) throw new Error(`invalid ${key}`);
      o[name] = Number(value);
    } else if (key === '--out' && value && !value.startsWith('--')) o.out = value;
    else if (key === '--phases' && value === 'on') o.phases = true;
    else if (key === '--phase-delay' && /^(read|encrypt):([1-9]\d{0,2}|1000)$/.test(value ?? '')) {
      const [phase, ms] = value.split(':'); o.phaseDelay = { phase, ms: Number(ms) };
    }
    else if (key === '--case' && Object.hasOwn(CASES, value)) o.cases = [value];
    else if (key === '--control' && value === 'bad-hash') o.control = true;
    else throw new Error(`unknown or invalid option ${key}`);
  }
  if (!o.out) throw new Error('--out FILE is required (existing files are never overwritten)');
  if (o.control && o.cases.includes('text')) throw new Error('bad-hash control requires --case small, large or batch');
  if (o.phaseDelay && (!o.phases || o.cases.includes('text'))) throw new Error('phase delay requires --phases on and a file --case');
  return o;
}

/** The P95 of fewer than twenty observations would just disguise a smoke run. */
export function distribution(values) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('invalid duration sample');
  const a = [...values].sort((x, y) => x - y), n = a.length;
  return { count: n, medianMs: n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2,
    p95Ms: n >= 20 ? a[Math.ceil(n * .95) - 1] : null, minMs: a[0], maxMs: a[n - 1] };
}

export function checkedSample({ kind, direction, iteration, warmup, startAt, observation }) {
  const c = CASES[kind], p = observation;
  if (!c || !['A→B', 'B→A'].includes(direction) || !Number.isInteger(iteration) || iteration < 0 || typeof warmup !== 'boolean') throw new Error('invalid sample identity');
  if (p.error || !p.ready || p.verified !== true || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.closedFiles !== c.files || p.verifiedFiles !== c.files || p.bytes !== (kind === 'text' ? p.expectedTextBytes : c.files * c.bytes)) throw new Error(`unverified/incomplete ${kind} sample: ${p.error ?? 'counts or completion'}`);
  const times = kind === 'text' ? [p.visibleAt, p.verifiedAt] : [p.consentAt, p.firstWriteAt, p.closedAt, p.verifiedAt];
  if (![startAt, ...times, p.readyAt].every(Number.isFinite) || times[0] < startAt || times.some((v, i) => i && v < times[i - 1]) || p.readyAt < p.verifiedAt) throw new Error('invalid or non-monotonic browser milestones');
  const durations = { verifiedReadyMs: p.readyAt - startAt, verificationTailMs: p.verifiedAt - (kind === 'text' ? p.visibleAt : p.closedAt) };
  if (kind === 'text') durations.visibleMs = p.visibleAt - startAt;
  else Object.assign(durations, { selectionToConsentMs: p.consentAt - startAt, consentToFirstWriteMs: p.firstWriteAt - p.consentAt,
    firstWriteToClosedMs: p.closedAt - p.firstWriteAt });
  return { kind, direction, iteration, warmup, startedAt: startAt, bytes: p.bytes, files: c.files, verified: true, durations };
}

/** Any incomplete group poisons the run; never compute success-only statistics. */
export function summarize(samples, selectedCases, expectedSamples) {
  if (samples.some(x => x.verified !== true || !selectedCases.includes(x.kind) || !['A→B', 'B→A'].includes(x.direction)
    || typeof x.warmup !== 'boolean' || Object.values(x.durations).some(v => !Number.isFinite(v) || v < 0))) throw new Error('invalid raw sample, including warmup');
  const result = {};
  for (const kind of selectedCases) for (const direction of ['A→B', 'B→A']) {
    const rows = samples.filter(x => x.kind === kind && x.direction === direction && !x.warmup);
    if (rows.length !== expectedSamples || rows.some(x => x.verified !== true) || new Set(rows.map(x => x.iteration)).size !== rows.length) throw new Error(`incomplete/duplicate group ${kind}/${direction}`);
    const names = Object.keys(rows[0].durations);
    if (rows.some(x => Object.keys(x.durations).sort().join() !== [...names].sort().join())) throw new Error('inconsistent duration fields');
    result[`${kind}/${direction}`] = Object.fromEntries(names.map(name => [name, distribution(rows.map(x => x.durations[name]))]));
  }
  return result;
}

/** Injected into each browser before the product loads. All inputs are synthetic.
 * The destination is MEMORY, not disk; its async hash observer never delays the
 * product's close promise. Browser timestamps exclude CDP polling latency. */
export function installProbe() {
  const clock = () => performance.timeOrigin + performance.now();
  const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
  let p;
  window.__transferBaseline = {
    linkReadyAt: null,
    arm(spec) {
      p = { ...spec, bytes: 0, closedFiles: 0, verifiedFiles: 0, ready: false, verified: false, error: null, destinations: new Map() };
    },
    snapshot() {
      const { destinations, expected, text, ...out } = p;
      return out;
    },
    clock,
  };
  const check = () => {
    if (!window.__transferBaseline.linkReadyAt && document.querySelector('.workspace-head .sas code')) window.__transferBaseline.linkReadyAt = clock();
    if (!p || p.error || p.ready) return;
    const receive = document.querySelector('#xfer-label-recv')?.closest('.xfer');
    if (receive?.classList.contains('bad')) p.error = 'product receive failed';
    if (p.kind === 'text') {
      const error = document.querySelector('.msgpanel p.bad');
      if (error) { p.error = `product text lane: ${error.textContent}`; return; }
      if (!p.visibleAt && [...document.querySelectorAll('.msg-body')].some(n => n.textContent === p.text)) {
        const sample = p;
        sample.visibleAt = clock();
        const bytes = new TextEncoder().encode(sample.text);
        crypto.subtle.digest('SHA-256', bytes).then(hash => {
          if (hex(hash) !== sample.expectedTextHash) throw new Error('text hash mismatch');
          sample.bytes = bytes.byteLength; sample.verified = true; sample.verifiedAt = clock(); check();
        }).catch(e => { sample.error = e.message; });
      }
      if (p.verified) { p.ready = true; p.readyAt = clock(); }
      return;
    }
    const card = document.querySelector('.request');
    if (card && !p.consentAt) {
      if (card.querySelector('.memwarn')) { p.error = 'memory-warning consent requires a separate scenario'; return; }
      const button = card.querySelector('.btn-primary');
      if (button && !button.disabled) { p.consentAt = clock(); button.click(); }
    }
    if (p.verified && receive?.classList.contains('ok')) { p.ready = true; p.readyAt = clock(); }
  };
  const file = name => ({
    createWritable: async () => {
      const sample = p;
      if (!sample.expected[name] || sample.destinations.has(name)) throw new Error('unexpected/duplicate destination');
      const entry = { chunks: [], bytes: 0, closed: false };
      sample.destinations.set(name, entry);
      return {
        write: async chunk => {
          if (entry.closed) throw new Error('write after close');
          if (sample.writeDelayMs) await new Promise(r => setTimeout(r, sample.writeDelayMs));
          sample.firstWriteAt ??= clock();
          const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
          entry.chunks.push(bytes); entry.bytes += bytes.byteLength; sample.bytes += bytes.byteLength;
        },
        close: async () => {
          if (entry.closed) throw new Error('duplicate close');
          entry.closed = true; sample.closedFiles++; sample.closedAt = clock();
          const expected = sample.expected[name];
          // Deliberately don't await this observer in the product's close().
          new Blob(entry.chunks).arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(hash => {
            entry.chunks = [];
            if (entry.bytes !== expected.bytes || hex(hash) !== expected.sha256) throw new Error('file hash/size mismatch');
            sample.verifiedFiles++;
            if (sample.closedFiles === Object.keys(sample.expected).length && sample.verifiedFiles === sample.closedFiles) {
              sample.verified = true; sample.verifiedAt = clock(); check();
            }
          }).catch(e => { sample.error = e.message; });
          check();
        },
        abort: async () => { sample.error = 'destination aborted'; },
      };
    },
  });
  window.showSaveFilePicker = async ({ suggestedName }) => file(suggestedName);
  window.showDirectoryPicker = async () => ({
    getFileHandle: async (name, opts) => {
      if (!opts.create) throw new DOMException('synthetic empty directory', 'NotFoundError');
      return file(name);
    },
    getDirectoryHandle: async () => { throw new Error('nested folders are outside this baseline'); },
  });
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
}
