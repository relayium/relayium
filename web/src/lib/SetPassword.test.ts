import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SetPassword from "./SetPassword.svelte";
import { loadLang, setLang } from "./i18n.svelte";
import { navigate } from "./router.svelte";

const mounted: unknown[] = [];
async function settle(n = 3) { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); } }

beforeEach(async () => { await loadLang("en"); await setLang("en"); document.body.innerHTML = ""; });
afterEach(async () => {
  while (mounted.length) unmount(mounted.pop() as never);
  vi.unstubAllGlobals(); navigate("lan"); history.replaceState(null, "", "/");
});

async function render(path = "/set-password#token=fresh-secret") {
  history.replaceState(null, "", path);
  const target = document.createElement("div"); document.body.appendChild(target);
  mounted.push(mount(SetPassword, { target })); await settle(); return target;
}

describe("fresh first-password landing", () => {
  it("scrubs a fragment proof immediately and sends it only in the POST body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const target = await render();
    expect(location.pathname + location.search + location.hash).toBe("/set-password");
    for (const input of target.querySelectorAll<HTMLInputElement>("input[type=password]")) { input.value = "freshpass12"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    (target.querySelector("form") as HTMLFormElement).requestSubmit(); await settle();
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>)[0];
    expect(url).toBe("/api/auth/password/set/confirm");
    expect(JSON.parse(String(init?.body))).toEqual({ token: "fresh-secret", newPassword: "freshpass12" });
    expect(String(url)).not.toContain("fresh-secret");
    expect(target.querySelector("form")).toBeNull();
  });

  it("accepts a legacy query proof but scrubs it before rendering", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const target = await render("/set-password?token=legacy-secret");
    expect(location.pathname + location.search + location.hash).toBe("/set-password");
    expect(target.querySelector("form")).not.toBeNull();
  });

  it("removes the form after an invalid or replayed proof", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 400, headers: { "Content-Type": "application/json" } })));
    const target = await render();
    for (const input of target.querySelectorAll<HTMLInputElement>("input[type=password]")) { input.value = "freshpass12"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    (target.querySelector("form") as HTMLFormElement).requestSubmit(); await settle();
    expect(target.querySelector("form")).toBeNull();
    expect(target.textContent).toContain("invalid, expired or already used");
  });
});
