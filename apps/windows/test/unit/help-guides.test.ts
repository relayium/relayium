// The guide links, checked against what the site actually publishes.
//
// A link in help is a promise, and the way it breaks is silent: a slug is
// renamed on the site, or a guide is written in English and never translated,
// and the app goes on offering a 404 to whoever was already confused enough to
// open the help. Nothing in a build catches that, because the address is a
// string and the page is in another repository directory.
//
// So these tests read `web/public` and `web/src` rather than a transcription of
// them. The macOS equivalent holds a hand-copied `publishedGuides` set, which
// can only ever tell the truth until the site changes; a set copied from the
// thing it is meant to verify verifies nothing about the thing.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HELP_GUIDES,
  guideUrl,
  isGuideLanguage,
  isHelpSurface,
  resolveGuideRequest,
  type HelpSurface,
} from "../../src/shared/help-guides.js";
import { PRODUCTION_SITE_ORIGIN } from "../../src/shared/origin-constants.js";

const SURFACES: readonly HelpSurface[] = ["lan", "pair", "stored", "inbox", "account"];
const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

describe("which screens promise a document", () => {
  it("decides for every screen", () => {
    expect(Object.keys(HELP_GUIDES).sort()).toEqual([...SURFACES].sort());
  });

  // Asserted as an absence, deliberately. Plans, devices and stored files are
  // account state rather than a workflow with a document behind it, and the one
  // page that could be linked is the web account page this client does not send
  // people to. If that ever gains a guide this test is the place to say so.
  it("promises nothing on the screen that has nothing to read", () => {
    expect(HELP_GUIDES.account).toBeNull();
    expect(guideUrl("account", "en")).toBeNull();
    expect(guideUrl("account", "zh")).toBeNull();
  });

  it("promises one on each of the other four", () => {
    for (const surface of SURFACES.filter((s) => s !== "account")) {
      expect(HELP_GUIDES[surface], surface).not.toBeNull();
    }
  });

  it("sends no two screens to the same document", () => {
    const seen = new Set<string>();
    for (const surface of SURFACES) {
      const url = guideUrl(surface, "en");
      if (url === null) continue;
      expect(seen.has(url), `${surface} -> ${url} reused`).toBe(false);
      seen.add(url);
    }
    expect(seen.size).toBe(4);
  });
});

describe("the address each link opens", () => {
  it("puts English at the root and Chinese under its own prefix", () => {
    expect(guideUrl("lan", "en")).toBe(
      "https://relayium.com/guides/what-is-peer-to-peer-file-transfer",
    );
    expect(guideUrl("lan", "zh")).toBe(
      "https://relayium.com/zh/guides/what-is-peer-to-peer-file-transfer",
    );
  });

  // The site publishes this one in English only. Generating `/zh/device-inbox`
  // would be a 404 shipped to every Chinese reader, so the language is ignored
  // by construction rather than by a branch somebody could remove.
  it("does not invent a translation of an English-only page", () => {
    expect(guideUrl("inbox", "en")).toBe("https://relayium.com/device-inbox");
    expect(guideUrl("inbox", "zh")).toBe("https://relayium.com/device-inbox");
  });

  // Documentation is published by the site, not by whichever server this build
  // dials. An engineering build points its API at loopback, and a guide URL
  // composed on that origin would open a page that never existed there.
  it("is on the site's origin, which is not a build-varying value", () => {
    for (const surface of SURFACES) {
      const url = guideUrl(surface, "en");
      if (url === null) continue;
      expect(new URL(url).origin, surface).toBe(PRODUCTION_SITE_ORIGIN);
    }
    expect(guideUrl("lan", "en", "http://127.0.0.1:18080")).toBe(
      "http://127.0.0.1:18080/guides/what-is-peer-to-peer-file-transfer",
    );
  });
});

// ---------------------------------------------------------------------------
// Against the site itself
// ---------------------------------------------------------------------------

