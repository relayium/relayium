import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildShells, applyShell, HEAD_MARKERS, BODY_MARKERS } from "./shells.mjs";
import { MAINTAINED_LANGS } from "./shared.mjs";
import crossNetwork from "./content/cross-network.mjs";
import offlineTransfer from "./content/offline-transfer.mjs";
import apps from "./content/apps.mjs";
import { pricing, cli, deviceInbox } from "./content/spa-pages.mjs";
import { CLI_ARTICLES } from "./content/cli-articles.mjs";
import en from "../../src/lib/i18n/en";
import { INBOX_PLATFORMS, REQUIRED_PLATFORM_IDS, platformStatus } from "../../src/lib/device-inbox-platforms";
import nativeReleases from "../../native-releases.json";

// Vitest runs with `web/` as the root, so these resolve off the project dir.
const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const indexHtml = read("index.html");
const llmsTxt = read("public/llms.txt");
const robotsTxt = read("public/robots.txt");
const manifestTs = read("src/lib/manifest.ts");

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
const byFile = Object.fromEntries(shells.map((s) => [s.file, s]));

describe("private route crawler policy", () => {
  it("keeps every emailed-token landing out of search crawler queues", () => {
    for (const route of ["/verify-email", "/reset-password", "/magic-link"]) {
      expect(robotsTxt.match(new RegExp(`^Disallow: ${route}$`, "gm")), route).toHaveLength(2);
    }
  });
});

// The homepage's structured data is the machine-readable version of what the
// product currently is, and two of its fields had drifted away from that:
//
//  * `inLanguage` listed nine locales. The product maintains two. The other
//    seven are archived translations that self-label as archives — reachable,
//    but not languages the application is offered in, and declaring them here
//    invites a crawler to advertise a Japanese product surface that does not
//    exist.
//  * `softwareVersion: "M0"` was a planning milestone. The Web app is
//    continuously deployed and has no product version at all, so the honest
//    schema has no such field rather than an invented one. Read as an absence
//    on purpose: this must fail if someone reintroduces a Web version number.
describe("index.html structured data matches the current product", () => {
  const graph = JSON.parse(
    indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  )["@graph"];
  const app = graph.find((n) => [].concat(n["@type"]).includes("WebApplication"));

  it("declares only the maintained product languages", () => {
    expect(app.inLanguage).toEqual([...MAINTAINED_LANGS]);
  });

  it("claims no version for a continuously deployed web app", () => {
    expect(app).not.toHaveProperty("softwareVersion");
    expect(indexHtml).not.toContain('"softwareVersion"');
  });
});

describe("index.html shell markers", () => {
  it("carries both marker pairs, byte-exact", () => {
    // applyShell does an indexOf on these literals. A reworded marker comment
    // fails the build (closeBundle throws), but this test says why.
    for (const m of [...HEAD_MARKERS, ...BODY_MARKERS]) {
      expect(indexHtml.split(m).length - 1, `marker ${m}`).toBe(1);
    }
  });
});

