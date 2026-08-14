import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Nav from "./Nav.svelte";
import { loadLang, setLang, messages, dir, LANGS } from "./i18n.svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  navigate, syncRouteFromLocation,
  CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH, DEVICE_INBOX_PATH,
} from "./router.svelte";

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
  // Unconditional, not per-test: the nav now renders Account on FIVE routes, and
  // any test that navigates to one mounts a component whose onMount fetches
  // /api/me. Without the stub that is an unhandled rejection attributed to
  // whichever test happens to be running when it lands.
  stubAccountFetches();
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
const railNav = () => target.querySelector(".rail-nav");
const prevBtn = () => target.querySelector<HTMLButtonElement>(".rail-prev");
const nextBtn = () => target.querySelector<HTMLButtonElement>(".rail-next");

function rect(left: number, right: number): DOMRect {
  return { left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

/**
 * jsdom has no layout, so the rail's geometry is stated rather than measured.
 * `from`..`to` are the destination indices fully inside the 280px-wide rail;
 * everything before sits off the start edge and everything after off the end.
 * `overflowing: false` states a rail whose six chips genuinely fit.
 */
function layoutRail(from: number, to: number, overflowing = true) {
  const rail = target.querySelector<HTMLElement>(".tabs")!;
  Object.defineProperty(rail, "scrollWidth", { configurable: true, value: overflowing ? 600 : 280 });
  Object.defineProperty(rail, "clientWidth", { configurable: true, value: 280 });
  rail.getBoundingClientRect = () => rect(0, 280);
  tabs().forEach((a, i) => {
    const box = i < from ? rect(-300, -200) : i > to ? rect(400, 500) : rect(10 + (i - from) * 60, 60 + (i - from) * 60);
    a.getBoundingClientRect = () => box;
  });
  // The component re-measures whenever the rail scrolls; a scroll is exactly
  // what changes which destinations are inside it.
  rail.dispatchEvent(new Event("scroll"));
  flushSync();
}

describe("Nav destinations", () => {
  it("renders all six destinations as real links, never as fake tabs", () => {
    const links = tabs();
    expect(links.length).toBe(6);
    // Device Inbox is a PRIMARY destination (PRD §12), so it sits in the rail
    // with the other five rather than being reachable only from a device card.
    expect(links.map((a) => new URL(a.href).pathname)).toEqual([
      "/", CROSS_PATH, OFFLINE_PATH, DEVICE_INBOX_PATH, CLI_PATH, APPS_PATH,
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
    navigate("device-inbox");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[3]);

    navigate("cli");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[4]);

    navigate("apps");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[5]);
  });

  // Every destination has to be operable from the keyboard, and Device Inbox is
  // the one that was added last — the branchy href expression it replaced is
  // exactly where a new destination silently gets the wrong URL.
  it("reaches Device Inbox by keyboard and marks it current", () => {
    const link = tabs()[3];
    expect(link.tagName).toBe("A");
    expect(link.tabIndex).toBe(0); // a real anchor with an href: focusable, no tabindex needed
    link.focus();
    expect(document.activeElement).toBe(link);
    link.click();
    flushSync();
    expect(location.pathname).toBe(DEVICE_INBOX_PATH);
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[3]);
    expect(tabs()[3].getAttribute("aria-current")).toBe("page");
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
    expect(spy.mock.instances.at(-1)).toBe(tabs()[5]);
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

// Six primary destinations do not fit a 320px row in any language, so the row
// scrolls. A fade at its edges tells a sighted swiper that there is more; these
// controls are what tell everyone else, and what makes the hidden destinations
// reachable without a horizontal-scroll gesture at all.
describe("Nav rail overflow controls", () => {
  it("offers no controls while every destination already fits", () => {
    layoutRail(0, 5, false);
    expect(railNav()).toBeNull();
    // …and the rail is not claiming an edge fade it does not need either.
    expect(target.querySelector(".tabs")!.classList.contains("overflowing")).toBe(false);
  });

  it("appears only once the row overflows, as two real buttons", () => {
    layoutRail(0, 2);
    expect(railNav()).not.toBeNull();
    for (const btn of [prevBtn()!, nextBtn()!]) {
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.getAttribute("type")).toBe("button");
      // Native buttons: focusable and Enter/Space-operable with no key handler
      // of their own, which is the only version of this that cannot rot.
      expect(btn.tabIndex).toBe(0);
      // No visible copy — the row is already the tightest thing on the screen.
      expect(btn.textContent!.trim()).toBe("");
    }
  });

  it("names both controls from the active locale, never from a hardcoded string", async () => {
    layoutRail(0, 2);
    expect(prevBtn()!.getAttribute("aria-label")).toBe(messages.en.nav.railPrev);
    expect(nextBtn()!.getAttribute("aria-label")).toBe(messages.en.nav.railNext);

    await setLang("zh");
    flushSync();
    layoutRail(0, 2);
    expect(prevBtn()!.getAttribute("aria-label")).toBe(messages.zh.nav.railPrev);
    expect(prevBtn()!.getAttribute("aria-label")).not.toBe(messages.en.nav.railPrev);
    await setLang("en");
    flushSync();
  });

  it("disables the direction that has nothing left to reveal", () => {
    layoutRail(0, 2);
    expect(prevBtn()!.disabled).toBe(true);
    expect(nextBtn()!.disabled).toBe(false);

    layoutRail(2, 4);
    expect(prevBtn()!.disabled).toBe(false);
    expect(nextBtn()!.disabled).toBe(false);

    layoutRail(3, 5);
    expect(prevBtn()!.disabled).toBe(false);
    expect(nextBtn()!.disabled).toBe(true);
  });

  it("reveals the next hidden destination in reading order, and the previous one going back", () => {
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    layoutRail(2, 4);

    spy.mockClear();
    nextBtn()!.click();
    flushSync();
    expect(spy.mock.instances.at(-1)).toBe(tabs()[5]);
    // Centre, not "nearest". The rail snaps its chips on their centres, so a
    // minimal scroll is undone by proximity snapping and the control pages once
    // and then freezes — reproduced in Chrome at 320px before this was fixed.
    expect(spy.mock.calls.at(-1)![0]).toEqual({ block: "nearest", inline: "center" });

    spy.mockClear();
    prevBtn()!.click();
    flushSync();
    expect(spy.mock.instances.at(-1)).toBe(tabs()[1]);
  });

  // The route reveal is a different job with a different rule: move the page as
  // little as possible. Collapsing the two would make every route change
  // recentre the rail under the reader.
  it("leaves the route reveal on its minimal-movement alignment", () => {
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    layoutRail(0, 2);
    spy.mockClear();
    navigate("apps");
    flushSync();
    expect(spy.mock.calls.at(-1)![0]).toEqual({ block: "nearest", inline: "nearest" });
  });

  // The whole point of doing this geometrically instead of with scrollLeft
  // arithmetic: "previous" means the destination earlier in the row in BOTH
  // directions, and engines disagree about the sign and origin of scrollLeft
  // under dir=rtl. Only the chevrons flip.
  // The Arabic half of this used to run here as a mounted RTL render. Since the
  // 2026-08-14 language freeze neither maintained language is RTL, so there is
  // no way to put this component into `dir="rtl"` through the product's own
  // controls, and a test that did it some other way would be testing a state a
  // user cannot reach.
  //
  // The RTL machinery is deliberately kept — restoring Arabic is a locale-level
  // decision, and it should not also be a component rewrite (PROJECT-GOVERNANCE
  // "preserve the localization architecture"). So what is pinned is the part
  // that would silently rot: that the flip is still a function of `dir()` and
  // not of a hardcoded direction, and that `dir()` still knows Arabic. See
  // rtl-head-isolation.test.mjs for the archived Arabic pages, where RTL
  // rendering is still live and still asserted end to end.
  it("still derives the glyph flip from dir(), not from a hardcoded direction", () => {
    layoutRail(2, 4);
    expect(prevBtn()!.classList.contains("flip")).toBe(true);
    expect(nextBtn()!.classList.contains("flip")).toBe(false);

    const src = readFileSync(resolve(process.cwd(), "src/lib/Nav.svelte"), "utf8");
    expect(src, "Nav must read direction from dir(lang())").toMatch(
      /const rtl = \$derived\(dir\(lang\(\)\) === "rtl"\)/,
    );
    expect(src, "prev flips in LTR, next flips in RTL").toContain("class:flip={!rtl}");
    expect(src, "prev flips in LTR, next flips in RTL").toContain("class:flip={rtl}");
    // And the reason the mounted half is gone: no language the product offers
    // renders right to left today, while dir() still answers for Arabic.
    for (const { code } of LANGS) expect(dir(code), code).toBe("ltr");
    expect(dir("ar")).toBe("rtl");
  });

  it("moves the rail by one destination in each direction", () => {
    // The behaviour the Arabic case shared: prev/next mean the same two
    // destinations regardless of which glyph is flipped.
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    layoutRail(2, 4);

    spy.mockClear();
    nextBtn()!.click();
    flushSync();
    expect(spy.mock.instances.at(-1)).toBe(tabs()[5]);

    spy.mockClear();
    prevBtn()!.click();
    flushSync();
    expect(spy.mock.instances.at(-1)).toBe(tabs()[1]);
  });

  it("still renders all six destinations as links while the controls are up", () => {
    layoutRail(1, 3);
    // The controls page the row; they never replace, collapse or hide a
    // destination behind a menu.
    expect(tabs().length).toBe(6);
    expect(tabs().every((a) => a.getAttribute("href"))).toBe(true);
  });
});

describe("Nav utility controls", () => {
  it("always offers the language and theme controls", () => {
    expect(target.querySelector(".util select.lang")).not.toBeNull();
    expect(target.querySelectorAll(".util select").length).toBeGreaterThanOrEqual(2);
  });

  // The account control belongs to flows whose primary action requires an
  // account. Pricing must include it: otherwise its "Sign in to upgrade"
  // recovery text has no executable action on that route.
  it("shows the account control only on the login-gated routes", () => {
    expect(target.querySelector(".account")).toBeNull();

    navigate("cli");
    flushSync();
    expect(target.querySelector(".account")).toBeNull();

    navigate("cross");
    flushSync();
    expect(target.querySelector(".account")).not.toBeNull();

    // Device Inbox requires an account for its primary action, and its own
    // "Sign in" / "Create an account" buttons open THIS control's modal — the
    // page would offer two dead buttons without it.
    navigate("device-inbox");
    flushSync();
    expect(target.querySelector(".account")).not.toBeNull();

    navigate("pricing");
    flushSync();
    expect(target.querySelector(".account")).not.toBeNull();

    navigate("lan");
    flushSync();
    expect(target.querySelector(".account")).toBeNull();
  });
});
