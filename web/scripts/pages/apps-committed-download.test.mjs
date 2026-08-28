// web/scripts/pages/apps-committed-download.test.mjs — the COMMITTED bytes of
// every localized /apps page, against the one canonical manifest.
//
// `macos-release-surface.test.mjs` already holds the SOURCE to the manifest:
// `content/apps.mjs` renders `nativeDownload.href` from `native-releases.json`,
// and the SPA reads the same file. Neither of those is what a reader without
// JavaScript, a crawler or an answer engine actually fetches. That is
// `web/public/<lang>/apps/index.html`, a generated artifact that is COMMITTED —
// and nothing was reading it.
//
// The gap was not theoretical. At `9735f444` the manifest said 1.3.8, the
// deployed site said 1.3.8, and the seven committed archived pages said 1.3.2,
// because the macOS publication job regenerated those seven and then restored
// them to whatever tag main already carried. The source guard passed the whole
// time: it reads the generator's input, and the defect was applied to the
// generator's output.
//
// So this file reads the output. It is deliberately dumb about prose — an
// archived translation stays frozen and this test asserts nothing about a single
// word of it — and exact about the one operational pointer the manifest owns.
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS, FROZEN_LANGS } from "./shared.mjs";

const publicDir = resolve(process.cwd(), "public");

const manifest = JSON.parse(
  await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
);
const MAC_AVAILABLE = manifest.macos.available === true;

/**
 * The localized twins, which is every language except English.
 *
 * English `/apps` has no static twin at all: `apps` is in `MODE_SLUGS`, so
 * `buildModePages` emits the localized pages and leaves the English route to
 * the SPA (`src/lib/AppsPage.svelte`). Asserting that absence is half the point
 * — a checker that silently skipped a missing file would also silently skip
 * seven of them.
 */
const LOCALIZED = LANGS.filter((lang) => lang !== "en");

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Every macOS release tag named anywhere in the document. */
const macTags = (html) =>
  new Set([...html.matchAll(/macos-v[0-9]+(?:\.[0-9]+){1,2}/g)].map((m) => m[0]));

/**
 * The whole verdict for one page, as a function, so the negative case below can
 * drive the SAME assertions over mutated bytes.
 *
 * A guard that only ever sees passing input proves nothing about what it would
 * reject. This one is shown a page with one stale href and is required to fail.
 */
function expectPageMatchesManifest(lang, html) {
  const tags = macTags(html);
  if (MAC_AVAILABLE) {
    // Exact set equality, not containment. A page that gained the new tag while
    // keeping the old one offers a reader two downloads and no way to tell which
    // is current — and containment is what would have passed at `9735f444` had
    // the restore been partial rather than total.
    expect(tags, `${lang} /apps names a macOS release other than the manifest's`)
      .toEqual(new Set([`macos-v${manifest.macos.version}`]));
    // The tag being right is not the URL being right. Assert the exact href the
    // manifest publishes, attribute quotes included, so a correct tag on a
    // wrong asset path still fails.
    expect(html, `${lang} /apps does not link the canonical download`)
      .toContain(`href="${manifest.macos.downloadUrl}"`);
  } else {
    // The pre-release direction, asserted rather than skipped. Without it this
    // whole file becomes a no-op the moment a release is unpublished, which is
    // the state in which a stale committed download button is most harmful.
    expect(tags, `${lang} /apps offers a download the manifest does not publish`)
      .toEqual(new Set());
    expect(html, `${lang} /apps links a release asset while none is published`)
      .not.toContain("/releases/download/");
  }
}

describe("the committed /apps pages carry the manifest's macOS download", () => {
  it("generates a localized twin for every language except English", async () => {
    for (const lang of LOCALIZED) {
      expect(
        await exists(resolve(publicDir, lang, "apps/index.html")),
        `${lang} has no committed /apps twin`,
      ).toBe(true);
    }
    // English is SPA-only. If this ever starts existing it needs its own case
    // above, not a silent pass.
    expect(
      await exists(resolve(publicDir, "apps/index.html")),
      "English /apps grew a static twin that nothing here checks",
    ).toBe(false);
    // What this file claims to cover: Simplified Chinese and all seven archived
    // locales. Stated as membership, not as a partition — `LANGS` splitting
    // cleanly into maintained and frozen is `maintained-frozen-split.test.mjs`'s
    // rule, and restating it here would be a second copy of it.
    for (const lang of ["zh", ...FROZEN_LANGS]) {
      expect(LOCALIZED, `${lang} /apps is not covered by this guard`).toContain(lang);
    }
  });

  it.each(LOCALIZED)("%s links exactly the manifest's release and no other", async (lang) => {
    const html = await readFile(resolve(publicDir, lang, "apps/index.html"), "utf8");
    expectPageMatchesManifest(lang, html);
  });

  it("fails on a single archived page left on a superseded tag", async () => {
    // The exact defect, driven through the SAME checker the cases above use, so
    // this is evidence about the guard rather than a second guard.
    //
    // The document is NORMALIZED onto the manifest first and staled second.
    // Mutating the on-disk bytes directly would make this case depend on those
    // bytes already being current: run it against the tree the defect actually
    // produced and the "mutation" is a no-op, so the case that exists to prove
    // the guard bites would report that it does not.
    const lang = FROZEN_LANGS[0];
    const html = await readFile(resolve(publicDir, lang, "apps/index.html"), "utf8");
    const canonical = html.replace(
      /macos-v[0-9]+(?:\.[0-9]+){1,2}/g,
      `macos-v${manifest.macos.version}`,
    );

    if (MAC_AVAILABLE) {
      const stale = canonical.replaceAll(`macos-v${manifest.macos.version}`, "macos-v0.0.1");
      expect(stale, `${lang} /apps names no release tag to stale`).not.toBe(canonical);
      expect(() => expectPageMatchesManifest(lang, stale)).toThrow();
    }

    // A page that gained a SECOND download beside the right one, which is what a
    // partial restore leaves behind. Wrong in both manifest states — two
    // downloads when one is published, one download when none is — so this half
    // of the case cannot go quiet the way a released-only assertion can.
    const doubled = canonical.replace(
      "</body>",
      '<a href="https://github.com/relayium/relayium/releases/download/macos-v0.0.1/Relayium.dmg">x</a></body>',
    );
    expect(doubled, `${lang} /apps has no </body> to append to`).not.toBe(canonical);
    expect(() => expectPageMatchesManifest(lang, doubled)).toThrow();
  });
});
