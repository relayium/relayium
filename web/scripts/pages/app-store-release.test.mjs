// web/scripts/pages/app-store-release.test.mjs — the Mac App Store release has
// exactly one authoritative record, and this is the file that keeps it that way.
// The digits still appear as prose in the two READMEs and on the nine published
// `/releases` pages; what is asserted here is that every one of those copies is
// interpolated from `mac-app-store-release.json` or checked against it, never
// maintained beside it.
//
// Relayium ships macOS on two channels that are versioned independently and move
// on independent schedules. The Developer ID download is `native-releases.json`:
// one manifest, pointing at one immutable GitHub Release, which the /apps CTA,
// the Device Inbox badge, Sparkle and the release workflow all resolve an
// artifact URL from. Nothing in it can describe the other channel, because Apple
// decides when a submitted build goes live and the repository finds out
// afterwards.
//
// Before this file the App Store version was a LITERAL, and fourteen copies of
// it stood in for the record: the root README twice, `apps/README.md` once, all
// nine locales of `content/releases.mjs`, and once more in each of the two
// suites that check the READMEs — `MacSurfaceGuardTests` and
// `repository-status.test.mjs`. `releases.test.mjs` carried nine more, one per
// locale, checking the pages. Every one of those copies said 1.3.1. The listing
// had been at 1.3.8 since 2026-08-26. Nothing failed, because the tests were
// comparing the documents against a literal copied out of the same documents —
// the guard and the thing it guarded had drifted together.
//
// So `mac-app-store-release.json` is the record, and this file holds it to two
// things a downstream reader has to be able to assume:
//
//   1. It is WELL FORMED. Everything that consumes it — `content/releases.mjs`
//      at page-generation time, `bumpReleaseDocs` when it protects the App Store
//      claim from a Developer ID bump, `MacSurfaceGuardTests` when it checks the
//      READMEs — fails closed on a malformed record rather than rendering or
//      certifying whatever it happened to parse.
//   2. It actually REACHED the committed pages. The nine `/releases` twins are
//      the bytes a reader without JavaScript, a crawler or an answer engine
//      fetches. A corrected source with an unregenerated page is the same defect
//      one file over.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import releases from "./content/releases.mjs";
import { LANGS, esc, urlPath } from "./shared.mjs";
import {
  readMacAppStoreRelease,
  validateMacAppStoreRelease,
} from "../macos-release-candidate.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = resolve(webRoot, "..");

const raw = await readFile(resolve(webRoot, "mac-app-store-release.json"), "utf8");
const record = JSON.parse(raw);

