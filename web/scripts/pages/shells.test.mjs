import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildShells, applyShell, HEAD_MARKERS, BODY_MARKERS } from "./shells.mjs";
import crossNetwork from "./content/cross-network.mjs";
import offlineTransfer from "./content/offline-transfer.mjs";
import apps from "./content/apps.mjs";
import { pricing, cli, deviceInbox } from "./content/spa-pages.mjs";
import { CLI_ARTICLES } from "./content/cli-articles.mjs";
import en from "../../src/lib/i18n/en";

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

  it("points the mode routes' hreflang at their localized twins", () => {
    const head = byFile["cross-network.html"].head;
    expect(head).toContain('hreflang="zh-Hans" href="https://relayium.com/zh/cross-network/"');
    expect(head).toContain('hreflang="ar" href="https://relayium.com/ar/cross-network/"');
    expect(head).toContain('hreflang="x-default" href="https://relayium.com/cross-network"');
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
    // …each with a status, and none of the three planned ones claiming to exist.
    expect(body).toContain("available now");
    expect(body).toContain("in testing");
    expect((body.match(/— planned/g) ?? []).length).toBe(3);
    // The two claims this page is not allowed to blur.
    expect(body).toContain("Uploaded is not saved");
    expect(body).toContain("A link can never make one of your devices write to disk");
    // The account prerequisite and the offline queue.
    expect(body).toMatch(/same account/i);
    expect(body).toMatch(/waits in the queue/i);
    // No download CTA for the engineering-build Mac app.
    expect(body).not.toMatch(/\.dmg/i);
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
