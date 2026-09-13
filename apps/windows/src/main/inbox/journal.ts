// The durable task journal.
//
// ## What it is for
//
// Publication and the completion ACK are irreversible in different directions.
// Publishing creates files the user can see; ACKing tells central the delivery
// is done and it may be discarded. A crash between them must resolve to exactly
// one outcome, and the only way to know which is to have written the intent
// down first.
//
// So the ordering is: record the intent, publish, record the result, ACK,
// record the ACK. Every step is durable before the effect it describes.
//
// ## What reconciliation must NOT do
//
// A task recorded as published but not ACKed is replayed by **re-sending the
// ACK**, never by re-publishing. Re-publishing would either duplicate the
// user's files or fail against its own earlier output; the recorded
// `publishedCount` prefix is authoritative and is neither duplicated nor
// dropped.
//
// ## What it deliberately does not hold
//
// No filenames, no text, no paths. A journal is metadata: task ids, counts and
// a phase. The user's content lives in the vault, and a diagnostic store is the
// last place it should accumulate. Records are still encrypted at rest, because
// a task id is linkable even when it is not content.
import { AtRestError, importAtRestKey, open, seal, type AtRestKind } from "./atrest.js";
import type { AccountContext } from "./account.js";

const JOURNAL_KIND: AtRestKind = "journal";
/**
 * Version 2 is the only readable format, and its watermark is REQUIRED.
 *
 * ## Why v1 is refused rather than migrated
 *
 * A v1 document carried no watermark and stored server expiries in wire
 * seconds. Reading one would mean inventing both: a horizon it never recorded,
 * and a unit conversion applied to values this build cannot distinguish from
 * already-converted ones. An earlier revision of this file did exactly that and
 * got both halves wrong — v1 records were validated without converting their
 * expiries, so every v1 partial stayed immediately evictable, and a missing
 * history was inferred as `0`, which is the LEAST conservative answer rather
 * than a safe default.
 *
 * The Inbox has never been in a shipped candidate and has never been public, so
 * there is no v1 document in anyone's profile to migrate. Refusing is therefore
 * strictly safer than guessing, and it is what happens: a v1 document is
 * `unreadable`, and the BYTES ARE LEFT ALONE. Nothing resets, nothing deletes,
 * and an operator can still inspect or move the file.
 */
const JOURNAL_VERSION = 2;

/**
 * The wire speaks SECONDS; this journal speaks MILLISECONDS.
 *
 * `newInboxTaskView` serialises `CreatedAt`/`ExpiresAt` from `s.now().Unix()`,
 * while every local timestamp here comes from `Date.now()`. Comparing the two
 * directly is not an off-by-a-bit, it inverts two decisions completely:
 *
 *  - `evictable` asked `now > serverExpiresAt` with `now` in milliseconds and
 *    the expiry in seconds, so EVERY record carrying a server expiry was
 *    immediately evictable — retention would drop records central had not
 *    finished with;
 *  - `isSettled` asked `deliveryCreatedAt <= prunedBefore` the same way, so once
 *    anything had been pruned EVERY future delivery answered `unknown` and the
 *    receiver would refuse all of them.
 *
 * So server times are normalised the moment they enter, and every comparison
 * below is milliseconds against milliseconds.
 */
function msFromWireSeconds(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return 0;
  return seconds * 1000;
}

/** Where a task had got to when the last durable write happened. */
export type TaskPhase =
  /** Claimed and about to be written. Nothing irreversible has happened. */
  | "claimed"
  /** A publish is about to run. On restart this is AMBIGUOUS — see needsReconcile. */
  | "publishing"
  /** Published in FULL; the ACK has not been confirmed. Replay the ACK. */
  | "published"
  /** A prefix was published and the batch cannot be completed. NOT ackable. */
  | "partial"
  /** Fully settled: published in full and ACKed. */
  | "acked"
  /** Terminal without publication. */
  | "failed";

/** Exported so a test can hold the page's phase copy against this list. */
export const PHASES: readonly TaskPhase[] = ["claimed", "publishing", "published", "partial", "acked", "failed"];

