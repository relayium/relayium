// What the sign-in form says when the server refuses, and what it must never
// say.
//
// The account endpoints emit fourteen error codes. This screen knew four, and
// everything else read as "wrong email or password" — a specific claim about
// something the person can retype.
//
// The case that made this worth fixing rather than filing: a locked-out sign-in
// answers 429, so the screen told the person their password was wrong, they
// retyped the CORRECT one, and each attempt kept the lockout alive. The app was
// instructing somebody to do the one thing that prolongs the problem.
//
// Each case here drives the real component through a real submit, because the
// mapping is only worth anything if it reaches the screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Account from "./Account.svelte";
import { loadLang, messages, setLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;
const realFetch = globalThis.fetch;

/** Mount signed out, with `/api/auth/password/login` answering as given. */
async function mountWithLoginAnswer(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (url === "/api/auth/methods") {
      return { ok: true, status: 200, json: async () => ({ password: true, google: false, magic: false }) };
    }
    if (url === "/api/me") return { ok: true, status: 401, json: async () => ({}) };
    if (url === "/api/auth/password/login") {
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;

  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Account, { target, props: { open: true } });
  for (let i = 0; i < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
  return target.querySelector("[role='dialog']") as HTMLElement;
}

/** Fill the two fields and submit, then let the answer land. */
async function signIn(dialog: HTMLElement) {
  const email = dialog.querySelector("input[type=email]") as HTMLInputElement;
  const password = dialog.querySelector("input[type=password]") as HTMLInputElement;
  email.value = "someone@example.com";
  email.dispatchEvent(new Event("input", { bubbles: true }));
  password.value = "the-correct-password";
  password.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  (dialog.querySelector("form.menu") as HTMLFormElement).requestSubmit();
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
  return (dialog.querySelector(".err")?.textContent ?? "").trim();
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

describe("a refused sign-in says which refusal it was", () => {
  it("does not blame the password when the server is throttling", async () => {
    const dialog = await mountWithLoginAnswer(429, { error: "too many attempts, try again later" });
    const shown = await signIn(dialog);

    const t = messages.en.account;
    expect(shown).toBe(t.errRateLimited);
    // The assertion that matters: the password the person just typed is correct,
    // and telling them otherwise is what makes them retry into the lockout.
    expect(shown).not.toBe(t.errLogin);
  });

  it("still blames the credentials when the credentials are the problem", async () => {
    // The other half. A fix that stopped saying "wrong password" for a wrong
    // password would be a worse screen, not a better one.
    const dialog = await mountWithLoginAnswer(401, { error: "invalid credentials" });
    expect(await signIn(dialog)).toBe(messages.en.account.errLogin);
  });

  it("names an account awaiting deletion, using the sentence that already existed", async () => {
    // `pendingDeletion` was in this catalogue and wired only on the magic-link
    // path, so a password sign-in read it as a wrong password.
    const dialog = await mountWithLoginAnswer(403, { error: "account_pending_deletion" });
    expect(await signIn(dialog)).toBe(messages.en.account.pendingDeletion);
  });

  it("says it does not recognise a code rather than naming the credentials", async () => {
    // Nine of the fourteen codes are not handled by name, and a build talking to
    // a newer server will meet codes that do not exist yet. Neither may be
    // reported as a credential error.
    const dialog = await mountWithLoginAnswer(400, { error: "some_code_from_a_newer_server" });
    const shown = await signIn(dialog);
    expect(shown).toBe(messages.en.account.errUnrecognised);
    expect(shown).not.toBe(messages.en.account.errLogin);
  });

  it("says the throttle in Chinese too", async () => {
    await setLang("zh");
    const dialog = await mountWithLoginAnswer(429, { error: "too many attempts, try again later" });
    const shown = await signIn(dialog);
    expect(shown).toBe(messages.zh.account.errRateLimited);
    expect(/[一-鿿]/.test(shown)).toBe(true);
  });
});
