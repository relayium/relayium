import type { DeviceAuthTransport } from "./device-auth.js";
import type { PasswordSignInOutcome } from "../../shared/ipc-contract.js";

export type PasswordLoginResult =
  | { readonly status: "ok"; readonly accessToken: string; readonly accountEmail: string }
  | Exclude<PasswordSignInOutcome, { status: "ok" }>;

/** Uses the same bearer endpoint as the Mac app. A browser cookie is not needed. */
export class PasswordAuthClient {
  constructor(private readonly origin: string, private readonly transport: DeviceAuthTransport) {}

  async login(email: string, password: string, signal?: AbortSignal): Promise<PasswordLoginResult> {
    const body = { email: email.trim(), password, deviceName: "Relayium Windows" };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 4096) throw new Error("invalid login input");
    const res = await this.transport.postJSON(`${this.origin}/api/auth/native/login`, body, signal);
    if (res.status === 401) return { status: "invalid-credentials" };
    if (res.status === 429) return { status: "rate-limited" };
    const b = res.body;
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error("login unavailable");
    const data = b as Record<string, unknown>;
    if (res.status === 403 && data["error"] === "email_unverified") return { status: "email-unverified" };
    if (res.status !== 200) throw new Error("login unavailable");
    if (data["status"] === "pending_deletion") return { status: "pending-deletion" };
    // A future server status must never be mistaken for an authenticated account.
    if (data["status"] !== undefined) throw new Error("login unavailable");
    const user = data["user"];
    if (typeof user !== "object" || user === null || Array.isArray(user)) throw new Error("login unavailable");
    const accountEmail = (user as Record<string, unknown>)["email"];
    const accessToken = data["token"];
    if (typeof accessToken !== "string" || !/^[!-~]{1,4096}$/.test(accessToken)
        || typeof accountEmail !== "string" || accountEmail.length === 0 || accountEmail.length > 320) {
      throw new Error("login unavailable");
    }
    return { status: "ok", accessToken, accountEmail };
  }
}
