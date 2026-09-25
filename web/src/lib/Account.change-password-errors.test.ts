// What the change-password form says when the server refuses, and what it
// must never say.
//
// The person is already signed in, so "Wrong email or password." is false for
// every answer this endpoint gives — and it used to be the fallback for all of
// them: a too-long new password, an expired browser session, a 500. Each case
// drives the real component through a real submit against the server's real
// bodies (handlers.go handleChangePassword; RequireAuth's plain-text 401).
//
// The success sentence is pinned too. It used to say other devices were signed
// out, but a password change revokes browser sessions only
// (ChangePasswordAndRevokeSessions: `UPDATE sessions …`); app and CLI bearer
// tokens in cli_tokens stay valid until the device is removed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Account from "./Account.svelte";
import { loadLang, messages, setLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;
const realFetch = globalThis.fetch;

type Answer = { status: number; json?: unknown; text?: string };

async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/** Mount signed in, with `/api/auth/password/change` answering as given. */
async function mountSignedIn(answer: Answer) {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (url === "/api/auth/methods") {
      return new Response(JSON.stringify({ password: true, google: false, magic: false }), { status: 200 });
    }
    if (url === "/api/me") {
      return new Response(JSON.stringify({ user: { id: "u1", email: "me@example.com", hasPassword: true } }), { status: 200 });
    }
    if (url === "/api/auth/password/change") {
      return answer.json !== undefined
        ? new Response(JSON.stringify(answer.json), { status: answer.status, headers: { "Content-Type": "application/json" } })
        : new Response(answer.text ?? "", { status: answer.status, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Account, { target, props: { open: true } });
  await settle();
  return target.querySelector("[role='dialog']") as HTMLElement;
}

/** Open the form, fill it, submit; return the error line (or ""). */
async function changePassword(dialog: HTMLElement, newPw = "a-new-password") {
  const t = messages.en.account;
  const opener = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === t.changePassword);
  opener!.click();
  flushSync();
  const form = dialog.querySelector("form.pwform") as HTMLFormElement;
  const [cur, next, confirm] = [...form.querySelectorAll("input[type=password]")] as HTMLInputElement[];
  for (const [el, v] of [[cur, "the-old-password"], [next, newPw], [confirm, newPw]] as const) {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  flushSync();
  form.requestSubmit();
  await settle();
  return (dialog.querySelector(".pwform .err")?.textContent ?? "").trim();
}

beforeEach(async () => {
  await loadLang("en");
});

afterEach(async () => {
  if (app) unmount(app as never);
  app = undefined;
  target?.remove();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await setLang("en");
});

describe("a refused password change never blames the sign-in credentials", () => {
  it("names a too-long password", async () => {
    const dialog = await mountSignedIn({ status: 400, json: { error: "password_too_long" } });
    const shown = await changePassword(dialog);
    expect(shown).toBe(messages.en.account.errTooLong);
    expect(shown).not.toBe(messages.en.account.errLogin);
  });

  it("says the browser session is gone when RequireAuth answers a plain-text 401", async () => {
    const dialog = await mountSignedIn({ status: 401, text: "unauthorized\n" });
    const shown = await changePassword(dialog);
    expect(shown).toBe(messages.en.account.errSessionExpired);
    expect(shown).not.toBe(messages.en.account.errLogin);
    expect(shown).not.toBe(messages.en.account.errCurrentWrong);
  });

  it("keeps the current-password sentence for the JSON 401 that means it", async () => {
    const dialog = await mountSignedIn({ status: 401, json: { error: "current password incorrect" } });
    expect(await changePassword(dialog)).toBe(messages.en.account.errCurrentWrong);
  });

  it("reports a 500 as a server error", async () => {
    const dialog = await mountSignedIn({ status: 500, text: "server error\n" });
    const shown = await changePassword(dialog);
    expect(shown).toBe(messages.en.account.errUnrecognised);
    expect(shown).not.toBe(messages.en.account.errLogin);
  });

  // server/account/sqlite_password_recovery.go revokes every other browser
  // session AND every app/CLI bearer (OA-053 Q2); the browser that changed the
  // password stays signed in. The copy must say so before and after.
  it("says before and after that other browsers, apps and the CLI are signed out", async () => {
    const dialog = await mountSignedIn({ status: 200, json: { status: "ok" } });
    const t = messages.en.account;
    const opener = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === t.changePassword);
    opener!.click();
    flushSync();
    expect(dialog.querySelector("form.pwform")?.textContent, "the consequence is shown before submitting").toContain(t.pwSignsOutNote);
    dialog.querySelector<HTMLButtonElement>("form.pwform .btn-link")!.click(); // close again
    flushSync();

    expect(await changePassword(dialog)).toBe("");
    expect(dialog.textContent ?? "").toContain(t.pwChanged);
    for (const s of [t.pwChanged, t.pwSignsOutNote]) {
      expect(s).toMatch(/apps? and (the )?CLI/i);
      expect(s).not.toMatch(/stay signed in until you remove/i);
    }
    expect(t.pwSignsOutNote).toMatch(/this browser stays signed in/i);
    expect(messages.en.resetPassword.signsOutNote).toMatch(/signs out every browser, app and CLI/i);
    await loadLang("zh");
    const zh = messages.zh.account;
    expect(zh.pwChanged).not.toContain("仍保持登录");
    expect(zh.pwChanged).toContain("App");
    expect(zh.pwSignsOutNote).toContain("当前这个浏览器保持登录");
    expect(messages.zh.resetPassword.signsOutNote).toContain("都会退出");
  });
});
