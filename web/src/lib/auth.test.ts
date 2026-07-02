import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  session, refreshSession, localDeviceId, changePassword,
  passwordLogin, requestMagicLink, logout,
} from "./auth.svelte";

beforeEach(() => {
  localStorage.clear();
});

describe("auth", () => {
  it("sets user from /api/me on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: "u1", email: "a@b.com", displayName: "A" } }),
    })) as unknown as typeof fetch);
    await refreshSession();
    expect(session().user?.email).toBe("a@b.com");
  });

  it("clears user on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
    await refreshSession();
    expect(session().user).toBeNull();
  });

  it("localDeviceId is stable across calls", () => {
    const a = localDeviceId();
    const b = localDeviceId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });

  it("fetchAuthMethods falls back to password-only on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch);
    const { fetchAuthMethods } = await import("./auth.svelte");
    const m = await fetchAuthMethods();
    expect(m).toEqual({ password: true, google: false, magic: false });
  });

  it("register sets the session user on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ user: { id: "u9", email: "r@b.com", displayName: "" } }),
    })) as unknown as typeof fetch);
    const { register, session } = await import("./auth.svelte");
    const res = await register("r@b.com", "longenough1");
    expect(res.ok).toBe(true);
    expect(session().user?.email).toBe("r@b.com");
  });

  it("register surfaces server error on 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: "email already registered" }),
    })) as unknown as typeof fetch);
    const { register } = await import("./auth.svelte");
    const res = await register("dup@b.com", "longenough1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("registered");
  });
});

describe("changePassword", () => {
  it("returns ok on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ status: "ok" }),
    })) as unknown as typeof fetch);
    const res = await changePassword("old", "newpassword1");
    expect(res.ok).toBe(true);
  });

  it("maps the server error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ error: "current password incorrect" }),
    })) as unknown as typeof fetch);
    const res = await changePassword("bad", "newpassword1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("current password incorrect");
  });

  it("returns a network error instead of throwing when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const res = await changePassword("old", "newpassword1");
    expect(res).toEqual({ ok: false, error: "network" });
  });
});

describe("network resilience", () => {
  it("passwordLogin surfaces a structured network error rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch);
    const res = await passwordLogin("a@b.com", "longenough1");
    expect(res).toEqual({ ok: false, error: "network" });
  });
});

describe("requestMagicLink", () => {
  it("reports ok only on a 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch);
    expect(await requestMagicLink("a@b.com")).toEqual({ ok: true });
  });

  it("reports failure (not success) on 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch);
    const res = await requestMagicLink("a@b.com");
    expect(res.ok).toBe(false);
  });

  it("reports a network error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(await requestMagicLink("a@b.com")).toEqual({ ok: false, error: "network" });
  });
});

describe("logout", () => {
  it("clears the session and role markers even when the request fails", async () => {
    sessionStorage.setItem("relayium_pair_exp", "123");
    sessionStorage.setItem("relayium_xfer_token", "tok");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    await logout();
    expect(session().user).toBeNull();
    expect(sessionStorage.getItem("relayium_pair_exp")).toBeNull();
    expect(sessionStorage.getItem("relayium_xfer_token")).toBeNull();
  });
});
