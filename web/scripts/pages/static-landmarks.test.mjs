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
// This runs against the REAL builders and REAL content, not fixtures, so it fails
// for the pages that actually ship.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    // landmark of its own either way.)
    expect(inside, `${name}: the site header must stay outside <main>`).not.toContain("<header>");
    expect(inside, `${name}: the footer must stay outside <main>`).not.toContain("<footer>");
    expect(html.indexOf("<footer>"), `${name}: <main> must close before the footer`).toBeGreaterThan(close);
  });
});

describe("static templates use the readable accent for link text", () => {
  const TEMPLATES = ["landing-template.mjs", "article-template.mjs", "guides-index-template.mjs", "legal-template.mjs"];

  it.each(TEMPLATES)("%s declares --accent-fg in both colour schemes", (file) => {
    const src = readFileSync(resolve(process.cwd(), "scripts/pages", file), "utf8");
    // Light and dark each define it: the dark block is a separate :root, and a
    // token declared only in light silently falls back to the light value.
    expect(src.match(/--accent-fg:/g) ?? [], `${file} must set --accent-fg for light AND dark`).toHaveLength(2);
  });

  it.each(TEMPLATES)("%s paints no text with the decorative --accent", (file) => {
    const src = readFileSync(resolve(process.cwd(), "scripts/pages", file), "utf8");
    // `color:` only — `border-color:`/`background:` are exactly what the
    // decorative token is for, and must stay on it.
    const offenders = [...src.matchAll(/(^|[;{\s])color:var\(--accent\)/g)];
    expect(offenders.map((m) => m[0]), `${file} paints text with the decorative accent`).toEqual([]);
  });
});

describe("static CTAs use the white-text-safe action gradient", () => {
  // mode and 404 reuse landing's STYLE, so these are the two unique .cta rule
  // owners. axe cannot calculate contrast over a gradient; this source contract
  // prevents a decorative-gradient regression from being reported as incomplete
  // instead of failing.
  it.each(["landing-template.mjs", "article-template.mjs"])("%s uses both action stops", (file) => {
    const src = readFileSync(resolve(process.cwd(), "scripts/pages", file), "utf8");
    expect(src).toMatch(/\.cta\{[^}]*color:#fff[^}]*background:linear-gradient\(135deg,var\(--accent-action\),var\(--accent-action-deep\)\)/);
  });
});
