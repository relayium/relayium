// The durable send plan: what a retry in another process must be able to read.
//
// ## Why the randomized sealed box is on disk
//
// `crypto_box_seal` is randomized, so sealing the same content key twice gives
// two different values. Central keys a create on the idempotency key AND the
// request that carried it, so a retry that re-sealed would arrive as a
// DIFFERENT request under the same key — an idempotency conflict rather than
// the convergence it was meant to be. The exact bytes sent the first time are
// therefore persisted, and reused verbatim.
//
// Nothing here holds a content key, a plaintext name, or a message. The plan is
// encrypted at rest with the account's own key, exactly as the journal and the
// vault are, and its shape carries no field a plaintext could travel in.
import { AT_REST_KEY_BYTES, AtRestError, open as openRecord, seal as sealRecord } from "./atrest.js";
import type { AccountContext } from "./account.js";

const PLAN_VERSION = 3;
const MAX_ID_LENGTH = 256;
/** Live plans at once. A plan store is not an unbounded log. */
export const MAX_SEND_PLANS = 128;
/** The largest plan document this build will parse, before it parses it. */
export const MAX_PLAN_DOCUMENT_BYTES = 1 << 20;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url length for `n` bytes. */
function base64urlLength(n: number): number {
  return Math.ceil((4 * n) / 3);
}

/** How far a plan has got. Ordered; a plan never moves backwards. */
export type SendPhase =
  /**
   * Staged locally. NOTHING has been attempted against the server.
   *
   * The only phase from which the staged bytes are safe to drop, and it stops
   * being true the moment an upload is initiated — not when one is recorded.
   */
  | "staged"
  /**
   * An upload was INITIATED. An object may exist that this side cannot name.
   *
   * Entered BEFORE `init` is called, because a response that never arrives
   * still leaves whatever the server did. A plan here is never treated as
   * having no object.
   */
  | "uploading"
  /**
   * A finalize was attempted and its outcome was NOT observed.
   *
   * Distinct from `uploading` because the object is more likely to exist, and
   * distinct from `uploaded` because this side cannot name it. Never safe to
   * drop, and never reported as "no object".
   */
  | "upload-unknown"
  /** Finalize returned an id. The object exists and is named. */
  | "uploaded"
  /** A create was attempted. A delivery MAY be live — release nothing. */
  | "creating"
  /** Central returned a task. Its id is recorded. */
  | "created"
  /** Local tidy-up finished. */
  | "settled"
  /**
   * This job will make NO further attempt. It says nothing about the server.
   *
   * Deliberately NOT `settled`. `settled` means the delivery reached its end and
   * nothing of it is owed; `abandoned` means only that this side stopped, which
   * is the truthful terminal for three different situations:
   *
   *  - a definitive refusal whose best-effort object release did not succeed —
   *    the ciphertext is still out there, for central's collector to reclaim;
   *  - an `upload-unknown` the caller explicitly gave up on;
   *  - a `creating` plan central definitively refused.
   *
   * `storedObjectID` is what distinguishes them: it is cleared ONLY by a release
   * this side observed succeed, so an abandoned plan that still names an object
   * is ciphertext left for central's own collector, and one that names none is
   * done. `safeToDrop` is false here for exactly that reason.
   */
  | "abandoned";

const ALLOWED: Readonly<Record<SendPhase, readonly SendPhase[]>> = {
  // A staged plan may be abandoned; nothing exists yet.
  staged: ["uploading", "settled", "abandoned"],
  // An upload in flight may resume, reach an unknown finalize, or complete.
  // It may NOT return to `staged`: that would re-assert that nothing exists.
  uploading: ["uploading", "upload-unknown", "uploaded", "abandoned"],
  // An unobserved finalize can only be resolved by asking the server. It never
  // becomes `staged` and never becomes `settled` on a guess — `abandoned` is
  // the honest terminal, and it does not claim the object is gone.
  "upload-unknown": ["upload-unknown", "uploaded", "abandoned"],
  uploaded: ["creating", "settled", "abandoned"],
  // Deliberately NOT back to `uploaded`: once a create has been attempted the
  // outcome is unknown until central says otherwise, and re-entering an earlier
  // phase is how a second task gets created for one delivery.
  //
  // `settled` is deliberately NOT here either. A create was attempted, so
  // "finished, nothing owed" is a claim this phase can never support; a
  // definitively refused create ends at `abandoned`, which retains the object id
  // until a release is observed.
  creating: ["created", "creating", "abandoned"],
  created: ["settled"],
  settled: [],
  abandoned: [],
};

