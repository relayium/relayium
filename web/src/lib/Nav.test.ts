import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Nav from "./Nav.svelte";
import { loadLang, setLang, messages, dir, LANGS } from "./i18n.svelte";
import { setLoginOpen } from "./login.svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  navigate, syncRouteFromLocation,
  CROSS_PATH, OFFLINE_PATH, CLI_PATH, APPS_PATH, DEVICE_INBOX_PATH, PRICING_PATH,
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
/** The secondary group: the two links that are not ways to move a file. */
const tools = () => [...target.querySelectorAll<HTMLAnchorElement>("nav.tools a.tool")];
const current = () => target.querySelectorAll(".tabs [aria-current='page']");
const currentTool = () => target.querySelectorAll("nav.tools [aria-current='page']");

describe("Nav destinations", () => {
  it("renders the four transfer destinations as real links, never as fake tabs", () => {
    const links = tabs();
    expect(links.length).toBe(4);
    // Device Inbox is a PRIMARY destination (PRD §12), so it sits in the rail
    // with the other three rather than being reachable only from a device card.
    // /cli and /apps deliberately do NOT: they are not ways to move a file, and
    // the row is the choice between the ways that are.
    expect(links.map((a) => new URL(a.href).pathname)).toEqual([
      "/", CROSS_PATH, OFFLINE_PATH, DEVICE_INBOX_PATH,
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
    navigate("cross");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[1]);

    navigate("device-inbox");
    flushSync();
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[3]);

    // Leaving the transfer destinations empties the rail's current marker and
    // moves it into the tools group — never both, and never neither.
    navigate("cli");
    flushSync();
    expect(current().length).toBe(0);
    expect(currentTool().length).toBe(1);
    expect(currentTool()[0]).toBe(tools()[0]);

    navigate("apps");
    flushSync();
    expect(current().length).toBe(0);
    expect(currentTool().length).toBe(1);
    expect(currentTool()[0]).toBe(tools()[1]);
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

  // The mobile rail used to SCROLL, and the three cases here pinned the reveal
  // that kept the active chip on screen: a route change, a direct load, and the
  // no-overflow case that must not scroll at all. The narrow header is now four
  // equal grid columns on their own row, so there is no scroll container for any
  // of them to act on — and the defect they were guarding against (a
  // destination off the edge) is prevented by the layout instead of corrected
  // after the fact. What replaces them is the stronger statement: nothing
  // scrolls, and all four are laid out.
  it("never scrolls the destination row, because nothing can be off it", () => {
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    const rail = target.querySelector<HTMLElement>(".tabs")!;
    // State a rail that WOULD have overflowed under the old single-row layout.
    Object.defineProperty(rail, "scrollWidth", { configurable: true, value: 600 });
    Object.defineProperty(rail, "clientWidth", { configurable: true, value: 280 });
    spy.mockClear();
    navigate("device-inbox");
    flushSync();
    expect(spy, "a grid row has nothing to scroll into view").not.toHaveBeenCalled();
    // …and the destination that used to need revealing is simply present.
    expect(current().length).toBe(1);
    expect(current()[0]).toBe(tabs()[3]);
  });

});

// The compact header. Four destinations under FULL labels do not fit a 320px
// row in either maintained language, which is why this row used to be four rows
// — toolbar, tabs, a pair of paging chevrons, and the tools links — spending
// ~170px of an 844px phone screen before the reader reached the page.
//
// It is one row now: short labels (each a substring of the full accessible name,
// so WCAG 2.5.3 still holds) and one disclosure for everything else. The
// chevrons are gone with the row they paged. What is KEPT is the edge fade: a
// chip wider than the rail is still possible, and a fade is the honest signal
// for it — but only on an edge that is actually hiding something.
describe("Nav compact header", () => {
  // The label is ONE element carrying ONE string, chosen by width. Two elements
  // with the unused one hidden would both land in `textContent`, so the LAN chip
  // would read "LANLAN" to anything not using `innerText` — including this
  // repo's own auth-landing browser step, which finds that link by its text.
  it("carries the full destination name at desktop width, as both text and name", async () => {
    for (const a of tabs()) {
      const id = a.getAttribute("data-nav")!;
      const full = a.getAttribute("aria-label")!;
      expect(full, id).toBeTruthy();
      // jsdom's matchMedia never matches, which is the wide form.
      expect(a.textContent!.trim(), id).toBe(full);
    }
    await setLang("zh");
    flushSync();
    for (const a of tabs()) {
      expect(a.textContent!.trim(), a.getAttribute("data-nav")!).toBe(a.getAttribute("aria-label"));
    }
    await setLang("en");
    flushSync();
  });

  // The compact form, driven through the same media query the component reads.
  // WCAG 2.5.3: the visible label must be part of the accessible name, or speech
  // input cannot address the control by what it says. Both languages, because
  // the substring relation is a property of each translation pair.
  it("shows a short label at narrow width, contained in the full accessible name", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: /max-width:\s*1099px/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      for (const code of ["en", "zh"] as const) {
        await setLang(code);
        if (app) unmount(app);
        app = mount(Nav, { target });
        flushSync();
        for (const a of tabs()) {
          const id = a.getAttribute("data-nav")!;
          const full = a.getAttribute("aria-label")!;
          const shown = a.textContent!.trim();
          expect(shown, `${code}/${id} must show something`).toBeTruthy();
          expect(full, `${code}/${id}: "${shown}" must be contained in "${full}"`).toContain(shown);
        }
        // Four, and only four: the tools links stay in the disclosure.
        expect(tabs().length, code).toBe(4);
      }
    } finally {
      window.matchMedia = realMatchMedia;
      await setLang("en");
      if (app) unmount(app);
      app = mount(Nav, { target });
      flushSync();
    }
  });

  it("offers no paging controls, because there is no row left to page", () => {
    expect(target.querySelector(".rail-nav")).toBeNull();
    expect(target.querySelectorAll("button.rail-prev, button.rail-next").length).toBe(0);
    // …and every destination is still a real link, not an entry in a menu.
    expect(tabs().length).toBe(4);
    expect(tabs().every((a) => a.getAttribute("href"))).toBe(true);
  });

  // Everything positional in this component was a rect comparison, because
  // scrollLeft is the one measurement whose sign and origin engines disagree
  // about under dir=rtl. The rects went with the scroller; what must not come
  // back is scrollLeft arithmetic, and what must still be true is that `dir()`
  // answers for a locale the product can restore.
  it("never does scrollLeft arithmetic, and dir() still answers for Arabic", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/Nav.svelte"), "utf8");
    expect(src).not.toMatch(/\.scrollLeft/);
    expect(src, "Nav must read direction from dir(lang())").toMatch(
      /const rtl = \$derived\(dir\(lang\(\)\) === "rtl"\)/,
    );
    for (const { code } of LANGS) expect(dir(code), code).toBe("ltr");
    expect(dir("ar")).toBe("rtl");
  });

  // Every box in the compact and sidebar forms is a LOGICAL property, so a
  // restored RTL locale mirrors the header with no second rule. A physical
  // left/right in either block is how that would silently stop being true.
  it("lays both narrow and sidebar forms out in logical directions", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/Nav.svelte"), "utf8");
    const css = src.slice(src.indexOf("<style>"));
    expect(css).not.toMatch(/\b(?:margin|padding)-(?:left|right)\b/);
    expect(css).not.toMatch(/\b(?:float|text-align)\s*:\s*(?:right|left)\b/);
  });

  // jsdom paints nothing, so the layer order is pinned at the source. The
  // sticky rail is a stacking context and `<Account>` is mounted inside it: the
  // dialog's own z-index cannot lift it above the content pane, only the rail's
  // can. With `z-index: auto` every positioned card on /cross-network painted
  // over the open sign-in dialog and its backdrop (production, 2026-09-18).
  it("gives the sticky rail the account dialog's place in the page layer scale", () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
    const layer = (src: string, selector: string) => {
      const at = src.indexOf(`\n  ${selector} {`);
      expect(at, `${selector} rule`).toBeGreaterThan(-1);
      const z = /z-index:\s*(\d+)/.exec(src.slice(at, src.indexOf("}", at)));
      expect(z, `${selector} z-index`).not.toBeNull();
      return Number(z![1]);
    };
    const nav = read("src/lib/Nav.svelte");
    const railAt = nav.indexOf("    .topnav.shell {\n      position: sticky;");
    expect(railAt, "the sticky rail rule").toBeGreaterThan(-1);
    const railZ = /\n\s*z-index:\s*(\d+);/.exec(nav.slice(railAt, nav.indexOf("\n    }", railAt)));
    expect(railZ, "a sticky rail with z-index: auto traps the dialog under the page").not.toBeNull();
    const rail = Number(railZ![1]);

    const app = read("src/App.svelte");
    expect(rail).toBe(layer(read("src/lib/Account.svelte"), ".backdrop"));
    expect(rail).toBeGreaterThan(layer(app, ".toast"));
    expect(rail).toBeLessThan(layer(app, ".dropzone"));
  });
});

