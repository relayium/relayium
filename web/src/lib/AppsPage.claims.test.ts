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
import { FORBIDDEN_APP_CLAIMS, violatesClaim } from "./apps-claim-rules";
import { LANGS, messages, setLang, loadLang, type Lang } from "./i18n.svelte";
import type { Platform } from "./platform";
import androidRelease from "../../android-release.json";

type MacRelease = { available: boolean; downloadUrl: string | null };
type AndroidRelease = {
  available: boolean;
  versionName?: string;
  versionCode?: number;
  downloadUrl?: string;
};

let target: HTMLDivElement;
let app: unknown;

async function mountPage(lang: Lang = "en", platformOverride: Platform = "unknown",
                         macRelease: MacRelease = { available: true, downloadUrl: "https://relayium.test/R.dmg" },
                         // Defaults to the COMMITTED manifest, so the general
                         // assertions below run against the state the site
                         // actually ships in rather than an invented one.
                         androidRel: AndroidRelease = androidRelease.android as AndroidRelease) {
  await setLang(lang);
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(AppsPage, { target, props: { macRelease, androidRel, platformOverride } });
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

// ── The things /apps may not say ─────────────────────────────────────────────
//
// Each is paired with the reason it is false, because a banned phrase with no
// reason is a rule the next person deletes.
//
// The shared list lives in apps-claim-rules.ts so importing it from the static
// twin test does not also register and rerun this test suite. Its probes now
// live on the rules themselves: they used to be a positional array here, and
// inserting or removing a rule silently re-paired every rule after it with
// somebody else's evidence.

describe("what the Apps page may not claim", () => {
  it("proves every rule can catch its English and its Chinese form", () => {
    expect(FORBIDDEN_APP_CLAIMS.length).toBeGreaterThan(0);
    for (const rule of FORBIDDEN_APP_CLAIMS) {
      expect(rule.probes.length, `${rule.why}: rule carries no probe`).toBeGreaterThan(1);
      for (const probe of rule.probes) {
        expect(violatesClaim(probe, rule), `${rule.why}: rule does not catch "${probe}"`).toBe(true);
      }
    }
  });

  it("lets a rule's permitted phrasing through, and only that phrasing", () => {
    // The half `allow` exists for. "Mac App Store" is a public listing recorded
    // in web/mac-app-store-release.json; a bare "App Store", TestFlight and
    // Google Play are not, and subtracting the true phrase must not disarm the
    // rule for the false ones. Asserted here because a rule that permits
    // everything reads exactly like a rule that permits one thing.
    const permitting = FORBIDDEN_APP_CLAIMS.filter((r) => r.permitted?.length);
    expect(permitting.length, "no rule exercises the allow path").toBeGreaterThan(0);
    for (const rule of permitting) {
      for (const allowed of rule.permitted!) {
        expect(violatesClaim(allowed, rule), `${rule.why}: rejects the true phrasing "${allowed}"`)
          .toBe(false);
      }
      for (const probe of rule.probes) {
        expect(violatesClaim(`${rule.permitted![0]} ${probe}`, rule),
               `${rule.why}: the permitted phrase disarmed the rule for "${probe}"`).toBe(true);
      }
    }
  });

  // Direction, pinned separately from the declarative probes/permitted pairs
  // above, because the bug these rules had was one-way. They fired on the words
  // and not on the assertion, so the accurate correction — "Relayium publishes
  // no Windows app", "no shipped client receives push notifications" — was
  // itself a violation, and the only copy that satisfied every rule was copy
  // that said nothing. A negator only counts when it precedes the phrase and
  // shares its clause: a negator afterwards does not unsay it.
  it("reads a denial as a denial, and only forwards within one clause", () => {
    const iosRule = FORBIDDEN_APP_CLAIMS.find((r) => r.why.includes("no iOS or Windows app"))!;
    const pushRule = FORBIDDEN_APP_CLAIMS.find((r) => r.why.includes("push"))!;

    for (const denial of [
      "Relayium publishes no Windows app.",
      "There is no iPhone app, and none is offered.",
      "Relayium 没有 iOS 应用。",
    ])
      expect(violatesClaim(denial, iosRule), `denial flagged: ${denial}`).toBe(false);
    expect(violatesClaim("No shipped client receives push notifications.", pushRule)).toBe(false);

    // A negator that arrives after the claim does not retract it…
    expect(violatesClaim("We ship an iOS app, no really.", iosRule)).toBe(true);
    // …and one in an earlier clause is a different sentence, not a scope.
    expect(violatesClaim("There is no Mac app yet. Download the Windows app.", iosRule)).toBe(true);
    // The denial must not disarm the rule for a promise later in the same text.
    expect(
      violatesClaim("Relayium publishes no Windows app. The iOS app is in development.", iosRule),
    ).toBe(true);
  });

  // Word order, which the platform rule did not have. It only recognised
  // "<platform> app", so three ordinary ways of promising the same thing walked
  // straight past it — while the one phrasing that is TRUE today, running the
  // web app in a phone browser, has to keep working.
  it("catches an app promised in any word order, and spares the web-platform one", () => {
    const rule = FORBIDDEN_APP_CLAIMS.find((r) => r.why.includes("no iOS or Windows app"))!;
    for (const promise of [
      "Download the app for Windows.",
      "Install our client on iPhone.",
      "The Windows version of the app lands this year.",
      "客户端支持 Windows。",
    ])
      expect(violatesClaim(promise, rule), `missed: ${promise}`).toBe(true);
    for (const truthful of [
      "Open the web app on iPhone — nothing to install.",
      "It runs in the browser on Android.",
      "在 iPhone 的浏览器里打开网页版即可。",
      // Android is a published product now: naming its app is a fact.
      "Download the Android app.",
      "下载 Android 应用。",
    ])
      expect(violatesClaim(truthful, rule), `flagged a true web statement: ${truthful}`).toBe(false);
  });

  it.each(LANGS.map((l) => l.code))("%s says none of the forbidden things", async (code) => {
    await mountPage(code);
    for (const rule of FORBIDDEN_APP_CLAIMS) {
      expect(violatesClaim(text(), rule), `${code}: ${rule.why} — matched ${rule.re}`).toBe(false);
    }
  });

  it("names the Mac App Store rather than going silent about it", async () => {
    // The positive half of the revised store rule, and the reason it could be
    // relaxed at all. Until 2026-08-28 the page was forbidden from mentioning
    // any store; the listing had been public since 2026-08-26, so the guard was
    // enforcing a false statement by omission. Deleting the ban without
    // requiring the fact would have left the page equally silent and passing.
    for (const code of LANGS.map((l) => l.code)) {
      await mountPage(code);
      expect(text(), `${code} does not name the Mac App Store channel`).toMatch(/Mac App Store/);
      if (app) unmount(app as never);
      app = undefined;
      target.remove();
    }
  });

  it("tells a reader on an unsupported platform what to use, rather than nothing", async () => {
    // Removing the iOS, Android and Windows cards must not turn into silence:
    // a visitor on one of those platforms still has to learn that the browser
    // is the client. This is the sentence that replaced three cards.
    await mountPage("en");
    expect(text()).toMatch(/iPhone, iPad, Windows and Linux/);
    expect(text()).toMatch(/nothing to install/i);
    await setLang("zh");
    flushSync();
    expect(text()).toMatch(/浏览器/);
    expect(text()).toMatch(/无需安装/);
  });

  it("renders no card for a platform this repository does not ship", async () => {
    // Structural, not textual. A card is an advertisement whatever its status
    // line says, and `apps/` publishes nothing for iOS or Windows: iOS
    // development is paused with no public listing, and there is no Windows
    // target at all. Android is no longer in this list — `apps/android/` builds
    // a real signed APK — and its own truthfulness is asserted below, against
    // the release manifest rather than against its absence.
    await mountPage("en");
    for (const id of ["#app-ios", "#app-windows"]) {
      expect(target.querySelector(id), `${id} is back on the page`).toBeNull();
    }
  });

  // The Android card is manifest-driven in both directions, and the shipped
  // manifest state is the one that matters most: until root has published the
  // APK, `available` is false and the page must offer nothing at all.
  it("offers no Android download while the manifest advertises none", async () => {
    await mountPage("en", "unknown", undefined, { available: false });
    const card = target.querySelector("#app-android")!;
    expect(card, "the Android card vanished entirely").toBeTruthy();
    expect(card.querySelector("a, button"), "an unavailable card offered an action").toBeNull();
    expect(card.querySelector(".future-status")?.textContent).toBe(
      messages.en.appsPage.inDevelopmentBadge,
    );
    // No download hint, no checksum, no version — nothing that reads as an offer.
    expect(card.textContent ?? "").not.toMatch(/\bdownloads?\b/i);
  });

  it("offers the exact published build once the manifest advertises one", async () => {
    await mountPage("en", "unknown", undefined, {
      available: true,
      versionName: "0.1.1",
      versionCode: 2,
      downloadUrl:
        "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.1-2.apk",
    });
    const card = target.querySelector("#app-android")!;
    const cta = card.querySelector("a.btn")!;
    // The href is the manifest's, never a string assembled in the page.
    expect(cta.getAttribute("href")).toBe(
      "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.1-2.apk",
    );
    // The button names the version being offered, from the manifest.
    expect(cta.textContent).toContain("0.1.1");
    // And the limits travel with the download, because a direct APK has no
    // store listing where a reader could otherwise find them.
    expect(card.textContent ?? "").toMatch(/joins/i);
    expect(card.textContent ?? "").toMatch(/Android 8\.0/);
  });

  // A half-filled manifest must fail closed exactly as the macOS one does.
  it("offers nothing when the manifest is incomplete", async () => {
    for (const partial of [
      { available: true },
      { available: true, versionName: "0.1.1" },
      {
        available: true,
        downloadUrl:
          "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.1-2.apk",
      },
    ]) {
      await mountPage("en", "unknown", undefined, partial);
      const card = target.querySelector("#app-android")!;
      expect(card.querySelector("a, button"), JSON.stringify(partial)).toBeNull();
      // Tear down between iterations. `afterEach` only unmounts the LAST
      // mount, so a loop that remounts without this leaves live components
      // subscribed to shared language and route state — which then throws
      // inside a LATER test's mount and fails an assertion that has nothing to
      // do with this loop. Observed exactly that way.
      if (app) unmount(app as never);
      app = undefined;
      target.remove();
    }
  });

  it("is checked against a page that actually rendered", async () => {
    // Guards the guards: every negative above passes on an empty string.
    await mountPage("en");
    expect(text().length).toBeGreaterThan(1200);
    // Four platform cards — web, CLI, macOS and Android — plus the two
    // decision columns below them.
    expect(target.querySelectorAll("article").length).toBe(6);
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

  it("names the macOS Share extension's real scope, not text or links", async () => {
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

describe("platform detection points every visitor at something they can use", () => {
  const CASES: { platform: Platform; marked: string[]; note: string | null }[] = [
    { platform: "windows", marked: ["app-cli"], note: "Windows" },
    // iOS and Android resolve to the web card. They used to resolve to a card
    // that said "in development", which told a visitor their platform was not
    // served by the very page serving it — the browser IS the client there.
    // Unavailable: the browser is what serves this reader, so the web card is
    // marked. The published case is asserted separately below, because the
    // right answer there is app-android and never app-web.
    { platform: "android", marked: ["app-web"], note: "Android" },
    { platform: "ios", marked: ["app-web"], note: "iOS" },
    { platform: "mac", marked: ["app-mac"], note: "macOS" },
    { platform: "linux", marked: ["app-cli"], note: "Linux" },
    { platform: "unknown", marked: ["app-web"], note: null },
  ];

  // These cases are about PLATFORM DETECTION, so they are mounted against an
  // explicit unavailable manifest rather than against whichever state the
  // checkout happens to hold.
  //
  // That is the fix for a real defect: the Android expectation was `app-web`,
  // which is correct only while no APK is published. `mountPage` defaults to
  // the committed manifest, so the day a release is staged this suite failed —
  // a test that has to be edited during publication is a test that blocks it.
  // Pinning the input here makes the expectation true by construction, and the
  // published-state behaviour is asserted separately below, where the correct
  // answer is app-android and never app-web.
  const ANDROID_UNAVAILABLE = { available: false };

  it.each(CASES.map((c) => c.platform))("%s marks the right cards", async (platform) => {
    const c = CASES.find((x) => x.platform === platform)!;
    await mountPage("en", platform, undefined, ANDROID_UNAVAILABLE);
    const marked = [...target.querySelectorAll(".is-platform")].map((el) => el.id).sort();
    expect(marked).toEqual([...c.marked].sort());
    // At most one card per group, so the page identifies rather than lights up.
    expect(target.querySelectorAll(".available-grid .is-platform").length).toBeLessThanOrEqual(1);
    expect(target.querySelectorAll(".future-grid .is-platform").length).toBeLessThanOrEqual(1);
  });

  it.each(CASES.map((c) => c.platform))("%s is marked on a card that carries an action", async (platform) => {
    // The inverse of the rule this replaces. There is no in-development group
    // any more, so "a highlight never becomes an offer" has nothing to guard;
    // what matters now is that a highlight is never a dead end.
    await mountPage("en", platform, undefined, ANDROID_UNAVAILABLE);
    for (const el of target.querySelectorAll(".is-platform")) {
      expect(el.querySelector("a.btn"), `${platform}: ${el.id} highlighted with no way in`).toBeTruthy();
    }
    // The in-development group is drawn only when something is actually in it.
    // With the shipped manifest that is the Android card; with a published one
    // the group disappears again.
    const future = target.querySelectorAll(".future-grid");
    if (future.length > 0) {
      expect(future[0].querySelectorAll("article").length, "an empty group was drawn").toBeGreaterThan(0);
    }
  });

  it("captions the highlight only when it can name the OS", async () => {
    for (const c of CASES) {
      await mountPage("en", c.platform, undefined, ANDROID_UNAVAILABLE);
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

// ── the Android highlight, in the state that actually ships a download ──────
//
// Split out rather than folded into CASES because the correct answer flips with
// the manifest: with no published APK the browser is what serves an Android
// reader, and with one the Android card is. A single hardcoded expectation is
// how a suite passes today and blocks the release it was supposed to protect.
describe("the Android highlight follows the manifest, in both states", () => {
  const PUBLISHED = {
    available: true,
    versionName: "0.1.1",
    versionCode: 2,
    downloadUrl:
      "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.1-2.apk",
  };

  it("marks the Android card, and only it, once a download exists", async () => {
    await mountPage("en", "android", undefined, PUBLISHED);
    const marked = [...target.querySelectorAll(".is-platform")].map((el) => el.id);
    expect(marked).toEqual(["app-android"]);
    // The highlight must carry an action, or it points at a dead end.
    expect(target.querySelector("#app-android a.btn.btn-primary")).toBeTruthy();
    expect(target.querySelector("#app-android")?.getAttribute("aria-describedby"))
      .toBe("platform-note");
    // Still at most one per group.
    expect(target.querySelectorAll(".available-grid .is-platform").length).toBe(1);
  });

  it("marks the web card while nothing is published", async () => {
    await mountPage("en", "android", undefined, { available: false });
    const marked = [...target.querySelectorAll(".is-platform")].map((el) => el.id);
    expect(marked).toEqual(["app-web"]);
    // …and the Android card offers nothing at all.
    expect(target.querySelector("#app-android a, #app-android button")).toBeNull();
  });

  it("never leaves an Android visitor unmarked in either state", async () => {
    for (const rel of [PUBLISHED, { available: false }]) {
      await mountPage("en", "android", undefined, rel);
      expect(target.querySelectorAll(".is-platform").length, JSON.stringify(rel)).toBe(1);
      // Tear down between iterations. `afterEach` only unmounts the LAST
      // mount, so a loop that remounts without this leaves live components
      // subscribed to shared language and route state — which then throws
      // inside a LATER test's mount and fails an assertion that has nothing to
      // do with this loop. Observed exactly that way.
      if (app) unmount(app as never);
      app = undefined;
      target.remove();
    }
  });
});
