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
import {
  FORBIDDEN_APP_CLAIMS,
  FORBIDDEN_IOS_SHARE_CLAIMS,
  IOS_SHARE_EXTENSION_FACTS,
} from "./apps-claim-rules";
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

describe("the iOS Share Extension the page describes is the one apps/ios ships", () => {
  // Same discipline as the macOS block above: the page may say this because
  // apps/ios/RelayiumShare says it, and each assertion names the file that would
  // put the claim back in question. The extension is presentation-free here —
  // what is being checked is its BOUNDARY, which is a set of absences, and an
  // absence has no runtime a browser test could observe.
  const repoFile = (p: string) => readFileSync(resolve(process.cwd(), "..", p), "utf8");

  /** Swift source with its comments removed.
   *
   * `ShareViewController.swift` documents the boundary by NAMING the symbols it
   * refuses to contain — `URLSession`, `NSExtensionContext.open`, the responder
   * walk. A raw scan therefore matches the explanation of the rule and calls it
   * a violation. There are no block comments in this target; `//` and `///` are
   * the whole of it. */
  const swiftSource = (p: string) =>
    repoFile(p).split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");

  /** A plist's declarations, without its XML comments.
   *
   * The same trap one level over: both plists in this target explain the keys
   * they deliberately DO NOT carry — `keychain-access-groups`,
   * `associated-domains`, `SupportsText` — so a scan of the raw file finds every
   * absence present and every one of these assertions inverts. */
  const plistBody = (p: string) => repoFile(p).replace(/<!--[\s\S]*?-->/g, "");

  const IOS_SHARE = "apps/ios/RelayiumShare";

  it("is a share-sheet extension that takes files, images and movies — not text or a link", () => {
    const plist = plistBody(`${IOS_SHARE}/Info.plist`);
    expect(plist, "the iOS target is no longer a share extension")
      .toMatch(/com\.apple\.share-services/);
    for (const kind of ["File", "Image", "Movie", "Attachments"]) {
      expect(plist, `the activation rule dropped ${kind}`)
        .toMatch(new RegExp(`NSExtensionActivationSupports${kind}WithMaxCount`));
    }
    // The page says "files, folders, photos or videos" and stops there because
    // the sheet stops there. Text and web pages are deliberately unsupported.
    for (const absent of ["SupportsText", "SupportsWebURL", "SupportsWebPage"]) {
      expect(plist, `the rule now activates for ${absent}, which the page does not promise`)
        .not.toMatch(new RegExp(`NSExtensionActivation${absent}`));
    }
  });

  it("holds one entitlement, so 'nothing is uploaded' is structural", () => {
    const ents = plistBody(`${IOS_SHARE}/RelayiumShare.entitlements`);
    expect(ents, "the App Group is what makes the local hand-off possible")
      .toMatch(/com\.apple\.security\.application-groups/);
    // The three that would make the copy a lie: a credential to upload with, a
    // domain to be launched for, and a network client to upload through.
    expect(ents, "a keychain group would put a bearer inside the extension")
      .not.toMatch(/keychain-access-groups/);
    expect(ents, "an associated domain would give the extension a link to route")
      .not.toMatch(/associated-domains/);
    for (const file of ["ShareViewController.swift", "ShareRootView.swift"]) {
      const swift = swiftSource(`${IOS_SHARE}/${file}`);
      for (const symbol of ["URLSession", "URLRequest", "CloudUploader", "AccountSession"]) {
        expect(swift, `${file} gained ${symbol}; the page still says nothing is uploaded`)
          .not.toMatch(new RegExp(symbol));
      }
    }
  });

  it("never opens its containing app, which is why the page asks the reader to", () => {
    const controller = swiftSource(`${IOS_SHARE}/ShareViewController.swift`);
    // Apple gives `open(_:completionHandler:)` to the Today and iMessage points,
    // not to a share extension — plus the three ways of half-doing it anyway.
    expect(controller, "the extension now opens the app; the manual step is no longer true")
      .not.toMatch(/\.open\(/);
    expect(controller).not.toMatch(/UIApplication/);
    expect(controller).not.toMatch(/UIPasteboard/);
    // What it does instead: hand the request back with nothing returned.
    expect(controller, "the extension no longer finishes by completing the request")
      .toMatch(/completeRequest\(returningItems: \[\]/);
  });

  it("states the whole boundary in English and in Chinese, on the rendered page", async () => {
    await mountPage("en");
    for (const f of IOS_SHARE_EXTENSION_FACTS) {
      expect(text(), `English /apps does not state: ${f.fact}`).toMatch(f.en);
    }
    await setLang("zh");
    flushSync();
    for (const f of IOS_SHARE_EXTENSION_FACTS) {
      expect(text(), `Chinese /apps does not state: ${f.fact}`).toMatch(f.zh);
    }
  });

  it("proves every forbidden share claim can catch its English and Chinese form", () => {
    // Guards the guards, exactly as the five-claim rule table above is guarded:
    // a negative that has never matched anything is not a negative.
    for (const { why, re, probes } of FORBIDDEN_IOS_SHARE_CLAIMS) {
      for (const probe of probes) {
        expect(probe, `${why}: rule does not match ${probe}`).toMatch(re);
      }
    }
  });

  it.each(LANGS.map((l) => l.code))("%s claims no upload, no auto-open and no automatic send", async (code) => {
    await mountPage(code);
    for (const { why, re } of FORBIDDEN_IOS_SHARE_CLAIMS) {
      expect(text(), `${code}: ${why} — matched ${re}`).not.toMatch(re);
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
