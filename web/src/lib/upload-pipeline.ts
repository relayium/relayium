// Two owned ciphertext buffers; only their network requests may overlap.
// The successor starts after its predecessor's body-sent event. Storage still
// commits one contiguous prefix. Any uncertain outcome drains both requests
// before returning the same retained ciphertext to the serial recovery loop.
export const UPLOAD_PIPELINE_V1 = "ordered-v1";
export const UPLOAD_PIPELINE_WAIT_MS = 30_000;

type Answer = { kind: "answer"; received: number } | { kind: "fault" };
type Chunk = {
  start: number; length: number; buffer: Uint8Array;
  sent: boolean; settled: boolean; handled: boolean; ownedAbort: boolean;
  controller: AbortController; flight?: Promise<void>; answer?: Answer; error?: unknown;
};

export interface PipelineOptions {
  source: AsyncIterableIterator<Uint8Array>;
  buffer: Uint8Array;
  target: number;
  total: number;
  signal?: AbortSignal;
  enabled: () => boolean;
  send: (bytes: Uint8Array, start: number, signal: AbortSignal, bodySent: () => void) => Promise<Answer>;
  recover: (confirmed: number) => Promise<number>;
  confirmed: (received: number) => void;
  prepared?: (milliseconds: number) => void;
}

export interface PipelineResult {
  completed: boolean;
  offset: number;
  highestSent: number;
  buffer: Uint8Array;
  filled: number;
  source: AsyncIterableIterator<Uint8Array>;
  bufferPeak: number;
  skipReplay?: (bytes: number) => boolean;
}

const abortError = () => new DOMException("aborted", "AbortError");
const invariant = () => new Error("invalid upload pipeline state");

export async function uploadPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const buffers = [o.buffer];
  const chunks: Chunk[] = [];
  let frontier = 0, confirmed = 0, highestSent = 0, peak = o.buffer.length;
  let stopped = false, fallback = false;
  let wake: (() => void) | undefined;
  const changed = () => { wake?.(); wake = undefined; };
  const onAbort = () => { for (const c of chunks) c.controller.abort(); changed(); };
  o.signal?.addEventListener("abort", onAbort);

  const note = (received: number) => {
    if (!Number.isSafeInteger(received) || received < 0 || received > highestSent) throw invariant();
    if (received > confirmed) { confirmed = received; if (!o.signal?.aborted) o.confirmed(received); }
  };
  const settle = () => {
    for (const c of chunks) {
      if (!c.settled || c.handled) continue;
      c.handled = true;
      if (c.error !== undefined) { if (!c.ownedAbort) throw c.error; }
      else if (c.answer?.kind === "answer") note(c.answer.received);
      else if (!c.ownedAbort) fallback = true;
    }
    for (const c of chunks) {
      if (c.handled && c.answer?.kind === "answer" && c.answer.received < c.start + c.length && confirmed < c.start + c.length) fallback = true;
    }
  };
  const drain = async () => {
    stopped = true;
    for (const c of chunks) if (!c.settled) { c.ownedAbort = true; c.controller.abort(); }
    await Promise.allSettled(chunks.map((c) => c.flight));
  };
  try {
    for (;;) {
      if (o.signal?.aborted) throw abortError();
      settle();
      if (fallback || !o.enabled()) break;
      if (confirmed === o.total && chunks.every((c) => c.settled)) {
        if (!(await o.source.next()).done) throw invariant();
        return { completed: true, offset: confirmed, highestSent, buffer: o.buffer, filled: 0, source: o.source, bufferPeak: peak };
      }
      // Reuse only after that request has terminated AND its entire body is
      // known committed. A later cumulative ACK cannot release a live owner.
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c.handled && c.start + c.length <= confirmed) { buffers.push(c.buffer); chunks.splice(i, 1); }
      }
      const last = chunks.at(-1);
      if (frontier < o.total && chunks.length < 2 && (!last || last.sent || last.settled)) {
        const buffer = buffers.pop() ?? new Uint8Array(o.buffer.length);
        const preparing = performance.now();
        let filled = 0;
        while (filled < o.target && frontier + filled < o.total) {
          if (o.signal?.aborted) throw abortError();
          const next = await o.source.next();
          if (next.done) throw invariant();
          if (next.value.length > buffer.length - filled || frontier + filled + next.value.length > o.total) throw invariant();
          buffer.set(next.value, filled); filled += next.value.length;
        }
        if (!filled) throw invariant();
        o.prepared?.(performance.now() - preparing);
        const c: Chunk = { start: frontier, length: filled, buffer, sent: false, settled: false, handled: false, ownedAbort: false, controller: new AbortController() };
        chunks.push(c);
        peak = Math.max(peak, (chunks.length + buffers.length) * o.buffer.length);
        frontier += filled;
        if (o.signal?.aborted) throw abortError();
        // File reads/encryption can yield while the speed setting changes.
        // Retain these prepared bytes for the paced path before any dispatch.
        if (!o.enabled()) { fallback = true; break; }
        highestSent = frontier;
        c.flight = o.send(buffer.subarray(0, filled), c.start, c.controller.signal, () => {
          if (!stopped) { c.sent = true; changed(); }
        }).then((answer) => { c.answer = answer; }, (error: unknown) => { c.error = error; })
          .then(() => { c.settled = true; changed(); });
        continue;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    await drain();
    if (o.signal?.aborted) throw abortError();
    settle();
    const recovered = await o.recover(confirmed);
    if (recovered < confirmed) throw invariant();
    note(recovered);
    const remaining = chunks.filter((c) => c.start + c.length > confirmed).sort((a,b) => a.start-b.start);
    let buffer = buffers[0] ?? o.buffer, filled = 0;
    if (remaining.length) {
      const first = remaining.shift()!;
      const consumed = confirmed - first.start;
      if (consumed < 0 || consumed > first.length) throw invariant();
      buffer = first.buffer;
      buffer.copyWithin(0, consumed, first.length);
      filled = first.length - consumed;
    }
    const frame = o.buffer.length - o.target;
    if (frame <= 0) throw invariant();
    let prefixIndex = 0, prefixAt = 0;
    let prefixBytes = remaining.reduce((sum,c) => sum+c.length,0);
    const skipReplay = (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0 || count > prefixBytes) return false;
      prefixBytes -= count;
      while (count > 0) {
        const n = Math.min(count, remaining[prefixIndex].length-prefixAt);
        prefixAt += n; count -= n;
        if (prefixAt === remaining[prefixIndex].length) { prefixIndex++; prefixAt=0; }
      }
      return true;
    };
    async function* replay(): AsyncGenerator<Uint8Array> {
      try {
        while (prefixIndex < remaining.length) {
          const c = remaining[prefixIndex];
          const n = Math.min(frame,c.length-prefixAt);
          const value = c.buffer.subarray(prefixAt,prefixAt+n);
          skipReplay(n);
          yield value;
        }
        yield* o.source;
      } finally { await o.source.return?.(); }
    }
    return { completed: false, offset: confirmed, highestSent, buffer, filled, source: replay(), bufferPeak: peak, skipReplay };
  } finally {
    await drain();
    o.signal?.removeEventListener("abort", onAbort);
  }
}
