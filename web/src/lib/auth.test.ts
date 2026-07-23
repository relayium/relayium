import { describe, it, expect, test, vi, beforeEach } from "vitest";
import {
  session, refreshSession, localDeviceId, changePassword,
  passwordLogin, requestMagicLink, logout,
  appleLoginUrl, fetchAuthMethods,
} from "./auth.svelte";
import { rememberUploadKey, uploadKey } from "./upload-keys";
import { recordTransfer, loadHistory } from "./history";

test("appleLoginUrl points at the web start route", () => {
  expect(appleLoginUrl()).toBe("/api/auth/apple/web/start");
});

test("fetchAuthMethods default includes apple:false", async () => {
  // With fetch unavailable/erroring, the safe default must carry apple:false.
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("no net"));
  const m = await fetchAuthMethods();
  expect(m.apple).toBe(false);
  globalThis.fetch = orig;
});

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
    expect(m).toEqual({ password: true, google: false, apple: false, magic: false });
  });

  it("register reports verification_sent without logging the user in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ status: "verification_sent", email: "r@b.com" }),
    })) as unknown as typeof fetch);
    const { register, session } = await import("./auth.svelte");
    const res = await register("r@b.com", "longenough1");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("verification_sent");
    expect(res.email).toBe("r@b.com");
    expect(session().user).toBeNull();
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

describe("email verification + password reset", () => {
  it("passwordLogin distinguishes email_unverified (403) from a generic error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 403,
      json: async () => ({ error: "email_unverified", email: "a@b.com" }),
    })) as unknown as typeof fetch);
    const res = await passwordLogin("a@b.com", "longenough1");
    expect(res.ok).toBe(false);
    expect(res.unverified).toBe(true);
    expect(res.email).toBe("a@b.com");
  });

  it("verifyEmail sets the session user from the returned user on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ user: { id: "u2", email: "v@b.com", displayName: "" } }),
    })) as unknown as typeof fetch);
    const { verifyEmail, session } = await import("./auth.svelte");
    const res = await verifyEmail("tok123");
    expect(res.ok).toBe(true);
    expect(session().user?.email).toBe("v@b.com");
  });

  it("verifyEmail surfaces invalid_token distinctly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: "invalid_token" }),
    })) as unknown as typeof fetch);
    const { verifyEmail } = await import("./auth.svelte");
    const res = await verifyEmail("bad-token");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_token");
  });

  it("resendVerification and forgotPassword resolve without throwing even offline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const { resendVerification, forgotPassword } = await import("./auth.svelte");
    await expect(resendVerification("a@b.com")).resolves.toBeUndefined();
    await expect(forgotPassword("a@b.com")).resolves.toBeUndefined();
  });

  it("resetPassword sets the session user on success and surfaces invalid_token on failure", async () => {
    const { resetPassword, session } = await import("./auth.svelte");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: "invalid_token" }),
    })) as unknown as typeof fetch);
    const bad = await resetPassword("bad-token", "newpassword1");
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("invalid_token");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ user: { id: "u3", email: "r2@b.com", displayName: "" } }),
    })) as unknown as typeof fetch);
    const good = await resetPassword("tok456", "newpassword1");
    expect(good.ok).toBe(true);
    expect(session().user?.email).toBe("r2@b.com");
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
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    await logout();
    expect(session().user).toBeNull();
    expect(sessionStorage.getItem("relayium_pair_exp")).toBeNull();
  });
});

describe("logout 清本机凭证", () => {
  it("清掉上传密钥和传输历史 —— 否则「退出登录」只退了 UI", async () => {
    // 每条 id→key 都是完整能力凭证：/d/<id>#k=<key> 不需要任何会话就能下载。
    rememberUploadKey("file-1", "k1");
    recordTransfer({ name: "salary.pdf", size: 10, direction: "send", peer: "Mac-1" });
    expect(uploadKey("file-1")).toBe("k1");
    expect(loadHistory().length).toBe(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await logout();

    expect(uploadKey("file-1"), "登出后上传密钥仍在 —— 共用设备上等于把文件访问权留给下一个人").toBeUndefined();
    expect(loadHistory(), "登出后传输历史仍在").toEqual([]);
  });

  it("服务端登出请求失败也照样清本机 —— 本机状态不该由网络决定", async () => {
    rememberUploadKey("file-2", "k2");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await logout();
    expect(uploadKey("file-2")).toBeUndefined();
  });
});
