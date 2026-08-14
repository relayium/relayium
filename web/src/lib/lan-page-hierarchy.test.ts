// The LAN destination's heading hierarchy, and the one factual rail it draws
// over a real selection.
//
// Both of these were the same defect: the top of the page repeated the chrome
// directly above it. Nav already renders the Relayium mark and wordmark, and the
// page opened with a second 64px mark and an <h1> that also said "Relayium" —
// so the LAN page's only first-level heading named the product instead of naming
// what the page is for, and the thing it IS for ("Nearby devices") was demoted
// to an <h2> further down. These pin the corrected shape: exactly one visible
// h1, it is the localized roster title, and nothing that was explaining the page
// went missing to get there.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, unmount, flushSync } from "svelte";
import App from "../App.svelte";
import CrossPage from "./CrossPage.svelte";
import LanPathRail from "./LanPathRail.svelte";
import Hero from "./Hero.svelte";
import { loadLang, setLang, messages } from "./i18n.svelte";
import { syncRouteFromLocation } from "./router.svelte";

let target: HTMLDivElement;
let app: unknown;
const realFetch = globalThis.fetch;

const appSource = readFileSync(resolve(import.meta.dirname, "..", "App.svelte"), "utf8");

// jsdom leaves window.isSecureContext undefined, so App takes its "unsupported
// browser" path: no socket, no ICE fetch. That is deliberately the state tested
// here — a page title has to survive the branch that has the least on it.
async function mountApp(path = "/") {
  history.replaceState(null, "", path);
  syncRouteFromLocation();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(App, { target });
  flushSync();
  await Promise.resolve();
  flushSync();
}

function render(component: unknown, props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(component as never, { target, props });
  flushSync();
  return target;
}

