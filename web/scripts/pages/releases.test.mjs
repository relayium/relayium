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
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import releases from "./content/releases.mjs";
import { buildReleasesPages, buildSitemap } from "./build-pages.mjs";
import { FROZEN_LANGS, LANGS, MAINTAINED_LANGS, RELEASES_LABELS, urlPath } from "./shared.mjs";
import en from "../../src/lib/i18n/en.ts";
import zh from "../../src/lib/i18n/zh.ts";

const APP_TABLES = { en, zh };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pages = buildReleasesPages(releases);
const byLang = Object.fromEntries(LANGS.map((l, i) => [l, pages[i].html]));

/**
 * The published macOS release, read rather than written down again.
 *
 * `native-releases.json` is the one manifest the /apps download CTA, the Device
 * Inbox badge and the release workflow already resolve against, so deriving the
 * expected tag from it is the difference between "the page names A tag" and
 * "the page names THE tag whose DMG a reader can actually fetch". Duplicating
 * the literal here would only move the drift one file over: that is precisely
 * how `macos-v1.0` stayed asserted, and green, for five releases after it
 * stopped being current.
 */
const MAC = JSON.parse(
  await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
).macos;

/** The one macOS release tag this page is allowed to name. */
const CURRENT_TAG = `macos-v${MAC.version}`;

/** Every distinct `macos-v…` tag in a string. Set, not count: how many times a
 *  locale repeats the tag is editorial, but each one has to be the current one. */
const macTags = (text) => new Set([...text.matchAll(/macos-v[0-9]+(?:\.[0-9]+)*/g)].map((m) => m[0]));

/** Every distinct `macOS <version>` claim in a string — the lead's half of the
 *  same fact, which carries the bare version rather than the tag. At least one
 *  dot is required, so "the macOS app" is not swept in.
 *
 *  This deliberately cannot tell "Relayium macOS 1.2.1" from a system
 *  requirement like "requires macOS 14.0 or later". The page carries no such
 *  sentence today, and the set-equality below is what makes the guard real
 *  rather than vacuous — so the first one added fails HERE, loudly, and whoever
 *  adds it decides how to distinguish the two claims. Quietly loosening this to
 *  a substring check would restore exactly the hole that let `macOS 1.0` ride
 *  through five releases. */
const macVersions = (text) => new Set([...text.matchAll(/macOS [0-9]+(?:\.[0-9]+)+/g)].map((m) => m[0]));

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

/** `v1.2.3` — the command-line release namespace this page lists. */
const CLI_TAG = /^v\d+\.\d+\.\d+$/;
/** `macos-v1.0` — a native release, deliberately NOT in the list. */
const NATIVE_TAG = /^macos-v\d+(?:\.\d+){1,2}$/;

/**
 * Tags that are not a namespace at all — they are one incident's debris.
 *
 * On 2026-08-12 auto-release.yml still picked its base with `git describe
 * --tags`, which returns the newest tag of ANY family. The macOS app was ahead,
 * so it got `macos-v1.1.3`, stripped a leading `v` that was not there, did
 * integer arithmetic on the string `macos-v1` and pushed `vmacos-v1.2.0`. The
 * release it dispatched died inside GoReleaser before publishing anything —
 * see scripts/release/server-tag.sh, which now owns that decision.
 *
 * So this tag publishes NOTHING: not the CLI and node a `v*` row promises, not
 * a DMG a `macos-v*` tag delivers. Listing it would be the page's one real lie;
 * widening NATIVE_TAG to absorb it would be a quieter one, since it would also
 * green-light the next mistyped tag. It is enumerated by exact name instead —
 * a published tag cannot be un-pushed, and pretending it is gone is what the
 * `unknown` bucket below exists to prevent.
 */
const BROKEN_TAGS = new Set(["vmacos-v1.2.0"]);

/**
 * Sort a tag table into the four things a tag can be.
 *
 * Until 2026-08-10 every tag in this repository was a `v*` command-line release
 * and "the list equals `git tag`" was exactly right. Publishing macOS 1.0 added
 * `macos-v1.0`, which this page must not list — it ships neither of the two
 * binaries a `v*` tag publishes — so an unfiltered comparison would now fail in
 * every full clone, and the obvious repair (list it) would put a version on the
 * page that means something different from every other row.
 *
 * `unknown` is the part that matters. Filtering by "looks like a CLI tag" and
 * discarding the rest would also silently discard the FIRST `ios-v…` tag, which
 * is precisely the moment someone has to decide what this page says about it.
 * So anything that is neither namespace is surfaced and fails below.
 */
