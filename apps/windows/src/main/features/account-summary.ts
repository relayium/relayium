// Who owns the account screen's reads, and what a rename or a revoke is allowed
// to land on.
//
// `src/main/account/summary.ts` owns one request, completely and correctly. It
// does not own the SET of them: it has no epoch of its own beyond the one it was
// handed, no registry, no fence, no document and no idea that a person may sign
// out halfway through. That is this file's whole job, and it is deliberately the
// same shape as `StoredSendService` and `InboxService`, because the failures are
// the same ones.
//
// ## The account is CAPTURED, and re-checked after every await
//
// A bearer read after an await can belong to an account that replaced the one
// the operation started under. For a read that means rendering a stranger's
// usage; for a rename it means putting somebody's chosen name on a stranger's
// device. So every operation captures the authority once, at entry, and then
// re-checks the epoch after each await and immediately BEFORE it sends anything
// or installs anything. A client, once constructed, never retargets: rotating an
// account constructs a new one.
//
// Nothing here looks a credential up a second time, and nothing here holds one
// between calls. `AccountClient` snapshots the three primitives it needs; this
// file keeps the client and the epoch it belongs to, and the view it publishes
// carries the EPOCH ALONE. No bearer, no origin, no address, no `LastIP`, no
// inbox key — none of those has a path from here to a renderer or to a log.
//
// ## Three sections, three outcomes
//
// The three reads are independent all the way out. A usage endpoint that is
// slow or broken leaves the profile and the device list exactly as they were,
// each section fails with its own reason and its own retry, and a failed read
// is NEVER degraded into a number: not a zero quota, not an unlimited cap, not
// a free plan. `src/shared/account-summary.ts` states that rule; this file is
// where it is enforced.
//
// ## What it refuses to do
//
// It does not compute entitlement — `planId`, the caps and `isTop` are the
// server's answers and a second opinion computed here would eventually disagree
// with what is actually enforced. It performs no purchase, no upgrade, no
// cancel and no provider call of any kind. The single journey out of the app is
// a fixed path on this build's own pinned origin, named by a closed token, and
// resolved HERE rather than anywhere a renderer can reach.

import {
  AccountApiError,
  AccountClient,
  MAX_DEVICE_NAME_RUNES,
  type AccountDevice,
  type AccountProfile,
  type AccountUsage,
  type CapturedAccountContext,
} from "../account/summary.js";
import type { AppService } from "../app-service.js";
import {
  ACCOUNT_MANAGEMENT_PATH,
  ACCOUNT_SUMMARY_LOADING,
  isAccountExternalTarget,
  signedOutAccountView,
  type AccountCycleView,
  type AccountDeviceView,
  type AccountExternalTarget,
  type AccountFailure,
  type AccountMutationOutcome,
  type AccountProfileView,
  type AccountProviderView,
  type AccountRenewalView,
  type AccountSection,
  type AccountSectionName,
  type AccountSummaryView,
  type AccountUsageView,
} from "../../shared/account-summary.js";

/**
 * What this feature needs from the host, and nothing more.
 *
 * A narrow structural `Pick` of `AppService` rather than a hand-written
 * interface: the four members below are the host's own public main-only
 * surface, and picking them means a change to any of their signatures is a
 * compile error HERE rather than a runtime shape mismatch discovered by a user.
 * Nothing in this file constructs an `AppService` or reaches past these four.
 */
export type AccountAuthoritySource = Pick<
  AppService,
  "captureAccountAuthority" | "accountEpoch" | "onAccountChanged" | "signOut"
>;

/**
 * The account client this feature drives.
 *
 * Structurally what `AccountClient` already is. Declared as an interface so a
 * test can hold a read open, complete two in the wrong order, or fail exactly
 * one of the three — none of which is expressible against a real socket.
 */
export interface AccountReadClient {
  readonly epoch: number;
  profile(signal: AbortSignal): Promise<AccountProfile>;
  usage(signal: AbortSignal): Promise<AccountUsage>;
  devices(signal: AbortSignal): Promise<readonly AccountDevice[]>;
  renameDevice(
    deviceID: string,
    name: string,
    normalize: (value: string) => string,
    signal: AbortSignal,
  ): Promise<string>;
  revokeDevice(deviceID: string, signal: AbortSignal): Promise<void>;
}

export interface AccountSummaryDeps {
  /** This build's pinned origin. The only address anything here may reach. */
  readonly origin: string;
  readonly account: AccountAuthoritySource;
  /**
   * Which document may act right now.
   *
   * Mutations are tied to the document that asked for them, so a confirmation a
   * person gave on a page that has since reloaded cannot submit. Reads are not:
   * a refresh belongs to the account, and the view it publishes is what the
   * NEXT page renders on arrival.
   */
  currentDocument(): number;
  /**
   * A new snapshot is available.
   *
   * Called AFTER the state is installed and after the work is registered, and
   * called defensively: an observer may throw, and it may re-enter this object.
   * Neither may leave this feature holding a half-installed state.
   */
  onView?(view: AccountSummaryView): void;
  /** Test seam. Production constructs the real `AccountClient`. */
  makeClient?(context: CapturedAccountContext): AccountReadClient;
  /** Injected by the smoke and the tests; production uses the real `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * The app's own device-name normaliser.
   *
   * Optional, with the default below, and the default is asserted equivalent to
   * `web/src/lib/device-identity.ts` by an executable case rather than by
   * assertion in a comment. Two spellings of "what counts as a device name" is
   * how a client rejects something the server would have accepted.
   */
  normalizeDeviceName?(name: string): string;
  reportFailure?(err: unknown): void;
  /** How long `quiesce` waits for aborted work before reporting it unjoined. */
  quiesceTimeoutMs?: number;
}

