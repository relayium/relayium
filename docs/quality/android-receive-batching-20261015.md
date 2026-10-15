# Android realtime receive: coalesced durable writes (O7)

Status: source batch, not released. Physical-device throughput, SAF export and
process-kill/power-loss behaviour are **unverified** — no Android phone was
connected. Nothing here is a phone, SAF or WAN measurement.

## What changed

Before: every decrypted realtime chunk (≤192 KiB) was one storage task doing
`append` + `fsync`, and the receiver's cumulative ACK could advance only after
that task's own fsync.

Now (`TransferController.onWrite` → `storage/DurableWriteQueue`):

- Each chunk is still one storage task, but its entry also sits in a bounded
  queue. When a task runs it takes its own entry **plus whatever is already
  queued contiguously behind it** (same receive generation, no intervening
  begin/export/discard/finish barrier), appends them in order, then fsyncs each
  affected staging file once (`ReceiveStore.appendStaged` / `syncStaged`).
- The run reports durable only if every append and every fsync succeeded; only
  then does the session thread add its bytes to `receivedBytes` and call
  `FileLaneSession.onDurableBytes` once with the new cumulative total. A failed
  append or fsync fails the whole run (no ACK for any of its bytes), cancels the
  receive truthfully, and poisons the generation so later queued writes of that
  batch do no further I/O on a sink of unknown state.
- A run never waits for more input: budgets are 2 MiB (¼ flow window), 64
  chunks, 25 ms of appending; an empty queue, a barrier or a budget ends it.
- Plaintext is not copied. Entries reference the chunk already counted by the
  existing `STORAGE_QUEUE_MAX_BYTES`/`TASKS` caps (unchanged). The payload is
  detached from the entry on retirement (`clear` at every receive-generation
  bump, `withdraw`, fenced-off orphans) and moved into the run when taken, so
  queued no-op executor tasks pin only metadata. An append in progress keeps
  its own bytes; a concurrent retirement never touches them, and the
  generation fence still drops its completion.
- A storage executor that refuses a write now withdraws the entry, releases its
  gauges and fails the receive visibly (`error_save_failed` + REJECT) instead of
  stalling silently.
- `ReceiveStore.write` is unchanged: standalone append + fsync per call (cloud
  download and any other caller). Only the exact `ReceiveStore` class batches
  (`batchesWrites`); a subclass that customises `write` — test doubles, the
  debug `HeldFirstWriteStore` hold gate used by instrumentation — keeps one
  write = one append + fsync per chunk.

Unchanged: wire protocol, crypto, flow window, ACK interval, queue caps,
export (verified-before-visible copy, collision/auto-rename refusal, ledgered
non-recursive cleanup, provider failure handling), COMPLETE only after every
export closed.

## Evidence (author, host JVM, offline Gradle 9.3.1 / JDK 17)

Raw logs: `artifacts/transfer-all-optimizations-20261014/android-io/r2/`.

- Owning suites: `DurableWriteQueueTest` 25, `ReceiveStoreTest` 24,
  `TransferControllerTest` 80 — 0 failures. Full `:app:testDebugUnitTest`
  94 suites / 1459 tests, 0 failures, 0 skips; `:app:assembleDebug` succeeded.
- ACK-after-fsync is checked against real staging-file effects at the instant
  each ACK frame is sent (`ack ≤ fsync-covered bytes`, strictly increasing),
  not against a returned `Outcome.Ok`.
- Baseline control (71f07459f sources, same new test): the coalescing test
  fails `saw 21 fsyncs for 21 chunks`; the safety tests pass on baseline.
- Mutation controls, each killed: durable despite failed sync; fsync skipped;
  `clear` keeps payload (Root's 32 × 64 KiB retained-payload case);
  barrier ignored; rejected submission only withdraws.
- Real-file before/after (32 MiB single file, 1000 small files; every file
  SHA-256 verified; "before" = the per-chunk path through the same controller):

  | sync delay (SIMULATED) | shape | fsyncs before → after | host wall ms before → after |
  |---|---|---|---|
  | 0 ms | 32 MiB / 171 chunks | 171 → 171 | 1014 → 954 |
  | 2 ms | 32 MiB | 171 → 171 | 936 → 941 |
  | 8 ms | 32 MiB | 171 → 73 | 1891 → 930 |
  | 0 / 2 / 8 ms | 1000 small files | 1000 → 1000 | ≈ unchanged |

  In this harness the sealed-frame feeder, not the disk, is the bottleneck, so
  coalescing engages only when a sync is slower than chunk arrival. Small files
  do not coalesce by design: every file's export is a barrier and each small
  file is one chunk. Host timings were taken while other workspace jobs ran and
  are indicative only.

## Pending (not claimed)

- Physical Android: real fsync cost on device storage, end-to-end throughput,
  SAF provider export, process kill / power loss mid-run.
- Coalescing across small-file export barriers would need a separate design
  (export of file *i* overlapped with writes of file *i+1*); not done.
