// Accessibility contracts that live in markup rather than in CSS.
//
// Each of these was a real finding from the axe baseline, and each is the kind of
// thing that comes back the moment someone refactors the component: a role moved
// onto the wrong element, a landmark that lost its name, a dialog nobody named, a
// scrollable box that stopped being a keyboard stop. The browser scan catches them
// too, but only for the states it can reach and only after a build — these run in
// milliseconds and pin the reason each attribute is there.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, unmount, flushSync } from "svelte";
import { loadLang, messages, setLang } from "./i18n.svelte";
import { syncRouteFromLocation } from "./router.svelte";
import Nav from "./Nav.svelte";
import ModeCompare from "./ModeCompare.svelte";
import PricingPage from "./PricingPage.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import CommandBlock from "./CommandBlock.svelte";
import CliPage from "./CliPage.svelte";
import { confirmState } from "./confirm-dialog.svelte";

let target: HTMLDivElement;
let app: unknown;
const realFetch = globalThis.fetch;
const realScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeEach(async () => {
  await loadLang("en");
  history.pushState({}, "", "/");
  syncRouteFromLocation();
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
  globalThis.fetch = realFetch;
  if (realScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", realScrollIntoView);
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  confirmState.open = false;
  confirmState.message = "";
  history.pushState({}, "", "/");
  syncRouteFromLocation();
});

function render(component: unknown, props: Record<string, unknown> = {}) {
  app = mount(component as never, { target, props });
  flushSync();
  return target;
}

describe("navigation landmarks are distinguishable", () => {
  it("names the top nav from the localized string, not a hardcoded one", () => {
    const nav = render(Nav).querySelector("nav.topnav")!;
    // Two navigation landmarks with the same (or no) name are one landmark as far
    // as a screen reader's landmark list is concerned.
    expect(nav.getAttribute("aria-label")).toBe(messages.en.nav.primaryLabel);
  });

  it("uses a translated label, not English, in another language", async () => {
    await setLang("ja");
    const nav = render(Nav).querySelector("nav.topnav")!;
    expect(nav.getAttribute("aria-label")).toBe(messages.ja.nav.primaryLabel);
    expect(nav.getAttribute("aria-label")).not.toBe(messages.en.nav.primaryLabel);
    await setLang("en");
  });

  it("keeps the brand word in the accessibility tree so the link has a name", () => {
    // The mobile breakpoint hides this word. It must be hidden VISUALLY only:
    // display:none removed it from the tree too, leaving the brand link with
    // nothing but an aria-hidden logo and therefore no accessible name at all.
    const word = render(Nav).querySelector(".brand .word")!;
    expect(word.textContent).toBe("Relayium");
    expect(word.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("ModeCompare keeps table semantics without illegal roles", () => {
  it("puts columnheader on cells and never on the links inside them", () => {
    const root = render(ModeCompare);
    // ARIA does not allow a link to also be a column header; browsers disagree
    // about which of the two to drop.
    expect(root.querySelectorAll("a[role='columnheader']").length).toBe(0);
    expect(root.querySelectorAll("[role='columnheader']").length).toBe(3);
    for (const cell of root.querySelectorAll("[role='columnheader']")) {
      expect(cell.tagName).toBe("SPAN");
    }
  });

  it("still offers both header links inside the header row", () => {
    const root = render(ModeCompare);
    const links = root.querySelectorAll("[role='row'] [role='columnheader'] a.head-link");
    expect(links.length).toBe(2);
    expect([...links].map((a) => a.getAttribute("href"))).toEqual(["/cross-network", "/offline-transfer"]);
  });

  it("lets the link fill its header cell instead of shrinking to the words", () => {
    // Moving the role off the <a> and onto the cell must not shrink the click
    // target: the whole header cell used to be clickable, and quietly trading
    // that for a text-sized target is a WCAG 2.5.8 regression no axe rule reports.
    // jsdom has no layout, so the contract is expressed in CSS terms: the cell
    // hands its padding to the link, and the link fills the cell.
    const css = readFileSync(resolve(import.meta.dirname, "ModeCompare.svelte"), "utf8");
    expect(css).toMatch(/\.cell\.is-link \{ padding: 0; \}/);
    expect(css).toMatch(/\.head-link \{[\s\S]*?block-size: 100%;[\s\S]*?padding: var\(--space-3\) var\(--space-4\);/);
    const root = render(ModeCompare);
    // The marker class the padding rule keys off must actually be on both cells.
    expect(root.querySelectorAll("[role='columnheader'].is-link").length).toBe(2);
  });
});

describe("plan-change dialog announces which plan it is about", () => {
  it("names itself from the heading it already shows", () => {
    // The heading reads "Change plan · Pro monthly"; a generic aria-label would be
    // a second copy of that sentence with nothing keeping the two in sync.
    const source = readFileSync(resolve(import.meta.dirname, "ChangePlanModal.svelte"), "utf8");
    expect(source).toMatch(/role="dialog"[^>]*aria-labelledby="change-plan-title"/);
    expect(source).toMatch(/<h3 id="change-plan-title">\{t\.billing\.changePlan\}/);
  });
});

describe("only one main landmark exists in the app", () => {
  it("renders the pricing route as a section, since App already owns <main>", () => {
    // Nesting a second <main> inside App's leaves a screen reader with no
    // unambiguous "skip to the content" target.
    const root = render(PricingPage);
    expect(root.querySelector("main")).toBeNull();
    expect(root.querySelector("section.pricing-page")).not.toBeNull();
  });
});

describe("dialogs announce what they are", () => {
  it("names the confirm dialog by the question it is asking", () => {
    confirmState.open = true;
    confirmState.message = "Delete this device?";
    const root = render(ConfirmModal);
    const dialog = root.querySelector("[role='dialog']")!;
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    expect(labelledBy).toBeTruthy();
    expect(root.querySelector(`#${labelledBy}`)?.textContent).toBe("Delete this device?");
  });
});

describe("scrollable code regions are reachable by keyboard", () => {
  it("makes the command block a focus stop named by its visible title", () => {
    const root = render(CommandBlock, { code: "curl -fsSL https://relayium.com/install.sh | sh", title: "install" });
    const pre = root.querySelector("pre")!;
    // The block scrolls sideways; without a tab stop the hidden end of a long
    // command cannot be read without a mouse.
    expect(pre.getAttribute("tabindex")).toBe("0");
    const labelledBy = pre.getAttribute("aria-labelledby")!;
    expect(root.querySelector(`#${labelledBy}`)?.textContent).toBe("install");
  });

  it("does not invent a name when there is no visible title to borrow", () => {
    const pre = render(CommandBlock, { code: "relayium push ." }).querySelector("pre")!;
    expect(pre.getAttribute("tabindex")).toBe("0");
    expect(pre.getAttribute("aria-labelledby")).toBeNull();
    expect(pre.getAttribute("aria-label")).toBeNull();
  });

  it("makes every CLI pick-card command focusable and named by its card heading", () => {
    const root = render(CliPage);
    const blocks = root.querySelectorAll(".pick-card code");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.getAttribute("tabindex")).toBe("0");
      const labelledBy = block.getAttribute("aria-labelledby")!;
      expect(root.querySelector(`#${labelledBy}`)?.tagName).toBe("H3");
    }
  });
});
