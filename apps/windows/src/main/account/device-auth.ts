// The native sign-in flow: RFC 8628 device authorization, against the same two
// endpoints the Go CLI and the macOS app already use.
//
// ## Why not the web client's cookie session
//
// `web/src/lib/auth.svelte.ts` authenticates with an `HttpOnly` cookie set
// `SameSite=Lax` on an HTTPS origin, and every call it makes passes
// `credentials: "include"`. None of that is reusable here: a desktop client has
// no browser cookie jar bound to that origin, and a renderer that tried to
// inherit one would be asking for the cookie to be readable — the precise
// property `HttpOnly` exists to deny. The bearer flow below is the path the
// server already offers non-browser clients, and it is the correct one.
//
// ## The two rules that are easy to get wrong
//
//   1. **Every poll outcome is HTTP 200** with a `status` field. A client that
//      waited for a non-200 would poll until the code expired and then report a
//      timeout for a login that had already succeeded.
//   2. **The installation hint rides `start` only.** `poll` is the call that
//      returns a bearer; nothing that is not a credential travels with it.

export interface DeviceAuthStart {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationURL: string;
  readonly interval: number;
  readonly expiresIn: number;
}

export type DevicePollOutcome =
  | { readonly status: "pending" }
  | { readonly status: "denied" }
  | { readonly status: "expired" }
  | { readonly status: "ok"; readonly accessToken: string; readonly accountEmail: string };

export type DeviceAuthFailure = "network" | "http" | "decode";

export class DeviceAuthError extends Error {
  constructor(readonly code: DeviceAuthFailure, message?: string) {
    super(message ?? code);
    this.name = "DeviceAuthError";
  }
}

/** The one page this client will ever open for approval. */
export const DEVICE_APPROVAL_PATH = "/device";

/**
 * The approval page with the code pre-filled, so approving is one click.
 *
 * Re-validates rather than trusting the stored value: this is the string that
 * reaches `shell.openExternal`, and it is worth being the last check as well as
 * the first.
 */
export function approvalURL(start: DeviceAuthStart, expectedOrigin: string): string {
  const url = new URL(start.verificationURL);
  if (url.origin !== expectedOrigin || url.pathname !== DEVICE_APPROVAL_PATH) {
    throw new DeviceAuthError("decode");
  }
  if (url.username.length > 0 || url.password.length > 0) throw new DeviceAuthError("decode");
  url.searchParams.set("code", start.userCode);
  return url.toString();
}

/** RFC 8628 leaves these open; a client that does not bound them will happily
 *  poll on a negative interval (a hot loop) or trust an expiry of `Infinity`. */
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 60;
export const MAX_EXPIRES_SECONDS = 30 * 60;

const boundedSeconds = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new DeviceAuthError("decode");
  if (!Number.isFinite(value) || value < min || value > max) throw new DeviceAuthError("decode");
  return value;
};

/**
 * Parse `start`, refusing anything that could not be acted on safely.
 *
 * `expectedOrigin` is required, not optional. The verification URL is handed to
 * the system browser, so an unchecked value is an open-redirect with the user's
 * trust attached: a compromised or spoofed response could send them to a
 * credential-harvesting page that looks like the real approval screen. Scheme,
 * origin and embedded credentials are all checked HERE, before any caller can
 * reach `shell.openExternal`.
 */
