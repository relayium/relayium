// The account read path, and the two device mutations that already exist.
//
// Main-only. The bearer never leaves this process, and nothing here composes a
// screen: it turns two JSON documents and a device list into closed types, and
// refuses anything it cannot read. What the renderer is eventually told is the
// IPC layer's decision, not this module's.
//
// ## The context is CAPTURED, not fetched per call
//
// Same discipline as the send transport and the receive client, for the same
// reason: a bearer read AFTER an await can belong to an account that replaced
// the one the operation started under, so a rename could land on a stranger's
// device. Rotating an account means constructing a new client, and `epoch` is
// how a caller checks that the one it holds is still current.
//
// There is no refresh here and no fallback credential. A 401 is a refusal this
// reports; it is not a cue to go looking for another token.
//
// ## Three reads, reported separately
//
// `/api/me`, `/api/me/usage` and `/api/devices` are three calls and three
// outcomes. They are deliberately not combined: a usage endpoint that is slow or
// broken must not blank the profile, and a caller that wants one object can
// build it knowing which half it is missing. A 500 is never degraded into a free
// plan, a zero quota or an unlimited cap.
//
// ## What this refuses to compute
//
// Entitlement. `planId`, `entitlementProvider`, the caps and `isTop` are the
// server's answers; a second opinion computed here would eventually disagree
// with what is actually enforced. This module parses them and stops.

/** Where a captured account context points, and what it may carry. */
export interface CapturedAccountContext {
  readonly origin: string;
  readonly bearer: string;
  /** Incremented by the owner when the account changes. */
  readonly epoch: number;
}

export interface AccountClientOptions {
  readonly context: CapturedAccountContext;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
export const MAX_ERROR_BODY_BYTES = 4 << 10;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** A device list is a page to render, not an authoritative inventory. */
export const MAX_DEVICE_ROWS = 200;
/**
 * The device-name ceiling, in RUNES, from the server's own rule
 * (`server/internal/devicelabel.MaxRunes`).
 *
 * Counted the way the server counts it. A UTF-16 length would disagree for any
 * name containing an astral character, and disagreeing with the validator that
 * decides is how a client rejects something the server would have taken — or
 * sends something it refuses.
 */
export const MAX_DEVICE_NAME_RUNES = 64;

export type AccountFailure =
  | "origin-refused"
  | "redirect-refused"
  | "server-refused"
  | "network"
  | "timeout"
  | "too-large"
  | "malformed";

export class AccountApiError extends Error {
  constructor(
    readonly code: AccountFailure,
    /** A short machine code the server sent, when it sent one. */
    readonly serverCode?: string,
    readonly status?: number,
  ) {
    // No token, no URL and no server prose: all three end up in a log.
    super(serverCode === undefined ? code : `${code}: ${serverCode}`);
    this.name = "AccountApiError";
  }
}

// ---------------------------------------------------------------------------
// Closed types. Optional exactly where the server says optional.
// ---------------------------------------------------------------------------

/** `""` is a real value and means "no paid provider". */
export type EntitlementProvider = "" | "stripe" | "apple" | "admin" | "multiple";
/** `""` means UNKNOWN — never assume monthly. */
export type BillingCycle = "" | "monthly" | "yearly";

const PROVIDERS: ReadonlySet<string> = new Set(["", "stripe", "apple", "admin", "multiple"]);
const CYCLES: ReadonlySet<string> = new Set(["", "monthly", "yearly"]);

export type AppleRenewal =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly currentProductId: string;
      readonly renewalProductId: string;
      readonly renewalAt: number;
      readonly autoRenewEnabled: boolean;
      readonly expirationIntent: number;
      readonly priceIncreaseStatus: number;
      readonly inBillingRetry: boolean;
      /** Server-computed. Not re-derived here against a different clock. */
      readonly inGracePeriod: boolean;
      readonly graceUntil: number;
    };

export interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly hasPassword: boolean;
  readonly emailVerified: boolean;
  readonly linkedMethods: readonly string[];
  readonly onlyOwnNodes: boolean;
  /** The EFFECTIVE tier, including an administrator grant. */
  readonly planId: string;
  /** Describes the PROVIDER, and may disagree with `planId` for a grant. */
  readonly subscriptionStatus: string;
  readonly subscriptionEnd: number;
  /** "a Stripe customer exists", i.e. the portal is reachable. NOT "subscribed". */
  readonly hasBilling: boolean;
  readonly scheduledPlanId: string;
  readonly scheduledCycle: BillingCycle;
  readonly billingCycle: BillingCycle;
  readonly entitlementProvider: EntitlementProvider;
  readonly appleRenewal: AppleRenewal;
}

/** A byte or second ceiling. **0 means unlimited**, never "none". */
export type Cap = number;

export interface AccountUsagePlan {
  readonly id: string;
  readonly name: string;
  readonly storageBytes: Cap;
  /** The tier's NOMINAL monthly figure — not the effective allowance. */
  readonly trafficBytes: Cap;
  /** The only place retention appears on either endpoint. */
  readonly retentionSecs: Cap;
  readonly priceMonthly: number;
  readonly priceYearly: number;
  /** Fail-closed: `false` does not prove an upgrade exists. */
  readonly isTop: boolean;
  readonly subscriptionStatus: string;
  readonly subscriptionEnd: number;
  readonly billingCycle: BillingCycle;
  readonly scheduledPlanId: string;
  /** Best-effort on the server; may be `""` while `scheduledPlanId` is set. */
  readonly scheduledPlanName: string;
  readonly scheduledCycle: BillingCycle;
  readonly entitlementProvider: EntitlementProvider;
  readonly appleRenewal: AppleRenewal;
}

export interface AccountUsage {
  readonly period: string;
  readonly resetsAt: number;
  /** `cap` is the EFFECTIVE allowance, prorated across a mid-month tier change. */
  readonly traffic: { readonly used: number; readonly cap: Cap };
  readonly storage: { readonly used: number; readonly cap: Cap };
  readonly plan: AccountUsagePlan;
}

/**
 * One device row, reduced.
 *
 * `LastIP` is dropped: it is personal data with no use in this client, and a
 * field that never leaves this module cannot leak from it. The `Inbox` object is
 * reduced to `enrolled`, because an account row needs to know THAT a device
 * enrolled, not the capabilities and public key a sender would wrap to.
 */
export interface AccountDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  /** True for the device whose bearer authenticated this request. */
  readonly current: boolean;
  readonly enrolled: boolean;
}

// ---------------------------------------------------------------------------
// Parsing. Strict about what it needs, indifferent to what it does not.
// ---------------------------------------------------------------------------

/**
 * The machine codes these routes actually emit, from `server/account/handlers.go`.
 *
 * `invalid_device_name` is the rename refusal (line 461). Everything else on
 * `/api/me`, `/api/me/usage`, `GET /api/devices` and `DELETE /api/devices/{id}`
 * is `http.Error` prose, which never reaches a caller from here. A code outside
 * this set is DROPPED rather than echoed: the status still says what happened.
 */
