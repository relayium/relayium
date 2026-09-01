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
    await setLang("zh");
    const nav = render(Nav).querySelector("nav.topnav")!;
    expect(nav.getAttribute("aria-label")).toBe(messages.zh.nav.primaryLabel);
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
    // One aspect column plus the three transfer modes.
    expect(root.querySelectorAll("[role='columnheader']").length).toBe(4);
    for (const cell of root.querySelectorAll("[role='columnheader']")) {
      expect(cell.tagName).toBe("SPAN");
    }
  });

  it("offers a header link for every mode in the header row", () => {
    const root = render(ModeCompare);
    const links = root.querySelectorAll("[role='row'] [role='columnheader'] a.head-link");
    // A named mode the reader cannot open is a dead end: all three columns are
    // pages, so all three headings are links to them.
    expect(links.length).toBe(3);
    expect([...links].map((a) => a.getAttribute("href"))).toEqual(["/", "/cross-network", "/offline-transfer"]);
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
    // The marker class the padding rule keys off must actually be on every
    // linked cell.
    expect(root.querySelectorAll("[role='columnheader'].is-link").length).toBe(3);
  });

  it("names the mode inside each card cell, as text rather than CSS content", () => {
    // Narrow layout hides the header row, so the only thing left saying which
    // mode an answer belongs to is the per-cell tag. As `content: attr(...)`
    // that label was not reliably in the accessibility tree — a phone reader got
    // three unattributed answers per row. As an element it is announced when the
    // cards are showing, and `display: none` keeps it out of both the layout and
    // the tree at the widths where the real column headers do the job.
    const compare = readFileSync(resolve(import.meta.dirname, "ModeCompare.svelte"), "utf8");
    expect(compare).not.toContain("content: attr(data-label)");
    expect(compare).toMatch(/\.tag \{ display: none; \}/);
    expect(compare).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.tag \{ display: block;/);

    const root = render(ModeCompare);
    const rows = [...root.querySelectorAll("[role='row']")].filter((r) => !r.classList.contains("header"));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      const tags = [...row.querySelectorAll("[role='cell'] > .tag")].map((t) => t.textContent?.trim());
      expect(tags.filter(Boolean)).toHaveLength(3);
      // Each answer carries its own mode name, and no two in a row are the same.
      expect(new Set(tags).size).toBe(3);
    }
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

  it("renders /cli's inner column as a plain element, since App already owns <main>", () => {
    // Same defect as the pricing route, found by axe (landmark-unique) on
    // spa/cli: `.body` is the grid column that holds the page's bands, not a
    // second main landmark. The class assertion is the other half — `.body`
    // carries `min-inline-size: 0`, and page-shell.mjs's CLI mobile scenario
    // measures that box by class, so dropping it would silently un-measure the
    // container whose overflow the scenario exists to catch.
    const root = render(CliPage);
    expect(root.querySelector("main")).toBeNull();
    const body = root.querySelector(".body")!;
    expect(body).not.toBeNull();
    expect(body.tagName).toBe("DIV");
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

describe("the peer card is a pointer shortcut, not a control it does not own", () => {
  // History, because it is what these assertions are still holding down. The
  // primary picker was once claimed by two labels at once: the whole peer card
  // (`<label class="pcard" for={pick-…}>`) and the visible "Send files" action
  // that wrapped the input. One input, two labels — axe reports
  // form-field-multiple-labels and each AT is free to announce a different name.
  //
  // The `link/1`-only contraction removed that picker from this card entirely:
  // a routing peer has one action (open the workspace, where the pickers live),
  // and a peer that does not route has none at all. So the multiple-label rule
  // is now held structurally — there is no per-peer picker here for a second
  // label to attach to — and what these tests pin is the pair of semantics that
  // replaced it: the card is still not a label, and the unreachable state is a
  // statement rather than a control.
  const source = readFileSync(resolve(import.meta.dirname, "..", "App.svelte"), "utf8");
  const card = /<div\b[^>]*class="pcard"[\s\S]*?<\/div>/.exec(source)?.[0] ?? "";
  const snippet = source.slice(source.indexOf("{#snippet peerCard("), source.indexOf("{#snippet transferSurface()"));
  const actions = snippet.slice(snippet.indexOf('<div class="peer-actions">'));
  /** Markup only. A comment may legitimately NAME the control it is explaining
   *  it no longer renders — which is exactly what several of these do. */
  const markup = (t: string) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*/g, "");

  it("owns no form control at all, so no control here can have two labels", () => {
    expect(card).not.toBe("");
    expect(card).not.toMatch(/\bfor=/);
    expect(source).not.toMatch(/<label[^>]*class="pcard"/);
    // The whole snippet, not only the .pcard div: a picker moved a few lines
    // down would satisfy a card-scoped assertion and reopen the same hole.
    expect(markup(snippet)).not.toMatch(/<input\b/);
    expect(markup(snippet)).not.toMatch(/<label\b/);
    expect(markup(snippet)).not.toContain("file-pick-input");
    expect(markup(snippet)).not.toContain("pick-${p.id}");
    // The pickers did not vanish from the product — they moved to the surface
    // that only exists once a link does. This is the positive control: an
    // assertion that only says "no input here" is satisfied by deleting the
    // feature, and would stay green if it had been.
    const panel = readFileSync(resolve(import.meta.dirname, "MessagePanel.svelte"), "utf8");
    expect(panel).toContain("file-pick-input attach-file");
    expect(panel).toMatch(/<input\b[\s\S]*?type="file"/);
    expect(source).toContain("onPickFiles={(e) => pickFile(e, workspace.linkPeerId)}");
  });

  it("still points the card at the peer's one real action on pointer input", () => {
    expect(card).toMatch(/onclick=/);
    // Attached only for a peer that HAS that action — see the cascade suite
    // below for why the unreachable card carries no listener at all.
    expect(card).toContain("onclick={unifiedPeer ? (e) => {");
    expect(card).toContain("openWorkspace(p.id);");
    // A busy peer must not be able to act, and a click that only ended a
    // selection drag is not a tap — both are what the <label> used to do for
    // free, and both still guard the one action that is left.
    expect(card).toMatch(/if \(intentBlocked \|\|/);
    expect(card).toMatch(/!picked\.isCollapsed && picked\.containsNode\(/);
    // …and it reaches nothing for a peer that cannot be reached. The shortcut
    // used to focus and click a hidden input; a shortcut to a control that is
    // not on the card is a tap that silently does nothing.
    expect(card).not.toMatch(/getElementById/);
    expect(card).not.toMatch(/input\?\.click\(\)/);
  });

  it("gives the card no keyboard path of its own", () => {
    expect(card).not.toBe("");
    expect(card).not.toMatch(/onkey/i);
    expect(card).not.toMatch(/tabindex/i);
    expect(card).not.toMatch(/role=/);
  });

  it("states an unreachable peer rather than rendering a control for it", () => {
    const terminal = actions.slice(actions.indexOf("{:else}"));
    // A paragraph, and a localized one. Not a button, not a disabled button, not
    // an aria-disabled anything: those all say "not now", and the truth is "not
    // this device". A disabled control is also still an accessible-name carrier
    // and, in several ATs, still announced — so it would read as an action.
    expect(terminal).toContain('<p class="pa-unsupported">{t.peerUnsupported}</p>');
    for (const control of ["<button", "<label", "<input", "tabindex", "aria-disabled", "role="]) {
      expect(markup(terminal), control).not.toContain(control);
    }
    // It is the whole of that branch — nothing else renders beside it.
    expect(markup(terminal).match(/<p /g)).toHaveLength(1);
  });

  it("keeps a name on the peer for the surface that still describes by it", () => {
    // `peer-target-` is the card's stable per-peer name node. Both branches keep
    // it, so the workspace surface and the announcement can still point at a
    // peer by id regardless of whether it can be reached.
    expect(snippet.match(/id=\{`peer-target-\$\{p\.id\}`\}/g)).toHaveLength(2);
    expect(source).toMatch(/<span class="pname" id=\{`peer-target-\$\{p\.id\}`\}>/);
  });
});

describe("a peer that cannot be reached does not look pressable", () => {
  // The finding this pins: the terminal-unsupported card lost its controls but
  // kept every affordance that had advertised them. `.peer .pcard` set
  // `cursor: pointer` unconditionally, `.peer:not(.disabled):hover` painted the
  // card in the accent state, and the list-level drag rule repainted it again
  // while a file was over the list — so the one card in the product with nothing
  // to press looked, to a pointer, exactly like the one card that opens a
  // workspace. Its click then did nothing, which the user reads as a failure
  // they caused.
  //
  // These run the REAL cascade rather than matching source text. jsdom parses
  // App.svelte's own <style> block and resolves specificity and order, so an
  // added rule that re-grants the affordance later in the sheet fails here even
  // though every source-shaped assertion below would still pass. Both states are
  // built from the same markup, so the routing card is a live positive control:
  // if the whole style block failed to load, IT would go unstyled and fail too.
  const source = readFileSync(resolve(import.meta.dirname, "..", "App.svelte"), "utf8");
  const css = /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? "";

  /** Svelte's `:global(x)` is not a selector jsdom can match; the browser sees
   *  the inner compound, scoped away. Unwrapping it keeps those rules in the
   *  comparison instead of silently dropping the ones we most want to check. */
  const plain = (sel: string) => sel.replace(/:global\(([^()]*)\)/g, "$1");

  let sheet: CSSStyleSheet;
  let routing: HTMLElement;
  let unreachable: HTMLElement;

  beforeEach(() => {
    expect(css).not.toBe("");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    sheet = style.sheet!;
    // A stylesheet that failed to parse would make every "no affordance" claim
    // below vacuously true.
    expect(sheet.cssRules.length).toBeGreaterThan(50);

    // `solo` deliberately: a single connected peer is the case the accent fill
    // was written for, and therefore the case where an untrue highlight is
    // permanent rather than hover-only.
    target.innerHTML = `<div class="peers"><ul class="solo">
      <li class="peer"><div class="pcard" id="routing-card"></div></li>
      <li class="peer unreachable"><div class="pcard" id="unreachable-card"></div></li>
    </ul></div>`;
    routing = target.querySelector("#routing-card")!;
    unreachable = target.querySelector("#unreachable-card")!;
  });

  afterEach(() => {
    for (const s of [...document.head.querySelectorAll("style")]) s.remove();
  });

  it("resolves to a plain cursor, where a reachable peer resolves to a pointer", () => {
    expect(getComputedStyle(routing).cursor).toBe("pointer");
    expect(getComputedStyle(unreachable).cursor).toBe("default");
  });

  it("matches no hover rule that a reachable peer matches", () => {
    // Every rule that only applies on hover, with the hover stripped: "would
    // this style land if the pointer were over the card?"
    const hoverRules = [...sheet.cssRules]
      .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes(":hover"))
      .map((r) => plain(r.selectorText).replace(/:hover/g, ""));
    expect(hoverRules.length).toBeGreaterThan(0);

    const applies = (el: HTMLElement) =>
      hoverRules.filter((sel) => el.matches(sel) || el.parentElement!.matches(sel));
    // The positive control: hovering a reachable peer DOES change it, so this
    // test is measuring an exclusion and not an empty rule set.
    expect(applies(routing).length).toBeGreaterThan(0);
    expect(applies(unreachable)).toEqual([]);
  });

  it("is not repainted as a drop target while a file is over the list", () => {
    // The per-card handler already withholds `.drag` from a peer that will
    // refuse the drop; the list-level rule used to re-grant the same accent.
    target.querySelector("ul")!.classList.add("dragging");
    const dragRules = [...sheet.cssRules]
      .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule && /\bdragging\b/.test(r.selectorText))
      .map((r) => plain(r.selectorText));
    expect(dragRules.length).toBeGreaterThan(0);
    expect(dragRules.filter((sel) => routing.parentElement!.matches(sel)).length).toBeGreaterThan(0);
    expect(dragRules.filter((sel) => unreachable.parentElement!.matches(sel))).toEqual([]);
  });

  it("carries no click handler at all, rather than one whose body is a guard", () => {
    const snippet = source.slice(source.indexOf("{#snippet peerCard("),
                                source.indexOf("{#snippet transferSurface()"));
    // Conditional ATTACHMENT, not a conditional body: `onclick={unifiedPeer ? …
    // : undefined}` leaves the unreachable card with no listener, so it is not a
    // click target to a pointer, to an inspector, or to an event-delegation
    // walk. A handler that returns early is still all three.
    expect(snippet).toContain("onclick={unifiedPeer ? (e) => {");
    expect(snippet).toContain("} : undefined}");
    expect(snippet).toContain("class:unreachable={!unifiedPeer}");
    // And the card must not have grown a keyboard or role affordance instead.
    const card = /<div\n\s+class="pcard"[\s\S]*?\n    >/.exec(snippet)?.[0] ?? "";
    expect(card).not.toBe("");
    expect(card).not.toMatch(/onkey|tabindex|role=|aria-disabled/i);
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

  // The /cli page's two wide reference tables scroll sideways and contain
  // nothing focusable of their own, so each has to be its own tab stop:
  // otherwise the right-hand columns — "where the bytes go", "verification" —
  // are readable with a mouse and unreachable without one.
  //
  // This replaces the old assertion about `.pick-card code`. Those cards are
  // gone: the picker they belonged to was replaced by task branches whose
  // commands are links, which are already tab stops and need no tabindex.
  it("makes every scrollable table on /cli a focus stop named by its caption", () => {
    const root = render(CliPage);
    const wraps = root.querySelectorAll(".wrap");
    expect(wraps.length).toBe(2);
    for (const wrap of wraps) {
      expect(wrap.getAttribute("tabindex")).toBe("0");
      const labelledBy = wrap.getAttribute("aria-labelledby")!;
      // Named by the table's own <caption>, which is in the document — no
      // invented, untranslated string that could drift from what is rendered.
      expect(root.querySelector(`#${labelledBy}`)?.tagName).toBe("CAPTION");
    }
  });

  it("gives /cli's task-branch commands real links rather than fake focus stops", () => {
    const root = render(CliPage);
    const links = root.querySelectorAll("#choose-by-task a");
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute("tabindex")).toBeNull();
      expect(a.getAttribute("href")?.startsWith("#")).toBe(true);
    }
  });
});