/**
 * Which transitions are legal.
 *
 * A table rather than scattered conditionals, because the illegal moves are the
 * point: `partial -> acked` would tell central a partial batch was complete,
 * and any backward move would let a settled task be re-driven. Both were
 * possible before this existed.
 *
 * `published` requires a FULL publish and is the only phase that may be ACKed.
 * `partial`, `acked` and `failed` are terminal — nothing follows them.
 */
const ALLOWED: Readonly<Record<TaskPhase, readonly TaskPhase[]>> = {
  claimed: ["publishing", "failed"],
  publishing: ["published", "partial", "failed"],
  published: ["acked"],
  partial: [],
  acked: [],
  failed: [],
};

/** Live tasks tracked at once. A journal is not an unbounded log. */
export const MAX_JOURNAL_TASKS = 256;

/** Bounds on the identifiers a record may carry, so a record cannot be huge. */
const MAX_ID_LENGTH = 256;

/**
 * The retention policy, stated once and exported because the receiver has to
 * honour it.
 *
 * ## Local terminality is not permission to forget
 *
 * A record may be evicted only when the SERVER side is provably finished with
 * the delivery: central reported it terminal, or its advertised expiry has
 * passed. A locally terminal operation is not the same thing — a `partial` has
 * `publishedCount > 0` and central has NOT completed the delivery, so dropping
 * that record loses the only authoritative statement of which files already
 * exist, and a redelivery would then re-drive or duplicate them.
 *
 * ## Dedup is horizon-bounded and says so
 *
 * An `acked` record is an idempotency tombstone. Aging it out is necessary —
 * the journal is bounded — but it means dedup can no longer answer for a
 * delivery created before the retained window. `isSettled` therefore returns
 * `unknown` for that case rather than `false`, because "we have no record" and
 * "it never happened" are different claims and only one of them is safe to act
 * on.
 */
export const RETENTION = Object.freeze({
  /**
   * Local fallback horizon for an acked tombstone when central advertised no
   * expiry. Deliberately generous: it bounds memory, not correctness, and the
   * cost of keeping a tombstone too long is a few hundred bytes.
   */
  ackedTombstoneMs: 30 * 24 * 60 * 60 * 1000,
});

export interface TaskRecord {
  readonly taskID: string;
  /** Central's idempotency key when the delivery carries one. */
  readonly idempotencyKey: string;
  readonly phase: TaskPhase;
  /** Manifest item total this task was accepted against. */
  readonly manifestTotal: number;
  /** Files actually published, as the helper receipt reported. */
  readonly publishedCount: number;
  /** True for a text delivery saved to the vault rather than to disk. */
  readonly text: boolean;
  readonly updatedAt: number;
  /**
   * Central reported this delivery terminal — it will not be redelivered.
   *
   * The ONLY thing that makes a non-acked record evictable. Set from the task
   * state central returns, never inferred from a local outcome.
   */
  readonly serverTerminal: boolean;
  /**
   * Central's advertised expiry in MILLISECONDS, or 0 when it advertised none.
   *
   * Normalised on the way in. It arrives from the wire in seconds, and
   * `evictable` compares it against a millisecond clock — raw, every record
   * with an expiry was immediately evictable.
   */
  readonly serverExpiresAt: number;
}

export type JournalFailure =
  | "unreadable"
  | "total-mismatch"
  | "illegal-transition"
  | "count-out-of-range"
  | "retention-full"
  | "not-recorded";

export class JournalError extends Error {
  constructor(readonly code: JournalFailure, message?: string) {
    super(message ?? code);
    this.name = "JournalError";
  }
}