describe("buildShells", () => {
  it("emits a file per SPA route", () => {
    expect(Object.keys(byFile).sort()).toEqual(
      [
        "apps.html",
        "cli.html",
        "cross-network.html",
        "d.html",
        "device-inbox.html",
        "magic-link.html",
        "me.html",
        "offline-transfer.html",
        "pricing.html",
        "reset-password.html",
        "share-target.html",
        "verify-email.html",
      ].sort()
    );
  });

  it("canonicals each indexable route at itself, never at the homepage", () => {
    // The bug this whole mechanism exists for: the raw HTML at /cross-network
    // used to declare <link rel=canonical href="https://relayium.com/">.
    const want = {
      "cross-network.html": "https://relayium.com/cross-network",
      "offline-transfer.html": "https://relayium.com/offline-transfer",
      "apps.html": "https://relayium.com/apps",
      "pricing.html": "https://relayium.com/pricing",
      "cli.html": "https://relayium.com/cli",
      "device-inbox.html": "https://relayium.com/device-inbox",
    };
    for (const [file, canonical] of Object.entries(want)) {
      expect(byFile[file].head, file).toContain(`<link rel="canonical" href="${canonical}" />`);
      expect(byFile[file].head, file).toContain('name="robots" content="index, follow');
    }
  });

  it("points the mode routes' hreflang at their maintained twins only", () => {
    const head = byFile["cross-network.html"].head;
    expect(head).toContain('hreflang="zh-Hans" href="https://relayium.com/zh/cross-network/"');
    expect(head).toContain('hreflang="x-default" href="https://relayium.com/cross-network"');
    // The seven archived twins are not alternates of a current page. They stay
    // public, indexable and in the sitemap; see shared.mjs's FROZEN_LANGS.
    for (const code of ["ja", "ko", "de", "fr", "ar", "es", "pt"]) {
      expect(head, code).not.toContain(`hreflang="${code}"`);
      expect(head, code).not.toContain(`https://relayium.com/${code}/cross-network/`);
    }
  });

  it("offers only the maintained languages in the crawlable body", () => {
    // This line used to list all eight non-English twins — primary navigation
    // straight into seven frozen locales, read by every non-rendering crawler.
    const body = byFile["cross-network.html"].body;
    expect(body).toContain('Also available in: <a href="/zh/cross-network/">中文</a>');
    for (const code of ["ja", "ko", "de", "fr", "ar", "es", "pt"]) {
      expect(body, code).not.toContain(`/${code}/cross-network/`);
    }
  });

  it("gives the English-only routes no hreflang cluster", () => {
    // /pricing, /cli and /device-inbox have no localized page; an alternate
    // pointing at a URL that 404s is worse than none.
    for (const f of ["pricing.html", "cli.html", "device-inbox.html"]) {
      expect(byFile[f].head, f).not.toContain("hreflang=");
    }
  });

  it("marks the private routes noindex and gives them no canonical", () => {
    for (const f of ["me.html", "d.html", "verify-email.html", "reset-password.html", "magic-link.html", "share-target.html"]) {
      expect(byFile[f].head, f).toContain('content="noindex, nofollow"');
      expect(byFile[f].head, f).not.toContain("rel=\"canonical\"");
    }
  });

  it("keeps the private shell titles aligned with their rendered page headings", () => {
    expect(byFile["me.html"].head).toContain(`<title>${en.me.title} · Relayium</title>`);
    expect(byFile["d.html"].head).toContain(`<title>${en.download.title} · Relayium</title>`);
  });

  it("puts the route's own prose in the crawlable body", () => {
    expect(byFile["cross-network.html"].body).toContain(
      "Cross-network files and live text, end-to-end encrypted",
    );
    expect(byFile["pricing.html"].body).toContain("Simple, honest pricing");
    // The CLI hub links every CLI guide — that is the point of making it a page.
    for (const a of CLI_ARTICLES) {
      expect(byFile["cli.html"].body, a.slug).toContain(`href="/${a.slug}/"`);
    }
  });

  it("titles and describes each route exactly as the SPA will on boot", () => {
    // Raw HTML and rendered HTML must agree; otherwise the fix just moves the
    // discrepancy from "homepage vs route" to "shell vs app" — one URL with two
    // different <head>s depending on whether the reader runs JavaScript.
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
    const want = {
      "cross-network.html": [en.titleCross, en.descCross],
      "offline-transfer.html": [en.titleOffline, en.descOffline],
      "apps.html": [en.appsPage.metaTitle, en.appsPage.metaDesc],
      "cli.html": [en.cliPage.metaTitle, en.cliPage.metaDesc],
      "device-inbox.html": [en.deviceInboxPage.metaTitle, en.deviceInboxPage.metaDesc],
      "pricing.html": [`${en.pricingPage.title} · Relayium`, en.pricingPage.subtitle],
      "verify-email.html": [`${en.verifyEmail.title} · Relayium`, en.verifyEmail.confirmPrompt],
      "reset-password.html": [`${en.resetPassword.title} · Relayium`, en.resetPassword.lead],
      "magic-link.html": [`${en.magicLink.title} · Relayium`, en.magicLink.lead],
    };
    for (const [file, [title, description]] of Object.entries(want)) {
      expect(byFile[file].head, file).toContain(`<title>${esc(title)}</title>`);
      expect(byFile[file].head, file).toContain(`<meta name="description" content="${esc(description)}" />`);
    }
  });

  // /device-inbox is a product page, not a stub: without JavaScript a crawler
  // (or a reader) must still get the model, the account prerequisite, the
  // upload-is-not-saved distinction, the share-link boundary and an honest
  // status for all six platforms. Asserted on the SHELL body, because that is
  // the only thing a non-rendering client ever sees.
  it("gives /device-inbox a crawlable body that carries the product facts", () => {
    const body = byFile["device-inbox.html"].body;
    expect(body).toContain("<h1>Device Inbox</h1>");
    // Every platform the PRD requires the page to name, separately.
    for (const name of ["Linux server", "Linux desktop", "macOS", "Windows", "iPhone", "Android"]) {
      expect(body, name).toContain(name);
    }
    // The two claims this page is not allowed to blur.
    expect(body).toContain("Uploaded is not saved");
    expect(body).toContain("A link can never make one of your devices write to disk");
    // The account prerequisite and the offline queue.
    expect(body).toMatch(/same account/i);
    expect(body).toMatch(/waits in the queue/i);
  });

  // Statuses are asserted against the authority rather than pinned as literals.
  //
  // The pinned version of this test froze the defect it was meant to prevent.
  // It asserted "in testing" and exactly three "— planned" on the crawler shell,
  // and that no .dmg was offered. All three had been false since macOS 1.3.8
  // shipped: device-inbox-platforms.ts derives the macOS badge from
  // native-releases.json precisely so the page cannot claim one thing while the
  // download button does another, and this file was the one place still writing
  // the pre-release answer down a second time. So it now reads the same two
  // inputs the page reads, and the literals live only in i18n.
  it("gives every Device Inbox platform the status its authority says it has", () => {
    const body = byFile["device-inbox.html"].body;
    const macDownloadable = Boolean(nativeReleases?.macos?.available);
    const label = {
      available: en.deviceInboxPage.statusAvailable,
      testing: en.deviceInboxPage.statusTesting,
      planned: en.deviceInboxPage.statusPlanned,
    };
    // The array and the PRD's required set have to agree before either is used
    // to judge the shell; otherwise a dropped platform silently narrows this.
    expect([...INBOX_PLATFORMS].map((p) => p.id).sort()).toEqual([...REQUIRED_PLATFORM_IDS].sort());

    for (const p of INBOX_PLATFORMS) {
      const status = platformStatus(p, macDownloadable);
      const name = en.deviceInboxPage.platforms[p.id].name;
      // The shell names the platform and carries its status word, case-folded
      // because a heading renders it differently from a badge.
      expect(body, p.id).toContain(name);
      expect(body.toLowerCase(), `${p.id} status`).toContain(label[status].toLowerCase());
      // …and never the status it does NOT have. macOS is the one this catches:
      // with 1.3.8 published, "in testing" beside it is a false badge.
      for (const [other, text] of Object.entries(label))
        if (other !== status)
          expect(body, `${p.id} must not also read "${text}"`).not.toContain(`${name} — ${text.toLowerCase()}`);
    }
  });

  it("promises no native receiver Relayium does not publish", () => {
    const body = byFile["device-inbox.html"].body;
    // An absent native receiver is stated as an absence, never as a plan — the
    // rule device-inbox-platforms.ts records for the same reason. Windows,
    // iPhone and Android had "planned, not built" prose here describing share
    // sheets and tray receivers that no roadmap commits to.
    for (const promise of [
      /\bplanned\b/i,
      /\bcoming soon\b/i,
      /\bwill be (available|released|shipped)\b/i,
      /\ba future (receiver|app|client|version)\b/i,
      /\bnative (client|receiver)s? are (planned|coming)\b/i,
    ])
      expect(body, `${promise}`).not.toMatch(promise);
    // And each platform without a published app says so as an absence.
    for (const id of ["windows", "iphone", "android"])
      expect(body, id).toMatch(new RegExp(`publishes no [^.]*${id === "iphone" ? "iPhone" : id}`, "i"));
  });

  it("emits FAQPage structured data where the doc has an FAQ", () => {
    expect(byFile["pricing.html"].head).toContain('"FAQPage"');
    expect(byFile["apps.html"].head).not.toContain('"FAQPage"'); // apps has no FAQ
  });
});

