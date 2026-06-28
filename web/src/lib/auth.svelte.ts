// Session + account state for Relayium, driven by Svelte 5 runes. The LAN transfer
// flow does not depend on this; login only gates future cross-network features.

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
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

export async function requestMagicLink(email: string): Promise<void> {
  const form = new URLSearchParams({ email });
  await fetch("/api/auth/magic/request", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  user = null;
}

export function googleLoginUrl(): string {
  return "/api/auth/google/start";
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
