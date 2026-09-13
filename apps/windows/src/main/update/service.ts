// The update coordinator: one job, app-owned, nothing installed unasked, and
// no authority taken from a local file.
//
// ## Admission covers EVERY public operation
//
// Not just the long ones. `automaticCheckDue` reads the journal, `reveal`
// touches the filesystem, and both used to run unregistered — so either could
// act after a quiesce had returned. Every entry point below takes the single
// slot before its first await, and every one re-checks the fence after each
// await before publishing anything.
//
// ## `quiesce` stops before it joins
//
// The fence is set and the abort fired FIRST, then the in-flight work is
// awaited. Joining before stopping would wait for work that was still free to
// start more work, and a caller would be told the app was quiet while local IO
// was still running.
//
// ## Ownership is a receipt, in two phases, and it is never inferred
//
// Three failures had one cause: a filesystem effect authorized by a DERIVED
// NAME. A failed exclusive open left this service deleting a file it had never
// created; a journal write that failed after a successful download left bytes
// on disk with nothing owning them; and a redirected `updates` let both reach
// outside the app.
//
// The download therefore runs in phases, and each one is durable before the
// effect it authorizes:
//
//   1. mint a nonce and record the claim as INTENT (`held: false`);
//   2. create the file exclusively under the nonced name;
//   3. record `held: true` — the receipt that the create actually returned;
//   4. stream and verify; 5. commit the candidate.
//
// Recovery reads that back literally. A HELD claim names a file this
// installation created, so it may be removed. An UNHELD claim proves only that
// a name was reserved — after a crash it is indistinguishable from a file
// something else put there — so if anything exists at that name it is retained
// as AMBIGUOUS residue and reported, never deleted.
//
// ## Every filesystem effect goes through the capability
//
// Including the advisory staleness digest, which used to `open`/`stat` a path
// here directly. `node:fs` is not imported by this module at all now, so a wired
// Windows adapter cannot be bypassed from the coordinator — and the install
// authority is still `installVerified`, which re-verifies through its own held
// handle.
//
// ## Nothing here derives authority from the journal
//
// The journal is an unsigned local file. It stores an identity and the exact
// SIGNED metadata bytes; every fact that matters — build, size, digest, URL —
// comes from re-verifying those bytes against the pinned key. And no path is
// ever read from it: `staging.ts` derives the one path an identity may have, so
// a forged record cannot authorize a read, a reveal, a retire or an execution
// of anything else.

import { ArtifactDownloadFailed, downloadArtifact, type ArtifactOptions } from "./artifact.js";
import {
  CustodyError,
  defaultScopeProvider,
  type OwnedFile,
  type StagingScope,
  type StagingScopeProvider,
} from "./custody.js";
import {
  failClosedInstaller,
  systemClock,
  unavailableVerifier,
  type Clock,
  type FileRevealer,
  type PlatformInstaller,
  type PublisherVerifier,
  type QuiesceConsent,
  type QuiesceLease,
} from "./contracts.js";
import { FeedError, readFeed, verifySignedMetadata, type FeedOptions } from "./feed.js";
import { installability, type UpdateManifest } from "./manifest.js";
import {
  JournalError,
  MAX_RESIDUE,
  UpdateJournal,
  type JournalClaim,
  type JournalDocument,
  type JournalResidue,
} from "./journal.js";
import {
  STAGING_DIRECTORY_NAME,
  mintNonce,
  retireCandidate,
  stagedFileName,
  stagingDirectory,
  type RetireOutcome,
  type StagedIdentity,
} from "./staging.js";
import {
  canInstall,
  canReveal,
  stateForVerdict,
  type CandidateFacts,
  type UpdateState,
} from "./state.js";
import { updatesEnabled, type UpdateTrust } from "./trust.js";

/** Once a day, plus whatever the user asks for by hand. */
export const AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long `quiesce` waits for an admitted job to notice the fence. */
export const QUIESCE_JOIN_BUDGET_MS = 10_000;

export interface CurrentBuild {
  readonly version: string;
  readonly build: number;
}

export interface UpdateServiceOptions {
  /** Null when no key is pinned: updates are then disabled. */
  readonly trust: UpdateTrust | null;
  readonly engineering: boolean;
  readonly current: CurrentBuild;
  /** The app's own data root. Staging lives underneath it and a renderer can
   *  never name a path here. */
  readonly dataDirectory: string;
  /** PREVIEW only — decides what the user is shown, never what runs. */
  readonly verifier?: PublisherVerifier;
  /** The only thing allowed to run an executable. Absent means no install. */
  readonly installer?: PlatformInstaller;
  readonly revealer?: FileRevealer;
  /** Absent means no install: consent has NO default. */
  readonly quiesceConsent?: QuiesceConsent;
  readonly clock?: Clock;
  readonly feed?: FeedOptions;
  readonly artifact?: ArtifactOptions;
  /** How staging is owned. Defaults per platform, and `win32` FAILS CLOSED
   *  until a native adapter is wired — see `custody.ts`. */
  readonly scope?: StagingScopeProvider;
}

type Slot = "check" | "download" | "install" | "reveal" | "read";

/**
 * States that are honest to publish even after the fence has been set.
 *
 * Each one says something DID NOT happen. Everything else claims progress and
 * is suppressed once stopping — a stopped run must not report an outcome it did
 * not reach.
 */
const REFUSAL_KINDS: ReadonlySet<UpdateState["kind"]> = new Set([
  "check-failed",
  "verify-failed",
  "feed-untrusted",
  "install-deferred",
  "journal-unavailable",
  "blocked",
]);

