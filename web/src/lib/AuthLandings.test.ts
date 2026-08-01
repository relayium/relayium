import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import VerifyEmail from "./VerifyEmail.svelte";
import ResetPassword from "./ResetPassword.svelte";
import { loadLang } from "./i18n.svelte";

beforeEach(async () => {
  await loadLang("en");
  document.body.innerHTML = "";
});

afterEach(() => vi.unstubAllGlobals());

function render(component: typeof VerifyEmail | typeof ResetPassword) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(component, { target });
  return { target, app };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("email verification landing", () => {
  it("scrubs the token, names one task, keeps a persistent password label, and waits for an explicit action", async () => {
    history.replaceState(null, "", "/verify-email?token=verify-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { target, app } = render(VerifyEmail);
    await settle();

    expect(location.search).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.querySelectorAll("h1")).toHaveLength(1);
    expect(target.querySelector("h1")?.textContent).toBe("Verify your email");
    const input = target.querySelector<HTMLInputElement>('#verify-password')!;
    expect(target.querySelector('label[for="verify-password"]')?.textContent).toBe("Password");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(target.querySelector(".auth-card")?.classList.contains("ui-card")).toBe(true);
    unmount(app);
  });

  it("keeps passwordless verification behind its explicit secondary action", async () => {
    history.replaceState(null, "", "/verify-email?token=verify-token");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "invalid_or_expired_token" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { target, app } = render(VerifyEmail);
    await settle();

    const secondary = [...target.querySelectorAll("button")].find((button) => /without a password/i.test(button.textContent ?? ""))!;
    expect(secondary.classList.contains("btn-primary")).toBe(false);
    secondary.click();
    await settle();
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/auth/email/verify");
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ token: "verify-token", password: "" });
    unmount(app);
  });
});

describe("password reset landing", () => {
  it("scrubs but does not spend the token on mount and exposes two labelled password fields", async () => {
    history.replaceState(null, "", "/reset-password?token=reset-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { target, app } = render(ResetPassword);
    await settle();

    expect(location.search).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.querySelectorAll("h1")).toHaveLength(1);
    expect(target.querySelector("h1")?.textContent).toBe("Reset your password");
    expect(target.querySelector('label[for="reset-new-password"]')?.textContent).toBe("New password");
    expect(target.querySelector('label[for="reset-confirm-password"]')?.textContent).toBe("Confirm new password");
    expect(target.querySelector('#reset-new-password')?.getAttribute("aria-describedby")).toBe("reset-password-hint");
    unmount(app);
  });

  it("reports local validation as an alert without spending the token", async () => {
    history.replaceState(null, "", "/reset-password?token=reset-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { target, app } = render(ResetPassword);
    await settle();

    target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/at least 8 characters/i);
    unmount(app);
  });
});
