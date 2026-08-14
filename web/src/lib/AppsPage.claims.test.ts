// web/src/lib/AppsPage.claims.test.ts — what /apps is allowed to say.
//
// AppsPage.test.ts owns the page's STRUCTURE: which cards are in which group,
// that an in-development card has no action, that the install command is a
// named region. This file owns its CLAIMS, because the two fail differently: a
// structural regression looks wrong, and a claim regression looks fine and is a
// lie. Every rule here was written from something that is or is not true of
// apps/mac and apps/ios in this repository, and each says which.
//
// The negatives are deliberately checked against the RENDERED text of the whole
// page rather than against individual message keys. A claim moved from a card
// into the comparison section is the same claim.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AppsPage from "./AppsPage.svelte";
import { FORBIDDEN_APP_CLAIMS } from "./apps-claim-rules";
import { LANGS, messages, setLang, loadLang, type Lang } from "./i18n.svelte";
import type { Platform } from "./platform";

type MacRelease = { available: boolean; downloadUrl: string | null };

let target: HTMLDivElement;
let app: unknown;

async function mountPage(lang: Lang = "en", platformOverride: Platform = "unknown",
                         macRelease: MacRelease = { available: true, downloadUrl: "https://relayium.test/R.dmg" }) {
  await setLang(lang);
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(AppsPage, { target, props: { macRelease, platformOverride } });
  flushSync();
  return target;
}

afterEach(async () => {
  if (app) unmount(app as never);
  app = undefined;
  target?.remove();
  await setLang("en");
});

const text = () => (target.textContent ?? "").replace(/\s+/g, " ");

// ── The five things /apps may not say ────────────────────────────────────────
//
// Each is paired with the reason it is false, because a banned phrase with no
// reason is a rule the next person deletes.
//
// The shared list lives in apps-claim-rules.ts so importing it from the static
// twin test does not also register and rerun this test suite.

describe("what the Apps page may not claim", () => {
  it("proves every rule can catch both its English and Chinese form", () => {
    const probes = [
      ["faster transfers", "传输更快"],
      ["background transfer", "支持后台传输"],
      ["push notifications", "支持推送通知"],
      ["App Store", "即将上架应用商店"],
      ["coming soon", "即将推出"],
    ];
    expect(FORBIDDEN_APP_CLAIMS).toHaveLength(probes.length);
    FORBIDDEN_APP_CLAIMS.forEach(({ why, re }, index) => {
      for (const probe of probes[index]) {
        expect(probe, `${why}: rule does not match ${probe}`).toMatch(re);
      }
    });
  });

  it.each(LANGS.map((l) => l.code))("%s says none of the five forbidden things", async (code) => {
    await mountPage(code);
    for (const { why, re } of FORBIDDEN_APP_CLAIMS) {
      expect(text(), `${code}: ${why} — matched ${re}`).not.toMatch(re);
    }
  });

  it("keeps the iOS limitation truthful rather than silent", async () => {
    // The honest sentence has to survive, not just the dishonest ones die. A
    // page that simply deleted "while it is open" would pass every negative
    // above and still mislead.
    await mountPage("en");
    expect(text()).toMatch(/while (?:the app )?it is open/i);
    await setLang("zh");
    flushSync();
    expect(text()).toMatch(/应用打开时/);
  });

  it("is checked against a page that actually rendered", async () => {
    // Guards the guards: every negative above passes on an empty string.
    await mountPage("en");
    expect(text().length).toBeGreaterThan(1500);
    expect(target.querySelectorAll("article").length).toBe(8);
  });
});