/** What a quiesce actually managed to stop. */
export interface AccountSummaryInventory {
  /** Operations that were still registered when the quiesce began. */
  readonly pending: number;
  /**
   * Operations that had NOT stopped when the bounded wait ran out.
   *
   * Reported rather than assumed away. A quiesce that returned zero because it
   * stopped counting would tell a quit prompt that nothing is at stake.
   */
  readonly unjoined: number;
}

const DEFAULT_QUIESCE_TIMEOUT_MS = 5_000;

/**
 * Trimmed, with internal whitespace runs collapsed. Nothing else.
 *
 * A local copy of `web/src/lib/device-identity.normalizeDeviceName`, which the
 * main process cannot import — `tsconfig.main.json` sets `rootDir: "src"`, so a
 * main file reaching into `web/src/lib` is TS6059. The control-character, bidi
 * and length rules deliberately stay in `internal/devicelabel` on the server and
 * are NOT restated here: the server refuses a name it would have had to alter,
 * so a person is told rather than shown a row they did not name, and
 * pre-sanitising here would defeat exactly that.
 *
 * `account-summary-feature.test.ts` runs this and the web module over the same
 * table and requires them to agree, so the copy cannot drift silently.
 */
export function normalizeDeviceNameDefault(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Reduction: closed client types in, closed contract types out
// ---------------------------------------------------------------------------

const renewalView = (renewal: AccountProfile["appleRenewal"]): AccountRenewalView =>
  renewal.available
    ? {
        available: true,
        renewalAt: renewal.renewalAt,
        autoRenewEnabled: renewal.autoRenewEnabled,
        inBillingRetry: renewal.inBillingRetry,
        // The SERVER's computation, carried across unchanged. Re-deriving it
        // from `graceUntil` against this machine's clock would disagree with
        // what is actually enforced, on exactly the machine whose clock is wrong.
        inGracePeriod: renewal.inGracePeriod,
        graceUntil: renewal.graceUntil,
      }
    : { available: false };

function profileView(profile: AccountProfile): AccountProfileView {
  return {
    email: profile.email,
    displayName: profile.displayName,
    emailVerified: profile.emailVerified,
    hasPassword: profile.hasPassword,
    linkedMethods: [...profile.linkedMethods],
    planId: profile.planId,
    subscriptionStatus: profile.subscriptionStatus,
    subscriptionEnd: profile.subscriptionEnd,
    hasBilling: profile.hasBilling,
    billingCycle: profile.billingCycle as AccountCycleView,
    scheduledPlanId: profile.scheduledPlanId,
    scheduledCycle: profile.scheduledCycle as AccountCycleView,
    entitlementProvider: profile.entitlementProvider as AccountProviderView,
    appleRenewal: renewalView(profile.appleRenewal),
  };
}

function usageView(usage: AccountUsage): AccountUsageView {
  const plan = usage.plan;
  return {
    period: usage.period,
    resetsAt: usage.resetsAt,
    // `cap` is the EFFECTIVE allowance and `plan.trafficBytes` is the nominal
    // one. They are carried as two different numbers because they ARE two
    // different numbers after a mid-month tier change, and a screen that showed
    // progress against the wrong one would draw a bar against a limit nobody is
    // enforcing.
    traffic: { used: usage.traffic.used, cap: usage.traffic.cap },
    storage: { used: usage.storage.used, cap: usage.storage.cap },
    plan: {
      id: plan.id,
      name: plan.name,
      storageBytes: plan.storageBytes,
      trafficBytes: plan.trafficBytes,
      // The only place retention appears on either endpoint. Exported to the
      // composition here so the stored surface has one source for it.
      retentionSecs: plan.retentionSecs,
      isTop: plan.isTop,
      subscriptionStatus: plan.subscriptionStatus,
      subscriptionEnd: plan.subscriptionEnd,
      billingCycle: plan.billingCycle as AccountCycleView,
      scheduledPlanId: plan.scheduledPlanId,
      scheduledPlanName: plan.scheduledPlanName,
      scheduledCycle: plan.scheduledCycle as AccountCycleView,
      entitlementProvider: plan.entitlementProvider as AccountProviderView,
      appleRenewal: renewalView(plan.appleRenewal),
    },
  };
}

const deviceView = (device: AccountDevice): AccountDeviceView => ({
  id: device.id,
  name: device.name,
  kind: device.kind,
  createdAt: device.createdAt,
  lastSeenAt: device.lastSeenAt,
  current: device.current,
  enrolled: device.enrolled,
});

/**
 * A closed failure for a closed error.
 *
 * `origin-refused`, `redirect-refused`, `too-large` and `malformed` all collapse
 * to `unreadable`, and that includes the case that matters most: a NEWER server
 * sending an entitlement provider this build does not know. The client refuses
 * it as malformed rather than passing it through, so the screen says it cannot
 * read the account instead of rendering a provider it cannot reason about.
 */
function failureFor(error: unknown): AccountFailure {
  if (!(error instanceof AccountApiError)) return { kind: "unreadable" };
  switch (error.code) {
    case "network":
      return { kind: "network" };
    case "timeout":
      return { kind: "timeout" };
    case "server-refused":
      // The STATUS, which is a number this build produced a meaning for. Never
      // the body: these routes emit `http.Error` prose, and a sentence chosen
      // by a server is not one this app will show a person or write to a log.
      return error.status === undefined
        ? { kind: "refused" }
        : { kind: "refused", status: error.status };
    default:
      return { kind: "unreadable" };
  }
}

/**
 * The statuses on which the server has STATED it did not act.
 *
 * A refusal carrying one of these is a decision the server made before touching
 * the row: a malformed request, an unauthenticated one, a device that is not
 * there, a label it will not store. Reporting those as definite failures is
 * correct and is what lets a person fix the input and try again.
 *
 * Everything else — a 5xx, an unrecognised status, no status at all — is NOT a
 * statement that nothing happened. A server that committed a revoke and then
 * failed while writing its response is indistinguishable, from here, from one
 * that refused outright.
 */
const DEFINITIVE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429,
]);