export function parseDeviceStart(body: unknown, expectedOrigin: string): DeviceAuthStart {
  const b = body as Record<string, unknown>;
  const userCode = b?.["user_code"];
  const deviceCode = b?.["device_code"];
  const verification = b?.["verification_uri"];
  if (
    typeof userCode !== "string" || userCode.length === 0 || userCode.length > 64 ||
    typeof deviceCode !== "string" || deviceCode.length === 0 || deviceCode.length > 512 ||
    typeof verification !== "string"
  ) {
    throw new DeviceAuthError("decode");
  }
  const interval = boundedSeconds(b["interval"], MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
  const expiresIn = boundedSeconds(b["expires_in"], MIN_INTERVAL_SECONDS, MAX_EXPIRES_SECONDS);

  let parsed: URL;
  try {
    parsed = new URL(verification);
  } catch {
    throw new DeviceAuthError("decode");
  }
  // Only http/https reach a browser at all; `javascript:`, `file:` and custom
  // schemes are refused before the origin check so a hostile scheme cannot be
  // smuggled past it.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new DeviceAuthError("decode");
  // `https://relayium.com@evil.example/` parses with hostname `evil.example`;
  // refusing credentials outright removes the whole class.
  if (parsed.username.length > 0 || parsed.password.length > 0) throw new DeviceAuthError("decode");
  if (parsed.origin !== expectedOrigin) throw new DeviceAuthError("decode");
  // The approval page is a known path. A response naming another one is either
  // a different product or an attempt to steer the user somewhere else.
  if (parsed.pathname !== DEVICE_APPROVAL_PATH) throw new DeviceAuthError("decode");

  return { userCode, deviceCode, verificationURL: parsed.toString(), interval, expiresIn };
}

export function parseDevicePoll(body: unknown): DevicePollOutcome {
  const b = body as Record<string, unknown>;
  switch (b?.["status"]) {
    case "authorization_pending":
      return { status: "pending" };
    case "denied":
      return { status: "denied" };
    case "expired":
      return { status: "expired" };
    case "ok": {
      const token = b["access_token"];
      // An empty token would land the session in "signed in" with a bearer that
      // 401s on the very next request. Refuse it here.
      if (typeof token !== "string" || token.length === 0) throw new DeviceAuthError("decode");
      const email = b["account_email"];
      return { status: "ok", accessToken: token, accountEmail: typeof email === "string" ? email : "" };
    }
    default:
      // Never guess. A future status read as success signs someone in wrongly.
      throw new DeviceAuthError("decode");
  }
}

export interface DeviceAuthTransport {
  postJSON(
    url: string,
    body: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
}

export class DeviceAuthClient {
  constructor(
    private readonly origin: string,
    private readonly transport: DeviceAuthTransport,
    /** Optional; omitted entirely when this installation has none to offer. */
    private readonly installationID?: string | undefined,
  ) {}

  /**
   * `signal` is the caller's cancellation, not a timeout.
   *
   * A sign-in the user has abandoned must stop waiting on the network rather
   * than run to completion and then be discarded: the response it is waiting
   * for is a device code nobody will ever poll.
   */
  async start(signal?: AbortSignal): Promise<DeviceAuthStart> {
    // A hint is sent only when there is a well-formed one; otherwise the request
    // stays byte-identical to the bodyless POST every shipped CLI makes, which
    // the server reads as "no hint".
    const body = this.installationID ? { install_id: this.installationID } : undefined;
    const res = await this.transport.postJSON(`${this.origin}/api/cli/device/start`, body, signal);
    if (res.status !== 200) throw new DeviceAuthError("http", `start returned ${res.status}`);
    return parseDeviceStart(res.body, this.origin);
  }

  /** Note the absent hint: see the header. */
  async poll(deviceCode: string, signal?: AbortSignal): Promise<DevicePollOutcome> {
    const res = await this.transport.postJSON(
      `${this.origin}/api/cli/device/poll`,
      { device_code: deviceCode },
      signal,
    );
    if (res.status !== 200) throw new DeviceAuthError("http", `poll returned ${res.status}`);
    return parseDevicePoll(res.body);
  }
}

/** Where the bearer lives. Separate key from the installation identity so that
 *  signing out clears one and cannot reach the other. */
export const BEARER_KEY = "account-bearer";

/**
 * There is no way to revoke an abandoned device code.
 *
 * The server exposes `start`, `poll` and a session-authenticated `approve`
 * (`server/account/handlers.go`); it has no unauthenticated deny. A cancelled
 * attempt is therefore ABANDONED, not revoked: this client stops polling it and
 * the server expires it on its own. If the user approves after cancelling, the
 * server mints a token nobody collects. That is stated here rather than papered
 * over, because "cancelled" must not be read as "revoked" by a later reader.
 * Adding a deny endpoint is server work and outside this client's scope.
 */
export const CANCELLED_CODES_ARE_ABANDONED_NOT_REVOKED = true;
