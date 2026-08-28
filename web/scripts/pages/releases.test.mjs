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

/**
 * The published Mac App Store release, read from its OWN canonical record.
 *
 * The two channels are independently versioned and move on independent
 * schedules, so they cannot share `native-releases.json` — that manifest is the
 * Developer ID download, and the /apps CTA, the Device Inbox badge and Sparkle
 * all resolve an artifact URL from it. `mac-app-store-release.json` carries the
 * other channel and nothing else.
 *
 * Read rather than written down again for the same reason `MAC` is. The App
 * Store literal sat at 1.3.1 in this file, in both READMEs and in all nine
 * locales while the listing was already at 1.3.8 — one fact copied into every
 * one of those places, each copy of which had to be remembered separately, and
 * none of which failed when the fact moved.
 */
const APP_STORE = JSON.parse(
  await readFile(resolve(process.cwd(), "mac-app-store-release.json"), "utf8"),
);

/** The App Store version as a regex fragment, so the tables below carry the
 *  wording they are testing and not a second copy of the version. */
const appStoreVersion = APP_STORE.version.replace(/\./g, "\\.");

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
// The DIRECT-DOWNLOAD claims are pinned in the two MAINTAINED_LANGS, en and zh —
// the locales whose copy is kept current and where new copy ships. The other
// seven are frozen archives: they stay published and stay correct about what
// they were written for, but their macOS version is not moved release by
// release, so pinning them to the manifest would fail every native release
// rather than catch drift.
//
// The App Store version is the exception, and it is pinned in all nine. The
// freeze is over PROSE and over the direct tag a locale was published with; it
// was never over an operational fact about the other channel. Both READMEs, this
// file and all nine locales said 1.3.1 while the listing was at 1.3.8, which is
// not an archive being old — it is nine live pages being wrong about a product a
// reader can open right now. `mac-app-store-release.json` is where that fact
// lives, `content/releases.mjs` interpolates it, and the table below reads it.
// The iOS sentence is now asserted in the FROZEN seven only. It left the
// maintained pair on 2026-08-28: iOS development is paused and the app cannot be
// obtained, so a release page that still listed it was promising a product by
// placement. The archives keep it because an archive is frozen prose — the
// sentence they were published with is still true of what they describe, and
// silently editing seven pages that carry an archived-translation notice would
// make the notice a lie. So the split is deliberate and asserted in both
// directions: the seven must still say it, and the two must not.
//
// Per locale rather than one alternation, because the assertions are positive:
// a union would be satisfied by any locale's sentence, so nine pages carrying
// the English wording — or eight carrying nothing — would pass.
describe("what /releases says about the native apps", () => {
  /**
   * The independently versioned public Mac App Store channel, pinned to
   * `mac-app-store-release.json` in ALL NINE locales.
   *
   * This is the one claim on the page that the freeze does not cover. An
   * archived translation freezes PROSE — the wording, and the direct-download
   * tag it was published with. It does not freeze an operational fact about a
   * DIFFERENT channel that is still live: an archive saying the App Store is at
   * 1.3.1 is not old, it is wrong today, and it is wrong in the direction that
   * sends a reader to look for a version the listing no longer offers.
   *
   * So the version is interpolated from the canonical record and the wording is
   * not, which is exactly the split the freeze draws.
   */
  const APP_STORE_CURRENT = {
    en: new RegExp(`Mac App Store release is currently ${appStoreVersion}`),
    zh: new RegExp(`Mac App Store 版本当前为 ${appStoreVersion}`),
    ja: new RegExp(`Mac App Store 版は現在 ${appStoreVersion}`),
    ko: new RegExp(`Mac App Store 릴리스는 현재 ${appStoreVersion}`),
    de: new RegExp(`Mac-App-Store-Version ist derzeit ${appStoreVersion}`),
    fr: new RegExp(`version Mac App Store.+actuellement la ${appStoreVersion}`),
    ar: new RegExp(`إصدار Mac App Store.+حاليًا ${appStoreVersion}`),
    es: new RegExp(`versión de la Mac App Store.+actualmente la ${appStoreVersion}`),
    pt: new RegExp(`versão da Mac App Store.+atualmente a ${appStoreVersion}`),
  };

  /** The archived seven still carry the iOS sentence they were published with.
   *  `en` and `zh` are deliberately absent: the maintained pair no longer names
   *  the iOS app at all, and `it("names no unobtainable product…")` below is
   *  the assertion that keeps it that way. */
  const IOS_UNRELEASED = {
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
      expect(bullet, `${lang} does not name the current Mac App Store release`).toMatch(APP_STORE_CURRENT[lang]);
    }
  });

  it("names no unobtainable product in the maintained locales", () => {
    // The positive-by-absence half of the 2026-08-28 change, checked over the
    // whole maintained document rather than one bullet: a claim moved from the
    // bullet into the lead is the same claim. `apps/` has no Android or Windows
    // target at all and iOS development is paused with no public listing, so
    // /releases — the page a reader opens to find out what they can download —
    // must not list any of the three.
    const NATIVE_APP = /\b(?:iOS|iPhone|iPad|Android|Windows)\s+(?:native\s+|desktop\s+)*app\b|(?:iOS|iPhone|iPad|Android|Windows)\s*(?:桌面)?(?:原生)?应用/i;
    for (const lang of MAINTAINED_LANGS) {
      const doc = releases.langs[lang];
      const copy = [
        ...doc.lead,
        ...doc.sections.flatMap((s) => [...(s.body ?? []), ...(s.bullets ?? [])]),
      ];
      expect(copy.length, `${lang} has no copy to check`).toBeGreaterThan(5);
      for (const line of copy) {
        expect(line, `${lang} /releases names a product a reader cannot get`).not.toMatch(NATIVE_APP);
      }
    }
  });

  // The frozen seven lose the DIRECT-DOWNLOAD pin, not the coverage. Three
  // things stay true of an archived translation, and after the narrowing above
  // nothing else in this suite would notice any of them disappearing:
  //
  //   * The App Store version is still pinned, to `mac-app-store-release.json`
  //     and not to the direct manifest. It is an operational fact about a
  //     channel that keeps moving under the archive, so an archive naming a
  //     superseded App Store version is wrong TODAY rather than merely old.
  //     This is what the seven pages were, for the whole 1.3.1-to-1.3.8 window.
  //   * "iOS is unreleased" is not a fact about 1.2.5 either — no macOS release
  //     moves it — so an archive that stopped saying it would be wrong today.
  //     The maintained pair dropped the sentence on 2026-08-28 (see above); the
  //     archives keep it, because editing frozen prose is what "frozen" rules
  //     out and because the sentence remains true of the state they describe.
  //   * Internal consistency of the frozen half. Frozen means a locale keeps the
  //     direct tag it was published with; it does not mean half of it may be
  //     refreshed. The bullet's tag and the lead's bare version are one claim
  //     written twice, so they must agree with each other even while they
  //     disagree with the manifest — the drift the pin used to catch and can no
  //     longer see here.
  it("keeps the frozen locales archived rather than half-refreshed", () => {
    for (const lang of FROZEN_LANGS) {
      const bullet = releases.langs[lang].sections[0].bullets[1];
      expect(bullet, `${lang} does not name the current Mac App Store release`).toMatch(APP_STORE_CURRENT[lang]);
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