/**
 * Whether a failed MUTATION leaves this process unable to say what happened.
 *
 * The distinction only matters for the two device mutations, and it matters a
 * great deal: a rename or a revoke that reached the server may have been
 * performed even though the answer never came back. `network`, `timeout`, a
 * body this build could not parse, a body over the ceiling and a response that
 * landed off-origin all describe a REPLY that went wrong — by which time the
 * request had already been dispatched and the server had already decided.
 *
 * So the default is uncertainty, and certainty is the exception that has to be
 * earned:
 *
 * * `origin-refused` is thrown while the URL is being built. Nothing was sent.
 * * A `server-refused` on one of the statuses above is the server saying no.
 *
 * The one code that would otherwise be ambiguous is `malformed`, which the
 * client throws BOTH for an unparseable response body and for its own
 * pre-flight checks on the device id and the name. `#mutate` performs those
 * same checks itself, with the same rules, before it calls the client — so by
 * the time a `malformed` can arrive from a mutation, the pre-flight cases are
 * already excluded and what is left is a response.
 *
 * Reporting one of these as "failed" would put "Revoke failed" on screen for a
 * device that is already gone and invite the person to press it again; reporting
 * it as success would show a device as revoked while it is still enrolled.
 * Neither is acceptable, so this reports neither.
 */
function mutationIsUncertain(error: unknown): boolean {
  if (!(error instanceof AccountApiError)) return true;
  if (error.code === "origin-refused") return false;
  if (error.code !== "server-refused") return true;
  return error.status === undefined ? true : !DEFINITIVE_REFUSAL_STATUSES.has(error.status);
}

/**
 * The client's own device-id rule, applied BEFORE the client sees it.
 *
 * Restated deliberately, and it is the restatement that makes
 * `mutationIsUncertain` sound: `AccountClient.deviceURL` throws `malformed` for
 * an id it will not put in a path, and a `malformed` thrown before anything is
 * sent means something entirely different from one thrown while reading a
 * response. Excluding the first case here is what leaves the second
 * unambiguous.
 */
function dispatchableDeviceID(deviceID: string): boolean {
  if (deviceID.length === 0 || deviceID.length > 256) return false;
  const segment = encodeURIComponent(deviceID);
  return !segment.includes("/") && !segment.includes("\\") && segment !== "." && segment !== "..";
}

/** Deep-frozen, so a held snapshot cannot be edited by whoever received it. */
function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  return value;
}

interface Work {
  readonly control: AbortController;
  /** Never rejects. Joined by a teardown to know the work has STOPPED. */
  readonly settled: Promise<void>;
}

interface Inflight {
  readonly epoch: number;
  readonly seq: number;
  readonly run: Promise<AccountSection<unknown>>;
}

type Captured =
  | { readonly ok: false; readonly failure: AccountFailure }
  | { readonly ok: true; readonly client: AccountReadClient; readonly epoch: number };

export class AccountSummaryService {
  #view: AccountSummaryView = ACCOUNT_SUMMARY_LOADING;
  /** The account everything held below belongs to. */
  #epoch: number;
  /**
   * Whether a credential is actually held.
   *
   * Tracked separately from the epoch because signing in changes this WITHOUT
   * changing that, and `unavailable` — a store that could not be read — leaves
   * it untouched: an unreadable store is not proof that nobody is signed in.
   */
  #signedIn = false;
  /**
   * The device list this process currently holds, and the ONLY list a rename or
   * a revoke may select from.
   *
   * A renderer sends an id; it does not get to name a device. Resolving the id
   * against this list is what stops a page — or a foothold in one — addressing a
   * row belonging to an account that is not the one signed in.
   */
  #devices: readonly AccountDeviceView[] | null = null;

  /**
   * Which answer may still be installed, per section.
   *
   * Bumped when a read starts, when the account changes, when a mutation lands
   * and when this object is torn down. Every install is guarded by it, which is
   * how an older read cannot overwrite a newer one — and, specifically, how a
   * device list read before a rename cannot put the old name back.
   */
  readonly #seq: Record<AccountSectionName, number> = { profile: 0, usage: 0, devices: 0 };
  /** One read per section in flight. A second caller joins rather than asks. */
  readonly #inflight = new Map<AccountSectionName, Inflight>();
  /**
   * Rows with an operation running, and WHICH operation.
   *
   * A token rather than a boolean: an account change clears this map, so a
   * finishing operation that deleted by key alone would clear the marker of a
   * newer operation that had already claimed the same row.
   */
  readonly #rows = new Map<string, number>();
  #rowToken = 0;
  readonly #work = new Set<Work>();

  #client: AccountReadClient | null = null;
  #clientEpoch: number | null = null;

