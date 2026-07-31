import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Nav from "./Nav.svelte";
import { loadLang } from "./i18n.svelte";
import { navigate, syncRouteFromLocation, CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH } from "./router.svelte";

let target: HTMLDivElement;
let app: unknown;

// jsdom implements neither of these; the component treats both as optional, and
// the route-reveal test needs the spy to observe what it was asked to do.
const realScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const realFetch = globalThis.fetch;

function stubAccountFetches() {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (url === "/api/auth/methods") return { ok: true, status: 200, json: async () => ({ password: true }) };
    if (url === "/api/me") return { ok: true, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await loadLang("en");
  history.pushState({}, "", "/");
  syncRouteFromLocation();
  Element.prototype.scrollIntoView = vi.fn();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Nav, { target });
  flushSync();
});

afterEach(() => {
  if (app) unmount(app);
  target.remove();
  history.pushState({}, "", "/");
  syncRouteFromLocation();
  if (realScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", realScrollIntoView);
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
  globalThis.fetch = realFetch;
});

const tabs = () => [...target.querySelectorAll<HTMLAnchorElement>(".tabs a.tab")];
const current = () => target.querySelectorAll(".tabs [aria-current='page']");

describe("Nav destinations", () => {
  it("renders all five destinations as real links, never as fake tabs", () => {
    const links = tabs();
    expect(links.length).toBe(5);
    expect(links.map((a) => new URL(a.href).pathname)).toEqual([
      "/", CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH,
    ]);
    for (const a of links) {
      expect(a.tagName).toBe("A");
      expect(a.getAttribute("role")).toBeNull();
      expect(a.textContent!.trim()).not.toBe("");
    }
  });

  it("marks exactly one link current, matching the route", () => {
    expect(current().length).toBe(1);
    expect(current()[0].textContent!.trim()).toBe(tabs()[0].textContent!.trim());
  });

  it("still marks exactly one link current after a route change", () => {
    navigate("cli");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[3]);

    navigate("apps");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[4]);
  });

  // The mobile rail scrolls, so the current destination can start offscreen.
  // scrollIntoView (rather than scrollLeft arithmetic) is what makes this work
  // in an RTL document, and `nearest` keeps the movement minimal.
  it("reveals the current link after a route change", () => {
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    const rail = target.querySelector(".tabs")!;
    Object.defineProperty(rail, "scrollWidth", { configurable: true, value: 400 });
    Object.defineProperty(rail, "clientWidth", { configurable: true, value: 280 });
    spy.mockClear();
    navigate("apps");
    flushSync();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.instances.at(-1)).toBe(tabs()[4]);
    expect(spy.mock.calls.at(-1)![0]).toEqual({ block: "nearest", inline: "nearest" });
  });

  it("does not reveal a link when the rail has no overflow", () => {
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    const rail = target.querySelector(".tabs")!;
    Object.defineProperty(rail, "scrollWidth", { configurable: true, value: 280 });
    Object.defineProperty(rail, "clientWidth", { configurable: true, value: 280 });
    spy.mockClear();
    navigate("apps");
    flushSync();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Nav utility controls", () => {
  it("always offers the language and theme controls", () => {
    expect(target.querySelector(".util select.lang")).not.toBeNull();
    expect(target.querySelectorAll(".util select").length).toBeGreaterThanOrEqual(2);
  });

  // Unchanged by this batch: the account control belongs to the login-gated
  // flows only. This test exists to catch it silently spreading to every route.
  it("shows the account control only on the login-gated routes", () => {
    stubAccountFetches();
    expect(target.querySelector(".account")).toBeNull();

    navigate("cli");
    flushSync();
    expect(target.querySelector(".account")).toBeNull();

    navigate("cross");
    flushSync();
    expect(target.querySelector(".account")).not.toBeNull();

    navigate("lan");
    flushSync();
    expect(target.querySelector(".account")).toBeNull();
  });
});
