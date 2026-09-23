// The two account-lifecycle landings the server's emails link to, which had no
// route at all: /account/delete/confirm (RequestAccountDeletion) and
// /account/reactivate (reactivateLink), both in server/account/deletion.go.
// Without them the SPA fell through to the home page, so nobody could finish
// deleting an account or undo a deletion from the email.
//
// Both spend a single-use token, and both do it ONLY on a button press. Mail
// gateways prefetch links (and some run the page's script); a page that
// confirmed on load would let a scanner delete somebody's account, or hold the
// session a reactivation mints. The first case of each block guards exactly
// that, because "save the user a click" is the change most likely to undo it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AccountDeleteConfirm from "./AccountDeleteConfirm.svelte";
import AccountReactivate from "./AccountReactivate.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { offerReactivation, session, takeReactivationOffer } from "./auth.svelte";
import {
  ACCOUNT_DELETE_PATH, ACCOUNT_REACTIVATE_PATH, routeFromLocation, isReactivateFragment,
} from "./router.svelte";

async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let app: unknown;
let target: HTMLDivElement;

function render(component: typeof AccountDeleteConfirm) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(component, { target });
}

const button = (label: string) =>
  [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const status = () => (target.querySelector(".status")?.textContent ?? "").trim();

beforeEach(async () => {
  await loadLang("en");
  document.body.innerHTML = "";
});
afterEach(() => {
  if (app) unmount(app as never);
  app = undefined;
  takeReactivationOffer();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("routes exist for the links the server mails", () => {
  it("the delete-confirm path is the one RequestAccountDeletion builds", () => {
    const go = readFileSync(resolve(process.cwd(), "../server/account/deletion.go"), "utf8");
    expect(go).toContain(`"%s${ACCOUNT_DELETE_PATH}?token=%s"`);
    expect(routeFromLocation(ACCOUNT_DELETE_PATH, "")).toBe("account-delete");
  });

  it("the reactivate path is the one reactivateLink builds", () => {
    const go = readFileSync(resolve(process.cwd(), "../server/account/deletion.go"), "utf8");
    expect(go).toContain(`"%s${ACCOUNT_REACTIVATE_PATH}?token=%s"`);
    expect(routeFromLocation(ACCOUNT_REACTIVATE_PATH, "")).toBe("account-reactivate");
  });

  it("the frozen-account OAuth redirect fragment opens the reactivation page", () => {
    // oauth.go / apple_web.go redirect a frozen account to "/#account=pending_deletion&token=…".
    for (const f of ["oauth.go", "apple_web.go"]) {
      const go = readFileSync(resolve(process.cwd(), `../server/account/${f}`), "utf8");
      expect(go, f).toContain(`"/#account=pending_deletion&token="`);
    }
    expect(routeFromLocation("/", "#account=pending_deletion&token=abc")).toBe("account-reactivate");
    expect(isReactivateFragment("#account=pending_deletion")).toBe(false); // no token, nothing to offer
    expect(routeFromLocation("/", "#compare")).toBe("lan");
  });
});

describe("/account/delete/confirm", () => {
  beforeEach(() => history.replaceState(null, "", `${ACCOUNT_DELETE_PATH}?token=del-tok`));

  it("does nothing on load: no request until the button is pressed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(AccountDeleteConfirm);
    await settle();
    expect(fetchMock, "the page confirmed the deletion on load").not.toHaveBeenCalled();
    expect(status()).toBe(messages.en.accountDelete.lead);
    expect(target.querySelector("[data-testid='delete-consequence']")?.textContent?.trim())
      .toBe(messages.en.accountDelete.consequence);
  });

  it("scrubs the token from the address bar", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(AccountDeleteConfirm);
    await settle();
    expect(location.search).toBe("");
    expect(location.pathname).toBe(ACCOUNT_DELETE_PATH);
  });

  it("the press POSTs exactly the emailed token, then reports the scheduled deletion", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/account/delete/confirm" ? json(200, { status: "ok" }) : new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    render(AccountDeleteConfirm);
    await settle();
    button(messages.en.accountDelete.cta)!.click();
    await settle();
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/account/delete/confirm") as unknown as [string, RequestInit];
    expect(call).toBeTruthy();
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body as string)).toEqual({ token: "del-tok" });
    expect(status()).toBe(messages.en.accountDelete.done);
    // Every session was deleted server-side; this browser shows signed out.
    expect(session().user ?? null).toBeNull();
    expect(button(messages.en.accountDelete.cta)).toBeUndefined();
  });

  it("an expired or used link says so and offers no delete button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: "invalid_or_expired_token" })));
    render(AccountDeleteConfirm);
    await settle();
    button(messages.en.accountDelete.cta)!.click();
    await settle();
    expect(status()).toBe(messages.en.accountDelete.invalid);
    expect(button(messages.en.accountDelete.cta)).toBeUndefined();
  });

  it("a network failure keeps the button for a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(AccountDeleteConfirm);
    await settle();
    button(messages.en.accountDelete.cta)!.click();
    await settle();
    expect(status()).toBe(messages.en.accountDelete.errNetwork);
    expect(button(messages.en.accountDelete.cta)).toBeTruthy();
  });

  it("a 500 is not reported as done or as an invalid link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error\n", { status: 500 })));
    render(AccountDeleteConfirm);
    await settle();
    button(messages.en.accountDelete.cta)!.click();
    await settle();
    expect(status()).toBe(messages.en.accountDelete.errServer);
    expect(button(messages.en.accountDelete.cta)).toBeTruthy();
  });

  it("without a token there is nothing to confirm", async () => {
    history.replaceState(null, "", ACCOUNT_DELETE_PATH);
    vi.stubGlobal("fetch", vi.fn());
    render(AccountDeleteConfirm);
    await settle();
    expect(status()).toBe(messages.en.accountDelete.noToken);
    expect(button(messages.en.accountDelete.cta)).toBeUndefined();
  });

  it("does not name a fixed number of grace days (the server setting is admin-tunable)", async () => {
    await loadLang("zh");
    for (const l of ["en", "zh"] as const) {
      const m = messages[l].accountDelete;
      expect(`${m.consequence} ${m.doneUndo}`).not.toMatch(/\d+\s*(-?day|天)/);
    }
  });
});