// The three rows that left the header: tools, language/theme, and the account
// control. They did not leave the DOM — a disclosure that unmounted `<Account>`
// would take a half-typed sign-in form with it on every rotation — so the panel
// is one structure at every width, forced open above the desktop breakpoint.
// jsdom reports `matchMedia(...).matches === false`, which is that wide state.
describe("Nav utility disclosure", () => {
  const more = () => target.querySelector<HTMLDetailsElement>("details.more")!;

  it("is a real disclosure with a localized accessible name", async () => {
    const summary = more().querySelector("summary")!;
    expect(summary.getAttribute("aria-label")).toBe(messages.en.shell.more);
    await setLang("zh");
    flushSync();
    expect(more().querySelector("summary")!.getAttribute("aria-label")).toBe(messages.zh.shell.more);
    expect(more().querySelector("summary")!.getAttribute("aria-label")).not.toBe(messages.en.shell.more);
    await setLang("en");
    flushSync();
  });

  it("keeps tools, language and theme inside the panel", () => {
    const panel = more().querySelector(".more-panel")!;
    expect(panel.querySelector("nav.tools")).not.toBeNull();
    expect(panel.querySelector("select.lang")).not.toBeNull();
    expect(panel.querySelector(".util")).not.toBeNull();
  });

  // The regression this component shipped and root caught in a real browser:
  // `<Account>` was inside this <details>, and a closed <details> hides its
  // whole non-summary subtree — including the `position: fixed` sign-in dialog
  // Account renders. A page's own "Sign in" button calls `setLoginOpen(true)`,
  // so it opened a dialog that existed and could not be seen
  // (login-menu-red.json: dialogCount 1, dialogVisible false, moreOpen false).
  //
  // Mounted-ness was never the property that mattered. This pins the structural
  // cause — Account is a SIBLING of the disclosure, never a descendant — and
  // e2e/page-shell.mjs's `shellLoginNavScenario` pins the behaviour in a real
  // browser, where "visible" is something a layout engine answers.
  it("renders the account control OUTSIDE the collapsing disclosure", () => {
    navigate("cross");
    flushSync();
    const acct = target.querySelector(".acct-btn")!;
    expect(acct, "the account control must exist on a login-gated route").not.toBeNull();
    expect(more().contains(acct), "account must not be inside details.more").toBe(false);
    expect(target.querySelector(".util-slot")!.contains(acct)).toBe(true);
    // Exactly one instance: two would mean two dialogs and two sign-in states.
    expect(target.querySelectorAll(".acct-btn").length).toBe(1);
  });

  it("puts the dialog outside the disclosure too, so opening it needs no menu", () => {
    navigate("cross");
    flushSync();
    setLoginOpen(true);
    flushSync();
    const dialog = target.querySelector('[role="dialog"]')!;
    expect(dialog, "setLoginOpen(true) must produce a dialog").not.toBeNull();
    expect(more().contains(dialog), "the dialog must not be inside details.more").toBe(false);
    setLoginOpen(false);
    flushSync();
  });

  it("is open, with no summary to press, at desktop width", () => {
    // jsdom's matchMedia never matches, so `narrow` is false — the wide form.
    expect(more().open).toBe(true);
  });
});