  #fenced = false;
  /**
   * A `quiesce` has run and no `resume` has followed.
   *
   * DISTINCT from `#fenced`, and the distinction is the whole point. A fence is
   * "a quit is being decided": it stops mutations and deliberately leaves reads
   * open, because a screen frozen mid-question is worse than one still reading.
   * A quiesce is "everything has been aborted and JOINED": it reported an
   * inventory, and any work admitted after it — a read every bit as much as a
   * mutation — makes that inventory untrue.
   *
   * So a quiesce closes ALL new work until `resume`.
   */
  #quiesced = false;
  #disposed = false;
  /** One coalesced post-account-change read is pending. See `#scheduleRefresh`. */
  #refreshScheduled = false;
  /**
   * The account moved while the fence was up, so the read was not started.
   *
   * Held rather than dropped: a quit prompt the person answers with "Stay"
   * would otherwise leave the screen at "…" for ever, because the one event
   * that would have refreshed it has already happened.
   */
  #missedRefresh = false;
  readonly #release: () => void;

  constructor(private readonly deps: AccountSummaryDeps) {
    this.#epoch = deps.account.accountEpoch;
    this.#view = freeze({ ...ACCOUNT_SUMMARY_LOADING, epoch: this.#epoch });
    // Registered in the constructor and held for the life of this object. The
    // account can move while no page is mounted, and the state that has to be
    // dropped when it does is held HERE, not in a component.
    this.#release = deps.account.onAccountChanged(() => this.#onAccountChanged());
  }

  /** The current snapshot. Deep-frozen; safe to hand across a channel. */
  view(): AccountSummaryView {
    return this.#view;
  }

  /** True while any read or mutation is registered. For the quit snapshot. */
  get active(): number {
    return this.#work.size;
  }