describe("applyShell", () => {
  const out = applyShell(indexHtml, byFile["pricing.html"]);

  it("swaps both regions", () => {
    expect(out).toContain(`<title>${en.pricingPage.title} · Relayium</title>`);
    expect(out).not.toContain("<title>Relayium — Encrypted P2P file and text transfer</title>");
    expect(out).toContain("Simple, honest pricing");
    expect(out).not.toContain("Relayium — End-to-end encrypted peer-to-peer file and text transfer</h1>");
  });

  it("keeps everything outside the markers — the app must still boot", () => {
    expect(out).toContain('<div id="app"></div>');
    expect(out).toContain('rel="manifest"');
    expect(out).toContain("relayium-theme"); // the pre-paint theme script
    expect(out).toContain("/src/main.ts"); // dev entry; vite rewrites it in the build
  });

  it("throws when a marker is missing rather than emitting a half-swapped page", () => {
    expect(() => applyShell("<html></html>", byFile["pricing.html"])).toThrow(/markers/);
  });
});

describe("product facts stay in sync across sources", () => {
  // The audit found "up to 10 files" in index.html and llms.txt against
  // MAX_FILES = 1000 in the app — a 100× discrepancy that AI answer engines
  // were free to quote either way. These files are hand-written, so this test
  // is the only thing keeping them honest.
  const maxFiles = Number(manifestTs.match(/export const MAX_FILES = (\d+)/)[1]);
  const formatted = maxFiles.toLocaleString("en-US");

  it("states the same batch cap in index.html and llms.txt", () => {
    expect(maxFiles).toBeGreaterThan(0);
    expect(indexHtml).toContain(`up to ${formatted}`);
    expect(llmsTxt).toContain(`up to ${formatted}`);
  });

  it("has no stale batch cap left anywhere", () => {
    for (const [name, text] of [
      ["index.html", indexHtml],
      ["llms.txt", llmsTxt],
    ]) {
      const claims = [...text.matchAll(/up to ([\d,]+)(?= (?:files|at once))/g)].map((m) => m[1]);
      expect(claims.length, name).toBeGreaterThan(0);
      expect(new Set(claims), name).toEqual(new Set([formatted]));
    }
  });

  it("positions the homepage as file plus online-only ephemeral text", () => {
    expect(indexHtml).toContain("P2P file and text transfer");
    expect(indexHtml).toContain("both devices are online");
    expect(indexHtml).toContain("Relayium servers keep no message bodies");
    expect(indexHtml).toContain("65,536 UTF-8 bytes");
  });

  it("states the ephemeral-text boundary without overclaiming for the endpoints", () => {
    // "never stored" / "no persistent history" were absolutes about the whole
    // system, but the only thing Relayium controls is its own servers: the
    // receiving device holds plaintext and may copy or keep it. Every surface
    // a crawler reads — meta, JSON-LD, noscript prose — has to say so.
    expect(indexHtml).not.toMatch(/never stor|persistent history|not stored/i);
    expect(indexHtml).toMatch(/no server-side history/);
    expect(indexHtml).toContain("use an encrypted TURN relay by design");
    expect(indexHtml).not.toContain("Across networks the connection may go through");
    // Endpoint retention, said out loud rather than left to inference.
    expect(indexHtml).toMatch(/copy or keep|copying or saving/i);
    // The per-message cap is a protocol fact and must survive the rewording.
    expect(indexHtml.match(/65,536 UTF-8 bytes/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
