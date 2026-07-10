import { describe, it, expect } from "vitest";
import { pageMeta } from "./page-meta";
import { CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
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

describe("SSG slugs match router paths", () => {
  it("cross-network / offline-transfer equal the router constants", () => {
    expect("/cross-network").toBe(CROSS_PATH);
    expect("/offline-transfer").toBe(OFFLINE_PATH);
  });
});
