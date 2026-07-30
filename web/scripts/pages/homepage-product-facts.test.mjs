import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OG_IMAGE_META } from "./shared.mjs";

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
    for (const text of [app.featureList.join(" "), faq, noscript]) {
      expect(text).toContain("Same-network file and live text transfers need no account");
      expect(text).toContain("cross-network pairing code for files or text requires sign-in");
      expect(text).toContain("joining with a code does not");
    }
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
});