const KNOWN_SERVER_CODES: ReadonlySet<string> = new Set(["invalid_device_name"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_STRING = 512;

function str(value: unknown, required: boolean): string | null {
  if (typeof value !== "string" || value.length > MAX_STRING) return null;
  if (required && value.length === 0) return null;
  return value;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** A non-negative safe integer, or nothing. */
function whole(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * A cap, refused rather than repaired.
 *
 * A negative or non-safe number is not rounded up to zero: zero MEANS unlimited
 * here, so repairing a broken value would turn "this response is wrong" into
 * "you have no limit".
 */
const cap = (value: unknown): Cap | null => whole(value);

function provider(value: unknown): EntitlementProvider | null {
  // ABSENT is back-compat: older servers omit it, and the documented default is
  // "". An UNKNOWN string is a newer server this build does not understand, and
  // accepting it would render a provider nothing here knows how to handle.
  if (value === undefined) return "";
  if (typeof value !== "string" || !PROVIDERS.has(value)) return null;
  return value as EntitlementProvider;
}

function cycle(value: unknown): BillingCycle | null {
  if (value === undefined) return "";
  if (typeof value !== "string" || !CYCLES.has(value)) return null;
  return value as BillingCycle;
}

function appleRenewal(value: unknown): AppleRenewal | null {
  if (value === undefined) return { available: false };
  if (!isRecord(value)) return null;
  const available = bool(value["available"]);
  if (available === null) return null;
  if (!available) return { available: false };
  const currentProductId = str(value["currentProductId"], false);
  const renewalProductId = str(value["renewalProductId"], false);
  const renewalAt = whole(value["renewalAt"]);
  const autoRenewEnabled = bool(value["autoRenewEnabled"]);
  const expirationIntent = whole(value["expirationIntent"]);
  const priceIncreaseStatus = whole(value["priceIncreaseStatus"]);
  const inBillingRetry = bool(value["inBillingRetry"]);
  const inGracePeriod = bool(value["inGracePeriod"]);
  const graceUntil = whole(value["graceUntil"]);
  if (
    currentProductId === null || renewalProductId === null || renewalAt === null ||
    autoRenewEnabled === null || expirationIntent === null || priceIncreaseStatus === null ||
    inBillingRetry === null || inGracePeriod === null || graceUntil === null
  ) {
    return null;
  }
  return {
    available: true, currentProductId, renewalProductId, renewalAt, autoRenewEnabled,
    expirationIntent, priceIncreaseStatus, inBillingRetry, inGracePeriod, graceUntil,
  };
}

function parseProfile(parsed: unknown): AccountProfile {
  // `/api/me` is WRAPPED. The wrapper is part of the contract.
  if (!isRecord(parsed) || !isRecord(parsed["user"])) throw new AccountApiError("malformed");
  const user = parsed["user"];
  const id = str(user["id"], true);
  const email = str(user["email"], false);
  const displayName = str(user["displayName"], false);
  const hasPassword = bool(user["hasPassword"]);
  const emailVerified = bool(user["emailVerified"]);
  const onlyOwnNodes = bool(user["onlyOwnNodes"]);
  const planId = str(user["planId"], false);
  const subscriptionStatus = str(user["subscriptionStatus"], false);
  const subscriptionEnd = whole(user["subscriptionEnd"] ?? 0);
  const hasBilling = bool(user["hasBilling"]);
  const scheduledPlanId = str(user["scheduledPlanId"] ?? "", false);
  const scheduledCycle = cycle(user["scheduledCycle"]);
  const billingCycle = cycle(user["billingCycle"]);
  const entitlementProvider = provider(user["entitlementProvider"]);
  const renewal = appleRenewal(user["appleRenewal"]);
  const methods = user["linkedMethods"];
  if (
    id === null || email === null || displayName === null || hasPassword === null ||
    emailVerified === null || onlyOwnNodes === null || planId === null ||
    subscriptionStatus === null || subscriptionEnd === null || hasBilling === null ||
    scheduledPlanId === null || scheduledCycle === null || billingCycle === null ||
    entitlementProvider === null || renewal === null || !Array.isArray(methods)
  ) {
    throw new AccountApiError("malformed");
  }
  const linkedMethods: string[] = [];
  for (const entry of methods.slice(0, 32)) {
    const method = str(entry, true);
    if (method === null) throw new AccountApiError("malformed");
    linkedMethods.push(method);
  }
  return {
    id, email, displayName, hasPassword, emailVerified, linkedMethods, onlyOwnNodes,
    planId, subscriptionStatus, subscriptionEnd, hasBilling, scheduledPlanId,
    scheduledCycle, billingCycle, entitlementProvider, appleRenewal: renewal,
  };
}

function parsePlan(value: unknown): AccountUsagePlan {
  if (!isRecord(value)) throw new AccountApiError("malformed");
  const id = str(value["id"], true);
  const name = str(value["name"], false);
  const storageBytes = cap(value["storageBytes"]);
  const trafficBytes = cap(value["trafficBytes"]);
  const retentionSecs = cap(value["retentionSecs"]);
  const priceMonthly = whole(value["priceMonthly"]);
  const priceYearly = whole(value["priceYearly"]);
  const isTop = bool(value["isTop"]);
  const subscriptionStatus = str(value["subscriptionStatus"] ?? "", false);
  const subscriptionEnd = whole(value["subscriptionEnd"] ?? 0);
  const billingCycle = cycle(value["billingCycle"]);
  const scheduledPlanId = str(value["scheduledPlanId"] ?? "", false);
  const scheduledPlanName = str(value["scheduledPlanName"] ?? "", false);
  const scheduledCycle = cycle(value["scheduledCycle"]);
  const entitlementProvider = provider(value["entitlementProvider"]);
  const renewal = appleRenewal(value["appleRenewal"]);
  if (
    id === null || name === null || storageBytes === null || trafficBytes === null ||
    retentionSecs === null || priceMonthly === null || priceYearly === null ||
    isTop === null || subscriptionStatus === null || subscriptionEnd === null ||
    billingCycle === null || scheduledPlanId === null || scheduledPlanName === null ||
    scheduledCycle === null || entitlementProvider === null || renewal === null
  ) {
    throw new AccountApiError("malformed");
  }
  return {
    id, name, storageBytes, trafficBytes, retentionSecs, priceMonthly, priceYearly,
    isTop, subscriptionStatus, subscriptionEnd, billingCycle, scheduledPlanId,
    scheduledPlanName, scheduledCycle, entitlementProvider, appleRenewal: renewal,
  };
}

function parseUsage(parsed: unknown): AccountUsage {
  // `/api/me/usage` is FLAT. Not wrapped, unlike `/api/me`.
  if (!isRecord(parsed)) throw new AccountApiError("malformed");
  const period = str(parsed["period"], true);
  const resetsAt = whole(parsed["resetsAt"]);
  const traffic = parsed["traffic"];
  const storage = parsed["storage"];
  if (period === null || resetsAt === null || !isRecord(traffic) || !isRecord(storage)) {
    throw new AccountApiError("malformed");
  }
  const trafficUsed = whole(traffic["used"]);
  const trafficCap = cap(traffic["cap"]);
  const storageUsed = whole(storage["used"]);
  const storageCap = cap(storage["cap"]);
  if (trafficUsed === null || trafficCap === null || storageUsed === null || storageCap === null) {
    throw new AccountApiError("malformed");
  }
  return {
    period,
    resetsAt,
    traffic: { used: trafficUsed, cap: trafficCap },
    storage: { used: storageUsed, cap: storageCap },
    plan: parsePlan(parsed["plan"]),
  };
}

function parseDevices(parsed: unknown): readonly AccountDevice[] {
  // WRAPPED: `{"devices": [...]}` (`server/account/handlers.go:363`). A bare
  // array is not this response, and accepting one would mean this parser had
  // only ever been tried against a fixture somebody wrote to match it.
  if (!isRecord(parsed)) throw new AccountApiError("malformed");
  const rows_ = parsed["devices"];
  if (!Array.isArray(rows_)) throw new AccountApiError("malformed");
  return parseDeviceRows(rows_);
}

function parseDeviceRows(parsed: readonly unknown[]): readonly AccountDevice[] {
  // Bounded: a list this long is not a page anybody renders, and reading further
  // would be trusting the length of remote input.
  if (parsed.length > MAX_DEVICE_ROWS) throw new AccountApiError("too-large");
  const rows: AccountDevice[] = [];
  for (const row of parsed) {
    if (!isRecord(row)) throw new AccountApiError("malformed");
    // PascalCase on the wire — the shape the web client has read since the
    // devices page was built.
    const id = str(row["ID"], true);
    const name = str(row["Name"], false);
    const kind = str(row["Kind"] ?? "", false);
    const createdAt = whole(row["CreatedAt"] ?? 0);
    const lastSeenAt = whole(row["LastSeenAt"] ?? 0);
    const current = bool(row["Current"] ?? false);
    if (
      id === null || name === null || kind === null ||
      createdAt === null || lastSeenAt === null || current === null
    ) {
      throw new AccountApiError("malformed");
    }
    // `Inbox` is null for a device that never enrolled. Presence is the whole
    // question here; the object itself is not carried.
    const inbox = row["Inbox"];
    if (inbox !== undefined && inbox !== null && !isRecord(inbox)) {
      throw new AccountApiError("malformed");
    }
    rows.push({
      id, name, kind, createdAt, lastSeenAt, current,
      enrolled: isRecord(inbox),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class AccountClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /**
   * The context, COPIED.
   *
   * `readonly` is a compile-time promise about a reference, and the caller keeps
   * the object it passed. A caller that reuses one context object across
   * accounts — updating `origin` and `bearer` in place — would otherwise have
   * every later call on this client go to the new origin with the new bearer,
   * including a revoke aimed at a device that belongs to the old account.
   *
   * So the three primitives are snapshotted here, and nothing reads
   * `options.context` again.
   */
  private readonly origin: string;
  private readonly bearer: string;
  private readonly capturedEpoch: number;

  constructor(options: AccountClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const context: unknown = options.context;
    if (!isRecord(context)) throw new AccountApiError("malformed");
    const origin = context["origin"];
    const bearer = context["bearer"];
    const epoch = context["epoch"];
    // Refused HERE, before anything can be sent. A client that cannot say where
    // it is allowed to talk should not exist, rather than fail on first use.
    if (typeof bearer !== "string" || bearer.length === 0 || bearer.length > 4096) {
      throw new AccountApiError("malformed");
    }
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch)) {
      throw new AccountApiError("malformed");
    }
    if (typeof origin !== "string" || origin.length === 0 || origin.length > 2048) {
      throw new AccountApiError("origin-refused");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new AccountApiError("origin-refused");
    }
    // An origin is a scheme, a host and a port — nothing else. A value carrying
    // a path or a query is not the thing every later URL is compared against.
    if (parsed.origin !== origin) throw new AccountApiError("origin-refused");
    this.origin = origin;
    this.bearer = bearer;
    this.capturedEpoch = epoch;
  }

  /** The captured account's epoch. A caller compares before it acts on a result. */
  get epoch(): number {
    return this.capturedEpoch;
  }

  async profile(signal: AbortSignal): Promise<AccountProfile> {
    return parseProfile(await this.json("GET", this.url("/api/me"), undefined, signal));
  }

  async usage(signal: AbortSignal): Promise<AccountUsage> {
    return parseUsage(await this.json("GET", this.url("/api/me/usage"), undefined, signal));
  }

  async devices(signal: AbortSignal): Promise<readonly AccountDevice[]> {
    return parseDevices(await this.json("GET", this.url("/api/devices"), undefined, signal));
  }

  /**
   * Rename one device, sending exactly what the user typed once whitespace is
   * collapsed.
   *
   * The normalizer is the CALLER'S — the same one the rest of this app uses —
   * because two spellings of "what counts as a device name" is how a client
   * rejects something the server would accept. The length is checked in RUNES
   * against the server's own ceiling, and the request is refused locally rather
   * than sent to be refused remotely.
   *
   * Nothing is sanitized beyond that: the server deliberately REFUSES a name it
   * would have had to alter, so that a person is told rather than shown a row
   * they did not name. Pre-sanitizing here would defeat exactly that.
   */
  async renameDevice(
    deviceID: string,
    name: string,
    normalize: (value: string) => string,
    signal: AbortSignal,
  ): Promise<string> {
    const cleaned = normalize(name);
    if (cleaned.length === 0 || [...cleaned].length > MAX_DEVICE_NAME_RUNES) {
      throw new AccountApiError("malformed");
    }
    await this.json("PATCH", this.deviceURL(deviceID), { name: cleaned }, signal);
    return cleaned;
  }

  /**
   * Revoke one device. One request, no retry, no loop.
   *
   * The caller owns the confirmation, and the caller owns what happens when the
   * revoked row is the CURRENT one — this does not sign anybody out, and it does
   * not decide that revoking yourself is allowed. A retry here would be a second
   * revoke of something already gone, reported as a fresh failure.
   */
  async revokeDevice(deviceID: string, signal: AbortSignal): Promise<void> {
    await this.json("DELETE", this.deviceURL(deviceID), undefined, signal);
  }

  /** Build a URL and refuse anything not on the pinned origin. */
  private url(suffix: string): URL {
    let target: URL;
    try {
      target = new URL(`${this.origin}${suffix}`);
    } catch {
      throw new AccountApiError("origin-refused");
    }
    if (target.origin !== this.origin) throw new AccountApiError("origin-refused");
    return target;
  }

  /**
   * A device route, with the id as ONE path segment.
   *
   * Encoded, and then checked: an id that survives encoding with a separator or
   * a traversal in it would address a different route than the caller named.
   */
  private deviceURL(deviceID: string): URL {
    if (typeof deviceID !== "string" || deviceID.length === 0 || deviceID.length > 256) {
      throw new AccountApiError("malformed");
    }
    const segment = encodeURIComponent(deviceID);
    if (segment.includes("/") || segment.includes("\\") || segment === "." || segment === "..") {
      throw new AccountApiError("malformed");
    }
    const target = this.url(`/api/devices/${segment}`);
    if (target.pathname !== `/api/devices/${segment}`) throw new AccountApiError("malformed");
    return target;
  }

  private headers(json: boolean): Headers {
    const headers = new Headers({ authorization: `Bearer ${this.bearer}`, accept: "application/json" });
    if (json) headers.set("content-type", "application/json");
    return headers;
  }

  private classify(error: unknown): AccountApiError {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError") return new AccountApiError("timeout");
    if (name === "AbortError") return new AccountApiError("network");
    return new AccountApiError("network");
  }

  /**
   * A KNOWN machine code from a refusal body, or nothing.
   *
   * An allowlist, not a shape test. A regex over "alphanumeric and short" admits
   * anything the server happens to put there — an identifier, an email, a token
   * fragment — and this value ends up in an error message and a log. The server's
   * own refusals on these routes are mostly prose (`http.Error` with "bad
   * request", "not found", "server error"), so the honest default is the status
   * plus this module's own closed code, and a machine token only when it is one
   * this build actually recognises.
   */
  private async rejection(response: Response): Promise<string | undefined> {
    try {
      const reader = response.body?.getReader();
      if (reader === undefined) return undefined;
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          total += value.byteLength;
          if (total > MAX_ERROR_BODY_BYTES) break;
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) return undefined;
      const code = parsed["error"];
      return typeof code === "string" && KNOWN_SERVER_CODES.has(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Ask the server to send the verification email again.
   *
   * The address is NOT a parameter, and that is the security property: it is
   * read from the profile this client just fetched under its own bearer. A
   * method that took an address would let whatever called it make this app
   * email anybody, and the renderer is a caller.
   *
   * The endpoint answers 200 whatever happens — it will not say whether an
   * account exists, whether it was already verified, or whether the throttle
   * swallowed the request. So this returns nothing, and the surface above says
   * only what is true: that it was asked for.
   */
  async resendVerification(signal: AbortSignal): Promise<"sent" | "already-verified"> {
    // Read FRESH rather than trusting the held view. Two reasons, and the
    // second is the one that matters: the address must be the server's current
    // answer for this credential, and somebody may have finished verifying in a
    // browser since this screen was drawn — in which case the truthful outcome
    // is "already verified", not an email nobody needs.
    const profile = await this.profile(signal);
    if (profile.emailVerified) return "already-verified";
    const email = profile.email;
    if (typeof email !== "string" || email.length === 0 || email.length > 320) {
      throw new AccountApiError("malformed");
    }
    const target = this.url("/api/auth/email/resend");
    if (target.pathname !== "/api/auth/email/resend") throw new AccountApiError("malformed");
    await this.json("POST", target, { email }, signal);
    return "sent";
  }

  private async json(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    target: URL,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers: this.headers(body !== undefined),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw this.classify(error);
    }
    if (response.status < 200 || response.status >= 300) {
      const code = await this.rejection(response);
      throw new AccountApiError("server-refused", code, response.status);
    }
    // Re-checked after the response: a redirect somehow followed would have
    // carried the bearer somewhere this build never pinned.
    const landed = response.url === "" ? target.toString() : response.url;
    if (new URL(landed).origin !== this.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new AccountApiError("redirect-refused");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        // Refused mid-flight, not after buffering: the ceiling exists so a
        // response cannot make this process hold an arbitrary amount.
        if (total > MAX_JSON_RESPONSE_BYTES) throw new AccountApiError("too-large");
        chunks.push(value);
      }
    } catch (error) {
      // The READ can fail too — an abort while the body is still arriving
      // rejects here, not at the `fetch` above. Letting that escape would hand
      // the caller a `DOMException` from outside this module's closed set, and
      // a caller matching on `code` would simply not match.
      throw error instanceof AccountApiError ? error : this.classify(error);
    } finally {
      // The body is always joined, including on the abort and too-large paths,
      // so a cancelled read does not leave a socket half-consumed.
      await reader.cancel().catch(() => undefined);
    }
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"));
    } catch {
      throw new AccountApiError("malformed");
    }
  }
}
