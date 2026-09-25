// The reset-password landing when the reset was overtaken (W-N48).
//
// POST /api/auth/password/reset answers 409 `{error:"credentials_changed"}`
// when this reset committed and spent its link, but another reset or change of
// the same account committed before this reset's session was issued: no cookie,
// and the later password is the one in effect (Go tests in
// server/account/reset_conflict_http_test.go). The page must say so, must not
// claim success, and must not offer this spent link's form again. A 500 keeps
// the generic copy, which says the new password may already be set.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ResetPassword from "./ResetPassword.svelte";
import { loadLang, messages, setLang, type Lang } from "./i18n.svelte";
import { session } from "./auth.svelte";
import { navigate } from "./router.svelte";

async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

const mounted: unknown[] = [];

beforeEach(() => {
  history.replaceState(null, "", "/reset-password?token=reset-tok");
  document.body.innerHTML = "";
});
afterEach(async () => {
  while (mounted.length) unmount(mounted.pop() as never);
  navigate("lan");
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  await setLang("en");
});

async function submitWith(answer: Response) {
  const fetchMock = vi.fn(async () => answer);
  vi.stubGlobal("fetch", fetchMock);
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(ResetPassword, { target }));
  await settle();
  for (const el of target.querySelectorAll<HTMLInputElement>("input[type=password]")) {
    el.value = "brandnewpass";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  flushSync();
  (target.querySelector("form") as HTMLFormElement).requestSubmit();
  await settle();
  return { target, fetchMock, status: (target.querySelector(".status")?.textContent ?? "").trim() };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe.each<Lang>(["en", "zh"])("reset-password overtaken by another reset/change (%s)", (lang) => {
  beforeEach(async () => {
    await loadLang(lang);
    await setLang(lang);
  });

  it("explains that a later change won, without success, sign-in or a retry of the spent link", async () => {
    const t = messages[lang].resetPassword;
    const { target, fetchMock, status } = await submitWith(json(409, { error: "credentials_changed" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status).toBe(t.credentialsChanged);
    expect(status).not.toBe(t.successBody);
    expect(status).not.toBe(t.errGeneric);
    expect(target.querySelector(".status")?.className ?? "").toContain("danger");
    expect(session().user ?? null).toBeNull();
    // The link is spent: its form (and submit button) is gone, only the way home remains.
    expect(target.querySelector("form")).toBeNull();
    expect([...target.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual([t.backHome]);
  });

  it("keeps the generic copy for a real server error", async () => {
    const { target, status } = await submitWith(new Response("server error\n", { status: 500 }));
    expect(status).not.toBe(messages[lang].resetPassword.successBody);
    expect((target.querySelector(".err")?.textContent ?? "").trim()).toBe(messages[lang].resetPassword.errGeneric);
  });
});

describe("credentialsChanged copy states the facts", () => {
  beforeEach(async () => {
    await loadLang("en");
    await loadLang("zh");
  });

  it("names the later change, the spent link, no sign-in, and both ways forward", () => {
    const en = messages.en.resetPassword.credentialsChanged;
    expect(en).toMatch(/link has been used/);
    expect(en).toMatch(/another password reset or change/);
    expect(en).toMatch(/not signed in/);
    expect(en).toMatch(/most recent password/);
    expect(en).toMatch(/request a new reset link/);
    expect(en).not.toMatch(/try again/i);

    const zh = messages.zh.resetPassword.credentialsChanged;
    expect(zh).toContain("链接已经用过");
    expect(zh).toContain("另一次密码重置或修改");
    expect(zh).toContain("没有登录");
    expect(zh).toContain("最新的密码");
    expect(zh).toContain("重新申请重置链接");
    expect(zh).not.toContain("重试");
  });
});
