import { describe, it, expect, vi, beforeEach } from "vitest";
import { session, refreshSession, localDeviceId } from "./auth.svelte";

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
});
