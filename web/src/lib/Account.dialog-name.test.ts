// The account dialog has five identities behind one <div role="dialog">, and the
// accessible name has to say which one is on screen right now.
//
// Signed out it can be sign-in, registration, password reset, or email
// verification; signed in it is the account menu. A fixed label would announce
// the wrong task in four of those states. The browser scan reaches sign-in only,
// so the remaining branches are driven here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Account from "./Account.svelte";
import { loadLang, messages, setLang } from "./i18n.svelte";

const USER = {
  id: "u1", email: "someone@example.com", displayName: "Someone",
  hasPassword: true, emailVerified: true, onlyOwnNodes: false,
  planId: "free", subscriptionStatus: "", subscriptionEnd: 0, hasBilling: false,
};

let target: HTMLDivElement;
let app: unknown;
const realFetch = globalThis.fetch;

/** `user: null` renders the signed-out sign-in form; a user renders the menu. */
async function mountAccount(user: unknown) {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (url === "/api/auth/methods") return { ok: true, status: 200, json: async () => ({ password: true, google: false, magic: false }) };
    if (url === "/api/me") return user
      ? { ok: true, status: 200, json: async () => ({ user }) }
      : { ok: true, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;

  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Account, { target, props: { open: true } });
  // Two await fetch()+json() pairs run on mount; a macrotask tick drains each.
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
  return target.querySelector("[role='dialog']")!;
}

beforeEach(async () => {
  await loadLang("en");
  history.replaceState(null, "", "/");
});

afterEach(async () => {
  if (app) unmount(app as never);
  app = undefined;
  target?.remove();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await setLang("en");
  history.replaceState(null, "", "/");
});

/** Clicks the first button whose visible text matches, then settles the update. */
function clickByText(root: HTMLElement, text: string) {
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button labelled "${text}" — found: ${[...root.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(" | ")}`);
  button.click();
  flushSync();
}

describe("account dialog accessible name", () => {
  it("is the sign-in label while signed out", async () => {
    const dialog = await mountAccount(null);
    expect(dialog.getAttribute("aria-label")).toBe(messages.en.account.signIn);
  });

  it("follows the switch into the registration form", async () => {
    const dialog = await mountAccount(null);
    clickByText(target, messages.en.account.toRegister);
    expect(dialog.getAttribute("aria-label")).toBe(messages.en.account.createAccount);
  });

  it("follows the switch into the forgot-password form and back", async () => {
    const dialog = await mountAccount(null);
    clickByText(target, messages.en.account.forgotPasswordLink);
    expect(dialog.getAttribute("aria-label")).toBe(messages.en.account.forgotPanel);
    clickByText(target, messages.en.account.toLogin);
    expect(dialog.getAttribute("aria-label")).toBe(messages.en.account.signIn);
  });

  it("becomes the verification panel after a successful registration", async () => {
    // register() resolves without a session — the dialog turns into "check your
    // email", which is a different thing to announce than "Create account".
    const dialog = await mountAccount(null);
    clickByText(target, messages.en.account.toRegister);
    (target.querySelector('input[type="email"]') as HTMLInputElement).value = "new@example.com";
    (target.querySelector('input[type="email"]') as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
    (target.querySelector('input[type="password"]') as HTMLInputElement).value = "correct-horse-battery";
    (target.querySelector('input[type="password"]') as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));

    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ email: "new@example.com" }) })) as unknown as typeof fetch;
    (target.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); }

    expect(dialog.getAttribute("aria-label")).toBe(messages.en.account.verifyPanel);
  });

  it("is the account-panel label once signed in", async () => {
    const dialog = await mountAccount(USER);
    expect(dialog.getAttribute("aria-label")).toBe(messages.en.account.panel);
    expect(dialog.getAttribute("aria-label")).not.toBe(messages.en.account.signIn);
  });

  it("is localized, not a hardcoded English string", async () => {
    await setLang("zh");
    const dialog = await mountAccount(USER);
    expect(dialog.getAttribute("aria-label")).toBe(messages.zh.account.panel);
    expect(dialog.getAttribute("aria-label")).not.toBe(messages.en.account.panel);
  });
});
