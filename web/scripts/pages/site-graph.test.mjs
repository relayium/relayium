// Whole-site checks over the REAL generated output, aimed at the three Search
// Console buckets that hold pages back from being indexed:
//
//   "Alternate page with proper canonical tag"  → duplicate URLs / titles
//   "Discovered - currently not indexed"        → orphans, weak internal linking
//   "Page with redirect"                        → internal links to redirecting URLs
//
// Each of these was found by crawling production, not by reading the code, so
// the checks run against the built HTML for the same reason.
import { describe, it, expect } from "vitest";
import { buildAllPages, buildSiteSitemap } from "../gen-pages.mjs";
import { SPA_ONLY_EN_SLUGS } from "./shared.mjs";
import { buildShells } from "./shells.mjs";
import crossNetwork from "./content/cross-network.mjs";
import offlineTransfer from "./content/offline-transfer.mjs";
import apps from "./content/apps.mjs";
import { pricing, cli, deviceInbox } from "./content/spa-pages.mjs";
import { CLI_ARTICLES } from "./content/cli-articles.mjs";

const pages = buildAllPages();
const sitemap = buildSiteSitemap();
const shells = buildShells({
  modes: [
    { def: crossNetwork, slug: "cross-network" },
    { def: offlineTransfer, slug: "offline-transfer" },
    { def: apps, slug: "apps" },
  ],
  pricing,
  cli,
  deviceInbox,
  cliArticles: CLI_ARTICLES,
});

const sitemapPaths = [...sitemap.matchAll(/<loc>https:\/\/relayium\.com([^<]*)<\/loc>/g)].map((m) => m[1]);

/** The URL a generated file is served at: <slug>/index.html → /<slug>/. */
const urlOf = (path) => "/" + path.replace(/index\.html$/, "");

// Every internal href across the generated pages AND the SPA shells' crawlable
// <noscript> bodies, with query strings and fragments dropped.
const linkTargets = new Set();
for (const src of [...pages.map((p) => p.html), ...shells.map((s) => s.body)]) {
  for (const m of src.matchAll(/href="(\/[^"]*)"/g)) {
    linkTargets.add(m[1].split(/[?#]/)[0]);
  }
}

describe("no duplicate titles", () => {
  it("every generated page has a title no other page shares", () => {
    // /fr/guides/ and /guides/ both said "Guides · Relayium" — the same word in
    // both languages — which is two indexable URLs with one title.
    const byTitle = new Map();
    for (const p of pages) {
      const t = p.html.match(/<title>(.*?)<\/title>/s)?.[1];
      expect(t, p.path).toBeTruthy();
      byTitle.set(t, [...(byTitle.get(t) ?? []), p.path]);
    }
    const dupes = [...byTitle].filter(([, paths]) => paths.length > 1);
    expect(dupes.map(([t, paths]) => `${t} → ${paths.join(", ")}`)).toEqual([]);
  });
});

describe("no orphans", () => {
  it("every sitemap URL is linked from at least one page", () => {
    // /pricing sat in the sitemap while not one page linked to it. An orphan
    // reachable only from the sitemap is the classic "Discovered - currently
    // not indexed" candidate.
    const orphans = sitemapPaths.filter((u) => u !== "/" && !linkTargets.has(u));
    expect(orphans).toEqual([]);
  });
});

describe("no internal link points somewhere that redirects or 404s", () => {
  // Generated pages live at <slug>/index.html and the origin 301s the
  // slash-less form, so a link without the trailing slash costs a redirect —
  // that is what put ~390 URLs in the "Page with redirect" bucket once already.
  const served = new Set([
    ...pages.map((p) => urlOf(p.path)),
    ...shells.map((s) => "/" + s.file.replace(/\.html$/, "")),
    "/",
  ]);
  // Static assets and the one dynamic route, which have no generated page.
  const ASSET = /\.(png|jpg|svg|ico|txt|xml|webmanifest|js|css|sh)$/;
  const ALLOW = new Set(["/me", "/d/"]);

  it("resolves every internal link to a page that is actually served", () => {
    const dead = [...linkTargets].filter(
      (h) => !served.has(h) && !ASSET.test(h) && !ALLOW.has(h) && !h.startsWith("/d/")
    );
    expect(dead.sort()).toEqual([]);
  });

  it("links the slashed form of every generated page", () => {
    // A link to /compare/croc (no slash) 301s to /compare/croc/.
    const redirecting = [...linkTargets].filter((h) => {
      if (h.endsWith("/") || ASSET.test(h)) return false;
      return served.has(h + "/");
    });
    expect(redirecting.sort()).toEqual([]);
  });

  it("never links a */index.html URL", () => {
    // /foo/index.html serves the same page as /foo/ and canonicals at it —
    // nginx 301s it now, but a link should not go through that redirect.
    expect([...linkTargets].filter((h) => h.endsWith("/index.html"))).toEqual([]);
  });
});

describe("the English-only SPA routes reach the static graph", () => {
  it("each is in the sitemap and linked", () => {
    for (const u of ["/pricing", "/cli", "/device-inbox"]) {
      expect(sitemapPaths, u).toContain(u);
      expect(linkTargets.has(u), `${u} is linked from a static page`).toBe(true);
    }
  });
});

// buildSitemap's guard only proves modes ⊆ MODE_SLUGS and spaPages ⊆
// NO_LOCALIZED_TWIN_SLUGS. The converse matters just as much: if a registered
// slug ever gains a generated English directory, urlPath() would report /cli
// while the page lands at cli/index.html, and the origin would 301 the sitemap's
// own URL — the same bug arriving from the other direction. This lives here
// rather than in build-pages.test.mjs because the page graph is already built
// at the top of this file.
describe("no slash-less slug has a generated English directory", () => {
  it("keeps the generated pages and SPA_ONLY_EN_SLUGS disjoint", () => {
    const collisions = pages
      .map((p) => p.path.replace(/^\/+/, ""))
      .filter((p) => [...SPA_ONLY_EN_SLUGS].some((s) => p === `${s}/index.html`));
    expect(collisions).toEqual([]);
  });
});