function partitionTags(tags) {
  const listed = {};
  const native = [];
  const broken = [];
  const unknown = [];
  for (const [tag, date] of Object.entries(tags)) {
    // Checked first: a known-bad tag must not be able to match anything else.
    if (BROKEN_TAGS.has(tag)) broken.push(tag);
    else if (CLI_TAG.test(tag)) listed[tag] = date;
    else if (NATIVE_TAG.test(tag)) native.push(tag);
    else unknown.push(tag);
  }
  return { listed, native, broken, unknown };
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

  it.skipIf(tags === null)("lists every command-line release tag, with its date", () => {
    // The failure this exists for: a release is cut (auto-release.yml tags from
    // main on a schedule, so it happens without anyone typing `git tag`) and the
    // page silently stops listing the newest version.
    const listed = Object.fromEntries(releases.releases.map((r) => [r.version, r.date]));
    expect(listed).toEqual(partitionTags(tags).listed);
  });

  it.skipIf(tags === null)("accounts for every tag it does not list", () => {
    const { native, broken, unknown } = partitionTags(tags);
    // A namespace nobody has decided about yet. Fail here rather than let the
    // filter above swallow it.
    expect(unknown, "tags in an unrecognised namespace").toEqual([]);
    // And a native release may never appear as a row: the rows mean "this
    // version publishes the CLI and the node", which macos-v1.0 does not.
    // Neither may the incident tag, which publishes nothing whatsoever.
    const rows = new Set(releases.releases.map((r) => r.version));
    for (const tag of [...native, ...broken]) {
      expect(rows.has(tag), `${tag} must not be listed`).toBe(false);
    }
  });

  it.runIf(tags === null)("says so when git could not be asked", () => {
    // Not a silent pass: this environment cannot check the invariant above, and
    // the test list should show that rather than 100% green.
    expect(tags).toBeNull();
  });
});

