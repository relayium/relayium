import { describe, it, expect } from "vitest";
import { applyHeadMeta, pageMeta, altHreflangs } from "./page-meta";
import { CROSS_PATH, OFFLINE_PATH, APPS_PATH, CLI_PATH, PRICING_PATH } from "./router.svelte";
// `messages` in i18n.svelte is populated lazily (code-split per language), so it's
// empty at import time in a test — import the English table directly instead,
// matching the pattern in i18n.test.ts.
import m from "./i18n/en";

describe("pageMeta", () => {
  it("distinct per-route title + description for cross/offline/lan", () => {
    const c = pageMeta("cross", m), o = pageMeta("offline", m), lan = pageMeta("lan", m);
    expect(c.title).toBe(m.titleCross);
    expect(o.title).toBe(m.titleOffline);
    expect(c.title).not.toBe(o.title);
    expect(lan.title).toBe(m.titleDefault);
    expect(c.description).toBe(m.descCross);
    expect(o.description).toBe(m.descOffline);
  });

  it("canonicalPath points cross/offline at their own route, else home", () => {
    expect(pageMeta("cross", m).canonicalPath).toBe("/cross-network");
    expect(pageMeta("offline", m).canonicalPath).toBe("/offline-transfer");
    expect(pageMeta("lan", m).canonicalPath).toBe("/");
  });
});

describe("altHreflangs", () => {
  it("home cluster keeps the localized homepages (trailing slash)", () => {
    const alt = altHreflangs("/");
    expect(alt.find((a) => a.hreflang === "en")?.path).toBe("/");
    expect(alt.find((a) => a.hreflang === "zh-Hans")?.path).toBe("/zh/");
    expect(alt.find((a) => a.hreflang === "x-default")?.path).toBe("/");
  });

  it("mode routes point each language at its own localized page", () => {
    // The localized pages live at <lang>/<slug>/index.html and the slash-less
    // form 301s, so the alternates must carry the trailing slash — otherwise
    // every alternate points at a redirect and the cluster isn't reciprocal
    // with what the static pages themselves emit. English is the exception: its
    // route is the SPA at /cross-network, with no directory behind it.
    const alt = altHreflangs("/cross-network");
    expect(alt.find((a) => a.hreflang === "en")?.path).toBe("/cross-network");
    expect(alt.find((a) => a.hreflang === "zh-Hans")?.path).toBe("/zh/cross-network/");
    expect(alt.some((a) => a.hreflang === "ja"), "archived locales are not alternates").toBe(false);
    expect(alt.find((a) => a.hreflang === "x-default")?.path).toBe("/cross-network");
  });

  it("emits no cluster for routes with no localized twin", () => {
    // /pricing and /cli exist in English only; /zh/pricing would 404.
    expect(altHreflangs(PRICING_PATH)).toEqual([]);
    expect(altHreflangs(CLI_PATH)).toEqual([]);
  });

  it("covers exactly the maintained languages plus x-default", () => {
    // This runs AFTER the SPA boots and rewrites the head, so it is the cluster
    // a rendering crawler actually reads. It has to equal the one index.html
    // ships, or the site answers "which languages do you have" twice, with two
    // different answers, at the same URL.
    expect(altHreflangs("/offline-transfer").map((a) => a.hreflang)).toEqual([
      "en", "zh-Hans", "x-default",
    ]);
  });
});

describe("pageMeta apps route", () => {
  it("uses the appsPage meta title/description and its own canonical", () => {
    const a = pageMeta("apps", m);
    expect(a.title).toBe(m.appsPage.metaTitle);
    expect(a.description).toBe(m.appsPage.metaDesc);
    expect(a.canonicalPath).toBe(APPS_PATH);
  });
});

describe("pageMeta cli route", () => {
  it("uses its own title/description and canonicals at /cli, not at the homepage", () => {
    const c = pageMeta("cli", m);
    expect(c.title).toBe(m.cliPage.metaTitle);
    expect(c.description).toBe(m.cliPage.metaDesc);
    expect(c.canonicalPath).toBe(CLI_PATH);
    expect(c.title).not.toBe(m.titleDefault);
  });
});

describe("private route metadata", () => {
  it("gives every noindex app route its own title and no canonical", () => {
    expect(pageMeta("verify-email", m)).toMatchObject({ title: `${m.verifyEmail.title} · Relayium`, canonicalPath: null });
    expect(pageMeta("reset-password", m)).toMatchObject({ title: `${m.resetPassword.title} · Relayium`, canonicalPath: null });
    expect(pageMeta("magic-link", m)).toMatchObject({ title: `${m.magicLink.title} · Relayium`, canonicalPath: null });
    expect(pageMeta("me", m)).toMatchObject({ title: `${m.me.title} · Relayium`, canonicalPath: null });
    expect(pageMeta("download", m)).toMatchObject({ title: `${m.download.title} · Relayium`, canonicalPath: null });
  });

  it("emits no hreflang cluster for a private route", () => {
    expect(altHreflangs(null)).toEqual([]);
  });

  it("clears public discovery links on private entry and recreates them on return", () => {
    document.head.innerHTML = `
      <meta name="description" content="old">
      <link rel="canonical" href="https://relayium.com/">
      <meta property="og:url" content="https://relayium.com/">
      <link rel="alternate" hreflang="en" href="https://relayium.com/">
    `;

    applyHeadMeta(document, pageMeta("verify-email", m), "https://relayium.com");
    expect(document.title).toBe(`${m.verifyEmail.title} · Relayium`);
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
    expect(document.querySelectorAll('link[rel="alternate"][hreflang]')).toHaveLength(0);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");

    applyHeadMeta(document, pageMeta("lan", m), "https://relayium.com");
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://relayium.com/");
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe("https://relayium.com/");
    expect(document.querySelectorAll('link[rel="alternate"][hreflang]')).toHaveLength(3);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("index, follow");
  });
});

describe("SSG slugs match router paths", () => {
  it("cross-network / offline-transfer equal the router constants", () => {
    expect("/cross-network").toBe(CROSS_PATH);
    expect("/offline-transfer").toBe(OFFLINE_PATH);
  });
});
