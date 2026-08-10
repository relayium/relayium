import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import apps from "./content/apps.mjs";

// The one canonical manifest, read once and shared by every case below.
//
// This file used to hard-code `available: false` in three places. That made it
// a test of one moment rather than of the rule, and it failed the instant a
// real release was staged — which is the single moment the guard most needed
// to be right. Both states are legitimate, so each case now asserts what is
// true of BOTH and then branches on the manifest for the half that differs.
// Neither branch is allowed to assert nothing: the unavailable branch pins the
// null shape and the honest not-public disclosure, and the available branch
// pins the exact published URL, the per-locale download entry, and the release
// wording — so a manifest flip cannot silently turn a guard into a no-op.
const manifest = JSON.parse(
  await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
);
const MAC_AVAILABLE = manifest.macos.available === true;

/** The only download URL a release of this version is allowed to point at. */
const canonicalUrl = (version) =>
  `https://github.com/relayium/relayium/releases/download/macos-v${version}/Relayium.dmg`;

/** Per-locale "signed / notarized" vocabulary. */
const NOTARY_TERM = {
  en: /notariz|signed/i,
  zh: /公证|签名/,
  ja: /公証|署名/,
  ko: /공증|서명/,
  de: /notarisiert|signiert/i,
  fr: /notaris|signée/i,
  es: /notarizad|firmada/i,
  pt: /notarizad|assinado/i,
  ar: /موثّق|موقّع/,
};

/** Per-locale "not publicly available yet" vocabulary.
 *
 * Per locale, not one union of all nine. A union is fine where the assertion is
 * negative ("this copy says none of these things"), but the pre-release branch
 * asserts it POSITIVELY — and a union there is satisfied by any locale's
 * phrase, so a French page carrying the English disclosure, or nine pages
 * carrying one locale's, would pass. The disclosure has to be in the language
 * the reader is reading. */
const NOT_PUBLIC = {
  en: /not publicly available yet/i,
  zh: /尚未开放公开下载/,
  ja: /まだ一般公開されていません/,
  ko: /아직 공개 배포되지 않았습니다/,
  de: /noch nicht öffentlich verfügbar/i,
  fr: /pas encore disponible publiquement/i,
  ar: /ليست متاحة للعامة بعد/,
  es: /aún no está disponible públicamente/i,
  pt: /ainda não está disponível publicamente/i,
};

/** The same nine, as one alternation, for the negative direction only. */
const ANY_NOT_PUBLIC = new RegExp(
  Object.values(NOT_PUBLIC).map((r) => r.source).join("|"),
  "i",
);