// The partition above decides what the check can see, and in a clone that has
// not fetched `macos-v1.0` every branch of it is unreachable — the real tag
// table is all `v*`, so "accounts for every tag it does not list" would pass
// without ever classifying anything. These drive it directly, so the rule is
// tested wherever this suite runs rather than only where the tags happen to be.
describe("which tags this page is responsible for", () => {
  it("lists command-line releases and holds back native ones", () => {
    const { listed, native, unknown } = partitionTags({
      "v0.18.0": "2026-08-09",
      "macos-v1.0": "2026-08-10",
      "macos-v1.1.2": "2026-09-01",
    });
    expect(listed).toEqual({ "v0.18.0": "2026-08-09" });
    expect(native).toEqual(["macos-v1.0", "macos-v1.1.2"]);
    expect(unknown).toEqual([]);
  });

  it("refuses to quietly drop a namespace nobody has ruled on", () => {
    // The first iOS release tag must stop this suite and force the decision,
    // not vanish into a filter.
    expect(partitionTags({ "ios-v1.0": "2026-09-01" }).unknown).toEqual(["ios-v1.0"]);
  });

  it("holds the incident tag apart from both real namespaces", () => {
    // `vmacos-v1.2.0` is the one tag in this repository that publishes nothing.
    // It must not become a row (it would claim a CLI and node build that does
    // not exist) and must not be counted as a native release either.
    const { listed, native, broken, unknown } = partitionTags({ "vmacos-v1.2.0": "2026-08-12" });
    expect(listed).toEqual({});
    expect(native).toEqual([]);
    expect(broken).toEqual(["vmacos-v1.2.0"]);
    expect(unknown).toEqual([]);
  });

  it("still surfaces a mistyped tag that is not the known one", () => {
    // The enumeration is exact on purpose: absorbing `vmacos-*` by pattern
    // would silently bless the next malformed tag the release path emits.
    expect(partitionTags({ "vmacos-v1.3.0": "2026-09-01" }).unknown).toEqual(["vmacos-v1.3.0"]);
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

// What this page says about the two native apps. They are in different states as
// of 2026-08-10 and the page has to carry both: macOS is published as its own
// GitHub Release, iOS is not published anywhere. The old copy said one true
// sentence about both of them, and it went false the moment the first one
// shipped.
//
// The current-release claims are pinned in the two MAINTAINED_LANGS, en and zh —
// the locales whose copy is kept current and where new copy ships. The other
// seven are frozen archives: they stay published and stay correct about what
// they were written for, but their macOS version is not moved release by
// release, so pinning them to the manifest would fail every native release
// rather than catch drift. Only the CURRENT-release claim narrows, though: the
// App Store denial and the iOS-unreleased sentence are facts no macOS release
// moves, so they stay asserted in all nine — for en and zh alongside the pin,
// for the frozen seven in their own test below.
//
// Per locale rather than one alternation, because the assertions are positive:
// a union would be satisfied by any locale's sentence, so nine pages carrying
// the English wording — or eight carrying nothing — would pass.
describe("what /releases says about the native apps", () => {
  /** "…and not a Mac App Store listing." Relayium ships no App Store build. */
  const NOT_APP_STORE = {
    en: /not a Mac App Store listing/,
    zh: /不是 Mac App Store 上架版本/,
    ja: /Mac App Store 版ではありません/,
    ko: /Mac App Store 등록이 아닙니다/,
    de: /kein Mac-App-Store-Eintrag/,
    fr: /non une fiche sur le Mac App Store/,
    ar: /وليس إدراجًا في Mac App Store/,
    es: /no una ficha en la Mac App Store/,
    pt: /não uma listagem na Mac App Store/,
  };

  /** iOS is still an engineering build, and the page has to keep saying so. */
  const IOS_UNRELEASED = {
    en: /iOS app is an engineering build and has not been released publicly/,
    zh: /iOS 应用仍是开发版，尚未公开发布/,
    ja: /iOS アプリは開発ビルドであり、まだ公開されていません/,
    ko: /iOS 앱은 개발 빌드이며 아직 공개 릴리스가 아닙니다/,
    de: /iOS-App ist ein Entwicklungs-Build und wurde nicht öffentlich veröffentlicht/,
    fr: /application iOS reste une version d'ingénierie, non diffusée publiquement/,
    ar: /تطبيق iOS فنسخة تطوير لم تُنشر للعموم/,
    es: /aplicación de iOS es una compilación de ingeniería y no se ha publicado/,
    pt: /app de iOS é um build de engenharia e não foi publicado/,
  };

  it("names the exact macOS release tag in every maintained locale", () => {
    for (const lang of MAINTAINED_LANGS) {
      const bullet = releases.langs[lang].sections[0].bullets[1];
      // The tag is the checkable part: a reader can paste it after
      // /releases/tag/ and land on the artifact this sentence describes.
      expect(bullet, `${lang} does not name the macOS release tag`).toContain(CURRENT_TAG);
      expect(macTags(bullet), `${lang} names a superseded macOS release tag`)
        .toEqual(new Set([CURRENT_TAG]));
      expect(bullet, `${lang} does not rule out the Mac App Store`).toMatch(NOT_APP_STORE[lang]);
      expect(bullet, `${lang} stops saying the iOS app is unreleased`).toMatch(IOS_UNRELEASED[lang]);
    }
  });

  // The frozen seven lose the pin, not the coverage. Two things stay true of an
  // archived translation, and after the narrowing above nothing else in this
  // suite would notice either one disappearing:
  //
  //   * The version-independent claims. "Not a Mac App Store listing" and "iOS
  //     is unreleased" are not facts about 1.2.5 — no macOS release moves them,
  //     so an archive that stopped saying either would be wrong TODAY, not
  //     merely old. These are the seven entries in the tables above that the
  //     maintained loop no longer reads.
  //   * Internal consistency. Frozen means a locale keeps the tag it was
  //     published with; it does not mean half of it may be refreshed. The
  //     bullet's tag and the lead's bare version are one claim written twice, so
  //     they must agree with each other even while they disagree with the
  //     manifest — the drift the pin used to catch and can no longer see here.
  it("keeps the frozen locales archived rather than half-refreshed", () => {
    for (const lang of FROZEN_LANGS) {
      const bullet = releases.langs[lang].sections[0].bullets[1];
      expect(bullet, `${lang} does not rule out the Mac App Store`).toMatch(NOT_APP_STORE[lang]);
      expect(bullet, `${lang} stops saying the iOS app is unreleased`).toMatch(IOS_UNRELEASED[lang]);

      const tags = macTags(bullet);
      expect(tags.size, `${lang} names ${tags.size} macOS release tags, not one`).toBe(1);
      const [tag] = tags;
      expect(macVersions(releases.langs[lang].lead[0]), `${lang} lead and bullet name different macOS releases`)
        .toEqual(new Set([`macOS ${tag.slice("macos-v".length)}`]));
    }
  });

  it("names the current macOS version in every maintained locale's lead", () => {
    // The bullet's tag and the lead's bare version are two claims about one
    // release, written in two different places by two different sentences. Only
    // the bullet was pinned before, so the lead kept saying "macOS 1.0" while
    // the bullet had moved on — the same page contradicting itself.
    for (const lang of MAINTAINED_LANGS) {
      const lead = releases.langs[lang].lead[0];
      expect(lead, `${lang} lead does not name the current macOS version`)
        .toContain(`macOS ${MAC.version}`);
      expect(macVersions(lead), `${lang} lead names a superseded macOS version`)
        .toEqual(new Set([`macOS ${MAC.version}`]));
    }
  });

  it("carries that sentence into the rendered page", () => {
    // The bullet exists in the content module; this is the half that proves the
    // template renders it, in the locale's own page.
    for (const lang of MAINTAINED_LANGS) {
      expect(byLang[lang], lang).toContain(CURRENT_TAG);
      expect(macTags(byLang[lang]), `${lang} page renders a superseded tag`)
        .toEqual(new Set([CURRENT_TAG]));
      expect(macVersions(byLang[lang]), `${lang} page renders a superseded version`)
        .toEqual(new Set([`macOS ${MAC.version}`]));
    }
  });

  // The generator's output and the bytes committed under public/ are two
  // different things, and only the first is checked above. content/releases.mjs
  // can be corrected and `npm run gen:pages` forgotten, which leaves the source
  // truthful and the pages a reader actually fetches still lying — which is the
  // exact state this batch found the site in.
  it("has regenerated every committed maintained release page from that source", async () => {
    for (const lang of MAINTAINED_LANGS) {
      const path = lang === "en" ? "releases/index.html" : `${lang}/releases/index.html`;
      const html = await readFile(resolve(process.cwd(), "public", path), "utf8");
      expect(macTags(html), `public/${path} is stale`).toEqual(new Set([CURRENT_TAG]));
      expect(macVersions(html), `public/${path} is stale`)
        .toEqual(new Set([`macOS ${MAC.version}`]));
    }
  });

  // Both predicates above are set-equality against a value derived from the
  // manifest, so they are only guards if they actually see a superseded tag.
  // Driven directly here with the tag that was really stale — nine locales and
  // nine committed pages sat on `macos-v1.0` through 1.1, 1.1.1, 1.1.2, 1.1.3
  // and 1.2.1 — so a refactor that made either scanner match nothing fails here
  // rather than passing everywhere.
  it("rejects the stale macos-v1.0 claim it was written for", () => {
    const stale =
      "The macOS app is released under its own tag, macos-v1.0: a Developer ID-signed, "
      + "Apple-notarized direct download from GitHub, not a Mac App Store listing.";
    expect(macTags(stale)).toEqual(new Set(["macos-v1.0"]));
    expect(macTags(stale)).not.toEqual(new Set([CURRENT_TAG]));
    expect(macVersions("macOS 1.0 is a signed download from GitHub"))
      .toEqual(new Set(["macOS 1.0"]));
    // And the manifest this suite derives from is a released one, so the
    // assertions above are comparing against a real published tag rather than a
    // null placeholder that would make every set-equality trivially agree.
    expect(MAC.available).toBe(true);
    expect(MAC.version).toMatch(/^[0-9]+(?:\.[0-9]+){1,2}$/);
    expect(CURRENT_TAG).not.toBe("macos-v1.0");
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
    // The static half stays on all nine — the archived /ja/releases/ page and
    // the archived footers that link it are still public, and a footer that
    // calls the page one name while the page calls itself another is the drift
    // this guards. The app half is the maintained pair, because the SPA has two
    // message tables now.
    for (const lang of LANGS) {
      expect(RELEASES_LABELS[lang], lang).toBe(releases.langs[lang].title);
    }
    for (const lang of MAINTAINED_LANGS) {
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
    expect(xml.match(new RegExp(`<lastmod>${releases.updated}</lastmod>`, "g"))).toHaveLength(LANGS.length);
  });

  it("does not claim the yearly changefreq the legal pages use", () => {
    // It gains a row every time a version ships; "yearly" would be wrong about
    // the one page on the site that changes on a schedule.
    const xml = buildSitemap([], { home: false, releases });
    expect(xml).not.toContain("<changefreq>yearly</changefreq>");
    expect(xml.match(/<changefreq>weekly<\/changefreq>/g)).toHaveLength(LANGS.length);
  });
});
