// The verify-email landing against the server's real answers
// (handlers.go handleVerifyEmail).
//
// Every refusal used to read "This link is invalid or has expired." A 500 is
// not that: by then the link may already be spent with the account verified
// (A29 V3), so the honest next step is to try signing in. A network failure is
// not that either — the request never arrived and the link is untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import VerifyEmail from "./VerifyEmail.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { takeReactivationOffer } from "./auth.svelte";
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
  history.replaceState(null, "", "/verify-email?token=verify-tok");
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

async function verifyWith(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(VerifyEmail, { target });
  await settle();
  (target.querySelector("form") as HTMLFormElement).requestSubmit();
  await settle();
  return (target.querySelector(".status")?.textContent ?? "").trim();
}

describe("verify-email says which failure it was", () => {
  it("a 500 is a server error, not an invalid link", async () => {
    const status = await verifyWith(async () => new Response("server error\n", { status: 500 }));
    expect(status).toBe(messages.en.verifyEmail.serverError);
    expect(status).not.toBe(messages.en.verifyEmail.invalidTitle);
  });

  it("a network failure says so and keeps the form", async () => {
    const status = await verifyWith(async () => { throw new TypeError("Failed to fetch"); });
    expect(status).toBe(messages.en.account.errNetwork);
    expect(target.querySelector("#verify-password"), "the retry form is gone").not.toBeNull();
  });

  it("invalid_token is still the invalid-link state", async () => {
    const status = await verifyWith(async () =>
      new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 }));
    expect(status).toBe(messages.en.verifyEmail.invalidTitle);
  });

  it("a pending_deletion body hands the reactivate token to the banner instead of claiming success", async () => {
    const status = await verifyWith(async () =>
      new Response(JSON.stringify({ status: "pending_deletion", purgeAfter: 1, reactivateToken: "react-9" }), { status: 200 }));
    expect(status).not.toBe(messages.en.verifyEmail.successBody);
    expect(currentRoute()).toBe("account-reactivate");
    expect(location.href).not.toContain("react-9");
    expect(takeReactivationOffer()).toBe("react-9");
  });
});