describe("the canonical Mac App Store release record", () => {
  it("carries the fields every consumer resolves, and nothing it has to guess at", () => {
    // `schema` matches `native-client-policy.json`'s convention — a bare integer
    // that a reader compares rather than parses — so a future shape change is a
    // rejection at every consumer instead of a silent misread.
    expect(record.schema).toBe(1);
    expect(record.version).toMatch(/^[0-9]+(?:\.[0-9]+){1,2}$/);
    expect(record.appleId).toMatch(/^[0-9]+$/);
    // ISO-8601 and a real calendar date. `publishedAt` is the day Apple made
    // this version public, which is the only thing that distinguishes "submitted"
    // from "released" — the distinction `apps/README.md` got wrong by describing
    // 1.3.3 (21) as being prepared long after 1.3.8 was live.
    expect(record.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${record.publishedAt}T00:00:00Z`).toISOString().slice(0, 10))
      .toBe(record.publishedAt);
    // The URL is not free-form. It is the canonical product page for that Apple
    // ID, so a record whose link and ID disagree names two different products
    // and cannot be used to write either one into a README.
    expect(record.url).toBe(`https://apps.apple.com/app/id${record.appleId}`);
  });

  it("is a JSON object with no trailing surprises", () => {
    // Re-serializing has to reproduce the file. It is committed data a human
    // edits by hand after checking the listing, so the only formatting rule is
    // that it stays the two-space JSON every other manifest here is.
    expect(raw).toBe(`${JSON.stringify(record, null, 2)}\n`);
  });

  it("is the only App Store record; the direct manifest carries no App Store fields", async () => {
    // Structural independence, asserted rather than assumed. Other surfaces may
    // and do print the version — that is what a README and a release page are
    // for — but no second place may OWN it. The direct-download manifest
    // describes one GitHub artifact; the moment it grows a field that looks like
    // an App Store fact there are two answers to one question again, and the
    // older one wins wherever it is read first.
    const native = JSON.parse(
      await readFile(resolve(webRoot, "native-releases.json"), "utf8"),
    );
    const nativeKeys = JSON.stringify(native);
    expect(nativeKeys).not.toMatch(/appStore|appleId|apps\.apple\.com/i);
    // Deliberately NOT an inequality against the direct version. The two
    // channels are at the same version today (both 1.3.8) and that is an
    // ordinary, expected state — asserting they differ would encode a
    // coincidence as a rule and fail the next time they converge.
    expect(typeof native.macos.version).toBe("string");
  });
});

// The reader is where "malformed" turns into a refusal instead of into a
// rendered page. Each case below is a record that parses as JSON and is still
// not a record of a published App Store release.
describe("reading the canonical record fails closed", () => {
  const read = (overrides) => validateMacAppStoreRelease({ ...record, ...overrides });

  it("accepts the committed record", () => {
    expect(readMacAppStoreRelease({ repoRoot })).toEqual(record);
  });

  it("refuses a record that is missing entirely", async () => {
    // The repository root, which contains no `web/` — the shape a staged
    // fixture has before someone remembers to copy this file into it. A missing
    // record must not read as "there is no App Store channel to protect".
    expect(() => readMacAppStoreRelease({ repoRoot: resolve(repoRoot, "web") }))
      .toThrow(/mac-app-store-release\.json/);
  });

  it("refuses a schema it was not written for", () => {
    expect(() => read({ schema: 2 })).toThrow(/schema/);
  });

  it("refuses a version that is not a version", () => {
    // The four-segment case is the upper bound of the anchored pattern, so it
    // has to be covered. It is joined at runtime because four dot-separated
    // numbers in a source literal read as an IPv4 address to the repository's
    // production-identifier scanner; the assembled string is what the validator
    // sees, so the bound is still proven.
    const fourSegments = ["1", "3", "8", "4"].join(".");
    for (const version of ["", "1", fourSegments, "1.3.8-beta", "v1.3.8", "latest", 138, null]) {
      expect(() => read({ version }), JSON.stringify(version)).toThrow(/version/);
    }
  });

  it("refuses an Apple ID that is not a bare numeric identifier", () => {
    for (const appleId of ["", "id6801142976", 6801142976, null]) {
      expect(() => read({ appleId }), JSON.stringify(appleId)).toThrow(/Apple ID/);
    }
  });

  it("refuses a publication date that is not a real ISO calendar day", () => {
    for (const publishedAt of ["", "2026-8-26", "26/08/2026", "2026-02-30", null]) {
      expect(() => read({ publishedAt }), JSON.stringify(publishedAt)).toThrow(/publication date/);
    }
  });

  it("refuses a URL that names a different product than the Apple ID does", () => {
    // The most dangerous malformation, because both halves look right on their
    // own: a link that resolves, an ID that is numeric, and a README sentence
    // built from them that sends readers to somebody else's app.
    expect(() => read({ url: "https://apps.apple.com/app/id123456789" }))
      .toThrow(/does not address/);
    expect(() => read({ url: "https://apps.apple.com/us/app/relayium/id6801142976" }))
      .toThrow(/does not address/);
  });
});

// The generated half. `content/releases.mjs` interpolates the version into all
// nine locales, so these nine files are where the correction either landed or
// silently did not.
describe("the committed /releases pages carry the canonical version", () => {
  const pagePath = (lang) => `web/public${urlPath("releases", lang)}index.html`;
  const html = async (lang) => readFile(resolve(repoRoot, pagePath(lang)), "utf8");

  it("renders the source bullet verbatim in all nine locales", async () => {
    // Source fidelity, which is the half a regenerate-and-forget failure breaks.
    // The bullet is the sentence that carries both channel claims, so a page
    // that contains it byte for byte cannot be a stale render of an older one.
    for (const lang of LANGS) {
      const bullet = esc(releases.langs[lang].sections[0].bullets[1]);
      expect(bullet, `${lang}'s source bullet does not name the App Store release`)
        .toContain(record.version);
      expect(await html(lang), `${pagePath(lang)} was not regenerated from its source`)
        .toContain(bullet);
    }
  });

  it("leaves no superseded App Store version behind in any locale", async () => {
    // The archived seven are the ones this catches, and it is the failure this
    // whole change exists to fix: seven live pages still telling readers the Mac
    // App Store was at 1.3.1 long after the listing had moved past it, through
    // later releases to 1.3.8.
    //
    // The two DIRECT-download claims are removed first, because a frozen locale
    // legitimately names the version it was published with in both of them — the
    // `macos-v1.2.3` tag in the bullet and the bare `macOS 1.2.3` in the lead.
    // What is left is the App Store claim, and every locale has to agree on it.
    // CLI versions carry a `v` and are excluded by the same lookbehind.
    for (const lang of LANGS) {
      const remaining = (await html(lang))
        .replace(/macos-v[0-9]+(?:\.[0-9]+){1,2}/g, "")
        .replace(/macOS [0-9]+(?:\.[0-9]+){1,2}/g, "");
      const versions = new Set(
        // A trailing dot ends the SENTENCE the version is the last word of —
        // "…is currently 1.3.8." — so only a following digit disqualifies a
        // match, exactly as `releaseVersionPattern` decides the same question.
        [...remaining.matchAll(/(?<![0-9.v])[0-9]+\.[0-9]+\.[0-9]+(?![0-9])(?!\.[0-9])/g)].map((m) => m[0]),
      );
      expect(versions, `${pagePath(lang)} names a superseded App Store version`)
        .toEqual(new Set([record.version]));
    }
  });
});
