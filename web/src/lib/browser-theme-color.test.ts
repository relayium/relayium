import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startBrowserThemeColor } from "./browser-theme-color";

// jsdom cascades custom properties from a stylesheet by selector, but does not
// substitute var() or evaluate media queries. So the <html> attribute/class
// cases below run against a real cascade, while the OS scheme and the width —
// both media queries in app.css — are driven through an injected reader and a
// controllable matchMedia. What app.css resolves to in a real browser is the
// root-owned built-browser matrix, not something jsdom can answer.

const LIGHT_OS_TAG = "#ffffff";
const DARK_OS_TAG = "#16171d";

let style: HTMLStyleElement;
let disposers: Array<() => void> = [];

function metas() {
  return Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
}
function contents() {
  return metas().map((m) => m.getAttribute("content"));
}
function start(...args: Parameters<typeof startBrowserThemeColor>) {
  const dispose = startBrowserThemeColor(...args);
  disposers.push(dispose);
  return dispose;
}
const mutationsDelivered = () => new Promise<void>((r) => setTimeout(r, 0));

/** The two tags index.html ships, in the same shape. */
function addStaticTags() {
  for (const [content, media] of [[LIGHT_OS_TAG, "(prefers-color-scheme: light)"], [DARK_OS_TAG, "(prefers-color-scheme: dark)"]]) {
    const m = document.createElement("meta");
    m.name = "theme-color";
    m.content = content;
    m.media = media;
    document.head.appendChild(m);
  }
}

class FakeMql extends EventTarget {
  listeners = 0;
  constructor(public media: string) { super(); }
  override addEventListener(...a: Parameters<EventTarget["addEventListener"]>) { this.listeners++; super.addEventListener(...a); }
  override removeEventListener(...a: Parameters<EventTarget["removeEventListener"]>) { this.listeners--; super.removeEventListener(...a); }
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
  style = document.createElement("style");
  style.textContent = `
    :root { --browser-surface: #fafafa; }
    :root[data-theme="dark"] { --browser-surface: #101010; }
    :root.shell-route { --browser-surface: #f8f8fa; }
    :root.shell-route[data-theme="dark"] { --browser-surface: #232326; }
  `;
  document.head.appendChild(style);
  addStaticTags();
});

afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  metas().forEach((m) => m.remove());
  style.remove();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
  Reflect.deleteProperty(window, "matchMedia");
});

