/** Ciphertext prepared while an upload waits for its next durable answer.
 * One serial producer, at most the budget plus one whole frame in the queue.
 * No request or acknowledgement is performed here. */
export const UPLOAD_AHEAD_BYTES = 1 << 20;
type Frame = Uint8Array<ArrayBuffer>;

export class UploadFrameAhead {
  private queue: Frame[] = [];
  private bytes = 0;
  private started = false;
  private stopped = false;
  private done = false;
  private failure: { error: unknown } | undefined;
  private pumping: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private abort = () => { this.stopped = true; this.notify(); };

  constructor(
    private source: AsyncGenerator<Frame, void>,
    private signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.stopped = true;
  }

  /** Includes whole frames retained by this queue, separate from the uploader's
   * replay buffer. The producer can also have one frame being sealed. */
  get bufferedBytes(): number { return this.bytes; }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** Called after the first PATCH starts; the first body needs no speculation. */
  start(): void {
    this.started = true;
    this.fill();
  }

  private fill(): void {
    if (this.pumping || this.stopped || this.done || this.failure) return;
    this.pumping = (async () => {
      try {
        while (!this.stopped && this.bytes < UPLOAD_AHEAD_BYTES) {
          const r = await this.source.next();
          if (this.stopped) break; // an unabortable read may settle after cancel
          if (r.done) { this.done = true; break; }
          this.queue.push(r.value);
          this.bytes += r.value.byteLength;
          this.notify();
        }
      } catch (error) {
        // Observe immediately, even if the network request is still pending.
        // Earlier queued frames retain their position before this failure.
        this.failure = { error };
      }
    })().finally(() => { this.pumping = undefined; this.notify(); });
  }

  async next(): Promise<IteratorResult<Frame, void>> {
    if (this.stopped) throw new DOMException("aborted", "AbortError");
    if (!this.started) return this.source.next();
    for (;;) {
      const frame = this.queue.shift();
      if (frame) {
        this.bytes -= frame.byteLength;
        this.fill();
        return { done: false, value: frame };
      }
      if (this.failure) throw this.failure.error;
      if (this.done) return { done: true, value: undefined };
      // Wait only for the next frame, never for the entire speculative pack.
      const ready = new Promise<void>((resolve) => { this.wake = resolve; });
      this.fill();
      await ready;
      if (this.stopped) throw new DOMException("aborted", "AbortError");
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.notify();
    this.signal?.removeEventListener("abort", this.abort);
    await this.pumping;
    this.queue = [];
    this.bytes = 0;
    await this.source.return(undefined);
  }
}