describe("/account/reactivate", () => {
  beforeEach(() => history.replaceState(null, "", `${ACCOUNT_REACTIVATE_PATH}?token=re-tok`));

  it("does nothing on load: no request until the button is pressed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(AccountReactivate);
    await settle();
    expect(fetchMock, "the page reactivated (and minted a session) on load").not.toHaveBeenCalled();
    expect(location.search).toBe("");
    expect(status()).toBe(messages.en.accountReactivate.lead);
  });

  it("the press POSTs the emailed token and signs the person in", async () => {
    const fetchMock = vi.fn(async () => json(200, { user: { id: "u1", email: "back@example.com" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(AccountReactivate);
    await settle();
    button(messages.en.accountReactivate.cta)!.click();
    await settle();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/account/reactivate");
    expect(JSON.parse(call[1].body as string)).toEqual({ token: "re-tok" });
    expect(status()).toBe(messages.en.accountReactivate.done);
    expect(session().user?.email).toBe("back@example.com");
  });

  it("an expired, used or no-longer-needed token says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: "invalid_or_expired_token" })));
    render(AccountReactivate);
    await settle();
    button(messages.en.accountReactivate.cta)!.click();
    await settle();
    expect(status()).toBe(messages.en.accountReactivate.invalid);
    expect(button(messages.en.accountReactivate.cta)).toBeUndefined();
  });

  it("a 500 points at signing in rather than claiming the link is dead", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error\n", { status: 500 })));
    render(AccountReactivate);
    await settle();
    button(messages.en.accountReactivate.cta)!.click();
    await settle();
    expect(status()).toBe(messages.en.accountReactivate.errServer);
  });

  it("takes the token from the frozen-account OAuth fragment and scrubs it", async () => {
    history.replaceState(null, "", "/#account=pending_deletion&token=frag-tok");
    const fetchMock = vi.fn(async () => json(200, { user: { id: "u1", email: "a@b.c" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(AccountReactivate);
    await settle();
    expect(location.hash).toBe("");
    expect(location.pathname).toBe(ACCOUNT_REACTIVATE_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
    button(messages.en.accountReactivate.cta)!.click();
    await settle();
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: "frag-tok" });
  });

  it("takes a token offered in memory by a frozen sign-in elsewhere", async () => {
    history.replaceState(null, "", ACCOUNT_REACTIVATE_PATH);
    offerReactivation("mem-tok");
    const fetchMock = vi.fn(async () => json(200, { user: { id: "u1", email: "a@b.c" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(AccountReactivate);
    await settle();
    button(messages.en.accountReactivate.cta)!.click();
    await settle();
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: "mem-tok" });
  });
});
