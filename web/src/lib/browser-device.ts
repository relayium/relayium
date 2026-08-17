/**
 * Establish the browser's server-minted sending identity.
 *
 * The credential is an HttpOnly cookie: JavaScript never receives, stores or
 * forwards it, and changing localStorage cannot impersonate another device.
 * This call is intentionally made before encryption/upload so a revoked
 * installation fails without leaving an orphan ciphertext object.
 */
export async function ensureBrowserDevice(signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/devices/browser-install", {
      method: "POST",
      credentials: "include",
      signal,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new BrowserDeviceError("unavailable");
  }
  if (!response.ok) {
    let code: BrowserDeviceErrorCode = "unavailable";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (body.error === "browser_device_revoked" || body.error === "browser_device_limit") code = body.error;
    } catch {
      // A non-JSON refusal remains a closed generic availability failure.
    }
    throw new BrowserDeviceError(code);
  }
}

export type BrowserDeviceErrorCode = "browser_device_revoked" | "browser_device_limit" | "unavailable";

export class BrowserDeviceError extends Error {
  constructor(public readonly code: BrowserDeviceErrorCode) {
    super(`browser device identity unavailable: ${code}`);
    this.name = "BrowserDeviceError";
  }
}