/** A candidate whose signed metadata has been re-verified in THIS process. */
interface VerifiedCandidate {
  readonly manifest: UpdateManifest;
  readonly facts: CandidateFacts;
  /** The staging nonce, once something is staged. Null means nothing is: there
   *  is no path to derive, rather than a path that happens to be empty. */
  readonly nonce: string | null;
}

/** What an observer is handed. Frozen, so a listener cannot edit the record. */
export type UpdateListener = (state: UpdateState) => void;

export class UpdateService {
  private state: UpdateState;
  /**
   * Observers of every state transition.
   *
   * A `Set`, so unsubscribing is one delete and calling it twice is harmless.
   * Registration is impossible before the constructor returns, which is why the
   * constructor assigns `state` directly instead of going through `set`: there
   * is no listener yet, and a notification from a half-built object is the
   * classic way one arrives with fields still undefined.
   */
  private readonly listeners = new Set<UpdateListener>();
  private readonly journal: UpdateJournal;
  private busy: Slot | null = null;
  private aborter: AbortController | null = null;
  private inFlight: Promise<unknown> | null = null;
  /** Settles the admission's promise when its job finishes. */
  private admitted: (() => void) | null = null;
  private stopping = false;
  /** The candidate the last successful check verified. Never persisted as
   *  authority; re-verified from stored bytes on restart. */
  private verified: VerifiedCandidate | null = null;
  /** Residue this process owns but could not record, because the journal was
   *  the thing that failed. Reported, and it bounds admission. */
  private readonly unrecorded: JournalResidue[] = [];

  constructor(private readonly options: UpdateServiceOptions) {
    this.journal = new UpdateJournal(options.dataDirectory, options.scope ?? defaultScopeProvider());
    // Frozen like every later state, but assigned rather than `set`: no listener
    // can exist yet, and notifying from a half-built object is how a callback
    // arrives with fields still undefined.
    this.state = freezeState(
      updatesEnabled(options.trust, options.engineering)
        ? { kind: "idle", lastCheckedAt: null }
        : { kind: "disabled", reason: options.engineering ? "engineering-build" : "no-pin" },
    );
  }

  get current(): UpdateState {
    return this.state;
  }

  /**
   * Watch every state transition, so a caller never has to poll.
   *
   * The listener receives the SAME closed union `current` returns, frozen: a UI
   * that mutated what it was handed would otherwise be editing this service's
   * record of what happened. It receives nothing else — no service reference, no
   * candidate authority, no way to answer a consent request — because an
   * observer that could act would be a second decision-maker on a path whose
   * whole design is that exactly one thing decides.
   *
   * Returns an unsubscribe that removes exactly this listener and is safe to
   * call more than once.
   */
  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Assign and announce. The ONE place `state` changes after construction.
   *
   * Funnelled so that "every transition is observed" is a property of the code
   * rather than a promise about remembering to call something.
   */
  private set(next: UpdateState): UpdateState {
    this.state = freezeState(next);
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch {
        // An observer's failure is the observer's. It must not abort a
        // download, skip a cleanup, or stop the next listener being told.
      }
    }
    return this.state;
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  private get provider(): StagingScopeProvider {
    return this.options.scope ?? defaultScopeProvider();
  }

  /**
   * Take the single slot, synchronously. Null means refused.
   *
   * The admission REGISTERS ITSELF: `inFlight` becomes a promise that settles
   * when the job finishes, before the caller publishes anything. Without that,
   * a state published between admission and `run` — and any listener reacting
   * to it — would find `inFlight` null and be told by `quiesce` that there was
   * nothing to join, while the job then went on to do its work.
   */
  private admit(slot: Slot): AbortController | null {
    if (this.stopping) return null;
    if (this.busy !== null) return null;
    if (this.state.kind === "disabled") return null;
    this.busy = slot;
    this.aborter = new AbortController();
    this.inFlight = new Promise<void>((resolve) => {
      this.admitted = resolve;
    });
    return this.aborter;
  }

  private done(): void {
    this.busy = null;
    this.aborter = null;
    this.inFlight = null;
    this.admitted = null;
  }

  /**
   * Publish a state, unless doing so would claim progress the fence stopped.
   *
   * The distinction matters and the first version got it wrong. A stopped run
   * must not publish a PROGRESS claim — "up to date", "ready", "revealed",
   * "installing" — because none of those happened; that is the phantom
   * completion the fence exists to prevent. But a REFUSAL is exactly what a
   * caller needs to learn after a stop: suppressing it left `install()`
   * returning `ready` for a job that had in fact been cancelled and its
   * consent lease handed back, which reads as "still installable" and is
   * false.
   */
  private publish(next: UpdateState, aborter: AbortController): UpdateState {
    if (this.stopping || aborter.signal.aborted) {
      return REFUSAL_KINDS.has(next.kind) ? this.set(next) : this.state;
    }
    return this.set(next);
  }

  /**
   * Run an admitted job, recording it BEFORE a line of it executes.
   *
   * The gate is the point. Without it the body runs synchronously up to its
   * first await, so anything it published — and any listener that published
   * reached — would observe `inFlight` still null and be told by `quiesce` that
   * there was nothing to join. A listener holding only a state can still call
   * `quiesce`, and it would have received `joined: true` while this job then
   * went on to do its work.
   */
  private run<T>(body: () => Promise<T>): Promise<T> {
    const settle = this.admitted;
    return (async () => {
      try {
        return await body();
      } finally {
        // The admission's promise settles first, so anyone already waiting on
        // it is released by the work finishing rather than by the slot being
        // cleared underneath them.
        settle?.();
        this.done();
      }
    })();
  }