describe("every promised page exists where the link points", () => {
  it("publishes each localized guide in BOTH maintained languages", () => {
    for (const surface of SURFACES) {
      const guide = HELP_GUIDES[surface];
      if (guide === null || guide.kind !== "localized") continue;
      for (const language of ["en", "zh"] as const) {
        const url = new URL(guideUrl(surface, language)!);
        // The path the site serves, resolved to the file it serves it from.
        const onDisk = repo(`web/public${url.pathname}/index.html`);
        expect(existsSync(onDisk), `${surface}/${language} -> ${url.pathname}`).toBe(true);
      }
    }
  });

  // The Device Inbox page is not a static directory — it is a route of the web
  // app, so `existsSync` would be the wrong question and would fail for a page
  // that is perfectly real. The router is where its existence is decided.
  it("routes the English-only page in the web app", () => {
    const router = readFileSync(repo("web/src/lib/router.svelte.ts"), "utf8");
    for (const surface of SURFACES) {
      const guide = HELP_GUIDES[surface];
      if (guide === null || guide.kind !== "english") continue;
      expect(router, surface).toContain(`"/${guide.path}"`);
    }
  });
});

describe("the tokens main will accept", () => {
  it("accepts exactly the five screens", () => {
    for (const surface of SURFACES) expect(isHelpSurface(surface), surface).toBe(true);
    for (const other of ["", "Lan", "storedReceive", "../lan", "constructor", "toString"]) {
      expect(isHelpSurface(other), other).toBe(false);
    }
    expect(isHelpSurface(null)).toBe(false);
    expect(isHelpSurface(undefined)).toBe(false);
    expect(isHelpSurface(1)).toBe(false);
  });

  it("accepts exactly the two maintained languages", () => {
    expect(isGuideLanguage("en")).toBe(true);
    expect(isGuideLanguage("zh")).toBe(true);
    for (const other of ["zh-Hans", "EN", "de", "", null, undefined, 2]) {
      expect(isGuideLanguage(other), String(other)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// What main does with a request
// ---------------------------------------------------------------------------

describe("the request main resolves", () => {
  it("answers an address for a screen that has one", () => {
    expect(resolveGuideRequest({ surface: "stored", language: "zh" })).toEqual({
      ok: true,
      url: "https://relayium.com/zh/guides/push-to-cloud-pull-on-another-computer",
    });
  });

  // Three distinct refusals, because they are three different facts and the
  // handler treats two of them differently: a token this build never issued is
  // a page sending something it was not given, and a screen that promises no
  // document is simply a screen with nothing to open.
  it("separates a screen with no document from a token it never issued", () => {
    expect(resolveGuideRequest({ surface: "account", language: "en" })).toEqual({
      ok: false,
      why: "no-guide",
    });
    expect(resolveGuideRequest({ surface: "storedReceive", language: "en" })).toEqual({
      ok: false,
      why: "unknown-surface",
    });
    expect(resolveGuideRequest({ surface: "lan", language: "de" })).toEqual({
      ok: false,
      why: "unknown-language",
    });
  });

  // The shape of an attack on this channel: a page trying to name a destination
  // rather than a screen. There is no field for it, and nothing that resembles
  // one is accepted by the wrong door.
  it("never turns something that is not a screen into an address", () => {
    for (const surface of [
      "https://evil.example",
      "//evil.example",
      "../../device-inbox",
      "guides/send-a-file-to-someone",
      { toString: () => "lan" },
      ["lan"],
      null,
    ]) {
      const result = resolveGuideRequest({ surface, language: "en" });
      expect(result.ok, String(surface)).toBe(false);
    }
  });
});

// The site constant itself, pinned independently.
//
// `main/origin.ts` derives the API origin from this rather than spelling the
// host twice, and the bootstrap smoke pins THAT against its own literal. This
// is the other half: a change to where the site lives has to be made here,
// deliberately, rather than arriving as a side effect somewhere else.
describe("where the site is published", () => {
  it("is the production host, spelled once", () => {
    expect(PRODUCTION_SITE_ORIGIN).toBe("https://relayium.com");
  });
});
