// web/scripts/pages/releases.test.mjs — the /releases/ page and, more
// importantly, the one thing that page can get wrong: drifting out of sync with
// the tags it claims to list.
//
// content/releases.mjs explains why the version list is committed data rather
// than something read from git at build time (CI checks out shallow, with no
// tags, so a git-driven list would render empty in the environment that ships
// it). The cost of that choice is exactly one failure mode — someone cuts a
// release and forgets the line — and "git tags are the source of truth" below
// is what pays for it. It bites in any full clone, which is every environment
// where the file could be edited in the first place.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import releases from "./content/releases.mjs";
import { buildReleasesPages, buildSitemap } from "./build-pages.mjs";
import { LANGS, RELEASES_LABELS, urlPath } from "./shared.mjs";
import en from "../../src/lib/i18n/en.ts";
import zh from "../../src/lib/i18n/zh.ts";
import ja from "../../src/lib/i18n/ja.ts";
import ko from "../../src/lib/i18n/ko.ts";
import de from "../../src/lib/i18n/de.ts";
import fr from "../../src/lib/i18n/fr.ts";
import ar from "../../src/lib/i18n/ar.ts";
import es from "../../src/lib/i18n/es.ts";
import pt from "../../src/lib/i18n/pt.ts";

const APP_TABLES = { en, zh, ja, ko, de, fr, ar, es, pt };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pages = buildReleasesPages(releases);
const byLang = Object.fromEntries(LANGS.map((l, i) => [l, pages[i].html]));

/**
 * Every tag in this clone as { version: date }, or null where git cannot answer
 * — no repository, no git binary, or a shallow checkout with no tags.
 *
 * An EMPTY tag list is not a discrepancy, it is a partial environment: CI clones
 * with fetch-depth 1 and gets no tags at all. Distinguishing "git says there are
 * no tags" from "git could not be asked" is the whole reason this returns null
 * rather than {}.
 */
function gitTags() {
  try {
    const out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short) %(creatordate:short)", "refs/tags"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return null;
    return Object.fromEntries(out.split("\n").map((line) => line.trim().split(/\s+/)));
  } catch {
    return null;
  }
}

describe("the release list is internally consistent", () => {
  it("every entry is a version tag and an ISO date", () => {
    for (const r of releases.releases) {
      expect(r.version, JSON.stringify(r)).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("lists each version once", () => {
    const versions = releases.releases.map((r) => r.version);
    expect(versions.length).toBe(new Set(versions).size);
  });

  it("is ordered newest first", () => {
    // The page says "Newest first" in nine languages, and a reader scanning for
    // the latest version reads the top row and stops.
    const dates = releases.releases.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("orders same-day releases by version, newest first", () => {
    // Six versions shipped on 2026-07-13 and three on 2026-07-23, so the date
    // ordering above cannot see their relative order at all.
    const key = (v) => v.slice(1).split(".").map(Number);
    for (let i = 1; i < releases.releases.length; i++) {
      const [a, b] = [releases.releases[i - 1], releases.releases[i]];
      if (a.date !== b.date) continue;
      expect(key(a.version) > key(b.version) ? 1 : -1, `${a.version} before ${b.version}`).toBe(1);
    }
  });

  it("dates the page from its newest release", () => {
    expect(releases.updated).toBe(releases.releases[0].date);
    for (const lang of LANGS) expect(releases.langs[lang].updated, lang).toBe(releases.updated);
  });
});

describe("git tags are the source of truth", () => {
  const tags = gitTags();

  it.skipIf(tags === null)("lists every tag in this repository, with its date", () => {
    // The failure this exists for: a release is cut (auto-release.yml tags from
    // main on a schedule, so it happens without anyone typing `git tag`) and the
    // page silently stops listing the newest version.
    const listed = Object.fromEntries(releases.releases.map((r) => [r.version, r.date]));
    expect(listed).toEqual(tags);
  });

  it.runIf(tags === null)("says so when git could not be asked", () => {
    // Not a silent pass: this environment cannot check the invariant above, and
    // the test list should show that rather than 100% green.
    expect(tags).toBeNull();
  });
});

describe("the generated pages", () => {
  it("builds one page per language", () => {
    expect(pages.map((p) => p.path)).toEqual([
      "releases/index.html",
      ...LANGS.filter((l) => l !== "en").map((l) => `${l}/releases/index.html`),
    ]);
  });

  it("renders every version, linked to its notes on GitHub", () => {
    for (const lang of LANGS) {
      for (const r of releases.releases) {
        expect(byLang[lang], `${lang} ${r.version}`).toContain(
          `<a href="https://github.com/relayium/relayium/releases/tag/${r.version}"><bdi>${r.version}</bdi></a>`,
        );
      }
      expect(byLang[lang].match(/class="releases"/g), lang).toHaveLength(1);
    }
  });

  it("localizes the list's own heading and note", () => {
    for (const lang of LANGS) {
      expect(byLang[lang], lang).toContain(releases.langs[lang].releasesHeading);
      expect(byLang[lang], lang).toContain(releases.langs[lang].releasesNote);
    }
  });

  it("isolates the version and date runs for RTL", () => {
    // Without <bdi>, "v0.15.0" and "2026-08-03" sit in an RTL paragraph
    // direction on the Arabic page and swap sides.
    expect(byLang.ar).toContain('<span class="date"><bdi>2026-08-03</bdi></span>');
  });

  it("does not link to itself from its own footer", () => {
    for (const lang of LANGS) {
      const footer = byLang[lang].slice(byLang[lang].indexOf("<footer>"));
      expect(footer, lang).not.toContain(`href="${urlPath("releases", lang)}"`);
    }
  });

  it("canonicalizes each language to its own URL", () => {
    for (const lang of LANGS) {
      expect(byLang[lang], lang).toContain(
        `<link rel="canonical" href="https://relayium.com${urlPath("releases", lang)}" />`,
      );
    }
  });
});

describe("the page is called the same thing everywhere", () => {
  // Three independent copies of one label: the page's own <h1>/<title>, the
  // footer label on the static pages (RELEASES_LABELS), and the footer label in
  // the running app (i18n `legal.releases`). GLOSSARY.md's "UI labels must match
  // the shipped app" is exactly about this shape — a link that calls a page one
  // name and the page that calls itself another. Two comments claim these agree;
  // this is what makes the claim true.
  it("uses one label per locale across the title, the static footer and the app", () => {
    for (const lang of LANGS) {
      expect(RELEASES_LABELS[lang], lang).toBe(releases.langs[lang].title);
      expect(APP_TABLES[lang].legal.releases, lang).toBe(releases.langs[lang].title);
    }
  });
});

describe("the sitemap", () => {
  it("carries all nine URLs, dated from the newest release", () => {
    const xml = buildSitemap([], { home: false, releases });
    for (const lang of LANGS) {
      expect(xml, lang).toContain(`<loc>https://relayium.com${urlPath("releases", lang)}</loc>`);
    }
    expect(xml.match(/<lastmod>2026-08-03<\/lastmod>/g)).toHaveLength(LANGS.length);
  });

  it("does not claim the yearly changefreq the legal pages use", () => {
    // It gains a row every time a version ships; "yearly" would be wrong about
    // the one page on the site that changes on a schedule.
    const xml = buildSitemap([], { home: false, releases });
    expect(xml).not.toContain("<changefreq>yearly</changefreq>");
    expect(xml.match(/<changefreq>weekly<\/changefreq>/g)).toHaveLength(LANGS.length);
  });
});