describe("the macOS advantages are ones this repository actually ships", () => {
  // Each claim names the file that makes it true. If one of these is ever
  // removed from the app, this test is where the page's promise comes back into
  // question — which is the point.
  const EVIDENCE: { claim: RegExp; zhClaim: RegExp; file: string; proof: RegExp }[] = [
    {
      claim: /menu bar/i,
      zhClaim: /菜单栏/,
      file: "apps/mac/Relayium/RelayiumApp.swift",
      proof: /MenuBarExtra|NSStatusItem/,
    },
    {
      claim: /share menu/i,
      zhClaim: /分享」?菜单/,
      file: "apps/mac/RelayiumShare/Info.plist",
      proof: /com\.apple\.share-services/,
    },
    {
      claim: /open with|dock icon/i,
      zhClaim: /打开方式|程序坞/,
      file: "apps/mac/Relayium/Info.plist",
      proof: /CFBundleDocumentTypes/,
    },
    {
      claim: /link opens in the app/i,
      zhClaim: /直接在应用里打开/,
      file: "apps/mac/Relayium/Relayium.entitlements",
      proof: /applinks:relayium\.com/,
    },
    {
      claim: /device inbox/i,
      zhClaim: /设备收件箱/,
      file: "apps/mac/Relayium/DeviceInbox/DeviceInboxSurface.swift",
      proof: /folderSection/,
    },
  ];

  const repoFile = (p: string) => readFileSync(resolve(process.cwd(), "..", p), "utf8");

  it.each(EVIDENCE.map((e) => e.file))("%s still backs the claim the page makes", (file) => {
    const e = EVIDENCE.find((x) => x.file === file)!;
    expect(repoFile(file), `${file} no longer proves ${e.claim}`).toMatch(e.proof);
  });

  it("makes all five claims in English and in Chinese", async () => {
    await mountPage("en");
    for (const e of EVIDENCE) {
      expect(text(), `English is missing the ${e.file} capability`).toMatch(e.claim);
    }
    await setLang("zh");
    flushSync();
    for (const e of EVIDENCE) {
      expect(text(), `Chinese is missing the ${e.file} capability`).toMatch(e.zhClaim);
    }
  });

  it("names the Share extension's real scope, not text or links", async () => {
    // The extension declares File/Image/Movie/Attachments activation and
    // deliberately NOT SupportsText/SupportsWebURL/SupportsWebPage, because
    // sharing a paragraph would produce a text file nobody asked for. The page
    // must not promise what the menu will not offer.
    const plist = readFileSync(resolve(process.cwd(), "..", "apps/mac/RelayiumShare/Info.plist"), "utf8");
    expect(plist).not.toMatch(/NSExtensionActivationSupportsText/);
    expect(plist).not.toMatch(/NSExtensionActivationSupportsWebURL/);
    await mountPage("en");
    const share = messages.en.appsPage.chooser.mac.points.find((p) => /share menu/i.test(p))!;
    expect(share).toMatch(/files, images and video/i);
    expect(share, "the Share menu cannot take a link or a paragraph").not.toMatch(/\b(link|text|url)\b/i);
  });

  it("does not promise Device Inbox residency it cannot keep", async () => {
    // Two halves of the documented contract: the destination is the folder the
    // user chose on that Mac, and "saved" means written to disk. Dropping either
    // turns a precise promise into a vague one.
    for (const code of LANGS.map((l) => l.code)) {
      await loadLang(code);
      const inbox = messages[code].appsPage.chooser.mac.points.find((p) => /device inbox|设备收件箱/i.test(p))!;
      expect(inbox, `${code} inbox point`).toBeTruthy();
      expect(inbox, `${code} does not name the destination`).toMatch(/folder you chose|选定的文件夹/);
      expect(inbox, `${code} does not say what saved means`).toMatch(/on disk|落盘/);
    }
  });
});

