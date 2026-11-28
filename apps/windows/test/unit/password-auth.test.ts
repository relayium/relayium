import { describe, expect, it } from "vitest";
import { PasswordAuthClient } from "../../src/main/account/password-auth.js";

const origin = "https://relayium.com";
describe("native password login", () => {
  it("uses the native bearer endpoint and preserves the password verbatim", async () => {
    const signal = new AbortController().signal;
    let observed: unknown;
    const client = new PasswordAuthClient(origin, { async postJSON(url, body, s) {
      observed = { url, body, s };
      return { status: 200, body: { token: "private-bearer", user: { email: "a@b.c" } } };
    } });
    await expect(client.login(" a@b.c ", "  password  ", signal)).resolves.toEqual({
      status: "ok", accessToken: "private-bearer", accountEmail: "a@b.c",
    });
    expect(observed).toEqual({ url: origin + "/api/auth/native/login",
      body: { email: "a@b.c", password: "  password  ", deviceName: "Relayium Windows" }, s: signal });
  });

  it.each([
    [401, {}, "invalid-credentials"], [429, {}, "rate-limited"],
    [403, { error: "email_unverified" }, "email-unverified"],
    [200, { status: "pending_deletion", reactivateToken: "must-not-leak", token: "not-adopted" }, "pending-deletion"],
  ])("returns only a closed outcome for HTTP %s", async (status, body, expected) => {
    const client = new PasswordAuthClient(origin, { postJSON: async () => ({ status, body }) });
    await expect(client.login("a@b.c", "password")).resolves.toEqual({ status: expected });
  });

  it.each([null, [], "server prose", { token: "", user: { email: "a@b.c" } },
    { token: "bearer\nheader", user: { email: "a@b.c" } },
    { token: "bearer", user: {} }, { status: "future", token: "bearer", user: { email: "a@b.c" } }])(
    "refuses malformed success without exposing response details", async (body) => {
      const client = new PasswordAuthClient(origin, { postJSON: async () => ({ status: 200, body }) });
      await expect(client.login("a@b.c", "password")).rejects.toThrow("login unavailable");
    });

  it("bounds the exact UTF-8 request before sending", async () => {
    let calls = 0;
    const client = new PasswordAuthClient(origin, { async postJSON() { calls++; return { status: 200, body: {} }; } });
    await expect(client.login("a@b.c", "密".repeat(2048))).rejects.toThrow("invalid login input");
    expect(calls).toBe(0);
  });
});
