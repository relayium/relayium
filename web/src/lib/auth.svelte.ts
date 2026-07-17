// Session + account state for Relayium, driven by Svelte 5 runes. The LAN transfer
// flow does not depend on this; login only gates future cross-network features.

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
  // Ways this account can sign in: "password" (if set) + linked OAuth providers
  // ("google"/"apple"). Absent on older responses → treated as empty.
  linkedMethods?: string[];
  // Billing (phase-2, all optional so older mocks/tests without them still
  // typecheck): current plan id ("free" absent a subscription), the raw
  // Stripe subscription status ("", "active", "past_due", "canceled", ...),
  // its current-period end (unix seconds, 0 = none), and whether a Stripe
  // customer exists yet (gates the "Manage billing" button).
  planId?: string;
  subscriptionStatus?: string;
  subscriptionEnd?: number;
  hasBilling?: boolean;
  // Tier a pending period-end downgrade will switch to ("" / absent = none). Lets
  // the pricing UI show a "scheduled downgrade" banner with a cancel action.
  scheduledPlanId?: string;
}

let user = $state<SessionUser | null>(null);

export function session(): { user: SessionUser | null } {
  return { user };
}

export async function refreshSession(): Promise<void> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
  } else {
    user = null;
  }
}

export async function requestMagicLink(
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const form = new URLSearchParams({ email });
  let res: Response;
  try {
    res = await fetch("/api/auth/magic/request", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  // A 429/500 must not read as "link sent" — the caller shows an error instead.
  if (!res.ok) return { ok: false, error: "error" };
  return { ok: true };
}

// Session/role markers stashed by the cross-network flows; cleared on logout so a
// later sign-in doesn't inherit a stale "I minted this code" side.
const ROLE_KEYS = ["relayium_pair_exp"];

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* offline — clear local state regardless so the UI reflects signed-out */
  }
  user = null;
  try {
    for (const k of ROLE_KEYS) sessionStorage.removeItem(k);
  } catch {
    /* storage may be unavailable */
  }
}

export function googleLoginUrl(): string {
  return "/api/auth/google/start";
}

export function appleLoginUrl(): string {
  return "/api/auth/apple/web/start";
}

export interface AuthMethods {
  password: boolean;
  google: boolean;
  apple: boolean;
  magic: boolean;
}

export async function fetchAuthMethods(): Promise<AuthMethods> {
  try {
    const res = await fetch("/api/auth/methods", { credentials: "include" });
    if (res.ok) return (await res.json()) as AuthMethods;
  } catch {
    /* fall through to default */
  }
  return { password: true, google: false, apple: false, magic: false };
}

// Shared shape for endpoints that, on success, receive {user} and set the
// session cookie — verifyEmail/resetPassword today, passwordLogin below.
async function postForUser(
  path: string,
  payload: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Never reached the server (offline / DNS / CORS) — a structured error the
    // form can surface instead of failing silently.
    return { ok: false, error: "network" };
  }
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
    return { ok: true };
  }
  let error = "error";
  try {
    error = ((await res.json()) as { error?: string }).error ?? error;
  } catch {
    /* non-JSON body */
  }
  return { ok: false, error };
}

// Flat like the rest of this module's result shapes (ok + optional error) —
// `status`/`email` are only populated on success.
export interface RegisterResult {
  ok: boolean;
  status?: "verification_sent";
  email?: string;
  error?: string;
}

// Registration only queues a verification email — the server does NOT set a
// session cookie or return a user, so the caller must show a "check your
// email" state rather than treating this like a login.
export async function register(
  email: string,
  password: string,
  displayName = "",
): Promise<RegisterResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/register", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (res.ok) {
    const body = (await res.json()) as { status: "verification_sent"; email: string };
    return { ok: true, status: "verification_sent", email: body.email };
  }
  let error = "error";
  try {
    error = ((await res.json()) as { error?: string }).error ?? error;
  } catch {
    /* non-JSON body */
  }
  return { ok: false, error };
}

// Flat like RegisterResult — `unverified`/`email` are only populated when the
// server rejected the login as HTTP 403 email_unverified, distinguishing it
// from a generic "wrong email/password" (401) so the UI can offer a resend.
export interface LoginResult {
  ok: boolean;
  unverified?: boolean;
  email?: string;
  error?: string;
}

export async function passwordLogin(email: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/password/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
    return { ok: true };
  }
  let payload: { error?: string; email?: string } = {};
  try {
    payload = (await res.json()) as { error?: string; email?: string };
  } catch {
    /* non-JSON body */
  }
  // A 403 email_unverified is not a generic auth failure — the UI shows a
  // resend affordance instead of "wrong email/password".
  if (res.status === 403 && payload.error === "email_unverified") {
    return { ok: false, unverified: true, email: payload.email ?? email };
  }
  return { ok: false, error: payload.error ?? "error" };
}

// Verifies the emailed token; on success the server sets the session cookie
// and returns {user}, which updates the current-user store just like
// passwordLogin does.
export async function verifyEmail(token: string): Promise<{ ok: boolean; error?: string }> {
  return postForUser("/api/auth/email/verify", { token });
}

// Fire-and-forget resend; the server always answers 200 (anti-enumeration —
// it does not reveal whether the address exists or is already verified).
export async function resendVerification(email: string): Promise<void> {
  try {
    await fetch("/api/auth/email/resend", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {
    /* best-effort; the caller shows a generic "check your email" regardless */
  }
}

// Fire-and-forget forgot-password request; the server always answers 200 for
// the same anti-enumeration reason as resendVerification.
export async function forgotPassword(email: string): Promise<void> {
  try {
    await fetch("/api/auth/password/forgot", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {
    /* best-effort */
  }
}

// On success the server sets the session cookie and returns {user}; update
// the current-user store just like passwordLogin/verifyEmail do.
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  return postForUser("/api/auth/password/reset", { token, newPassword });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch("/api/auth/password/change", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (res.ok) {
    if (user) user = { ...user, hasPassword: true };
    return { ok: true };
  }
  let error = "error";
  try {
    error = ((await res.json()) as { error?: string }).error ?? error;
  } catch {
    /* non-JSON body */
  }
  return { ok: false, error };
}

/** Remove a linked OAuth provider from the current account. The server refuses
 *  (409) to remove the last remaining login method. On success the returned
 *  linkedMethods are folded back into the session so the UI updates live. */
export async function unlinkIdentity(
  provider: string,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/auth/identities/${provider}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (res.ok) {
    try {
      const body = (await res.json()) as { linkedMethods?: string[] };
      if (user && body.linkedMethods) user = { ...user, linkedMethods: body.linkedMethods };
    } catch {
      /* non-JSON body — leave session as-is; a refresh will reconcile */
    }
    return { ok: true };
  }
  if (res.status === 409) return { ok: false, error: "last_login_method" };
  return { ok: false, error: "error" };
}

const DEVICE_KEY = "relayium_device_id";

export function localDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