/** The filesystem operations a journal needs. Injected so tests need no disk. */
export interface JournalFiles {
  readFile(path: string): Promise<Uint8Array>;
  /** Must be atomic: write to a temporary name and rename over the target. */
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

interface JournalFile {
  readonly v: number;
  readonly tasks: readonly TaskRecord[];
  /**
   * The dedup horizon, in milliseconds. REQUIRED, not optional.
   *
   * It MUST live in the same document as the tasks: it is a statement about
   * which records are gone, and a watermark written separately could disagree
   * with the list it describes. Held only in memory it was worse than useless —
   * a fresh process started at 0 and answered `not-settled` for deliveries it
   * could no longer vouch for, which is exactly the post-crash case the
   * tri-state exists for.
   */
  readonly watermark: number;
}

function validateRecord(value: unknown, index: number): TaskRecord {
  const refuse = (why: string): never => {
    throw new JournalError("unreadable", `journal record ${index}: ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("not an object");
  const r = value as Record<string, unknown>;
  const str = (field: string, required: boolean): string => {
    const v = r[field];
    if (typeof v !== "string") return refuse(`${field} is not a string`);
    if (v.length > MAX_ID_LENGTH) return refuse(`${field} exceeds ${MAX_ID_LENGTH} characters`);
    if (required && v.length === 0) return refuse(`${field} is empty`);
    return v;
  };
  const int = (field: string): number => {
    const v = r[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return refuse(`${field} is not a non-negative integer`);
    return v;
  };
  const phase = r["phase"];
  if (typeof phase !== "string" || !PHASES.includes(phase as TaskPhase)) return refuse("phase is not a known phase");
  const manifestTotal = int("manifestTotal");
  const publishedCount = int("publishedCount");
  // The same bound `advance` enforces, applied to what is already on disk.
  if (publishedCount > manifestTotal) return refuse("publishedCount exceeds manifestTotal");
  if (phase === "published" && publishedCount !== manifestTotal) {
    return refuse("published record is not a full publish");
  }
  if (phase === "acked" && publishedCount !== manifestTotal) {
    return refuse("acked record is not a full publish");
  }
  if (typeof r["text"] !== "boolean") return refuse("text is not a boolean");
  if (typeof r["serverTerminal"] !== "boolean") return refuse("serverTerminal is not a boolean");
  if (phase === "failed" && publishedCount !== 0) {
    // A failure that published a prefix is `partial`, not `failed`: the
    // distinction is what decides whether a redelivery may re-drive it.
    return refuse("failed record reports a published prefix");
  }
  return {
    taskID: str("taskID", true),
    idempotencyKey: str("idempotencyKey", false),
    phase: phase as TaskPhase,
    manifestTotal,
    publishedCount,
    text: r["text"],
    updatedAt: int("updatedAt"),
    serverTerminal: r["serverTerminal"],
    serverExpiresAt: int("serverExpiresAt"),
  };
}

/**
 * May this record be evicted?
 *
 * Requires PROOF the server is finished. `acked` additionally ages out on a
 * bounded horizon, because a tombstone whose delivery can no longer be replayed
 * has nothing left to protect.
 */
export function evictable(task: TaskRecord, now: number): boolean {
  if (task.serverTerminal) return true;
  if (task.serverExpiresAt > 0 && now > task.serverExpiresAt) return true;
  if (task.phase === "acked" && now - task.updatedAt > RETENTION.ackedTombstoneMs) return true;
  return false;
}

/**
 * What reconciliation may do with a task found mid-flight at startup.
 *
 * A discriminated union so a caller CANNOT accidentally treat the ambiguous
 * case as ackable. `published` is safe to replay because the record proves a
 * full publish already happened. `publishing` is not: the process died with a
 * publish in flight, and this journal records counts, not destination identity
 * or a receipt, so nothing here establishes what actually landed. Auto-ACKing
 * it would claim a save that may not exist; re-publishing it would duplicate
 * files or collide with its own earlier output.
 */
/**
 * Whether a delivery has already been settled.
 *
 * Three answers, not two: `unknown` means the journal evicted records that
 * could have covered this delivery, so it cannot say. A caller must treat that
 * as "ask central", never as "go ahead".
 */
export type SettledVerdict = "settled" | "not-settled" | "unknown";

export type Reconciliation =
  | { readonly kind: "replay-ack"; readonly task: TaskRecord }
  | {
      readonly kind: "blocked";
      readonly task: TaskRecord;
      /** Why this cannot be resolved from the journal alone. */
      readonly reason: "publish-outcome-unknown";
    };

export class TaskJournal {
  private readonly path: string;
  private key: CryptoKey | null = null;
  private cache: readonly TaskRecord[] | null = null;
  /** Newest `updatedAt` among evicted records; bounds what dedup can claim. */
  private prunedBefore = 0;
  /** Serialises writes so two updates cannot lose one another. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: AccountContext,
    private readonly files: JournalFiles,
    private readonly keyBytes: () => Promise<Uint8Array>,
  ) {
    this.path = `${context.directory}/journal.enc`;
  }

  private async cryptoKey(): Promise<CryptoKey> {
    this.key ??= await importAtRestKey(await this.keyBytes());
    return this.key;
  }

  private async load(): Promise<readonly TaskRecord[]> {
    if (this.cache !== null) return this.cache;
    let sealed: Uint8Array;
    try {
      sealed = await this.files.readFile(this.path);
    } catch (error) {
      // ONLY an explicit ENOENT means "no journal yet".
      //
      // A catch-all here was worse than it looks: EACCES or EIO became an empty
      // history, and the very next write OVERWROTE the journal that could not
      // be read — destroying the record of what had already been published and
      // ACKed. A permission blip would have turned into duplicate saves.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        this.cache = [];
        return this.cache;
      }
      throw new JournalError("unreadable", `journal is unavailable (${code ?? "unknown"})`);
    }
    const plaintext = await open(await this.cryptoKey(), this.context.accountKey, JOURNAL_KIND, sealed);
    let parsed: JournalFile;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext)) as JournalFile;
    } catch {
      throw new JournalError("unreadable", "journal is not JSON");
    }
    if (!Array.isArray(parsed.tasks)) {
      throw new JournalError("unreadable", "journal is malformed");
    }
    // Exactly one readable version. Anything else — an older v1, or a document
    // written by a later build — is REFUSED and its bytes are left untouched.
    if (parsed.v !== JOURNAL_VERSION) {
      throw new JournalError("unreadable", `journal version ${String(parsed.v)}`);
    }
    // The watermark is part of the format, not an optional extra. Accepting a
    // missing one as `0` would defeat the strictness above: a truncated or
    // hand-edited document would silently become a journal claiming it had
    // never pruned anything.
    const mark = parsed.watermark;
    if (typeof mark !== "number" || !Number.isSafeInteger(mark) || mark < 0) {
      throw new JournalError("unreadable", "journal watermark is missing or malformed");
    }
    this.prunedBefore = mark;
    if (parsed.tasks.length > MAX_JOURNAL_TASKS) {
      throw new JournalError("unreadable", `journal holds ${parsed.tasks.length} records`);
    }
    // Every record is checked. Trusting the array's shape meant a malformed or
    // hostile journal could yield a record with a phase outside the closed set,
    // a count past the total, or an unbounded id — and the reconciliation logic
    // would then act on it.
    this.cache = parsed.tasks.map((record, index) => validateRecord(record, index));
    return this.cache;
  }

  /**
   * Write the records and the watermark as ONE document.
   *
   * The cache and the in-memory watermark are updated only AFTER the write
   * lands. An earlier shape advanced the watermark before persisting, so a
   * failed write left this process claiming a horizon the disk did not have.
   */
  private async persist(tasks: readonly TaskRecord[], watermark = this.prunedBefore): Promise<void> {
    await this.files.mkdirp(this.context.directory);
    const document: JournalFile = { v: JOURNAL_VERSION, tasks, watermark };
    const plaintext = new TextEncoder().encode(JSON.stringify(document));
    const sealed = await seal(await this.cryptoKey(), this.context.accountKey, JOURNAL_KIND, plaintext);
    await this.files.writeAtomic(this.path, sealed);
    this.cache = tasks;
    this.prunedBefore = watermark;
  }

  /** Run an update with exclusive ownership of the journal. */
  private update<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async all(): Promise<readonly TaskRecord[]> {
    return this.load();
  }

  async find(taskID: string): Promise<TaskRecord | null> {
    return (await this.load()).find((t) => t.taskID === taskID) ?? null;
  }

  /**
   * Has this delivery already been settled?
   *
   * Keyed on the idempotency key when the delivery carries one, falling back to
   * the task id. Central may redeliver a task under a new id with the same
   * idempotency key, and treating that as new would save the same message twice.
   */
  async isSettled(
    taskID: string,
    idempotencyKey: string,
    /**
     * Central's creation time for this delivery, in WIRE SECONDS.
     *
     * The unit is the caller-visible contract and is normalised here. The
     * watermark is milliseconds, and comparing the two raw made every delivery
     * answer `unknown` once anything had been pruned.
     */
    deliveryCreatedAtSeconds: number,
  ): Promise<SettledVerdict> {
    const tasks = await this.load();
    const match = tasks.some(
      (t) =>
        t.phase === "acked" &&
        (t.taskID === taskID || (idempotencyKey.length > 0 && t.idempotencyKey === idempotencyKey)),
    );
    if (match) return "settled";
    // No record. That is only "not settled" for a delivery created INSIDE the
    // retained window; older than the watermark, this journal simply cannot
    // answer, and reporting `false` would be claiming a universal dedup it does
    // not have.
    const createdAtMs = msFromWireSeconds(deliveryCreatedAtSeconds);
    if (this.prunedBefore > 0 && createdAtMs <= this.prunedBefore) return "unknown";
    return "not-settled";
  }

  /** The newest record this journal has evicted, or 0 if it has evicted none. */
  get dedupHorizon(): number {
    return this.prunedBefore;
  }

  /** Record a claim. Refuses a replay whose manifest total has changed. */
  async recordClaimed(args: {
    readonly taskID: string;
    readonly idempotencyKey: string;
    readonly manifestTotal: number;
    readonly text: boolean;
    readonly now: number;
    /** Central's advertised expiry, in WIRE SECONDS. Stored as milliseconds. */
    readonly serverExpiresAt?: number;
  }): Promise<TaskRecord> {
    return this.update(async () => {
      const tasks = await this.load();
      let pendingWatermark = this.prunedBefore;
      const existing = tasks.find((t) => t.taskID === args.taskID);
      if (existing !== undefined && existing.manifestTotal !== args.manifestTotal) {
        // The same task arriving with a different total is not something to
        // merge: one of the two descriptions of what the user is receiving is
        // wrong, and picking either would publish a batch nobody described.
        throw new JournalError(
          "total-mismatch",
          `task was recorded with ${existing.manifestTotal} items and now claims ${args.manifestTotal}`,
        );
      }
      if (existing !== undefined) return existing;

      // Bounded. Settled records are pruned oldest-first to make room; if every
      // record is still live, the claim is REFUSED rather than tracked without
      // a durable home, because an untracked task is one whose publish cannot
      // be reconciled.
      let room = tasks;
      if (room.length >= MAX_JOURNAL_TASKS) {
        // Eviction requires PROOF the server is done — see RETENTION. Phase
        // alone is not enough: an earlier version treated `partial` and
        // `failed` as settled because the LOCAL operation had finished, which
        // discarded the saved-prefix authority for a delivery central had not
        // completed and left a redelivery free to duplicate it.
        const prunable = room.filter((t) => evictable(t, args.now));
        if (prunable.length === 0) {
          throw new JournalError(
            "retention-full",
            `${room.length} records are retained and none is provably settled server-side; refusing to track another`,
          );
        }
        const drop = room.length - MAX_JOURNAL_TASKS + 1;
        const dropped = new Set(
          [...prunable].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, drop),
        );
        if (dropped.size < drop) {
          throw new JournalError(
            "retention-full",
            `only ${dropped.size} of ${drop} records needed are provably settled server-side`,
          );
        }
        // The watermark is what keeps dedup honest afterwards, and it is
        // adopted only when the write that drops these records lands.
        for (const gone of dropped) {
          if (gone.updatedAt > pendingWatermark) pendingWatermark = gone.updatedAt;
        }
        room = room.filter((t) => !dropped.has(t));
      }

      const record: TaskRecord = {
        taskID: args.taskID,
        idempotencyKey: args.idempotencyKey,
        phase: "claimed",
        manifestTotal: args.manifestTotal,
        publishedCount: 0,
        text: args.text,
        updatedAt: args.now,
        serverTerminal: false,
        serverExpiresAt: msFromWireSeconds(args.serverExpiresAt ?? 0),
      };
      await this.persist([...room, record], pendingWatermark);
      return record;
    });
  }

  /** Move a task to a new phase, durably, before the effect it describes. */
  async advance(taskID: string, phase: TaskPhase, publishedCount: number, now: number): Promise<void> {
    return this.update(async () => {
      const tasks = await this.load();
      const at = tasks.findIndex((t) => t.taskID === taskID);
      const existing = at >= 0 ? tasks[at] : undefined;
      if (existing === undefined) throw new JournalError("not-recorded", "advancing an unrecorded task");

      if (!ALLOWED[existing.phase].includes(phase)) {
        // Covers both directions of the two moves that matter: a partial can
        // never become acked, and nothing terminal can be re-driven.
        throw new JournalError(
          "illegal-transition",
          `${existing.phase} -> ${phase} is not a legal transition`,
        );
      }
      if (publishedCount > existing.manifestTotal) {
        throw new JournalError(
          "count-out-of-range",
          `publishedCount ${publishedCount} exceeds the ${existing.manifestTotal} items this task declared`,
        );
      }
      if (publishedCount < existing.publishedCount) {
        // The prefix only grows. A smaller count would claim files un-published.
        throw new JournalError(
          "count-out-of-range",
          `publishedCount ${publishedCount} is below the recorded ${existing.publishedCount}`,
        );
      }
      if (phase === "published" && publishedCount !== existing.manifestTotal) {
        throw new JournalError(
          "count-out-of-range",
          "published requires a full publish; a prefix is `partial`",
        );
      }
      if (phase === "partial" && (publishedCount === 0 || publishedCount === existing.manifestTotal)) {
        throw new JournalError("count-out-of-range", "partial requires a proper prefix");
      }

      const updated = [...tasks];
      updated[at] = { ...existing, phase, publishedCount, updatedAt: now };
      await this.persist(updated);
    });
  }

  /**
   * Tasks that need reconciling at startup.
   *
   * `published` replays the ACK. `publishing` is the genuinely ambiguous one —
   * the process died with a publish in flight — and it is reported rather than
   * resolved here, because only the destination can say what landed.
   */
  async needsReconcile(): Promise<readonly Reconciliation[]> {
    const tasks = await this.load();
    const out: Reconciliation[] = [];
    for (const task of tasks) {
      if (task.phase === "published") out.push({ kind: "replay-ack", task });
      else if (task.phase === "publishing") {
        out.push({ kind: "blocked", task, reason: "publish-outcome-unknown" });
      }
    }
    return out;
  }

  /**
   * Record what central said about this delivery's lifetime.
   *
   * The only route to `serverTerminal`, and deliberately separate from
   * `advance`: local progress and server terminality are different facts, and
   * conflating them is what let a locally-finished task be evicted.
   */
  async recordServerState(
    taskID: string,
    /** `expiresAt` is in WIRE SECONDS; it is stored as milliseconds. */
    state: { readonly terminal: boolean; readonly expiresAt: number },
    now: number,
  ): Promise<void> {
    return this.update(async () => {
      const tasks = await this.load();
      const at = tasks.findIndex((t) => t.taskID === taskID);
      const existing = at >= 0 ? tasks[at] : undefined;
      if (existing === undefined) throw new JournalError("not-recorded", "unrecorded task");
      const updated = [...tasks];
      updated[at] = {
        ...existing,
        serverTerminal: existing.serverTerminal || state.terminal,
        serverExpiresAt:
          state.expiresAt > 0 ? msFromWireSeconds(state.expiresAt) : existing.serverExpiresAt,
        updatedAt: now,
      };
      await this.persist(updated);
    });
  }

  /** Forget provably settled tasks, freeing retention without touching live ones. */
  async pruneSettled(now: number): Promise<number> {
    return this.update(async () => {
      const tasks = await this.load();
      const keep = tasks.filter((t) => !evictable(t, now));
      if (keep.length === tasks.length) return 0;
      // Computed, then persisted WITH the records, then adopted. Advancing the
      // field first meant a failed write left this process claiming a horizon
      // the disk did not have.
      let watermark = this.prunedBefore;
      for (const gone of tasks.filter((t) => evictable(t, now))) {
        if (gone.updatedAt > watermark) watermark = gone.updatedAt;
      }
      await this.persist(keep, watermark);
      return tasks.length - keep.length;
    });
  }
}

export { AtRestError };
