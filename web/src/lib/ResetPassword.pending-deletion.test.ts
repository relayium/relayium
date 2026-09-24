// The reset-password landing against the server's real answers
// (handlers.go handleResetPassword).
//
// The case that matters: an account scheduled for deletion. The server answers
// HTTP 200 `{status:"pending_deletion", purgeAfter, reactivateToken}`, sets NO
// cookie and does NOT change the password (Go test
// TestResetPasswordOnFrozenAccountIssuesNoSession, deletion_test.go). Reading
// that 200 as success told the person "Password reset — signing you in…",
// redirected with no session, and dropped the only token that undoes the
// deletion.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ResetPassword from "./ResetPassword.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { session, takeReactivationOffer } from "./auth.svelte";
import { currentRoute, navigate } from "./router.svelte";

async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

let app: unknown;
let target: HTMLDivElement;

beforeEach(async () => {
  await loadLang("en");
  history.replaceState(null, "", "/reset-password?token=reset-tok");
  document.body.innerHTML = "";
});
afterEach(() => {
  navigate("lan");
  takeReactivationOffer();
  if (app) unmount(app as never);
  app = undefined;
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

async function submitWith(answer: Response, pw = "brandnewpass") {
  vi.stubGlobal("fetch", vi.fn(async () => answer));
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ResetPassword, { target });
  await settle();
  const [a, b] = [...target.querySelectorAll("input[type=password]")] as HTMLInputElement[];
  for (const el of [a, b]) {
    el.value = pw;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  flushSync();
  (target.querySelector("form") as HTMLFormElement).requestSubmit();
  await settle();
  return (target.querySelector(".status")?.textContent ?? "").trim();
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("reset-password on an account scheduled for deletion", () => {
  it("says the password was not changed and hands the reactivate token on", async () => {
    const t = messages.en.resetPassword;
    const status = await submitWith(json(200, { status: "pending_deletion", purgeAfter: 1790000000, reactivateToken: "react-7" }));

    expect(status).not.toBe(t.successBody);
    expect(status).toBe(t.pendingDeletion);
    // Nobody was signed in — the session store holds no user object.
    expect(session().user ?? null).toBeNull();

    const reactivate = [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === messages.en.account.reactivate);
    expect(reactivate, "no Reactivate hand-off").toBeTruthy();
    reactivate!.click();
    await settle();
    // Handed to the reactivation page in memory — never in a URL.
    expect(currentRoute()).toBe("account-reactivate");
    expect(location.href).not.toContain("react-7");
    expect(takeReactivationOffer()).toBe("react-7");
  });

  it("names a too-long password (the link stays valid for the retry)", async () => {
    await submitWith(json(400, { error: "password_too_long" }));
    expect((target.querySelector(".err")?.textContent ?? "").trim()).toBe(messages.en.account.errTooLong);
  });

  it("still succeeds on a real {user} answer", async () => {
    const status = await submitWith(json(200, { user: { id: "u", email: "a@b.c" } }));
    expect(status).toBe(messages.en.resetPassword.successBody);
  });
});