describe("browser theme-color", () => {
  it("names the painted surface on boot in BOTH media tags", () => {
    document.documentElement.classList.add("shell-route");
    start();
    expect(contents()).toEqual(["#f8f8fa", "#f8f8fa"]);
    // media attributes are untouched — only the colour moves
    expect(metas().map((m) => m.media)).toEqual(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]);
  });

  it("a manual theme opposite to the OS leaves no tag naming the other theme", async () => {
    // Forced dark: the (prefers-color-scheme: light) tag is the one a light-OS
    // browser selects, and it must say dark, not the static #ffffff.
    document.documentElement.classList.add("shell-route");
    start();
    document.documentElement.setAttribute("data-theme", "dark");
    await mutationsDelivered();
    expect(contents()).toEqual(["#232326", "#232326"]);

    // …and back to forced light: the dark-OS tag must not keep #16171d / #232326.
    document.documentElement.setAttribute("data-theme", "light");
    await mutationsDelivered();
    expect(contents()).toEqual(["#f8f8fa", "#f8f8fa"]);
  });

  it("follows the shell-route class arriving and leaving", async () => {
    start();
    expect(contents()).toEqual(["#fafafa", "#fafafa"]);
    document.documentElement.classList.add("shell-route");
    await mutationsDelivered();
    expect(contents()).toEqual(["#f8f8fa", "#f8f8fa"]);
    document.documentElement.classList.remove("shell-route");
    await mutationsDelivered();
    expect(contents()).toEqual(["#fafafa", "#fafafa"]);
  });

  it("follows an OS scheme change while on system", () => {
    const mql = new FakeMql("(prefers-color-scheme: dark)");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => mql });
    let os: "light" | "dark" = "light";
    start({ readSurface: () => (os === "dark" ? "#232326" : "#f8f8fa") });
    expect(contents()).toEqual(["#f8f8fa", "#f8f8fa"]);
    os = "dark";
    mql.dispatchEvent(new Event("change"));
    expect(contents()).toEqual(["#232326", "#232326"]);
  });

  it("follows the width across the shell breakpoint", () => {
    // Stands in for app.css's 1180px rule: content surface below, window above.
    let width = 1179;
    start({ readSurface: () => (width >= 1180 ? "#1e1e20" : "#232326") });
    expect(contents()).toEqual(["#232326", "#232326"]);
    width = 1180;
    window.dispatchEvent(new Event("resize"));
    expect(contents()).toEqual(["#1e1e20", "#1e1e20"]);
    width = 1179;
    window.dispatchEvent(new Event("resize"));
    expect(contents()).toEqual(["#232326", "#232326"]);
  });

  it("keeps the static fallback when the token is unavailable", () => {
    start({ readSurface: () => "" });
    expect(contents()).toEqual([LIGHT_OS_TAG, DARK_OS_TAG]);
  });

  it("disposal restores the served tags and stops every source of late updates", async () => {
    const mql = new FakeMql("(prefers-color-scheme: dark)");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => mql });
    let surface = "#232326";
    const dispose = start({ readSurface: () => surface });
    expect(contents()).toEqual(["#232326", "#232326"]);
    expect(mql.listeners).toBe(1);

    // A mutation already queued when disposal happens must not land afterwards.
    surface = "#abcdef";
    document.documentElement.setAttribute("data-theme", "dark");
    dispose();
    expect(contents()).toEqual([LIGHT_OS_TAG, DARK_OS_TAG]);
    expect(mql.listeners).toBe(0);

    await mutationsDelivered();
    document.documentElement.classList.add("shell-route");
    await mutationsDelivered();
    mql.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("resize"));
    expect(contents()).toEqual([LIGHT_OS_TAG, DARK_OS_TAG]);

    dispose(); // idempotent
    expect(mql.listeners).toBe(0);
  });

  it("creates a tag when none exists and removes it on disposal", () => {
    metas().forEach((m) => m.remove());
    const dispose = start({ readSurface: () => "#232326" });
    expect(contents()).toEqual(["#232326"]);
    dispose();
    expect(metas()).toHaveLength(0);
  });
});

// The wiring, mounted for real: App owns the lifecycle, so a missing or
// asynchronous onMount (whose teardown Svelte ignores) shows up here. jsdom
// leaves isSecureContext undefined, so App takes its inert "unsupported" path.
describe("App integration", () => {
  it("drives the tags from the shell route and theme, and releases them on unmount", async () => {
    const { mount, unmount, flushSync } = await import("svelte");
    const { default: App } = await import("../App.svelte");
    const { loadLang, setLang } = await import("./i18n.svelte");
    const { syncRouteFromLocation } = await import("./router.svelte");
    await loadLang("en");
    await setLang("en");
    history.replaceState(null, "", "/");
    syncRouteFromLocation();

    const target = document.createElement("div");
    document.body.appendChild(target);
    const app = mount(App, { target });
    try {
      flushSync();
      await mutationsDelivered();
      expect(document.documentElement.classList.contains("shell-route")).toBe(true);
      expect(contents()).toEqual(["#f8f8fa", "#f8f8fa"]);

      document.documentElement.setAttribute("data-theme", "dark");
      await mutationsDelivered();
      expect(contents()).toEqual(["#232326", "#232326"]);
    } finally {
      unmount(app);
      target.remove();
    }
    expect(contents()).toEqual([LIGHT_OS_TAG, DARK_OS_TAG]);
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.classList.add("shell-route");
    await mutationsDelivered();
    expect(contents()).toEqual([LIGHT_OS_TAG, DARK_OS_TAG]);
  });
});
