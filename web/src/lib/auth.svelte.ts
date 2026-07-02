// Session + account state for Relayium, driven by Svelte 5 runes. The LAN transfer
// flow does not depend on this; login only gates future cross-network features.

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
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
// later sign-in doesn't inherit a stale "I minted this / I originated that" side.
const ROLE_KEYS = ["relayium_pair_exp", "relayium_xfer_token"];

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

export interface AuthMethods {
  password: boolean;
  google: boolean;
  magic: boolean;
}

export async function fetchAuthMethods(): Promise<AuthMethods> {
  try {
    const res = await fetch("/api/auth/methods", { credentials: "include" });
    if (res.ok) return (await res.json()) as AuthMethods;
  } catch {
    /* fall through to default */
  }
  return { password: true, google: false, magic: false };
}

async function postCredentials(
  path: string,
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
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

export function register(email: string, password: string) {
  return postCredentials("/api/auth/register", email, password);
}

export function passwordLogin(email: string, password: string) {
  return postCredentials("/api/auth/password/login", email, password);
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

const DEVICE_KEY = "relayium_device_id";

export function localDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