beforeEach(async () => {
  await loadLang("en");
  await setLang("en");
  globalThis.fetch = (async () => ({ ok: true, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target?.remove();
  globalThis.fetch = realFetch;
  history.replaceState(null, "", "/");
  syncRouteFromLocation();
});

const heroProps = {
  connState: "ready" as const,
  unsupported: false,
  selfName: "Mac-938",
  selfIP: "203.0.113.9",
  onRename: () => {},
};

describe("the LAN page has one heading, and it names the page", () => {
  it("renders exactly one h1, and it is the localized roster title", async () => {
    await mountApp();
    const h1s = [...target.querySelectorAll("h1")];
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent!.trim()).toBe(messages.en.peersTitle);
    // Not the brand: the brand is Nav's job and it is still doing it.
    expect(h1s[0].textContent!.trim()).not.toBe("Relayium");
    expect(target.querySelector("nav.topnav .brand .word")!.textContent).toBe("Relayium");
  });

  it("translates that title rather than pinning the English one", async () => {
    await setLang("zh");
    await mountApp();
    expect(target.querySelector("h1")!.textContent!.trim()).toBe(messages.zh.peersTitle);
    expect(target.querySelector("h1")!.textContent!.trim()).not.toBe(messages.en.peersTitle);
    await setLang("en");
  });

  it("says it once — the roster below points at the title instead of repeating it", async () => {
    await mountApp();
    const printed = [...target.querySelectorAll("h1, h2, h3")]
      .filter((el) => el.textContent!.trim() === messages.en.peersTitle);
    expect(printed).toHaveLength(1);
    // The roster is still named for assistive technology; it borrows the
    // heading rather than carrying a second copy of the words.
    expect(appSource).toMatch(/aria-labelledby=\{currentRoute\(\) === "lan" \? "lan-peers-title" : undefined\}/);
    expect(appSource).toMatch(/<h1 class="lan-title" id="lan-peers-title">\{t\.peersTitle\}<\/h1>/);
  });

  // The roster section is replaced whole by a unified workspace, so a title
  // living inside it would leave the page with no h1 at all in that state.
  it("keeps the title outside the roster, so it survives every LAN state", () => {
    const task = /<div class="lan-task">[\s\S]*?\{#if unsupported\}/.exec(appSource)?.[0] ?? "";
    expect(task).toContain('<h1 class="lan-title"');
    const roster = /<section\s+class="peers"[\s\S]*?<QuotaNotice \/>/.exec(appSource)?.[0] ?? "";
    expect(roster).not.toBe("");
    expect(roster).not.toContain("t.peersTitle");
  });

  it("keeps the tagline, the device status and the public IP that used to sit under the brand", () => {
    const hero = render(Hero, heroProps);
    expect(hero.querySelector("h1")).toBeNull();
    // No second brand mark either: Nav's is the only one on the screen now.
    expect(hero.querySelector(".hero .logo")).toBeNull();
    expect(hero.querySelector(".tagline")!.textContent).toBe(messages.en.tagline);
    expect(hero.querySelector(".statusbar")!.textContent).toContain("Mac-938");
    // The rename control is a real button, not decoration on the status line.
    expect(hero.querySelector("button.name-btn")!.textContent).toBe("Mac-938");
    expect(hero.querySelector(".ip")!.textContent).toContain("203.0.113.9");
  });
});

describe("cross-network keeps its own hierarchy", () => {
  it("still opens with its own page title, which is not the roster title", () => {
    const page = render(CrossPage);
    const h1s = [...page.querySelectorAll("h1")];
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent!.trim()).toBe(messages.en.crossTitle);
    expect(page.querySelector(".ui-page-head .tagline")!.textContent).toBe(messages.en.tagline);
  });

  it("still renders its roster heading as an h2 under that title", () => {
    // Cross renders the same shared surface, so this is the branch that must NOT
    // have been collapsed along with LAN's: its page title is "Cross-network
    // transfer" and its roster is a section of that page, not the page itself.
    expect(appSource).toMatch(/\{#if currentRoute\(\) === "cross"\}\s*<h2>\{t\.crossPeersTitle\}<\/h2>/);
  });
});

describe("the LAN path rail states a route, not a connection", () => {
  it("names this device, the existing LAN-direct path label and the actual recipient", () => {
    const rail = render(LanPathRail, { selfName: "Mac-938", peerName: "lily's Mac mini" });
    const names = [...rail.querySelectorAll(".pr-name")].map((el) => el.textContent);
    expect(names).toEqual(["Mac-938", "lily's Mac mini"]);
    // The same string the workspace header and message panel use for a live LAN
    // link — one vocabulary for one route, and nothing newly invented.
    expect(rail.querySelector(".pr-path")!.textContent).toBe(messages.en.pathLan);
  });

  it("translates the route label with the page", async () => {
    await setLang("zh");
    const rail = render(LanPathRail, { selfName: "Mac-938", peerName: "lily 的 Mac mini" });
    expect(rail.querySelector(".pr-path")!.textContent).toBe(messages.zh.pathLan);
    expect(rail.querySelector(".pr-path")!.textContent).not.toBe(messages.en.pathLan);
    await setLang("en");
  });

  it("claims no connection, speed, size or encryption state", () => {
    const rail = render(LanPathRail, { selfName: "Mac-938", peerName: "lily's Mac mini" });
    const text = rail.textContent!.toLowerCase();
    for (const claim of ["connect", "encrypt", "secure", "/s", "mb", "%", "online", "ready"]) {
      expect(text, claim).not.toContain(claim);
    }
    // A status dot is how this kind of rail starts claiming liveness it cannot
    // know; the connectors are hairlines and are hidden from the reader.
    expect(rail.querySelector(".dot")).toBeNull();
    for (const line of rail.querySelectorAll(".pr-line")) {
      expect(line.getAttribute("aria-hidden")).toBe("true");
      expect(line.textContent).toBe("");
    }
  });

  it("is drawn only for a real selection, never in the empty or scanning state", () => {
    // The rail lives in the same branch as the send card for the selected peer,
    // which only exists when `selectedPeer` resolved to a live roster entry.
    const branch = /\{#if selectedPeer\}[\s\S]*?<ul/.exec(appSource)?.[0] ?? "";
    expect(branch).toContain("<LanPathRail {selfName} peerName={selectedPeer.name} />");
    expect(appSource.match(/<LanPathRail\b/g)).toHaveLength(1);
    // …and the empty state renders the scanning radar and its guidance, not a
    // rail with a placeholder on the far end.
    const empty = /\{#if chooser === "empty"\}[\s\S]*?\{:else if/.exec(appSource)?.[0] ?? "";
    expect(empty).toContain("t.emptyPeers");
    expect(empty).not.toContain("LanPathRail");
  });

  it("lays out in logical directions, so Arabic mirrors it without a second rule", () => {
    const source = readFileSync(resolve(import.meta.dirname, "LanPathRail.svelte"), "utf8");
    const css = source.slice(source.indexOf("<style>"));
    expect(css).not.toMatch(/\b(?:margin|padding|inset|border)-(?:left|right)\b/);
    expect(css).not.toMatch(/\b(?:left|right)\s*:/);
    expect(css).not.toMatch(/\b(?:float|text-align)\s*:\s*(?:right|left)\b/);
    expect(css).toContain("max-inline-size");
  });
});