  /**
   * Stop everything, then join it — within a bound.
   *
   * The fence and the abort come first so nothing new starts; only then is the
   * in-flight promise awaited. The BOUND matters: an admitted job can be
   * awaiting a HOST callback (consent), and a host that ignores the abort would
   * otherwise hang this call forever. So the join is bounded and the result is
   * reported: `joined: false` means the fence is set and nothing new can start,
   * but this service's own work has not finished — which is a different and
   * weaker statement than "quiet", and the caller has to be able to tell them
   * apart.
   */
  async quiesce(timeoutMs = QUIESCE_JOIN_BUDGET_MS): Promise<{ readonly joined: boolean }> {
    this.stopping = true;
    this.aborter?.abort();
    const running = this.inFlight;
    if (running === null) {
      // Nothing admitted. Stated as the slot's emptiness rather than assumed
      // from a null promise: reporting `joined: true` while a slot is taken
      // would be the untruth this whole arrangement exists to prevent.
      return { joined: this.busy === null };
    }
    const joined = await Promise.race([
      running.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return { joined };
  }

  /** Test/host seam: allow work again after a quiesce. */
  resume(): void {
    this.stopping = false;
  }

  /** Read the journal under admission, mapping its refusals to a state. */
  private async readJournal(aborter: AbortController): Promise<JournalDocument | null> {
    try {
      return await this.journal.read();
    } catch (error) {
      this.publish(
        {
          kind: "journal-unavailable",
          reason: error instanceof JournalError ? error.code : "unreadable",
        },
        aborter,
      );
      return null;
    }
  }

  /**
   * Whether an automatic check is due.
   *
   * Admitted like everything else: it reads the journal, and an unregistered
   * read could run after a quiesce.
   */
  async automaticCheckDue(): Promise<boolean> {
    if (this.state.kind === "disabled") return false;
    const aborter = this.admit("read");
    if (aborter === null) return false;
    return this.run(async () => {
      const journal = await this.readJournal(aborter);
      if (journal === null) return false;
      if (this.stopping || aborter.signal.aborted) return false;
      if (journal.lastCheckedAt === null) return true;
      return this.clock.now() - journal.lastCheckedAt >= AUTOMATIC_CHECK_INTERVAL_MS;
    });
  }

  /**
   * Unconfirmed deletions still owned by this installation.
   *
   * Durable entries plus anything this process is holding because the journal
   * itself failed. Reporting only the durable half would say "nothing left
   * behind" in exactly the case where something was.
   */
  async residue(): Promise<readonly JournalResidue[]> {
    const aborter = this.admit("read");
    if (aborter === null) return deepFreeze(this.unrecorded.slice());
    return this.run(async () => {
      const journal = await this.readJournal(aborter);
      // Frozen, entries included: this list contains THIS SERVICE'S own
      // in-memory records, and handing out live references would let a caller
      // edit the count of what is still owed cleanup.
      return deepFreeze(merged(journal?.residue ?? [], this.unrecorded));
    });
  }

  /** Everything this installation still owes cleanup for, claims included. */
  private outstanding(journal: JournalDocument): number {
    return merged(journal.residue, this.unrecorded).length + (journal.pending === null ? 0 : 1);
  }

  private remember(
    identity: StagedIdentity,
    detail: string,
    owned: boolean,
    receipt: string | null,
  ): void {
    if (this.unrecorded.length >= MAX_RESIDUE) return;
    if (this.unrecorded.some((entry) => keyOf(entry) === keyOf(identity))) return;
    this.unrecorded.push({ ...identity, attempts: 1, detail, owned, receipt });
  }

  /**
   * Read the feed and decide whether there is anything newer.
   *
   * Automatic triggers are bounded to once a day; manual ones are not. Neither
   * sends an identifier, a query string or a cookie.
   */
  async check(trigger: "manual" | "automatic" = "manual"): Promise<UpdateState> {
    const trust = this.options.trust;
    if (trust === null || this.state.kind === "disabled") return this.state;
    if (trigger === "automatic" && !(await this.automaticCheckDue())) return this.state;
    const aborter = this.admit("check");
    if (aborter === null) return this.state;
    this.set({ kind: "checking" });
    return this.run(async () => {
      try {
        const manifest = await readFeed(trust, this.options.feed, aborter.signal);
        // Fence AFTER the request and BEFORE the write: a cancelled check must
        // not persist a check time or publish a candidate.
        if (this.stopping || aborter.signal.aborted) return this.state;
        const at = this.clock.now();
        try {
          await this.journal.update((current) => ({ ...current, lastCheckedAt: at }));
        } catch (error) {
          return this.publish(
            {
              kind: "journal-unavailable",
              reason: error instanceof JournalError ? error.code : "unwritable",
            },
            aborter,
          );
        }
        const verdict = installability(manifest, this.options.current);
        if (verdict.verdict !== "newer") {
          this.verified = null;
          return this.publish(
            verdict.verdict === "version-regression"
              ? { kind: "check-failed", reason: "version-regression", retryable: false }
              : { kind: "up-to-date", checkedAt: at },
            aborter,
          );
        }
        this.verified = { manifest, facts: factsOf(manifest), nonce: null };
        return this.publish({ kind: "update-available", candidate: factsOf(manifest) }, aborter);
      } catch (error) {
        this.verified = null;
        if (error instanceof FeedError) {
          return this.publish(
            error.code === "untrusted"
              ? { kind: "feed-untrusted", detail: error.detail }
              : { kind: "check-failed", reason: error.code, retryable: error.retryable },
            aborter,
          );
        }
        return this.publish({ kind: "check-failed", reason: "internal", retryable: false }, aborter);
      }
    });
  }

  /**
   * Download the candidate the last check verified.
   *
   * Never automatic. The phases are the correction — see the header: an owned
   * scope, a settled reconcile, an intent claim, an exclusive create, a HELD
   * receipt, and only then bytes.
   */
  async download(): Promise<UpdateState> {
    const trust = this.options.trust;
    const candidate = this.verified;
    if (trust === null || candidate === null || this.state.kind !== "update-available") {
      return this.state;
    }
    const aborter = this.admit("download");
    if (aborter === null) return this.state;
    this.set({ kind: "downloading", candidate: candidate.facts, receivedBytes: 0 });
    return this.run(async () => {
      const journal = await this.readJournal(aborter);
      if (journal === null) return this.state;
      if (this.outstanding(journal) >= MAX_RESIDUE) {
        return this.publish(this.blocked("unresolved-residue", journal, null), aborter);
      }
      let scope: StagingScope;
      try {
        scope = await this.provider.open(this.options.dataDirectory, STAGING_DIRECTORY_NAME);
      } catch (error) {
        // Not established as ours: redirected, or no adapter on this platform.
        // Nothing is created and nothing is deleted.
        return this.publish(
          this.blocked(
            "staging-unowned",
            journal,
            error instanceof CustodyError ? error.code : "scope",
          ),
          aborter,
        );
      }
      try {
        let working = journal;
        if (working.pending !== null) {
          working = await this.reconcile(scope, working, working.pending);
        }
        if (working.candidate !== null) {
          working = await this.retire(
            working,
            working.candidate,
            working.candidate.receipt,
            "superseded",
          );
        }
        if (working.candidate !== null || working.pending !== null) {
          // Still owned, or still ambiguous: a new download would add state on
          // top of state this installation has not resolved.
          return this.publish(this.blocked("unresolved-residue", working, null), aborter);
        }
        if (this.outstanding(working) >= MAX_RESIDUE) {
          return this.publish(this.blocked("unresolved-residue", working, null), aborter);
        }
        if (this.stopping || aborter.signal.aborted) return this.state;
        return await this.downloadOwned(trust, candidate, scope, aborter);
      } finally {
        await scope.close();
      }
    });
  }

  /** The part that owns bytes. Split out so every exit settles the claim. */
  private async downloadOwned(
    trust: UpdateTrust,
    candidate: VerifiedCandidate,
    scope: StagingScope,
    aborter: AbortController,
  ): Promise<UpdateState> {
    const identity: StagedIdentity = {
      version: candidate.manifest.version,
      build: candidate.manifest.build,
      nonce: mintNonce(),
    };
    // Phase 1: INTENT. A journal that cannot record it is a journal that could
    // not clean up afterwards either, so nothing is created.
    try {
      await this.journal.update((current) => ({
        ...current,
        pending: { ...identity, receipt: null },
      }));
    } catch (error) {
      return this.publish(
        {
          kind: "journal-unavailable",
          reason: error instanceof JournalError ? error.code : "unwritable",
        },
        aborter,
      );
    }
    let staged;
    try {
      staged = await downloadArtifact(
        candidate.manifest,
        trust,
        scope,
        identity,
        // Phase 3: the RECEIPT, written the moment the exclusive create returns
        // and before a byte is streamed. It carries the created object's
        // identity, so recovery can tell that object from anything that later
        // takes its name.
        async (receipt) => {
          await this.journal.update((current) => ({
            ...current,
            pending: { ...identity, receipt },
          }));
        },
        {
          ...this.options.artifact,
          onProgress: (written) => this.progressed(candidate.facts, written, aborter),
        },
        aborter.signal,
      );
    } catch (error) {
      if (error instanceof ArtifactDownloadFailed) {
        if (error.custody === null) {
          if (error.orphan !== null) {
            // Created, then the directory stopped being provably ours. Keep the
            // bytes and say so rather than deleting into an unknown place.
            const journal = await this.journal.read().catch(() => null);
            if (journal !== null) {
              await this.preserve(journal, identity, error.orphan, "created-unverified-scope");
            }
          } else {
            // The exclusive create never returned, so nothing was created under
            // this nonce. The claim is dropped; a stale one reconciles cleanly
            // because there is nothing at that name.
            await this.releaseClaim(identity);
          }
        } else {
          await this.settle(error.custody, identity, `download-${error.cause.code}`);
        }
        return this.publish(
          { kind: "verify-failed", candidate: candidate.facts, reason: error.cause.code },
          aborter,
        );
      }
      await this.releaseClaim(identity);
      return this.publish(
        { kind: "verify-failed", candidate: candidate.facts, reason: "internal" },
        aborter,
      );
    }
    // The bytes are verified and PROVABLY this process's. From here every exit
    // either commits the record or destroys what it owns.
    if (this.stopping || aborter.signal.aborted) {
      await this.settle(staged.custody, identity, "cancelled");
      return this.state;
    }
    try {
      // The stored authority is the SIGNED bytes, not these facts.
      await this.journal.update((current) => ({
        ...current,
        pending: null,
        candidate: {
          ...identity,
          receipt: staged.custody.receipt,
          metadata: Buffer.from(candidate.manifest.signedBytes).toString("base64"),
          signature: candidate.manifest.signature,
        },
      }));
    } catch (error) {
      // The commit failed with the file already on disk. Ownership is held in
      // this process, so the file is destroyed rather than orphaned — and if
      // that cannot be confirmed, the residue is retained and reported.
      await this.settle(staged.custody, identity, "journal-commit");
      return this.publish(
        {
          kind: "journal-unavailable",
          reason: error instanceof JournalError ? error.code : "unwritable",
        },
        aborter,
      );
    }
    this.verified = { ...candidate, nonce: identity.nonce };
    const verdict = await (this.options.verifier ?? unavailableVerifier).verify(
      {
        directory: stagingDirectory(this.options.dataDirectory),
        name: stagedFileName(identity),
        receipt: staged.custody.receipt,
        sizeBytes: candidate.manifest.artifactBytes,
        sha256: candidate.manifest.artifactSha256,
      },
      aborter.signal,
    );
    return this.publish(
      stateForVerdict(verdict, { ...candidate.facts, sha256: staged.sha256 }),
      aborter,
    );
  }

  /**
   * Publish a byte count, or drop it.
   *
   * Every reason to drop one is a reason a UI would otherwise show something
   * false:
   *
   *   * the fence is set or this job was cancelled — a stopped download must not
   *     appear to still be moving;
   *   * a different job holds the slot now — a late report from an abandoned
   *     download would overwrite the current one's;
   *   * the published state is no longer `downloading` — verification has begun
   *     or the download already failed, and a count is not either;
   *   * the number did not grow, or would exceed the SIGNED length — progress is
   *     monotonic and bounded by the manifest, not by what arrived.
   *
   * Nothing here interpolates. A count only changes when bytes were written —
   * written, not flushed: `sync()` happens once, after the digest, so these are
   * not bytes that have survived anything yet.
   */
  private progressed(facts: CandidateFacts, written: number, aborter: AbortController): void {
    if (this.stopping || aborter.signal.aborted) return;
    if (this.aborter !== aborter) return;
    const current = this.state;
    if (current.kind !== "downloading") return;
    if (written <= current.receivedBytes || written > facts.sizeBytes) return;
    this.set({ kind: "downloading", candidate: facts, receivedBytes: written });
  }

  /**
   * Settle a claim an earlier run did not finish.
   *
   * The whole question is whether that run got as far as CREATING the file.
   *
   *   * nothing at the name — nothing was ever created, so the claim is simply
   *     dropped;
   *   * something there and the claim is HELD — this installation created it,
   *     so it is removed and confirmed;
   *   * something there and the claim is NOT held — the two histories are
   *     indistinguishable on disk, so the bytes are KEPT and recorded as
   *     ambiguous residue. Reported, bounded, never deleted.
   */
  private async reconcile(
    scope: StagingScope,
    journal: JournalDocument,
    claim: JournalClaim,
  ): Promise<JournalDocument> {
    let present: string | null;
    try {
      present = await scope.identityOf(stagedFileName(claim));
    } catch {
      return journal;
    }
    if (present === null) {
      try {
        return await this.journal.update((current) => clearSlots(current, claim));
      } catch {
        return journal;
      }
    }
    // The receipt has to describe what is THERE. A claim with none, or one that
    // no longer matches, is an ambiguity this process cannot resolve — and a
    // delete would resolve it in the one direction that destroys evidence.
    if (claim.receipt !== null && claim.receipt === present) {
      return this.retire(journal, claim, claim.receipt, "abandoned-claim");
    }
    const detail = claim.receipt === null ? "unproven-claim" : "identity-changed";
    return this.preserve(journal, claim, claim.receipt, detail);
  }

  /**
   * Keep bytes this installation cannot prove are its own, and say so.
   *
   * The record moves to residue with `owned: false`, which is never retried as a
   * deletion. Preserving is the safer half of an ambiguity that cannot be
   * resolved from here — the other half destroys somebody else's file.
   */
  private async preserve(
    journal: JournalDocument,
    identity: StagedIdentity,
    receipt: string | null,
    detail: string,
  ): Promise<JournalDocument> {
    this.remember(identity, detail, false, receipt);
    try {
      return await this.journal.update((current) => ({
        ...clearSlots(current, identity),
        residue: [...current.residue, { ...identity, attempts: 0, detail, receipt, owned: false }].slice(
          0,
          MAX_RESIDUE,
        ),
      }));
    } catch {
      return journal;
    }
  }

  /**
   * Destroy a file this process holds a receipt for, and settle the record.
   *
   * The delete comes first and its outcome decides the record: confirmed gone
   * clears the claim, anything else becomes OWNED residue. When the JOURNAL is
   * what failed, the residue is held in memory instead — dropping it would
   * report a clean installation that is not one.
   */
  private async settle(custody: OwnedFile, identity: StagedIdentity, reason: string): Promise<void> {
    const outcome = await custody.discard();
    if (outcome.outcome === "residue") {
      this.remember(identity, `${reason}:${outcome.detail}`, true, custody.receipt);
    }
    try {
      await this.journal.update((current) =>
        applyRetire(current, identity, outcome, reason, custody.receipt),
      );
    } catch {
      // The claim stays durable and is reconciled by the next run; the file it
      // named is already gone or already remembered above.
    }
  }

  /** Drop a claim for a name nothing was created under. */
  private async releaseClaim(identity: StagedIdentity): Promise<void> {
    try {
      await this.journal.update((current) => clearSlots(current, identity));
    } catch {
      // Nothing was created, so nothing leaks: a stale intent reconciles
      // cleanly because there is nothing at that nonce.
    }
  }

  private blocked(
    reason: "unresolved-residue" | "staging-unowned",
    journal: JournalDocument,
    detail: string | null,
  ): UpdateState {
    return { kind: "blocked", reason, count: this.outstanding(journal), detail };
  }

  /**
   * Run `body` on a staged path with the staging directory HELD.
   *
   * Null means the directory is not this app's, so nothing was touched. Reading
   * or revealing through a redirected directory would be a filesystem action
   * outside owned staging even when it cannot produce a wrong verdict.
   */
  private async held<T>(
    identity: StagedIdentity,
    body: (path: string) => Promise<T>,
  ): Promise<T | null> {
    let scope: StagingScope;
    try {
      scope = await this.provider.open(this.options.dataDirectory, STAGING_DIRECTORY_NAME);
    } catch {
      return null;
    }
    try {
      return await body(scope.pathFor(stagedFileName(identity)));
    } finally {
      await scope.close();
    }
  }

  /** Identity at a staged name. `undefined` means staging is not this app's. */
  private async identityHeld(identity: StagedIdentity): Promise<string | null | undefined> {
    let scope: StagingScope;
    try {
      scope = await this.provider.open(this.options.dataDirectory, STAGING_DIRECTORY_NAME);
    } catch {
      return undefined;
    }
    try {
      return await scope.identityOf(stagedFileName(identity));
    } catch {
      return undefined;
    } finally {
      await scope.close();
    }
  }

  /** The advisory digest, read through the capability against the receipt. */
  private async hashHeld(
    identity: StagedIdentity,
    receipt: string,
    expectedBytes: number,
  ): Promise<{ readonly path: string; readonly digest: string | null } | null> {
    let scope: StagingScope;
    try {
      scope = await this.provider.open(this.options.dataDirectory, STAGING_DIRECTORY_NAME);
    } catch {
      return null;
    }
    try {
      const name = stagedFileName(identity);
      return { path: scope.pathFor(name), digest: await scope.hashOwned(name, receipt, expectedBytes) };
    } catch {
      return null;
    } finally {
      await scope.close();
    }
  }

  /** Settle a claim outside a download, holding the scope for just that. Null
   *  means staging is not this app's, so nothing was inspected. */
  private async settleClaim(
    journal: JournalDocument,
    claim: JournalClaim,
  ): Promise<JournalDocument | null> {
    let scope: StagingScope;
    try {
      scope = await this.provider.open(this.options.dataDirectory, STAGING_DIRECTORY_NAME);
    } catch {
      return null;
    }
    try {
      return await this.reconcile(scope, journal, claim);
    } finally {
      await scope.close();
    }
  }

  /**
   * Re-authenticate and re-verify a candidate left by an earlier run.
   *
   * The stored SIGNED bytes go through the pinned key and the strict parser
   * again, so build, size, digest and URL come from a manifest this process
   * verified — not from journal fields anything with local write access could
   * choose. Only then is the file's hash compared, and only then is the
   * publisher asked.
   */
  async reverifyStaged(): Promise<UpdateState> {
    const trust = this.options.trust;
    if (trust === null || this.state.kind === "disabled") return this.state;
    const aborter = this.admit("check");
    if (aborter === null) return this.state;
    return this.run(async () => {
      const read = await this.readJournal(aborter);
      if (read === null) return this.state;
      // A claim with no commit is the restart case. Whether its file may be
      // removed depends on the RECEIPT, not on the claim's existence.
      const journal = read.pending === null ? read : await this.settleClaim(read, read.pending);
      if (journal === null) {
        return this.publish(this.blocked("staging-unowned", read, "scope"), aborter);
      }
      const stored = journal.candidate;
      if (stored === null) {
        if (journal.pending !== null) {
          return this.publish(this.blocked("unresolved-residue", journal, null), aborter);
        }
        return this.publish({ kind: "idle", lastCheckedAt: journal.lastCheckedAt }, aborter);
      }
      let manifest: UpdateManifest;
      try {
        manifest = verifySignedMetadata(
          trust,
          new Uint8Array(Buffer.from(stored.metadata, "base64")),
          stored.signature,
        );
      } catch (error) {
        // The record is not authenticatable. Its FILE is retired — by the
        // derived path for the identity in the record, which is the only path
        // this service will ever act on — and the record is cleared.
        await this.retire(journal, stored, stored.receipt, "unauthenticated-record");
        return this.publish(
          {
            kind: "feed-untrusted",
            detail: error instanceof FeedError ? error.detail : null,
          },
          aborter,
        );
      }
      // The identity the path is derived from must be the VERIFIED one.
      if (manifest.version !== stored.version || manifest.build !== stored.build) {
        await this.retire(journal, stored, stored.receipt, "identity-mismatch");
        return this.publish({ kind: "feed-untrusted", detail: "identity-mismatch" }, aborter);
      }
      const facts = factsOf(manifest);
      if (installability(manifest, this.options.current).verdict !== "newer") {
        await this.retire(journal, identityOf(manifest, stored), stored.receipt, "superseded");
        return this.publish({ kind: "up-to-date", checkedAt: this.clock.now() }, aborter);
      }
      const identity = identityOf(manifest, stored);
      // Before anything is read or retired: is the object at that name still
      // the one the receipt describes? A replacement is somebody else's file.
      const seen = await this.identityHeld(identity);
      if (seen === undefined) {
        return this.publish(this.blocked("staging-unowned", journal, "scope"), aborter);
      }
      if (seen !== null && seen !== stored.receipt) {
        await this.preserve(journal, identity, stored.receipt, "identity-changed");
        return this.publish(
          { kind: "verify-failed", candidate: facts, reason: "identity-changed" },
          aborter,
        );
      }
      const held = await this.hashHeld(identity, stored.receipt, manifest.artifactBytes);
      if (held === null) {
        return this.publish(this.blocked("staging-unowned", journal, "scope"), aborter);
      }
      const { path, digest } = held;
      if (this.stopping || aborter.signal.aborted) return this.state;
      if (digest === null || digest !== manifest.artifactSha256) {
        await this.retire(journal, identity, stored.receipt, "stale-staging");
        return this.publish({ kind: "verify-failed", candidate: facts, reason: "stale-staging" }, aborter);
      }
      const verdict = await (this.options.verifier ?? unavailableVerifier).verify(
        {
          directory: stagingDirectory(this.options.dataDirectory),
          name: stagedFileName(identity),
          receipt: stored.receipt,
          sizeBytes: manifest.artifactBytes,
          sha256: manifest.artifactSha256,
        },
        aborter.signal,
      );
      this.verified = { manifest, facts: { ...facts, sha256: digest }, nonce: stored.nonce };
      void path;
      return this.publish(stateForVerdict(verdict, { ...facts, sha256: digest }), aborter);
    });
  }

  /**
   * Install: re-derive the facts, take consent, and hand the decision to the
   * platform installer as ONE verified operation.
   *
   * The checks here avoid spending the user's session on a stale candidate.
   * They are NOT the security boundary — `installVerified` holds the file with
   * write and delete denied and verifies size, hash and Authenticode through
   * that handle.
   */
  async install(): Promise<UpdateState> {
    if (!canInstall(this.state)) return this.state;
    const trust = this.options.trust;
    const candidate = this.verified;
    if (trust === null || candidate === null) return this.state;
    const facts = this.state.kind === "ready" ? this.state.candidate : candidate.facts;
    const consent = this.options.quiesceConsent;
    const aborter = this.admit("install");
    if (aborter === null) return this.state;
    return this.run(async () => {
      let lease: QuiesceLease | null = null;
      // The outcome is COMPUTED first and published last, because a release
      // that does not resume has to be able to change it. An earlier revision
      // released in a `finally` and mutated `this.state` there — so the value
      // the caller received still said the install had merely been deferred,
      // while the app was in fact still quiesced.
      let result: UpdateState;
      try {
        const journal = await this.readJournal(aborter);
        if (journal === null) return this.state;
        const stored = journal.candidate;
        if (
          stored === null ||
          stored.build !== candidate.manifest.build ||
          stored.version !== candidate.manifest.version ||
          stored.nonce !== candidate.nonce
        ) {
          return this.publish(
            { kind: "check-failed", reason: "candidate-changed", retryable: false },
            aborter,
          );
        }
        if (installability(candidate.manifest, this.options.current).verdict !== "newer") {
          return this.publish({ kind: "up-to-date", checkedAt: this.clock.now() }, aborter);
        }
        const identity = identityOf(candidate.manifest, stored);
        const held = await this.hashHeld(identity, stored.receipt, candidate.manifest.artifactBytes);
        const digest = held?.digest ?? null;
        if (digest === null || digest !== candidate.manifest.artifactSha256) {
          await this.retire(journal, identity, stored.receipt, "staging-changed");
          return this.publish(
            { kind: "verify-failed", candidate: facts, reason: "staging-changed" },
            aborter,
          );
        }
        if (this.stopping || aborter.signal.aborted) {
          return this.publish(
            { kind: "install-deferred", candidate: facts, reason: "cancelled" },
            aborter,
          );
        }
        // NO DEFAULT. A build without a consent adapter refuses: the absence of
        // the resident lane's opinion must not be indistinguishable from its
        // approval on the operation that ends the session.
        if (consent === undefined) {
          return this.publish(
            { kind: "install-deferred", candidate: facts, reason: "no-consent-adapter" },
            aborter,
          );
        }
        const decision = await consent.request({
          // The host quiesces everything EXCEPT this job: awaiting it from
          // inside `request` would deadlock, since it is what is awaiting the
          // answer.
          excludeToken: `update:${candidate.manifest.version}+${String(candidate.manifest.build)}`,
          signal: aborter.signal,
        });
        if (!decision.granted) {
          return this.publish(
            { kind: "install-deferred", candidate: facts, reason: decision.reason },
            aborter,
          );
        }
        lease = decision.lease;
        // A grant that arrives after the user cancelled is released WITHOUT
        // installing.
        if (this.stopping || aborter.signal.aborted) {
          result = { kind: "install-deferred", candidate: facts, reason: "cancelled-late-grant" };
        } else {
          const outcome = await (this.options.installer ?? failClosedInstaller).installVerified(
            {
              // Split, so a conforming adapter reaches the file handle-relative
              // beneath a root it holds instead of re-resolving a path string.
              directory: stagingDirectory(this.options.dataDirectory),
              name: stagedFileName(identity),
              receipt: stored.receipt,
              sizeBytes: candidate.manifest.artifactBytes,
              sha256: candidate.manifest.artifactSha256,
              publisher: trust.expectedPublisher,
            },
            aborter.signal,
          );
          if (outcome.outcome === "launched") {
            // The app is going away; the lease is deliberately NOT released,
            // and this state is published even under the fence.
            lease = null;
            return this.set({ kind: "installing", candidate: facts });
          }
          result =
            outcome.verdict !== undefined && outcome.verdict !== "signed-by-expected-publisher"
              ? stateForVerdict(outcome.verdict, facts)
              : { kind: "install-deferred", candidate: facts, reason: outcome.refusal };
        }
      } catch {
        result = { kind: "install-deferred", candidate: facts, reason: "platform-error" };
      }
      if (lease !== null) {
        // A failed release leaves the app quiesced. It becomes THE outcome,
        // rather than being swallowed behind a friendlier one.
        const released = await lease.release("install-not-completed").catch((error: unknown) => ({
          outcome: "unknown" as const,
          detail: String((error as Error)?.message ?? "release-threw"),
        }));
        if (released.outcome !== "resumed") {
          result = {
            kind: "install-deferred",
            candidate: facts,
            reason: `not-resumed:${released.detail}`,
          };
        }
      }
      return this.publish(result, aborter);
    });
  }

  /**
   * Show an unsigned installer to the user. Never runs it.
   *
   * Admitted and fenced: an unregistered reveal could open Explorer after a
   * quiesce had returned.
   */
  async reveal(): Promise<UpdateState> {
    if (!canReveal(this.state)) return this.state;
    const candidate = this.verified;
    const facts = this.state.kind === "ready-unsigned" ? this.state.candidate : null;
    if (candidate === null || facts === null) return this.state;
    const revealer = this.options.revealer;
    const nonce = candidate.nonce;
    if (revealer === undefined || nonce === null) return this.state;
    const aborter = this.admit("reveal");
    if (aborter === null) return this.state;
    return this.run(async () => {
      const journal = await this.readJournal(aborter);
      if (journal === null) return this.state;
      if (
        journal.candidate === null ||
        journal.candidate.build !== candidate.manifest.build ||
        journal.candidate.version !== candidate.manifest.version ||
        journal.candidate.nonce !== nonce
      ) {
        return this.state;
      }
      if (this.stopping || aborter.signal.aborted) return this.state;
      // The DERIVED path, produced inside a HELD scope — never one from the
      // record, and never one through a directory that is not this app's.
      await this.held({ ...candidate.manifest, nonce }, (path) => revealer.reveal(path)).catch(
        () => undefined,
      );
      return this.publish({ kind: "revealed", candidate: facts }, aborter);
    });
  }

  /**
   * Retire one candidate this installation durably claimed, and only clear its
   * record when the deletion is CONFIRMED.
   *
   * The delete goes through an owned scope, so a redirected staging directory
   * refuses instead of reaching outside. An unconfirmed delete becomes a residue
   * entry, bounded and never evicted. Returns the journal as it now stands.
   */
  private async retire(
    journal: JournalDocument,
    identity: StagedIdentity,
    receipt: string | null,
    reason: string,
  ): Promise<JournalDocument> {
    const outcome = await retireCandidate(
      this.options.dataDirectory,
      identity,
      receipt,
      this.provider,
    );
    if (outcome.outcome === "residue") {
      this.remember(identity, `${reason}:${outcome.detail}`, outcome.detail !== "identity-changed", receipt);
    }
    try {
      return await this.journal.update((current) =>
        applyRetire(current, identity, outcome, reason, receipt),
      );
    } catch {
      return journal;
    }
  }
}

/** Identity as a key. The NONCE is part of it: two attempts at the same version
 *  are two distinct objects, and one must never clear the other's record. */
const keyOf = (identity: StagedIdentity): string =>
  `${identity.version}+${String(identity.build)}+${identity.nonce}`;

/** Durable residue plus whatever could not be recorded, without duplicates. */
function merged(
  durable: readonly JournalResidue[],
  extra: readonly JournalResidue[],
): readonly JournalResidue[] {
  const seen = new Set(durable.map(keyOf));
  return [...durable, ...extra.filter((entry) => !seen.has(keyOf(entry)))];
}

/** Forget every slot naming this identity. Only ever called for a CONFIRMED
 *  deletion, or for a claim under which nothing was created. */
function clearSlots(current: JournalDocument, identity: StagedIdentity): JournalDocument {
  const names = (slot: StagedIdentity | null): boolean =>
    slot !== null && keyOf(slot) === keyOf(identity);
  return {
    ...current,
    candidate: names(current.candidate) ? null : current.candidate,
    pending: names(current.pending) ? null : current.pending,
  };
}

/**
 * The record after a retire attempt.
 *
 * Confirmed gone clears the slots; anything else keeps them AND adds a residue
 * entry, because the slot is the only thing that can retry the deletion.
 */
function applyRetire(
  current: JournalDocument,
  identity: StagedIdentity,
  outcome: RetireOutcome,
  reason: string,
  receipt: string | null,
): JournalDocument {
  if (outcome.outcome === "gone") return clearSlots(current, identity);
  const detail = `${reason}:${outcome.detail}`;
  const already = current.residue.find((entry) => keyOf(entry) === keyOf(identity));
  const residue = already
    ? current.residue.map((entry) =>
        entry === already ? { ...entry, attempts: entry.attempts + 1, detail } : entry,
      )
    : [...current.residue, { ...identity, attempts: 1, detail, receipt, owned: true }].slice(
        0,
        MAX_RESIDUE,
      );
  return { ...current, residue };
}

/** The staged identity for a verified manifest plus the record's nonce. */
const identityOf = (manifest: UpdateManifest, stored: StagedIdentity): StagedIdentity => ({
  version: manifest.version,
  build: manifest.build,
  nonce: stored.nonce,
});

/**
 * Freeze a state, and everything reachable through it, before anyone sees it.
 *
 * `readonly` is a compile-time promise and the observer may not be TypeScript at
 * all. Freezing only the top level would leave every nested object editable —
 * the candidate today, and whatever a future member of this union carries. So
 * this walks the own values rather than naming one field, which is also what
 * keeps it correct when the union grows.
 */
function freezeState(state: UpdateState): UpdateState {
  return deepFreeze(state) as UpdateState;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  if (Array.isArray(value)) for (const entry of value) deepFreeze(entry);
  return value;
}

function factsOf(manifest: UpdateManifest): CandidateFacts {
  return {
    version: manifest.version,
    build: manifest.build,
    sizeBytes: manifest.artifactBytes,
    notesUrl: manifest.notesUrl,
    // Not known until the bytes on this disk are hashed.
    sha256: null,
  };
}