describe("macOS release surface", () => {
  it("keeps the SPA download state tied to the canonical manifest", async () => {
    const [component, app] = await Promise.all([
      readFile(resolve(process.cwd(), "src/lib/AppsPage.svelte"), "utf8"),
      readFile(resolve(process.cwd(), "src/App.svelte"), "utf8"),
    ]);

    expect(component).toContain('import releases from "../../native-releases.json"');
    // AppsPage accepts a test seam, but its production default remains the one
    // canonical build-time manifest. Availability fails closed unless both the
    // release bit and an exact URL are present, then the card moves sections.
    expect(component).toContain("macRelease = releases.macos");
    expect(component).toContain("macRelease.available === true && !!macRelease.downloadUrl");
    expect(component).toMatch(/macAvailable\s*\?\s*macRelease\.downloadUrl!/);
    expect(app.match(/<AppsPage\b[^>]*>/g)).toEqual(["<AppsPage />"]);
    expect(component).toContain("t.appsPage.cards.mac.cta");

    // `available` must be a real boolean. AppsPage fails closed on `=== true`,
    // so a stringified "false" would read as unavailable here while `jq` in the
    // release workflow read it as present — the two halves must agree.
    expect(typeof manifest.macos.available).toBe("boolean");

    if (MAC_AVAILABLE) {
      expect(manifest.macos.version).toMatch(/^[0-9]+(?:\.[0-9]+){1,2}$/);
      expect(Number.isInteger(manifest.macos.build)).toBe(true);
      expect(manifest.macos.build).toBeGreaterThan(0);
      expect(manifest.macos.downloadUrl).toBe(canonicalUrl(manifest.macos.version));
      // …and nothing else. The unavailable branch pins the whole object with
      // `toEqual`; without the same here, the released state would be the one
      // state in which an extra or renamed key goes unnoticed — and this file
      // is the only thing standing between `jq` in the release workflow and
      // `releases.macos` in AppsPage agreeing on what the shape is.
      expect(manifest.macos).toEqual({
        available: true,
        version: manifest.macos.version,
        build: manifest.macos.build,
        downloadUrl: canonicalUrl(manifest.macos.version),
      });
    } else {
      expect(manifest.macos).toEqual({
        available: false,
        version: null,
        build: null,
        downloadUrl: null,
      });
    }
  });

  it("has a localized macOS download CTA in every SPA locale", async () => {
    for (const code of LANGS) {
      const source = await readFile(resolve(process.cwd(), `src/lib/i18n/${code}.ts`), "utf8");
      const macCard = source.match(/mac:\s*\{[\s\S]*?\},\s*(?:\n\s*)?ios:/)?.[0] ?? "";
      expect(macCard, `${code} is missing its macOS card`).toContain("cta:");
      expect(macCard, `${code} still describes the macOS app as in development`)
        .not.toMatch(/in the works|正在开发|開発中|개발 중|in Arbeit|en cours de développement|قيد التطوير|en desarrollo|em desenvolvimento/i);
    }
  });

  // Release trust language — "signed", "notarized" — describes an artifact a
  // reader can actually fetch. Before a release is staged that wording would
  // dress a download that does not exist; once one is staged, its absence would
  // understate what Apple actually did. So the rendered copy is required to
  // match the manifest in BOTH directions, not merely to stay quiet in one.
  it("matches macOS release trust language to what the manifest actually offers", async () => {
    for (const code of LANGS) {
      const doc = apps.langs[code];
      const bullet = doc.how.steps[2];
      const card = doc.why.items[2].desc;
      if (MAC_AVAILABLE) {
        expect(bullet, `${code} macOS bullet does not say the release is signed/notarized`)
          .toMatch(NOTARY_TERM[code]);
        expect(card, `${code} macOS card does not say the release is signed/notarized`)
          .toMatch(NOTARY_TERM[code]);
      } else {
        expect(bullet, `${code} macOS bullet claims release trust it cannot show`)
          .not.toMatch(NOTARY_TERM[code]);
        expect(card, `${code} macOS card claims release trust it cannot show`)
          .not.toMatch(NOTARY_TERM[code]);
      }
    }

    // Both branches must exist in the source in either state, so this guard can
    // never be satisfied by deleting whichever half is currently unrendered.
    //
    // Read as PAIRS. Matching the available half alone — which is what this
    // check used to do while claiming to do this — leaves the pre-release half
    // unguarded in exactly the state where nothing renders it, so a release
    // could delete the honest "not publicly available yet" copy and stay green
    // until the day someone had to unpublish.
    const source = await readFile(resolve(process.cwd(), "scripts/pages/content/apps.mjs"), "utf8");
    const branches = [...source.matchAll(/MAC_AVAILABLE\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g)];
    expect(branches.length, "expected one branch pair per locale, in the bullet and the card").toBe(
      LANGS.length * 2,
    );
    const anyNotary = /notariz|公证|签名|公証|署名|공증|서명|notarisiert|signiert|notaris|signée|notarizad|firmada|assinado|موثّق|موقّع/i;
    for (const [i, [, available, pending]] of branches.entries()) {
      expect(available, `available branch ${i} lost its signing/notarization wording`)
        .toMatch(anyNotary);
      expect(pending, `pre-release branch ${i} lost its not-public disclosure`)
        .toMatch(ANY_NOT_PUBLIC);
    }
  });

  it("keeps localized crawler copy honest about what can be downloaded", async () => {
    const source = await readFile(resolve(process.cwd(), "scripts/pages/content/apps.mjs"), "utf8");
    expect(source).not.toMatch(
      /macOS app — a real native app, coming soon|macOS 应用——真正的原生应用，即将推出|macOS アプリ — 本物のネイティブアプリ、近日公開|macOS 앱 — 진짜 네이티브 앱, 출시 예정|macOS-App — eine echte native App, in Kürze|Appli macOS — une vraie appli native, bientôt disponible|تطبيق macOS — تطبيق أصلي حقيقي، قريبًا|App de macOS — una auténtica app nativa, próximamente|App para macOS — um verdadeiro app nativo, em breve/,
    );
    for (const code of LANGS) {
      const doc = apps.langs[code];
      const macCopy = `${doc.how.steps[2]} ${doc.why.items[2].desc}`;
      if (MAC_AVAILABLE) {
        // A staged release must actually reach the crawler page, at the exact
        // published URL — a localized page that still offered nothing would
        // contradict the manifest the SPA is rendering from.
        expect(doc.nativeDownload, `${code} hides the published download`).toBeDefined();
        expect(doc.nativeDownload.href, `${code} points at the wrong artifact`).toBe(
          manifest.macos.downloadUrl,
        );
        expect(doc.nativeDownload.label?.trim(), `${code} has no download label`).toBeTruthy();
        // Negative, so the union is the strict reading: no locale may keep any
        // locale's not-public disclosure once the download is on the page.
        expect(macCopy, `${code} still says the released app is not public`)
          .not.toMatch(ANY_NOT_PUBLIC);
      } else {
        expect(doc.nativeDownload, `${code} exposes a download before release`).toBeUndefined();
        expect(macCopy, `${code} does not disclose that the candidate is not public`).toMatch(
          NOT_PUBLIC[code],
        );
      }
    }
  });
});
