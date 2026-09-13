// Which device row central holds for this installation, under this account.
//
// ## Why main has to resolve this, and why `InboxApi` cannot
//
// Every Inbox endpoint is addressed `/api/devices/{deviceID}/inbox/...`, so the
// id is an INPUT to `InboxApi`, not something it can discover: `CapturedApiContext`
// takes it, and `currentDevice()` refuses a row whose id is not the one already
// captured. That check is right — it is what stops a hostile server naming a
// different device as "yours" — and it is exactly why a client with no id yet
// cannot use it.
//
// So the bootstrap read lives here, in the host, which is where the bearer is
// and where the account authority is captured. It is deliberately the ONLY
// authenticated request this feature makes outside `src/main/inbox/**`.
//
// ## The account list is account-scoped, and that is the whole trick
//
// `GET /api/devices` is answered under the bearer's account and marks exactly
// one row `Current: true` — this installation's row in that account. Signing in
// as somebody else on the same machine returns a DIFFERENT id, because it is a
// different account's device list. That is what makes this id usable as the
// account-scoping value for local Inbox state (see `InboxService`'s note on it)
// rather than an email that this process does not retain across a restart.

/** The ceiling on a device list, matching `api.ts`'s `MAX_DEVICES_IN_REPLY`. */
const MAX_DEVICES_IN_REPLY = 512;
/** The ceiling on the JSON body, matching the transport's own. */
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Bounded identifier, matching `api.ts`'s `MAX_ID_BYTES`. */
const MAX_ID_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CurrentDevice {
  readonly id: string;
  /** May be empty: a device that has never been renamed has no name. */
  readonly name: string;
}

/**
 * Why the lookup did not answer.
 *
 * Closed, because a caller branches on it: `unauthorized` means the credential
 * is no longer good and retrying on a timer is pointless, while `network` and
 * `timeout` are exactly what the scheduler's backoff exists for.
 */
export type DeviceLookupFailure =
  | "network"
  | "timeout"
  | "unauthorized"
  | "malformed"
  | "too-large"
  | "origin-refused"
  /** A list that named no current row. Central knows no device for this install. */
  | "not-enrolled";

export class DeviceLookupError extends Error {
  constructor(readonly code: DeviceLookupFailure, message?: string) {
    super(message ?? code);
    this.name = "DeviceLookupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedID(value: unknown, required: boolean): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_ID_BYTES) return null;
  if (required && value.length === 0) return null;
  return value;
}

/**
 * Read the body under a hard ceiling.
 *
 * `Content-Length` is the peer's claim and is used only to refuse early; the
 * counted read is the real bound. Written out rather than reusing
 * `BoundedTransport` because that class has no `GET` and carries no
 * `Authorization` header — adding either to it would widen a transport several
 * unauthenticated paths share.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new DeviceLookupError("too-large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceLookupError("too-large");
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface DeviceLookup {
  readonly origin: string;
  /** Captured with the account, never looked up. Main-only, never rendered. */
  readonly bearer: string;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Resolve this installation's device row, or refuse.
 *
 * Pinned to the build's origin and `redirect: "error"`, so a redirect cannot
 * move a bearer to another host — the same rule `InboxApi` and `BoundedTransport`
 * both hold, restated because this request does not go through either.
 */
export async function resolveCurrentDevice(lookup: DeviceLookup): Promise<CurrentDevice> {
  let target: URL;
  try {
    target = new URL(`${lookup.origin}/api/devices`);
  } catch {
    throw new DeviceLookupError("origin-refused");
  }
  if (target.origin !== lookup.origin) throw new DeviceLookupError("origin-refused");

  const deadline = AbortSignal.timeout(lookup.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = lookup.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(target.toString(), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${lookup.bearer}` },
      redirect: "error",
      signal: AbortSignal.any([deadline, lookup.signal]),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new DeviceLookupError("timeout");
    if (/redirect/i.test(String((err as Error)?.message))) throw new DeviceLookupError("origin-refused");
    throw new DeviceLookupError("network", String((err as Error)?.message));
  }

  // 401/403 is a fact about the credential, and the scheduler must not spin on
  // it: it stops rather than retries, and the user is told to sign in again.
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeviceLookupError("unauthorized");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeviceLookupError("network", `status ${String(response.status)}`);
  }

  const text = await readBounded(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeviceLookupError("malformed");
  }
  if (!isRecord(parsed)) throw new DeviceLookupError("malformed");
  const rows = parsed["devices"];
  if (!Array.isArray(rows)) throw new DeviceLookupError("malformed");
  if (rows.length > MAX_DEVICES_IN_REPLY) throw new DeviceLookupError("malformed");

  for (const row of rows) {
    if (!isRecord(row) || row["Current"] !== true) continue;
    const id = boundedID(row["ID"], true);
    const name = boundedID(row["Name"] ?? "", false);
    // A row that says it is current and cannot say which device it is is
    // malformed, not "keep looking": a second current row would then be taken
    // as this installation's, which is precisely the substitution to refuse.
    if (id === null || name === null) throw new DeviceLookupError("malformed");
    return { id, name };
  }
  throw new DeviceLookupError("not-enrolled");
}