// The two links that are NOT ways to move a file. They were the fifth and sixth
// pills in the destination row, dressed exactly like the four that are, so the
// row answered "how do I send this?" with two entries that answer "what can I
// install?". They moved into their own named landmark — and the whole risk of
// that move is that a secondary group becomes a group nobody can reach, or one
// that cannot say it is the page you are on.
describe("Nav downloads and tools", () => {
  it("is a second, separately named navigation landmark", () => {
    const primary = target.querySelector("nav.topnav")!;
    const secondary = target.querySelector("nav.tools")!;
    expect(secondary).not.toBeNull();
    // Two landmarks of the same role are indistinguishable in a screen reader's
    // landmark list unless both are named, and named in the reader's language.
    expect(primary.getAttribute("aria-label")).toBe(messages.en.nav.primaryLabel);
    expect(secondary.getAttribute("aria-label")).toBe(messages.en.nav.toolsLabel);
    expect(secondary.getAttribute("aria-label")).not.toBe(primary.getAttribute("aria-label"));
  });

  it("names itself from the active locale, never from a hardcoded string", async () => {
    await setLang("zh");
    flushSync();
    expect(target.querySelector("nav.tools")!.getAttribute("aria-label"))
      .toBe(messages.zh.nav.toolsLabel);
    await setLang("en");
    flushSync();
  });

  it("keeps all three hrefs, as real anchors that are reachable from the keyboard", () => {
    const links = tools();
    expect(links.length).toBe(3);
    expect(links.map((a) => new URL(a.href).pathname)).toEqual([CLI_PATH, APPS_PATH, PRICING_PATH]);
    for (const a of links) {
      expect(a.tagName).toBe("A");
      expect(a.getAttribute("role")).toBeNull();
      // No tabindex needed and none wanted: a real anchor with an href already
      // takes focus in DOM order, which is the only version of this that cannot
      // be broken by a later style change.
      expect(a.tabIndex).toBe(0);
      expect(a.textContent!.trim()).not.toBe("");
    }
  });

  it("marks the current tools page on a DIRECT load, with nothing to open first", () => {
    // The case a menu or a popover gets wrong. Somebody arriving at /cli from a
    // search result never opens anything, so a current-page marker that lives
    // inside a collapsed container is a marker they never see. There is no
    // container: the links are always rendered and always carry their state.
    for (const [path, index] of [[CLI_PATH, 0], [APPS_PATH, 1]] as const) {
      if (app) unmount(app);
      history.pushState({}, "", path);
      syncRouteFromLocation();
      app = mount(Nav, { target });
      flushSync();
      expect(currentTool().length, path).toBe(1);
      expect(currentTool()[0], path).toBe(tools()[index]);
      expect(tools()[index].getAttribute("aria-current"), path).toBe("page");
      // …and the transfer rail claims nothing while the reader is not on one.
      expect(current().length, path).toBe(0);
    }
  });

  it("navigates on a click, exactly as a destination does", () => {
    tools()[1].click();
    flushSync();
    expect(location.pathname).toBe(APPS_PATH);
    expect(currentTool()[0]).toBe(tools()[1]);
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

// Focus return across the inert background. The dialog's own trap restores while
// it is being torn down, when the background is still `inert`, so the restore is
// a no-op and focus lands on <body>. Nav restores once the background is usable.
describe("Nav returns focus to whatever opened the account dialog", () => {
  function opener(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = "Sign in";
    document.body.appendChild(btn);
    return btn;
  }

  it("restores the element that had focus before the dialog opened", async () => {
    navigate("cross");
    flushSync();
    const btn = opener();
    try {
      btn.dispatchEvent(new Event("focusin", { bubbles: true }));
      setLoginOpen(true);
      flushSync();
      (document.querySelector('[role="dialog"] input') as HTMLElement | null)?.focus();
      setLoginOpen(false);
      flushSync();
      await Promise.resolve();
      expect(document.activeElement).toBe(btn);
    } finally {
      btn.remove();
      setLoginOpen(false);
      flushSync();
    }
  });

  it("keeps the opener stable when the backdrop is what gets clicked", async () => {
    navigate("cross");
    flushSync();
    const btn = opener();
    const backdrop = document.createElement("button");
    backdrop.className = "backdrop";
    document.body.appendChild(backdrop);
    try {
      btn.dispatchEvent(new Event("focusin", { bubbles: true }));
      setLoginOpen(true);
      flushSync();
      // The backdrop is a real <button> OUTSIDE [role=dialog]: pressing it used
      // to overwrite the opener with a node detached a moment later.
      backdrop.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      backdrop.dispatchEvent(new Event("focusin", { bubbles: true }));
      backdrop.remove();
      setLoginOpen(false);
      flushSync();
      await Promise.resolve();
      expect(document.activeElement).toBe(btn);
    } finally {
      btn.remove();
      setLoginOpen(false);
      flushSync();
    }
  });

  it("does not take focus from a newer target", async () => {
    navigate("cross");
    flushSync();
    const btn = opener();
    const later = opener();
    try {
      btn.dispatchEvent(new Event("focusin", { bubbles: true }));
      setLoginOpen(true);
      flushSync();
      setLoginOpen(false);
      flushSync();
      later.focus();
      await Promise.resolve();
      expect(document.activeElement).toBe(later);
    } finally {
      btn.remove();
      later.remove();
      setLoginOpen(false);
      flushSync();
    }
  });
});