  /**
   * The one address this screen may send somebody to, resolved in MAIN.
   *
   * The renderer names a destination with a closed token; it never supplies a
   * URL, because a channel that accepted one would be script-triggered browser
   * navigation carrying the user's real session — the exact thing
   * `hardenContents` denies for `window.open` and `will-navigate`. The result is
   * built on the pinned origin and re-checked against it, so an origin that
   * somehow carried a path cannot widen the destination set.
   */
  externalUrl(target: AccountExternalTarget): string | null {
    if (!isAccountExternalTarget(target)) return null;
    try {
      const base = new URL(this.deps.origin);
      if (base.origin !== this.deps.origin) return null;
      const resolved = new URL(ACCOUNT_MANAGEMENT_PATH, base);
      if (resolved.origin !== base.origin) return null;
      if (resolved.pathname !== ACCOUNT_MANAGEMENT_PATH) return null;
      if (resolved.search !== "" || resolved.hash !== "") return null;
      return resolved.toString();
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Stop admitting new MUTATIONS. Reads continue, nothing running is touched.
   *
   * Set synchronously, together with every other feature's fence, in the tick a
   * quit is being decided: a quit asks a person a question and then waits for a
   * human, and a device revoked in that window is one the prompt never
   * mentioned. Refreshing is left open on purpose — it changes nothing on the
   * server and a screen frozen mid-question is worse than one still reading.
   */
  fence(): void {
    this.#fenced = true;
  }

  /** Nothing new may start: a quiesce has run, or this object is gone. */
  #closed(): boolean {
    return this.#disposed || this.#quiesced;
  }

  /**
   * The user stayed. Nothing that was STOPPED comes back — but a read the fence
   * refused to start is started now, because the account really did move.
   */
  resume(): void {
    if (this.#disposed) return;
    this.#fenced = false;
    this.#quiesced = false;
    if (!this.#missedRefresh) return;
    this.#missedRefresh = false;
    this.#scheduleRefresh();
  }

  /**
   * Stop admitting, abort everything, and JOIN it. Recoverable.
   *
   * Every operation is aborted synchronously BEFORE any of them is joined — a
   * loop that awaited each in turn would leave later ones running, and holding a
   * bearer, while the first unwound. The join is BOUNDED and what it could not
   * join is reported rather than assumed finished.
   */
  async quiesce(): Promise<AccountSummaryInventory> {
    // BOTH, and both set synchronously before anything is aborted. Setting only
    // the fence left reads admissible, so a `refreshDevices()` immediately after
    // a clean quiesce opened a new request against an inventory that had just
    // reported nothing outstanding.
    this.#fenced = true;
    this.#quiesced = true;
    return this.#stopAll();
  }

  /** Terminal. Nothing is admitted again and no observer is called again. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#fenced = true;
    this.#quiesced = true;
    try {
      this.#release();
    } catch (err) {
      // An injected unsubscribe is somebody else's code. A throw here would
      // abandon the teardown below, leaving work registered and aborted by
      // nothing.
      this.deps.reportFailure?.(err);
    }
    // Invalidated before anything is joined: a read or a mutation answering
    // after this point must install nothing and publish nothing.
    this.#invalidateAll();
    await this.#stopAll();
  }

  async #stopAll(): Promise<AccountSummaryInventory> {
    const work = [...this.#work];
    for (const entry of work) entry.control.abort();
    if (work.length === 0) return { pending: 0, unjoined: 0 };
    const timeout = this.deps.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
    let joined = 0;
    const counted = work.map((entry) =>
      entry.settled.then(() => {
        joined += 1;
      }),
    );
    await Promise.race([
      Promise.all(counted),
      new Promise<void>((resolve) => setTimeout(resolve, timeout).unref?.()),
    ]);
    return { pending: work.length, unjoined: work.length - joined };
  }

  /**
   * The account moved: forget everything that belonged to the one that left.
   *
   * Synchronous, and in this order deliberately. The held data is cleared and
   * every sequence invalidated FIRST, so an answer already on its way back
   * cannot install anything, and only then is the work aborted and the new view
   * published. Doing it the other way round leaves a window in which a
   * completing read writes the previous account's usage under the new epoch.
   */
  #onAccountChanged(): void {
    if (this.#disposed) return;
    const epoch = this.deps.account.accountEpoch;
    this.#epoch = epoch;
    this.#signedIn = false;
    this.#devices = null;
    this.#client = null;
    this.#clientEpoch = null;
    this.#invalidateAll();
    for (const entry of this.#work) entry.control.abort();
    // Everything is `loading` rather than empty: an empty account is a claim,
    // and nothing has been read yet. `signedIn` is false until a capture says
    // otherwise.
    this.#publish({ ...ACCOUNT_SUMMARY_LOADING, epoch });
    this.#scheduleRefresh();
  }

  /**
   * Read once for the account that has just arrived.
   *
   * MAIN drives this, not the page. The account can move while no window is
   * mounted, and a screen that waited for a page to notice would sit at "…"
   * until somebody navigated — which, after a sign-in, is exactly when a person
   * expects to see their account.
   *
   * Coalesced through one microtask because `AppService.adopt` notifies twice
   * under a single epoch — once before the bearer is durable and once after —
   * and the first of those reads "signed out". Coalescing collapses a burst
   * within a tick; a genuinely later notification schedules a genuinely new
   * read, which is what corrects that first answer.
   *
   * This cannot loop: a refresh publishes ready or failed, and neither of those
   * is an account change.
   */
  #scheduleRefresh(): void {
    if (this.#disposed) return;
    // Not while a quit is being decided, and not after a quiesce. An explicit
    // `refreshUsage()` during a fence is a person asking and is allowed; this
    // read is speculative, and three requests issued while somebody is deciding
    // whether to quit are three nobody asked for. Remembered, and started by
    // `resume`.
    if (this.#fenced || this.#quiesced) {
      this.#missedRefresh = true;
      return;
    }
    if (this.#refreshScheduled) return;
    this.#refreshScheduled = true;
    queueMicrotask(() => {
      this.#refreshScheduled = false;
      // ## Re-checked when it FIRES, not only when it was queued
      //
      // A callback queued before a quiesce still runs after it. Deciding
      // admissibility at schedule time alone meant an account change followed
      // immediately by `quiesce()` dispatched three reads once the microtask
      // drained — past a teardown that had already aborted, joined and reported
      // an empty inventory.
      if (this.#disposed) return;
      if (this.#fenced || this.#quiesced) {
        this.#missedRefresh = true;
        return;
      }
      void this.refresh().catch((err: unknown) => this.deps.reportFailure?.(err));
    });
  }

  /** Every in-flight answer, of every kind, becomes uninstallable. */
  #invalidateAll(): void {
    this.#seq.profile += 1;
    this.#seq.usage += 1;
    this.#seq.devices += 1;
    this.#inflight.clear();
    this.#rows.clear();
  }

  #register(control: AbortController): { readonly work: Work; done(): void } {
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work: Work = { control, settled };
    this.#work.add(work);
    return {
      work,
      done: () => {
        this.#work.delete(work);
        finish();
      },
    };
  }

  /**
   * Install a snapshot and tell whoever is listening.
   *
   * The state is installed BEFORE the observer runs, and the observer's
   * exceptions are caught: it may throw, and it may re-enter this object. A
   * throw that escaped here would abandon a `finally` that unregisters work, and
   * a re-entrant call that found a half-installed view would render one
   * account's plan beside another's devices.
   */
  #publish(view: AccountSummaryView): void {
    this.#view = freeze(view);
    if (this.#disposed) return;
    try {
      this.deps.onView?.(this.#view);
    } catch (err) {
      this.deps.reportFailure?.(err);
    }
  }

  // -------------------------------------------------------------------------
  // Authority
  // -------------------------------------------------------------------------

  /**
   * The client for the account that is current RIGHT NOW, or why there is none.
   *
   * Captured before the caller's own awaits and re-checked after this one's: an
   * epoch read after the credential would be the NEW account's, which is the
   * whole failure this discipline exists to prevent.
   */
  async #capture(): Promise<Captured> {
    if (this.#disposed) return { ok: false, failure: { kind: "unavailable" } };
    const before = this.#epoch;
    let captured: Awaited<ReturnType<AccountAuthoritySource["captureAccountAuthority"]>>;
    try {
      captured = await this.deps.account.captureAccountAuthority();
    } catch (err) {
      // `AppService` answers rather than throwing, but this dep is INJECTED and
      // a rejection here would escape as a rejected `refreshProfile()` — a
      // caller matching on a closed outcome would simply not match. Degraded to
      // the closed value that means the same thing.
      this.deps.reportFailure?.(err);
      return { ok: false, failure: { kind: "unavailable" } };
    }
    // Re-checked immediately, before the credential is used for anything.
    if (this.#disposed || this.#epoch !== before) {
      return { ok: false, failure: { kind: "unavailable" } };
    }
    if (captured.kind === "signed-out") {
      this.#signedIn = false;
      return { ok: false, failure: { kind: "signed-out" } };
    }
    // NOT "signed out". The enrolment may be perfectly live on the server and
    // only this machine's store unreadable; `signedIn` is deliberately left as
    // it was rather than being flipped to a claim nothing supports.
    if (captured.kind !== "ok") return { ok: false, failure: { kind: "unavailable" } };
    this.#signedIn = true;
    if (captured.epoch !== this.#epoch) return { ok: false, failure: { kind: "unavailable" } };
    if (this.#client !== null && this.#clientEpoch === captured.epoch) {
      return { ok: true, client: this.#client, epoch: captured.epoch };
    }
    const context: CapturedAccountContext = {
      origin: this.deps.origin,
      bearer: captured.bearer,
      epoch: captured.epoch,
    };
    let client: AccountReadClient;
    try {
      client = this.deps.makeClient
        ? this.deps.makeClient(context)
        : new AccountClient({
            context,
            ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
            ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
          });
    } catch (err) {
      // A client that cannot say where it is allowed to talk does not exist. A
      // refused origin is this build being misconfigured, not the account being
      // unreadable — but from a screen's point of view both mean the same
      // thing, and neither is a plan.
      return { ok: false, failure: failureFor(err) };
    }
    this.#client = client;
    this.#clientEpoch = captured.epoch;
    return { ok: true, client, epoch: captured.epoch };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Read all three, concurrently and independently.
   *
   * `Promise.all` over three sections that each resolve to their own outcome:
   * one failing does not reject, does not cancel the others, and does not blank
   * what they returned. That is the point of the endpoints being three.
   */
  async refresh(): Promise<AccountSummaryView> {
    await Promise.all([this.refreshProfile(), this.refreshUsage(), this.refreshDevices()]);
    return this.#view;
  }

  refreshProfile(): Promise<AccountSection<AccountProfileView>> {
    return this.#read("profile", (client, signal) => client.profile(signal), profileView) as Promise<
      AccountSection<AccountProfileView>
    >;
  }

  refreshUsage(): Promise<AccountSection<AccountUsageView>> {
    return this.#read("usage", (client, signal) => client.usage(signal), usageView) as Promise<
      AccountSection<AccountUsageView>
    >;
  }

  refreshDevices(): Promise<AccountSection<readonly AccountDeviceView[]>> {
    return this.#read(
      "devices",
      (client, signal) => client.devices(signal),
      (rows: readonly AccountDevice[]) => rows.map(deviceView),
    ) as Promise<AccountSection<readonly AccountDeviceView[]>>;
  }

  /**
   * One section, read once however many callers ask.
   *
   * The in-flight read is joinable only while it is still the NEWEST request for
   * its section under the current account. A mutation that lands, an account
   * change, or a caller explicitly asking again all bump the sequence, and from
   * that moment the old read is neither joined by anybody nor installed by
   * itself — it is a stale answer that happens to still be in the air.
   */
  #read<W, V>(
    section: AccountSectionName,
    run: (client: AccountReadClient, signal: AbortSignal) => Promise<W>,
    reduce: (wire: W) => V,
  ): Promise<AccountSection<V>> {
    // A quiesce closes reads too. See `#quiesced`.
    if (this.#closed()) {
      return Promise.resolve({ kind: "failed", failure: { kind: "unavailable" } });
    }
    const existing = this.#inflight.get(section);
    if (existing !== undefined && existing.epoch === this.#epoch && existing.seq === this.#seq[section]) {
      return existing.run as Promise<AccountSection<V>>;
    }
    const seq = (this.#seq[section] += 1);
    const epoch = this.#epoch;
    const control = new AbortController();
    // Registered BEFORE the first await, so a dispose or a sign-out arriving
    // while the authority is being read finds this operation rather than an
    // empty registry.
    const registration = this.#register(control);
    // Held by IDENTITY rather than by section name. Deregistering by name alone
    // would let a finishing read remove a newer read's registration, which is
    // the same class of mistake the per-row token below avoids.
    let entry: Inflight | null = null;
    const run_ = (async (): Promise<AccountSection<V>> => {
      try {
        const captured = await this.#capture();
        if (!this.#installable(section, seq, epoch)) {
          return { kind: "failed", failure: { kind: "unavailable" } };
        }
        if (!captured.ok) {
          // A signed-out read is a STATE, and it replaces every section at
          // once: there is no account, so there is no usage to keep showing.
          if (captured.failure.kind === "signed-out") {
            // The held list goes too. A mutation could not have used it — the
            // capture ahead of it would refuse first — but a list belonging to
            // an account nobody is signed in to should not remain selectable at
            // all, and leaving it there is one refactor away from being used.
            this.#devices = null;
            this.#publish(signedOutAccountView(epoch));
            return { kind: "failed", failure: captured.failure };
          }
          return this.#installFailure(section, seq, epoch, captured.failure);
        }
        // Abandoned while the credential was being read. Checked explicitly
        // rather than left to `fetch` to reject on an already-aborted signal:
        // the request is one this process has already given up on, and issuing
        // it to find that out is a round trip nobody is waiting for.
        if (control.signal.aborted) {
          return { kind: "failed", failure: { kind: "unavailable" } };
        }
        let wire: W;
        try {
          wire = await run(captured.client, control.signal);
        } catch (err) {
          // An abort is this process withdrawing, not the server failing. It
          // installs nothing: the section keeps whatever it last honestly knew.
          if (control.signal.aborted || !this.#installable(section, seq, epoch)) {
            return { kind: "failed", failure: { kind: "unavailable" } };
          }
          return this.#installFailure(section, seq, epoch, failureFor(err));
        }
        // Re-checked after the await and immediately before the install.
        if (!this.#installable(section, seq, epoch)) {
          return { kind: "failed", failure: { kind: "unavailable" } };
        }
        const value = reduce(wire);
        const ready: AccountSection<V> = freeze({ kind: "ready", value });
        if (section === "devices") this.#devices = value as readonly AccountDeviceView[];
        this.#publish({ ...this.#view, epoch, signedIn: true, [section]: ready });
        return ready;
      } finally {
        if (entry !== null && this.#inflight.get(section) === entry) this.#inflight.delete(section);
        registration.done();
      }
    })();
    entry = { epoch, seq, run: run_ as Promise<AccountSection<unknown>> };
    this.#inflight.set(section, entry);
    return run_;
  }

  /** Still the newest request for this section, under the same account. */
  #installable(section: AccountSectionName, seq: number, epoch: number): boolean {
    return !this.#disposed && this.#epoch === epoch && this.#seq[section] === seq;
  }

  #installFailure<V>(
    section: AccountSectionName,
    seq: number,
    epoch: number,
    failure: AccountFailure,
  ): AccountSection<V> {
    const failed: AccountSection<V> = freeze({ kind: "failed", failure });
    if (!this.#installable(section, seq, epoch)) return failed;
    // The device list is DROPPED when its read fails, and nothing else is.
    //
    // Not cosmetic: `#devices` is what a rename or a revoke resolves an id
    // against, so a list this process no longer knows to be true must not stay
    // selectable. The section renders its own failure with its own retry; the
    // profile and the usage beside it keep saying what they last honestly knew.
    if (section === "devices") this.#devices = null;
    this.#publish({ ...this.#view, epoch, signedIn: this.#signedIn, [section]: failed });
    return failed;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Rename one device the user can currently see.
   *
   * The id is resolved against `#devices` — the list THIS process holds — before
   * anything is sent, and again after the authority is captured. A renderer
   * naming a row that is not in that list is refused rather than forwarded,
   * which is what stops an id from a previous account, another account, or a
   * page that has been sitting open all day from addressing a real device.
   *
   * Exactly one request. No retry: a rename that failed is a thing to be told
   * about, and a second attempt sent automatically is a second chance to land on
   * a device the person has stopped looking at.
   */
  async renameDevice(
    document: number,
    deviceID: string,
    name: string,
  ): Promise<AccountMutationOutcome> {
    return this.#mutate(document, deviceID, async (client, row, signal) => {
      const normalize = this.deps.normalizeDeviceName ?? normalizeDeviceNameDefault;
      const cleaned = normalize(name);
      // Refused HERE rather than sent to be refused remotely. The ceiling is in
      // RUNES, matching the server's own rule — a UTF-16 length disagrees for
      // any astral character, and disagreeing with the validator that decides is
      // how a client refuses what the server would have taken.
      //
      // This check is also the second half of `mutationIsUncertain`'s argument.
      // `AccountClient.renameDevice` applies the same normaliser and the same
      // rune ceiling and throws `malformed` when they fail; performing them here
      // first, with the same function, means the client's pre-flight cannot be
      // the first thing to fail — so a `malformed` from a rename is a response,
      // not a rejected argument.
      if (cleaned.length === 0 || [...cleaned].length > MAX_DEVICE_NAME_RUNES) {
        return { kind: "invalid-name" };
      }
      if (cleaned === row.name) {
        // Nothing to send. Reported as done rather than as a request, because
        // there is no state on the server this would change.
        return { kind: "renamed", name: cleaned };
      }
      const saved = await client.renameDevice(row.id, cleaned, normalize, signal);
      return { kind: "renamed", name: saved };
    });
  }

  /**
   * Revoke one device the user can currently see.
   *
   * The CONFIRMATION is the caller's, and it is bound to this id: the screen
   * asks about a named row, and main will only act on that row if it is still in
   * the list this process holds. A row that has gone away between the question
   * and the answer is refused as unknown rather than resolved to whatever now
   * sits in its place.
   *
   * Revoking the CURRENT device signs this app out — but only if the account
   * that was captured is still the one signed in when the revoke comes back. A
   * late completion belonging to an account somebody has already left must not
   * sign out the person who has since signed in.
   */
  async revokeDevice(document: number, deviceID: string): Promise<AccountMutationOutcome> {
    return this.#mutate(document, deviceID, async (client, row, signal, epoch) => {
      await client.revokeDevice(row.id, signal);
      if (!row.current) return { kind: "revoked", self: false, signedOut: false };
      // Checked after the await and immediately before the sign-out, which is
      // itself a mutation of this app's state.
      if (this.#disposed || this.#epoch !== epoch || this.deps.account.accountEpoch !== epoch) {
        return { kind: "revoked", self: true, signedOut: false };
      }
      try {
        await this.deps.account.signOut();
      } catch (err) {
        // The device IS revoked — that already happened on the server. Failing
        // to clear the local credential does not un-revoke it, and reporting
        // the revoke as failed would invite a retry of something that is done.
        this.deps.reportFailure?.(err);
        return { kind: "revoked", self: true, signedOut: false };
      }
      return { kind: "revoked", self: true, signedOut: true };
    });
  }

  /**
   * The shared admission, fence, row exclusion and account discipline.
   *
   * Everything before the first await is synchronous on purpose: the fence, the
   * document, the row lookup and the busy claim all have to be decided in one
   * tick, or two clicks land two requests while both are still deciding.
   */
  async #mutate(
    document: number,
    deviceID: string,
    act: (
      client: AccountReadClient,
      row: AccountDeviceView,
      signal: AbortSignal,
      epoch: number,
    ) => Promise<AccountMutationOutcome>,
  ): Promise<AccountMutationOutcome> {
    if (this.#disposed || this.#fenced || this.#quiesced) return { kind: "unavailable" };
    // The document that ASKED. A confirmation given on a page that has since
    // reloaded cannot submit: the person who reloaded did not answer this
    // question, and the page that did is gone.
    if (document !== this.deps.currentDocument()) return { kind: "unavailable" };
    if (typeof deviceID !== "string" || deviceID.length === 0) return { kind: "unknown-device" };
    // The client's own path rule, applied here so that a `malformed` arriving
    // LATER can only be a response. See `dispatchableDeviceID`.
    if (!dispatchableDeviceID(deviceID)) return { kind: "unknown-device" };
    const row = this.#row(deviceID);
    if (row === null) return { kind: "unknown-device" };
    // One operation per row. The second click is refused rather than queued:
    // two revokes of one device is one revoke and one puzzling failure, and two
    // renames is a race over which name a person actually chose.
    if (this.#rows.has(deviceID)) return { kind: "busy" };
    const token = ++this.#rowToken;
    this.#rows.set(deviceID, token);
    const epoch = this.#epoch;
    const control = new AbortController();
    const registration = this.#register(control);
    try {
      const captured = await this.#capture();
      // After the await, before anything is sent.
      if (this.#disposed || this.#fenced || this.#quiesced || this.#epoch !== epoch) {
        return { kind: "unavailable" };
      }
      if (document !== this.deps.currentDocument()) return { kind: "unavailable" };
      if (control.signal.aborted) return { kind: "unavailable" };
      if (!captured.ok) {
        return captured.failure.kind === "signed-out"
          ? { kind: "signed-out" }
          : captured.failure.kind === "unavailable"
            ? { kind: "unavailable" }
            : { kind: "failed", failure: captured.failure };
      }
      // Resolved AGAIN against the list held right now: the list may have been
      // dropped or replaced while the credential was being read, and acting on
      // the row captured before that would be acting on a stale list.
      const live = this.#row(deviceID);
      if (live === null) return { kind: "unknown-device" };
      let outcome: AccountMutationOutcome;
      try {
        outcome = await act(captured.client, live, control.signal, epoch);
      } catch (err) {
        // ## A lost reply is exactly as unknowable as an abandoned request
        //
        // Abandoning it — a quit, a sign-out, a reload — is the OBVIOUS case,
        // and it was once the only one treated as unknown. That was wrong, and
        // wrong in the common direction: a dropped connection, a deadline, or a
        // response this build could not read all arrive AFTER the request was
        // dispatched and after the server already decided. A server that
        // committed the revoke and then failed to answer looks, from here,
        // exactly like one that never received it.
        //
        // So uncertainty is the DEFAULT and certainty is earned: only a refusal
        // the server actually stated, or a failure raised before anything was
        // sent, is reported as a failure. Everything else is `uncertain`, which
        // the screen renders as "we don't know" beside a re-check that READS the
        // device list. There is no automatic retry of either mutation — a rename
        // may already have been applied, and a second revoke of something
        // already gone comes back as a fresh, misleading failure.
        if (control.signal.aborted) return { kind: "uncertain" };
        if (err instanceof AccountApiError && err.serverCode === "invalid_device_name") {
          // Stated by the server, on the one machine code these routes emit.
          return { kind: "invalid-name" };
        }
        if (mutationIsUncertain(err)) return { kind: "uncertain" };
        return { kind: "failed", failure: failureFor(err) };
      }
      // ## The outcome is reported as it happened; only the STATE is fenced
      //
      // An earlier shape returned `unavailable` here whenever the account had
      // moved, and that was wrong in the one case it mattered most: a
      // self-revoke's own sign-out moves the epoch, so a revoke that had
      // demonstrably succeeded reported "that could not be done right now" to
      // the person who had just been signed out by it.
      //
      // It is the same rule as the lost-reply one above, from the other side: a
      // result this process KNOWS must not be downgraded to an unknown. What the
      // account fence protects is the held device list, so that is what the
      // guard covers — the outcome itself is the truth and travels either way.
      // The caller has its own epoch guard for deciding whether to render it.
      if (!this.#disposed && this.#epoch === epoch) this.#applyMutation(deviceID, epoch, outcome);
      return outcome;
    } finally {
      // Cleared only if this operation is still the one holding the row. An
      // account change empties the map, and a newer operation may have claimed
      // the same id since.
      if (this.#rows.get(deviceID) === token) this.#rows.delete(deviceID);
      registration.done();
    }
  }

  /**
   * Fold a landed mutation into the held list, and make older reads stale.
   *
   * The sequence bump is the important half. Without it a device list read
   * issued BEFORE the rename — already in flight, carrying the old name — would
   * arrive afterwards and put the previous name back on screen, which reads as
   * the rename having silently failed.
   */
  #applyMutation(deviceID: string, epoch: number, outcome: AccountMutationOutcome): void {
    const rows = this.#devices;
    if (rows === null) return;
    if (outcome.kind === "renamed") {
      const next = rows.map((row) => (row.id === deviceID ? { ...row, name: outcome.name } : row));
      this.#seq.devices += 1;
      this.#devices = next;
      this.#publish({
        ...this.#view,
        epoch,
        signedIn: this.#signedIn,
        devices: freeze({ kind: "ready", value: next }),
      });
      return;
    }
    if (outcome.kind !== "revoked") return;
    const next = rows.filter((row) => row.id !== deviceID);
    this.#seq.devices += 1;
    this.#devices = next;
    // A self-revoke that signed out will be followed by an account change,
    // which clears all of this. Publishing the shortened list first is still
    // right: between the two the screen says the device is gone, which is true.
    this.#publish({
      ...this.#view,
      epoch,
      signedIn: this.#signedIn,
      devices: freeze({ kind: "ready", value: next }),
    });
  }

  /** The row for an id, from the list this process holds. Never from input. */
  #row(deviceID: string): AccountDeviceView | null {
    return this.#devices?.find((row) => row.id === deviceID) ?? null;
  }
}