/**
 * May the staged bytes and the object be released?
 *
 * ONLY from `staged`, where nothing has been attempted, and from `settled`,
 * where the delivery is finished. Every other phase describes something that
 * may exist on the server, and dropping it there destroys either the user's
 * only copy or a live delivery.
 *
 * `abandoned` is NOT droppable. This side stopped trying; that is not the same
 * as knowing nothing is left, and an abandoned plan that still names an object
 * is precisely the record a retryable cleanup works from.
 */
export function safeToDrop(phase: SendPhase): boolean {
  return phase === "staged" || phase === "settled";
}

/**
 * An abandoned plan that still names ciphertext nothing binds.
 *
 * Reported, not owed: central refuses a task-purpose delete and reclaims the
 * object with its own collector. This exists so a host can SAY what was left.
 */
export function namesOrphan(plan: SendPlanRecord): boolean {
  return plan.phase === "abandoned" && plan.storedObjectID.length > 0;
}

export type PlanFailure = "unreadable" | "illegal-transition" | "not-found" | "malformed";

export class SendPlanError extends Error {
  constructor(
    readonly code: PlanFailure,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SendPlanError";
  }
}

export interface SendPlanRecord {
  readonly jobID: string;
  readonly targetDeviceID: string;
  readonly kind: "file" | "text";
  readonly phase: SendPhase;
  /** Chosen once, reused by every attempt. Central keys the create on it. */
  readonly idempotencyKey: string;
  /** The EXACT randomized sealed box that was sent, or "" before one was. */
  readonly wrappedKey: string;
  /**
   * The protocol version and wrap algorithm THAT REQUEST CARRIED.
   *
   * Persisted rather than re-derived, for the same reason the sealed box is.
   * "Repeat the exact request" is only structural if every field of it is on
   * disk: a later build with a different negotiated version or algorithm would
   * otherwise rebuild a DIFFERENT request under the same idempotency key. Worse
   * than a conflict — `handleCreateInboxTask` validates both BEFORE it reaches
   * the idempotent replay, so the retry would be refused without ever asking
   * whether the first attempt had already succeeded.
   *
   * Empty/zero only before a request has been composed.
   */
  readonly protocolVersion: number;
  readonly wrapAlgorithm: string;
  readonly targetKeyID: string;
  readonly targetKeyGeneration: number;
  /** True once this plan has followed a rotation. A second one is a dead end. */
  readonly resealed: boolean;
  /** The stored object, or "" before one exists. */
  readonly storedObjectID: string;
  /** The server's upload id, retained from the moment one is initiated. */
  readonly uploadID: string;
  /**
   * A digest of the EXACT sealed manifest this plan uploaded.
   *
   * Recovery's identity when the object id was never observed: the same plan
   * always seals the same document, so the digest names what to look for.
   */
  readonly manifestDigest: string;
  /** Central's task, once it has named one. */
  readonly taskID: string;
  readonly updatedAt: number;
}

interface PlanFile {
  readonly v: number;
  readonly plans: readonly SendPlanRecord[];
}

export interface PlanFiles {
  readFile(path: string): Promise<Uint8Array>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

function bounded(value: string, what: string, allowEmpty = false): string {
  if ((!allowEmpty && value.length === 0) || value.length > MAX_ID_LENGTH) {
    throw new SendPlanError("malformed", `${what} is empty or unbounded`);
  }
  return value;
}

/**
 * One account's send plans.
 *
 * Single-writer for the account's lifetime: every read-modify-write is
 * serialised, so two attempts on the same job cannot each read the plan before
 * the other's write lands and then both create.
 */
export class SendPlanStore {
  private readonly path: string;
  private key: CryptoKey | null = null;
  private cache: readonly SendPlanRecord[] | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  private readonly wrappedKeyLength: number;

