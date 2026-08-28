import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FROZEN_LANGS, OG_IMAGE_META } from "./shared.mjs";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const indexHtml = read("index.html");
const manifest = JSON.parse(read("public/site.webmanifest"));

function structuredData() {
  const match = indexHtml.match(
    /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match[1]);
}

describe("homepage product facts", () => {
  it("states the account boundary for file and live text pairing codes", () => {
    const json = structuredData();
    const app = json["@graph"].find((entry) => entry["@id"] === "https://relayium.com/#app");
    const faq = json["@graph"]
      .find((entry) => entry["@type"] === "FAQPage")
      .mainEntity.find((entry) => entry.name === "Is Relayium free?")
      .acceptedAnswer.text;
    const noscript = indexHtml.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];

    expect(noscript).toBeTruthy();
    for (const [surface, text] of [
      ["featureList", app.featureList.join(" ")],
      ["faq", faq],
      ["noscript", noscript],
    ]) {
      expect(text, `${surface}: same-network needs no account`)
        .toMatch(/same-network file and live text transfers[^.]*need no account/i);
      expect(text, `${surface}: a cross-network code needs sign-in`)
        .toMatch(/cross-network (?:file or text )?pairing code[^.]*requires sign-in/i);
      expect(text, `${surface}: joining never does`)
        .toMatch(/joining with a code (?:does not|never needs one)/i);
    }
    // …and the price question is answered with both halves, because the answer
    // to "is Relayium free?" differs for the software and for the hosted
    // service. It opened with a bare "Yes." until 2026-08-28.
    expect(faq).not.toMatch(/^\s*Yes\b/);
    expect(faq).toMatch(/free and open source \(AGPL-3\.0\)/);
    expect(faq).toMatch(/free tier rather than unlimited free hosting/i);
    expect(faq).toMatch(/monthly traffic allowance/i);
    expect(indexHtml).not.toContain(
      "Realtime transfers over the LAN or a pairing code need no account",
    );
    expect(indexHtml).not.toContain(
      "Realtime transfers (LAN or pairing code) need no account",
    );
  });

  it("positions the installable app as file plus live ephemeral text transfer", () => {
    expect(manifest.name).toContain("file and text transfer");
    expect(manifest.description).toContain("live ephemeral text");
    expect(manifest.description).toContain("cross-network browser pairing uses a ciphertext-only relay");
    expect(manifest.description).toContain(
      "Text is online-only, and Relayium servers do not store message bodies",
    );
    expect(manifest.description).not.toContain("never touch the server");
  });

  it("describes the shared social image as file and text transfer", () => {
    expect(OG_IMAGE_META).toContain("end-to-end encrypted file and text transfer");
  });

  // The head's hreflang cluster and og:locale:alternate set were narrowed to
  // English and Simplified Chinese in the 2026-08-14 freeze, and every
  // generated maintained page dropped its nine-way language bar in the same
  // batch. The no-JS body was missed: it went on ending with "Also available
  // in:" followed by Chinese and all seven archived locales until 2026-08-28,
  // which made this the last maintained page on the site presenting an archived
  // translation as a language the product currently offers.
  it("does not present a frozen locale as a current language in the no-JS body", () => {
    const noscript = indexHtml.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];
    expect(noscript, "index.html must keep a no-JS body").toBeTruthy();
    const paragraphs = [...noscript.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    const linksTo = (lang) => new RegExp(`href="/${lang}/`);

    // (1) "Also available in" is ordinary navigation, so everything it lists
    // reads as currently maintained. Chinese is the only other one there is.
    const offered = paragraphs.filter((p) => /Also available in/i.test(p));
    expect(offered, "exactly one 'Also available in' line is expected").toHaveLength(1);
    expect(offered[0], "Chinese is the maintained second language").toMatch(linksTo("zh"));
    for (const lang of FROZEN_LANGS)
      expect(offered[0], `/${lang}/ is an archived translation, not a current language`)
        .not.toMatch(linksTo(lang));

    // (2) Elsewhere in the no-JS body a frozen landing may be linked only from
    // a sentence that says it is an archive and may be out of date — the one
    // shape the supported-language policy allows. So the rule is not "never
    // href a frozen locale", it is "never href one from unlabelled prose":
    // drop the labelled paragraphs, and nothing may be left.
    const ARCHIVE_LABEL = /Archived translations?\s*\(\s*may differ from current behaviou?r\s*\)/i;
    const unlabelled = paragraphs
      .filter((p) => !ARCHIVE_LABEL.test(p))
      .join("\n")
      .concat("\n", noscript.replace(/<p>[\s\S]*?<\/p>/g, ""));
    for (const lang of FROZEN_LANGS)
      expect(unlabelled, `/${lang}/ is linked without an archived-translation label`)
        .not.toMatch(linksTo(lang));

    // (3) The defect text, verbatim, so the guard is known to fail on the thing
    // it was written for rather than only on a paraphrase of it.
    expect(indexHtml).not.toContain(
      '<p>Also available in: <a href="/zh/">中文</a> · <a href="/ja/">日本語</a>',
    );
  });
});