describe("the in-development cards", () => {
  it("mark Android and Windows in development, with no action of their own", async () => {
    await mountPage("en");
    for (const id of ["#app-android", "#app-windows"]) {
      const card = target.querySelector(id)!;
      expect(card, `${id} is missing`).toBeTruthy();
      expect(card.querySelector("a, button"), `${id} offers an action`).toBeNull();
      expect(card.querySelector(".future-status")?.textContent)
        .toBe(messages.en.appsPage.inDevelopmentBadge);
      expect(card.closest(".future-grid"), `${id} is not in the in-development group`).toBeTruthy();
    }
    expect(messages.en.appsPage.inDevelopmentBadge).toBe("In development");
    await setLang("zh");
    expect(messages.zh.appsPage.inDevelopmentBadge).toBe("正在开发中");
  });

  it("tells a Windows reader that the CLI already works", async () => {
    // The one thing a Windows visitor can act on today. An in-development card
    // with no action AND no mention of the working alternative is a dead end.
    await mountPage("en");
    expect(target.querySelector("#app-windows")!.textContent).toMatch(/command line already works on Windows/i);
    await setLang("zh");
    flushSync();
    expect(target.querySelector("#app-windows")!.textContent).toMatch(/命令行工具今天就已经支持 Windows/);
  });

  it("points an Android reader at the web app without giving the card a button", async () => {
    await mountPage("en");
    const card = target.querySelector("#app-android")!;
    expect(card.textContent).toMatch(/web app/i);
    expect(card.querySelector("a, button"), "the future card must stay actionless").toBeNull();
    // …and the web app it names is on the same page, with a real button.
    expect(target.querySelector("#app-web a.btn")).toBeTruthy();
  });
});

describe("platform detection recognises the new cards without inventing availability", () => {
  const CASES: { platform: Platform; marked: string[]; note: string | null }[] = [
    // Windows matches in both groups: the CLI works today AND a native app is
    // being built. Neither statement is complete without the other.
    { platform: "windows", marked: ["app-cli", "app-windows"], note: "Windows" },
    { platform: "android", marked: ["app-web", "app-android"], note: "Android" },
    { platform: "mac", marked: ["app-mac"], note: "macOS" },
    { platform: "ios", marked: ["app-ios"], note: "iOS" },
    { platform: "linux", marked: ["app-cli"], note: "Linux" },
    { platform: "unknown", marked: ["app-web"], note: null },
  ];

  it.each(CASES.map((c) => c.platform))("%s marks the right cards", async (platform) => {
    const c = CASES.find((x) => x.platform === platform)!;
    await mountPage("en", platform);
    const marked = [...target.querySelectorAll(".is-platform")].map((el) => el.id).sort();
    expect(marked).toEqual([...c.marked].sort());
    // At most one card per group, so the page identifies rather than lights up.
    expect(target.querySelectorAll(".available-grid .is-platform").length).toBeLessThanOrEqual(1);
    expect(target.querySelectorAll(".future-grid .is-platform").length).toBeLessThanOrEqual(1);
  });

  it.each(CASES.map((c) => c.platform))("%s never turns a marked card into an offer", async (platform) => {
    await mountPage("en", platform);
    for (const el of target.querySelectorAll(".future-grid .is-platform")) {
      expect(el.querySelector("a, button"), `${platform} manufactured an action`).toBeNull();
      expect(el.querySelector(".future-status")?.textContent)
        .toBe(messages.en.appsPage.inDevelopmentBadge);
    }
  });

  it("captions the highlight only when it can name the OS", async () => {
    for (const c of CASES) {
      await mountPage("en", c.platform);
      const note = target.querySelector("#platform-note");
      if (c.note) {
        expect(note?.textContent, `${c.platform} caption`).toBe(messages.en.appsPage.yourPlatformNote(c.note));
        // The marked cards point at it, so the association is in the tree and
        // not only in the styling.
        for (const el of target.querySelectorAll(".is-platform")) {
          expect(el.getAttribute("aria-describedby"), `${c.platform} ${el.id}`).toBe("platform-note");
        }
      } else {
        expect(note, "an unnamed platform gets no caption").toBeNull();
        for (const el of target.querySelectorAll(".is-platform")) {
          expect(el.getAttribute("aria-describedby"), el.id).toBeNull();
        }
      }
      if (app) unmount(app as never);
      app = undefined;
      target.remove();
    }
  });
});