  constructor(
    private readonly context: AccountContext,
    private readonly files: PlanFiles,
    private readonly keyBytes: () => Promise<Uint8Array>,
    /**
     * `runtime.constants.sealedBoxBytes`.
     *
     * Passed in rather than read here so the exact length is checked against
     * the same constant the seal was produced with, and so this store does not
     * depend on the runtime bundle.
     */
    sealedBoxBytes: number,
  ) {
    this.path = `${context.directory}/send-plans.enc`;
    this.wrappedKeyLength = base64urlLength(sealedBoxBytes);
  }

  private async atRestKey(): Promise<CryptoKey> {
    if (this.key !== null) return this.key;
    const raw = await this.keyBytes();
    if (raw.byteLength !== AT_REST_KEY_BYTES) {
      throw new SendPlanError("unreadable", "the at-rest key is the wrong length");
    }
    const { importAtRestKey } = await import("./atrest.js");
    this.key = await importAtRestKey(raw);
    return this.key;
  }

  private update<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<readonly SendPlanRecord[]> {
    if (this.cache !== null) return this.cache;
    let sealed: Uint8Array;
    try {
      sealed = await this.files.readFile(this.path);
    } catch (error) {
      // ONLY an explicit ENOENT is "no plans yet". A permission blip must not
      // become an empty store that the next write overwrites — that would
      // destroy the idempotency keys a live delivery converges on.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        this.cache = [];
        return this.cache;
      }
      throw new SendPlanError("unreadable", `send plans are unavailable (${code ?? "unknown"})`);
    }
    let plaintext: Uint8Array;
    try {
      plaintext = await openRecord(await this.atRestKey(), this.context.accountKey, "send-plan", sealed);
    } catch (error) {
      throw new SendPlanError(
        "unreadable",
        error instanceof AtRestError ? `send plans: ${error.code}` : "send plans failed authentication",
      );
    }
    // Bounded BEFORE it is parsed: a document this side will not accept is not
    // one to build an object graph from first.
    if (plaintext.byteLength > MAX_PLAN_DOCUMENT_BYTES) {
      throw new SendPlanError("unreadable", `send plans are ${plaintext.byteLength} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new SendPlanError("unreadable", "send plans are not JSON");
    }
    // `null` parses as valid JSON. Dereferencing it produced a TypeError rather
    // than this store's own typed refusal.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SendPlanError("unreadable", "send plans are not an object");
    }
    const document = parsed as { v?: unknown; plans?: unknown };
    // Strict: exactly this version. A document from a later build is not this
    // build's to reinterpret, and starting fresh would discard the record of a
    // delivery that may be live. Nothing is reset and nothing is deleted.
    if (document.v !== PLAN_VERSION) {
      throw new SendPlanError("unreadable", `send plans version ${String(document.v)}`);
    }
    if (!Array.isArray(document.plans)) {
      throw new SendPlanError("unreadable", "send plans are malformed");
    }
    if (document.plans.length > MAX_SEND_PLANS) {
      throw new SendPlanError("unreadable", `send plans hold ${document.plans.length} records`);
    }
    // Every record is VALIDATED, not cast.
    //
    // Purpose separation is enforced one layer below, by the `send-plan`
    // at-rest kind: a journal is sealed under different associated data and
    // fails authentication before this loop is reached. The strict shape below
    // is the second lock on that door, not the first.
    //
    // A plan file written by an earlier development build under the `journal`
    // purpose is therefore REFUSED as unreadable and left on disk, never
    // silently adopted. Those files never shipped.
    const seenJobs = new Set<string>();
    const seenKeys = new Set<string>();
    const records: SendPlanRecord[] = [];
    for (const raw of document.plans) {
      const record = this.validateRecord(raw);
      if (seenJobs.has(record.jobID)) {
        throw new SendPlanError("unreadable", "two plans share a job id");
      }
      // Two plans under one idempotency key would converge on each other's
      // task, which is the one identity central keys a create on.
      if (seenKeys.has(record.idempotencyKey)) {
        throw new SendPlanError("unreadable", "two plans share an idempotency key");
      }
      seenJobs.add(record.jobID);
      seenKeys.add(record.idempotencyKey);
      records.push(record);
    }
    this.cache = Object.freeze(records);
    return this.cache;
  }

  /**
   * One record, checked field by field.
   *
   * Phase-dependent, because the identity a retry rebuilds is only complete at
   * certain phases: an `uploaded` plan must name its object, and a `creating`
   * plan must carry the EXACT randomized sealed box that was sent — without it
   * a retry would re-seal and arrive as a different request under the same
   * idempotency key.
   */
  private validateRecord(raw: unknown): SendPlanRecord {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SendPlanError("unreadable", "a plan is not an object");
    }
    const r = raw as Record<string, unknown>;
    const str = (key: string, required: boolean): string => {
      const value = r[key];
      if (typeof value !== "string" || value.length > MAX_ID_LENGTH) {
        throw new SendPlanError("unreadable", `plan ${key} is malformed`);
      }
      if (required && value.length === 0) {
        throw new SendPlanError("unreadable", `plan ${key} is empty`);
      }
      return value;
    };
    const int = (key: string): number => {
      const value = r[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new SendPlanError("unreadable", `plan ${key} is not an exact non-negative integer`);
      }
      return value;
    };
    const bool = (key: string): boolean => {
      const value = r[key];
      if (typeof value !== "boolean") throw new SendPlanError("unreadable", `plan ${key} is not a boolean`);
      return value;
    };

    const phase = r["phase"];
    if (typeof phase !== "string" || !(phase in ALLOWED)) {
      throw new SendPlanError("unreadable", "plan phase is outside the closed set");
    }
    const kind = r["kind"];
    if (kind !== "file" && kind !== "text") {
      throw new SendPlanError("unreadable", "plan kind is outside the closed set");
    }
    const wrappedKey = str("wrappedKey", false);
    if (wrappedKey.length > 0) {
      if (!BASE64URL.test(wrappedKey) || wrappedKey.length !== this.wrappedKeyLength) {
        throw new SendPlanError("unreadable", "plan wrappedKey is not a sealed box");
      }
    }
    const record: SendPlanRecord = {
      jobID: str("jobID", true),
      targetDeviceID: str("targetDeviceID", true),
      kind,
      phase: phase as SendPhase,
      idempotencyKey: str("idempotencyKey", true),
      wrappedKey,
      protocolVersion: int("protocolVersion"),
      wrapAlgorithm: str("wrapAlgorithm", false),
      targetKeyID: str("targetKeyID", true),
      targetKeyGeneration: int("targetKeyGeneration"),
      resealed: bool("resealed"),
      storedObjectID: str("storedObjectID", false),
      uploadID: str("uploadID", false),
      manifestDigest: str("manifestDigest", false),
      taskID: str("taskID", false),
      updatedAt: int("updatedAt"),
    };
    // Phase-dependent identity. A plan that reached a phase without the field
    // that phase is defined by is not one a retry can converge from.
    if ((record.phase === "uploaded" || record.phase === "creating") && record.storedObjectID.length === 0) {
      throw new SendPlanError("unreadable", `a ${record.phase} plan names no stored object`);
    }
    // An in-flight or unresolved upload must carry the identity a recovery
    // reconciles from: the digest of the sealed manifest that names the object
    // it would have produced.
    //
    // The upload id is deliberately NOT required. `uploading` is entered before
    // `init` is called, precisely so a lost init response still leaves a plan
    // that knows something may exist — and in that case there is no id to
    // record. Requiring one would make the only state that needs this identity
    // the one state that cannot have it.
    if ((record.phase === "uploading" || record.phase === "upload-unknown") &&
        record.manifestDigest.length === 0) {
      throw new SendPlanError("unreadable", `a ${record.phase} plan carries no manifest identity`);
    }
    if (record.phase === "creating" && record.wrappedKey.length === 0) {
      throw new SendPlanError("unreadable", "a creating plan carries no sealed box");
    }
    if (record.phase === "created" && record.taskID.length === 0) {
      throw new SendPlanError("unreadable", "a created plan names no task");
    }
    return Object.freeze(record);
  }

  private async persist(plans: readonly SendPlanRecord[]): Promise<void> {
    const document: PlanFile = { v: PLAN_VERSION, plans };
    const sealed = await sealRecord(
      await this.atRestKey(),
      this.context.accountKey,
      "send-plan",
      new TextEncoder().encode(JSON.stringify(document)),
    );
    await this.files.mkdirp(this.context.directory);
    await this.files.writeAtomic(this.path, sealed);
    // Frozen for real, not merely typed `readonly`: a caller that mutated a
    // returned record would change this cache without anything reaching disk.
    this.cache = Object.freeze(plans.map((p) => Object.freeze({ ...p })));
  }

  all(): Promise<readonly SendPlanRecord[]> {
    return this.update(() => this.load());
  }

  find(jobID: string): Promise<SendPlanRecord | null> {
    return this.update(async () => (await this.load()).find((p) => p.jobID === jobID) ?? null);
  }

  /** Stage a job. Idempotent on the job id: a replay returns what exists. */
  stage(args: {
    readonly jobID: string;
    readonly targetDeviceID: string;
    readonly kind: "file" | "text";
    readonly idempotencyKey: string;
    readonly targetKeyID: string;
    readonly targetKeyGeneration: number;
    readonly now: number;
  }): Promise<SendPlanRecord> {
    return this.update(async () => {
      const plans = await this.load();
      const existing = plans.find((p) => p.jobID === args.jobID);
      if (existing !== undefined) {
        // A replay must be the SAME intent. Returning a plan whose target, kind
        // or idempotency key differs would let one job id quietly address a
        // different delivery — and the caller would then drive it believing it
        // had staged what it asked for.
        if (
          existing.targetDeviceID !== args.targetDeviceID ||
          existing.kind !== args.kind ||
          existing.idempotencyKey !== args.idempotencyKey
        ) {
          throw new SendPlanError("illegal-transition", "this job id already names a different delivery");
        }
        return existing;
      }
      if (plans.length >= MAX_SEND_PLANS) {
        // Refused rather than evicted. Every retained plan is a delivery whose
        // outcome may still be unknown, and dropping one to make room is how a
        // second task gets created for it.
        throw new SendPlanError("illegal-transition", `${plans.length} plans are retained`);
      }
      if (plans.some((p) => p.idempotencyKey === args.idempotencyKey)) {
        throw new SendPlanError("illegal-transition", "that idempotency key already names a plan");
      }
      const record: SendPlanRecord = {
        jobID: bounded(args.jobID, "job id"),
        targetDeviceID: bounded(args.targetDeviceID, "device id"),
        kind: args.kind,
        phase: "staged",
        idempotencyKey: bounded(args.idempotencyKey, "idempotency key"),
        wrappedKey: "",
        protocolVersion: 0,
        wrapAlgorithm: "",
        targetKeyID: bounded(args.targetKeyID, "key id"),
        targetKeyGeneration: args.targetKeyGeneration,
        resealed: false,
        storedObjectID: "",
        uploadID: "",
        manifestDigest: "",
        taskID: "",
        updatedAt: args.now,
      };
      await this.persist([...plans, record]);
      return Object.freeze(record);
    });
  }

  /**
   * Amend a plan and move it forward.
   *
   * The write happens BEFORE the effect it describes — the sealed box and the
   * idempotency key are durable before any create leaves this process — and a
   * backwards or illegal move is refused rather than merged.
   */
  advance(
    jobID: string,
    phase: SendPhase,
    patch: Partial<
      Pick<
        SendPlanRecord,
        | "wrappedKey" | "protocolVersion" | "wrapAlgorithm"
        | "targetKeyID" | "targetKeyGeneration" | "resealed"
        | "storedObjectID" | "uploadID" | "manifestDigest" | "taskID"
      >
    >,
    now: number,
  ): Promise<SendPlanRecord> {
    return this.update(async () => {
      const plans = await this.load();
      const at = plans.findIndex((p) => p.jobID === jobID);
      const existing = at >= 0 ? plans[at] : undefined;
      if (existing === undefined) throw new SendPlanError("not-found", "amending an unstaged job");
      if (!ALLOWED[existing.phase].includes(phase)) {
        throw new SendPlanError(
          "illegal-transition",
          `${existing.phase} -> ${phase} is not a legal move`,
        );
      }
      // A recorded task id is never replaced: it names the one delivery this
      // job produced, and overwriting it would lose the convergence target.
      if (existing.taskID.length > 0 && patch.taskID !== undefined && patch.taskID !== existing.taskID) {
        throw new SendPlanError("illegal-transition", "a plan already names a different task");
      }
      const updated: SendPlanRecord = Object.freeze({ ...existing, ...patch, phase, updatedAt: now });
      const next = [...plans];
      next[at] = updated;
      await this.persist(next);
      return updated;
    });
  }

  /**
   * Record that an abandoned plan's orphan release was OBSERVED to succeed.
   *
   * Deliberately its own operation rather than a self-transition through
   * `advance`: `abandoned` is terminal, and the ONE thing that may still change
   * about it is that the object it named is now provably gone. Clearing the id
   * any other way — or on an unobserved release — would erase the only record a
   * retryable cleanup works from.
   */
  observeRelease(jobID: string): Promise<SendPlanRecord> {
    return this.update(async () => {
      const plans = await this.load();
      const at = plans.findIndex((p) => p.jobID === jobID);
      const existing = at >= 0 ? plans[at] : undefined;
      if (existing === undefined) throw new SendPlanError("not-found", "releasing an unstaged job");
      if (existing.phase !== "abandoned") {
        throw new SendPlanError("illegal-transition", "only an abandoned plan records a release");
      }
      if (existing.storedObjectID.length === 0) return existing;
      const updated: SendPlanRecord = Object.freeze({ ...existing, storedObjectID: "" });
      const next = [...plans];
      next[at] = updated;
      await this.persist(next);
      return updated;
    });
  }

  /**
   * Forget a job whose delivery is provably finished, or explicitly written off.
   *
   * `settled` is the delivery that ended. An `abandoned` plan that still names
   * an object is refused BY DEFAULT: it is the only record of ciphertext the
   * account cannot see, and dropping it silently would leave nothing able to
   * report what was left. `acceptOrphan` is the caller stating it has decided —
   * a decision that is legitimate precisely because reclaiming a `device_task`
   * object is central's job (`handleDeleteFile` refuses one, and the GC's
   * `reclaimableTaskObjectSQL` collects it), so this side is not discharging an
   * obligation, only closing its own record. Without that escape a plan store
   * bounded at `MAX_SEND_PLANS` could fill with entries nothing can ever clear.
   *
   * There is no age-based eviction and no automatic reset — a plan that cannot
   * be proven finished is the record a retry converges on, and dropping it is
   * how a second task gets created for one delivery.
   */
  forget(jobID: string, options: { readonly acceptOrphan?: boolean } = {}): Promise<boolean> {
    return this.update(async () => {
      const plans = await this.load();
      const existing = plans.find((p) => p.jobID === jobID);
      if (existing === undefined) return false;
      if (existing.phase === "abandoned") {
        if (existing.storedObjectID.length > 0 && options.acceptOrphan !== true) {
          throw new SendPlanError("illegal-transition", "an abandoned plan still names an object");
        }
      } else if (existing.phase !== "settled") {
        throw new SendPlanError("illegal-transition", "only a settled plan may be forgotten");
      }
      await this.persist(plans.filter((p) => p.jobID !== jobID));
      return true;
    });
  }
}
