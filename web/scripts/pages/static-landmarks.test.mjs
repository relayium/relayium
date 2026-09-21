// Every static template must wrap its primary content in exactly one <main>, and
// must paint link text with the readable accent, not the decorative one.
//
// Both rules are invisible in review and expensive to lose. Before this test none
// of the six template types (landing, article, guides index, legal, mode, 404) had
// a main landmark at all: a screen-reader user could not jump to the content of any
// of the generated pages, and every paragraph on them sat outside a landmark.
// The link colour is the same shape of defect — #aa3bff is 4.39:1 on white, so it
// passes a glance and fails WCAG AA on every link in the language bar, the
// breadcrumb, the related list and the guides index.
//
// This runs against the REAL builders and REAL content, not fixtures, and every
// assertion reads the RENDERED page — so it fails for the pages that actually
// ship, and keeps failing however the six templates are refactored underneath.
import { describe, it, expect } from "vitest";
import landing from "./content/landing.mjs";
import guidesIndex from "./content/guides-index.mjs";
import crossNetwork from "./content/cross-network.mjs";
import privacy from "./content/legal/privacy.mjs";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";
import {
  buildLandingPages, buildArticlePages, buildLegalPages, buildModePages,
} from "./build-pages.mjs";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import { renderNotFoundPage } from "./notfound-template.mjs";

const groups = {
  guides: [{ slug: "guides/self-host-relayium", title: "Self-host" }],
  howTo: [{ slug: "how-to/send-a-folder", title: "Send a folder" }],
  compare: [{ slug: "compare/snapdrop", title: "vs Snapdrop" }],
};

/** One rendered page per template, named the way the a11y scanner names its targets. */
const PAGES = {
  landing: buildLandingPages(landing).find((p) => p.path === "zh/index.html").html,
  "landing/rtl": buildLandingPages(landing).find((p) => p.path === "ar/index.html").html,
  article: buildArticlePages([compareSnapdrop]).find((p) => p.path === "compare/snapdrop/index.html").html,
  "guides-index": renderGuidesIndexPage({ lang: "en", doc: guidesIndex.langs.en, groups }),
  legal: buildLegalPages([privacy]).find((p) => p.path === "privacy/index.html").html,
  mode: buildModePages(crossNetwork, { slug: "cross-network" }).find((p) => p.path === "zh/cross-network/index.html").html,
  notfound: renderNotFoundPage(),
};

const count = (html, needle) => html.split(needle).length - 1;
/** Every <style> block a page emits, concatenated — the CSS a browser applies. */
const styleOf = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");

describe("static templates expose one main landmark", () => {
  it.each(Object.keys(PAGES))("%s renders exactly one <main>", (name) => {
    const html = PAGES[name];
    expect(count(html, "<main>"), `${name} must open exactly one <main>`).toBe(1);
    expect(count(html, "</main>"), `${name} must close exactly one <main>`).toBe(1);
  });

  it.each(Object.keys(PAGES))("%s puts the h1 inside main and the chrome outside it", (name) => {
    const html = PAGES[name];
    const open = html.indexOf("<main>");
    const close = html.indexOf("</main>");
    const inside = html.slice(open, close);

    // The one thing a "skip to main content" jump must land on.
    expect(inside, `${name}: <h1> belongs inside <main>`).toContain("<h1>");
    // Site chrome is not page content; keeping it out is the whole point of the
    // landmark. (The language bar is allowed inside — it is a labelled <nav>
    // landmark of its own either way.) Matched on the OPENING angle bracket plus
    // the tag name, not on the complete `<header>`: an attribute on either
    // element would have made both "must not contain" assertions vacuously true
    // and the third one search for a string that is not there.
    expect(inside, `${name}: the site header must stay outside <main>`).not.toMatch(/<header[\s>]/);
    expect(inside, `${name}: the footer must stay outside <main>`).not.toMatch(/<footer[\s>]/);
    expect(html.search(/<footer[\s>]/), `${name}: <main> must close before the footer`).toBeGreaterThan(close);
  });
});

describe("static pages paint link text with the readable accent, never the decorative one", () => {
  // Asserted on the RENDERED page rather than on template source. The six
  // templates now compose one shared stylesheet (page-chrome.mjs), so a source
  // grep would report "the token is not in this file" for every one of them
  // while the pages themselves were perfect — or, worse, keep passing on a
  // template that had stopped emitting the stylesheet at all. What ships is
  // what is checked.

  it.each(Object.keys(PAGES))("%s declares --accent-fg for light AND dark", (name) => {
    const css = styleOf(PAGES[name]);
    // Three, not two: the light value, the `prefers-color-scheme` block, and
    // the `[data-theme="dark"]` block the pre-paint snippet drives. A theme a
    // reader chose explicitly cannot be expressed by a media query, so the
    // attribute selector is not a duplicate of it.
    expect(css.match(/--accent-fg:/g) ?? [], `${name} must set --accent-fg in all three theme selectors`)
      .toHaveLength(3);
  });

  it.each(Object.keys(PAGES))("%s paints no text with the decorative --accent", (name) => {
    // `color:` only — `border-color:`/`background:` are exactly what the
    // decorative token is for, and must stay on it.
    const offenders = [...styleOf(PAGES[name]).matchAll(/(^|[;{\s])color:var\(--accent\)/g)];
    expect(offenders.map((m) => m[0]), `${name} paints text with the decorative accent`).toEqual([]);
  });

  it.each(Object.keys(PAGES))("%s keeps a forced-light reader in light", (name) => {
    // The dark palette is applied by the media query ONLY when the reader has
    // not forced light. Without the guard, choosing Light in the app and then
    // opening a guide on a dark OS lands on a dark page — the exact mismatch
    // the snippet was added to remove, reintroduced by the stylesheet.
    expect(styleOf(PAGES[name]), `${name} must guard its dark media block`)
      .toContain('@media(prefers-color-scheme:dark){:root:not([data-theme="light"])');
  });
});

describe("static CTAs carry white text on a measurable fill", () => {
  // `--accent-action` is a FLAT colour, not the two-stop ramp this used to pin.
  // Two reasons, both load-bearing: the owner reference (`Relayium 设计规范` §3)
  // has no gradient anywhere and `src/app.css` follows it, and axe cannot
  // compute contrast over a gradient — it reports "incomplete", which is how an
  // unreadable button passes a scan. Flat, white on it measures 6.10:1 in light
  // and 5.53:1 in dark, and the scanner can say so.
  it.each(Object.keys(PAGES))("%s fills .cta with the action colour and white text", (name) => {
    const css = styleOf(PAGES[name]);
    expect(css).toMatch(/\.cta\{[^}]*color:#fff[^}]*background:var\(--accent-action\)/);
    expect(css, `${name} must not reintroduce a gradient under white text`)
      .not.toMatch(/\.cta\{[^}]*linear-gradient/);
  });
});
