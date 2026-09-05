// web/scripts/pages/privacy-purchase-channels.test.mjs — what the maintained
// privacy policy says about each native platform, and which of the nine locales
// is allowed to answer that question at all.
//
// This file has had its premise inverted once, and the history is the reason it
// is written the way it is now.
//
//   · 2026-08-28: the policy named "our iOS and macOS apps" as the in-app-purchase
//     surface and described an APNs token and photo-library access. None of that
//     was true of any shipping binary, so the maintained pair was narrowed to
//     macOS and this file banned the word-shapes the defect took.
//   · 2026-09-03: an iOS binary exists and is being prepared for App Store
//     submission, and App Review reads <https://relayium.com/privacy/> while
//     reviewing it. Guideline 5.1.1 requires the linked policy to identify what
//     the app collects, how, and every use. A macOS-scoped policy does not
//     describe the binary under review, so the blanket "no iOS" bans became the
//     defect: they pinned the document to a platform statement that was no
//     longer complete.
//
// So the guards below are no longer "does the word iOS appear". They are the
// exact per-platform device truth, positive and negative, derived from the
// source. Purchase-channel wording is the deliberate exception: it names
// Apple's App Store without naming a platform, so it remains true before and
// after the reviewed iOS binary becomes public.
//
//   · device label — `AppEnvironment.deviceName()` returns
//     `Host.current().localizedName` on macOS and `deviceFamilyName(
//     forModelIdentifier:)` ("iPhone"/"iPad"/"iPod touch") everywhere else;
//   · installation identifier — `InstallationIdentity`'s 32 bytes are posted as
//     `install_id` by `HTTPDeviceAuthClient.start`, which only the macOS browser
//     sign-in reaches. iOS takes the default `.legacyOneShot` purchase policy, so
//     `AccountClient.dispatchApplePurchase` omits `appInstanceId` as well;
//   · camera — `NSCameraUsageDescription` exists in `apps/ios/Relayium/Info.plist`
//     and in no macOS Info.plist; `PairingScannerView` reads a pairing code and
//     nothing leaves the device;
//   · push — no `aps-environment`, no `registerForRemoteNotifications` anywhere
//     under `apps/ios`; macOS posts local `UNUserNotificationCenter` banners only;
//   · purchase — `IOSAppleSubscriptions` builds a real `StoreKitSubscriptionStore`,
//     so Apple in-app purchase is iOS app behaviour as well as macOS app behaviour.
//
// Two rules did NOT change and are still enforced here:
//
//   1. **The seven frozen locales must not be rewritten.** They are archived
//      translations under the 2026-08-14 language freeze, corrected by
//      retranslation if a locale is ever restored, never by an editor who cannot
//      read them. Each is pinned by the exact sentence it still carries.
//   2. **The policy describes behaviour, not availability.** The iOS app is not
//      published and nobody can install it. Saying how a build behaves is what
//      5.1.1 asks for; saying it is on sale would be the same aspirational defect
//      in the opposite direction, so publication claims are banned outright.
//
// maintained-frozen-split.test.mjs owns the rendered-page half of the freeze
// (selectors, hreflang, archive notices). This file owns what the maintained
// privacy policy claims about the native apps, in the source of record and in
// the generated en/zh pages a reviewer actually opens.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

import privacy from "./content/legal/privacy.mjs";
import { MAINTAINED_LANGS, FROZEN_LANGS, LANGS } from "./shared.mjs";

const MAINTAINED_DATE = "2026-09-03";
const FROZEN_DATE = "2026-08-13";

/** Every string in a locale's document, flattened, so a sentence cannot hide
 *  from this file by moving between `body` and `bullets`. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

const textOf = (lang) => strings(privacy.langs[lang]).join("\n");

/** The section that introduces device-level native-app data, found by a clause
 *  rather than by its heading: the heading is prose and may be reworded, while
 *  the claim this file exists to police may not move out of the document. */
const NATIVE_SECTION_MARK = {
  en: "device-level data that the website does not",
  zh: "网站不涉及的设备级数据",
};

const nativeSection = (lang) =>
  privacy.langs[lang].sections.find((s) => strings(s).join("\n").includes(NATIVE_SECTION_MARK[lang]));

const generatedPrivacyPage = (lang) =>
  readFileSync(resolve(process.cwd(), `public/${lang === "en" ? "" : `${lang}/`}privacy/index.html`), "utf8");

describe("the privacy policy covers every generated language exactly once", () => {
  it("carries all nine locales and no others", () => {
    expect(Object.keys(privacy.langs).sort()).toEqual([...LANGS].sort());
  });

  it("splits them into the two maintained and the seven frozen", () => {
    expect([...MAINTAINED_LANGS, ...FROZEN_LANGS].sort()).toEqual([...LANGS].sort());
    expect(MAINTAINED_LANGS).toEqual(["en", "zh"]);
    expect(FROZEN_LANGS).toHaveLength(7);
  });
});

describe("maintained copy truthfully discloses identifier-free activation aggregates", () => {
  // Unchanged by the iOS correction, and re-pinned here because a rewrite of the
  // native-app section is exactly when an unrelated paragraph gets lost.
  it("pins the three server-owned actions and the deliberately weak semantics", () => {
    const en = textOf("en");
    const zh = textOf("zh");
    expect(en).toMatch(/successful code mints.*first admitted socket.*first transition to two admitted peers/s);
    expect(en).toMatch(/best-effort lower-bound action counts, not unique users, a cohort, or an exact conversion rate/);
    expect(en).toMatch(/same-month action totals and is not cohort conversion/);
    expect(en).toMatch(/database does not store it against your account and contains no field linking it to an account/);
    expect(zh).toMatch(/成功铸码.*首次接纳连接.*首次变为两个已接纳端/s);
    expect(zh).toMatch(/尽力写入的动作数下界，不是独立用户数、同期群或精确转化率/);
    expect(zh).toMatch(/同月动作总数相除，并不是同期群转化/);
    expect(zh).toMatch(/数据库不按账号保存这些聚合，也不含将其连接到账号的字段/);
  });

  it("keeps the account-metering and zero-knowledge claims the whole product rests on", () => {
    const REQUIRED = {
      en: [
        /A paid subscription is a fixed price for a plan, not a per-byte charge\./,
        /The server stores only ciphertext\. It cannot read your file contents, filenames, or keys\./,
        /The contents of your files\./,
        /Your encryption keys\./,
        /no advertising or third-party analytics SDK/,
      ],
      zh: [
        /付费订阅按套餐收取固定价格，不是按字节计费。/,
        /服务器仅存储密文，无法读取你的文件内容、文件名或密钥。/,
        /你的文件内容。/,
        /你的加密密钥。/,
        /不含任何广告或第三方分析 SDK/,
      ],
    };
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const re of REQUIRED[lang]) {
        expect(re.test(text), `${lang} privacy policy dropped a global truth (${re})`).toBe(true);
      }
    }
  });

  it("does not rewrite the seven frozen translations", () => {
    for (const lang of FROZEN_LANGS) {
      expect(privacy.langs[lang].updated).toBe(FROZEN_DATE);
      expect(textOf(lang)).not.toMatch(/best-effort lower-bound|尽力写入的动作数下界/);
    }
  });
});

describe("maintained copy names Apple's App Store as the native purchase channel", () => {
  // Superseded on 2026-09-03. The 2026-08-28 correction was right that a policy
  // may not name a purchase channel a reader cannot reach, and it fixed that by
  // naming macOS. That answer is now too narrow in the other direction: this
  // page is about to be entered as the Privacy Policy URL on the iOS App Store
  // Connect record, so "in our macOS app" becomes a false statement about an
  // iOS purchase the moment one is possible — while platform-specific purchase
  // wording can imply that the not-yet-public iOS purchase channel is live.
  //
  // Platform-neutral wording is the only phrasing true in both states: the
  // store is Apple's App Store, the seller is Apple, and the policy names
  // neither a platform that cannot buy nor one that does not ship. Both halves
  // are pinned below, so neither the retired macOS-only wording nor a premature
  // iOS purchase-channel claim can come back. This bridge deliberately changes the
  // purchase channel ONLY; the per-platform device-data section is a separate
  // claim and keeps describing the real macOS and pre-publication iOS binaries.
  const NEUTRAL_PROCESSOR = {
    en: "Apple, for subscriptions purchased through Apple's App Store — see Payments.",
    zh: "Apple——通过 Apple 的 App Store 购买订阅时的处理方，详见「支付」。",
  };

  it("names the store rather than a platform, in the processor list", () => {
    for (const lang of MAINTAINED_LANGS) {
      expect(strings(privacy.langs[lang]), `${lang} processor list`).toContain(
        NEUTRAL_PROCESSOR[lang],
      );
    }
  });

  it("english Payments names the store, the signed transaction and the binding token", () => {
    const payments = strings(privacy.langs.en).find((s) =>
      s.startsWith("In a native app, subscriptions are bought"),
    );
    expect(payments, "the Payments bullet must lead with a platform-neutral native app").toBeTruthy();
    expect(payments).toMatch(/through Apple's App Store rather than from us/);
    expect(payments).toMatch(/Apple processes the payment under your Apple ID/);
    // The two things a native app actually sends us on a purchase, and the only
    // two: Apple's signed transaction, and the random token that binds it to an
    // account. Both are named because both leave the device.
    expect(payments).toMatch(/Apple's signed record of the transaction/);
    expect(payments).toMatch(/random token that ties an App Store purchase to your Relayium account/);
  });

  it("chinese Payments says the same thing in its own words", () => {
    const payments = strings(privacy.langs.zh).find((s) =>
      s.startsWith("在原生 App 内，订阅是通过 Apple 的 App Store 购买的"),
    );
    expect(payments, "the Payments bullet must lead with a platform-neutral native app").toBeTruthy();
    expect(payments).toMatch(/Apple 从你的 Apple ID 处理支付/);
    expect(payments).toMatch(/Apple 签名的交易记录/);
    expect(payments).toMatch(/随机令牌，把 App Store 购买与你的 Relayium 账号关联起来/);
  });

  it("does not restore a platform-specific purchase channel", () => {
    // Scoped to the purchase claim. "macOS" remains required in the separate
    // per-platform device-data section; what may not return is a sentence that
    // makes macOS the place a subscription is bought.
    const RETIRED_PLATFORM_SPECIFIC = {
      en: [
        { label: "purchased inside our macOS app", re: /purchased inside our macOS app/i },
        { label: "In our macOS app, subscriptions are bought", re: /In our macOS app, subscriptions are bought/i },
        { label: "macOS scoped to a purchase", re: /macOS[^.]{0,60}(in-app purchase|subscriptions are bought)/i },
        { label: "iOS scoped to a purchase", re: /iOS[^.]{0,60}(in-app purchase|subscriptions are bought)/i },
      ],
      zh: [
        { label: "在我们的 macOS App 内通过应用内购买", re: /在我们的 macOS App 内通过应用内购买/ },
        { label: "在我们的 macOS App 内，订阅", re: /在我们的 macOS App 内，订阅/ },
        { label: "macOS App 作用域内的购买", re: /macOS App[^。]{0,40}应用内购买/ },
        { label: "iOS App 作用域内的购买", re: /iOS App[^。]{0,40}应用内购买/ },
      ],
    };
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const { label, re } of RETIRED_PLATFORM_SPECIFIC[lang]) {
        expect(
          re.test(text),
          `${lang} privacy policy restored a platform-specific purchase channel (${label})`,
        ).toBe(false);
      }
    }
  });

  it("keeps both processors named, so going neutral did not drop one", () => {
    // The negative tests above would also pass if somebody deleted the Apple
    // bullet outright, which would be a different lie — so both processors are
    // required to still be named, each on its own channel.
    expect(textOf("en")).toMatch(/On the web, payments are handled by Stripe/);
    expect(textOf("en")).toMatch(/subscriptions are bought through Apple's App Store/);
    expect(textOf("zh")).toMatch(/在网页端，支付由 Stripe 处理/);
    expect(textOf("zh")).toMatch(/订阅是通过 Apple 的 App Store 购买的/);
  });

  it("never lets a card number or a payment method be described as ours", () => {
    expect(textOf("en")).toMatch(/We never receive or store your full card number\./);
    expect(textOf("en")).toMatch(/never card data/);
    expect(textOf("zh")).toMatch(/我们绝不接收或存储你的完整卡号。/);
    expect(textOf("zh")).toMatch(/绝不存储卡片数据/);
  });
});

describe("stored-link encryption is claimed for every client, not just the browser", () => {
  // `StoredWire`/`ChunkEncryptor` is the same AES-GCM framing in RelayiumKit that
  // the browser and the CLI implement, and `generateStoreKey()` mints the same 32
  // random bytes that only ever appear in the `#k=` fragment. A browser-only
  // sentence would understate the guarantee on the platform under review, and
  // understating a zero-knowledge claim is as wrong as overstating one.
  it("english covers browser, CLI and both native apps", () => {
    const en = textOf("en");
    expect(en).toMatch(/encrypted with AES-256-GCM on your own device before they leave it/);
    expect(en).toMatch(/our native macOS and iOS apps all encrypt and decrypt locally/);
    expect(en).toMatch(/The decryption key exists only in the URL fragment — it is never sent to the server\./);
  });

  it("chinese covers browser, CLI and both native apps", () => {
    const zh = textOf("zh");
    expect(zh).toMatch(/在离开你的设备之前就已在本机以 AES-256-GCM 加密/);
    expect(zh).toMatch(/我们的 macOS 与 iOS 原生 App，都在本地完成加解密/);
    expect(zh).toMatch(/解密密钥仅存在于链接的 URL 片段（# 部分）中，绝不发送至服务器。/);
  });
});

describe("the native-app section states each platform's device data exactly", () => {
  it("exists in both maintained locales and still carries three bullets", () => {
    for (const lang of MAINTAINED_LANGS) {
      const section = nativeSection(lang);
      expect(section, `${lang} native-app section`).toBeTruthy();
      // The frozen seven carry three bullets here and content.test.mjs requires
      // one shape across all nine, so this count is not cosmetic: changing it
      // would either break the archive or silently rewrite it.
      expect(section.bullets, `${lang} native-app bullets`).toHaveLength(3);
    }
  });

  // Every claim below is a fact about a specific platform. Splitting them into
  // two maps is the point: the failure this file is built to catch is a true
  // sentence attached to the wrong operating system.
  const MACOS_FACTS = {
    en: [
      /On macOS the app reads the computer name from your Mac's Sharing settings/,
      /macOS often seeds that name from your full name/,
      /An installation identifier, on macOS only\./,
      /32 random bytes the app generates on that Mac and keeps in its keychain/,
      /sent when you sign in through your browser/,
      /never derived from your hardware — no serial number, MAC address, or hostname/,
      /announced by macOS on that Mac itself/,
      /deliberately carry no file names, links, or codes/,
      /The macOS app asks for no camera access at all/,
    ],
    zh: [
      /在 macOS 上，App 会读取 Mac「共享」设置中的电脑名称/,
      /macOS 通常会以你的全名生成该名称/,
      /安装标识符，仅限 macOS。/,
      /32 字节随机值，保存在本机钥匙串中/,
      /通过浏览器登录时发送/,
      /绝不由硬件推导——不含序列号、MAC 地址或主机名/,
      /都由 macOS 在那台 Mac 本地提示/,
      /刻意不含文件名、链接或配对码/,
      /macOS App 完全不申请摄像头权限/,
    ],
  };

  const IOS_FACTS = {
    en: [
      /On iOS the label is generic and is never a name you chose/,
      /"iPhone", "iPad" or "iPod touch"/,
      /No personal name reaches us from an iPhone or iPad this way\./,
      /The iOS app has no browser sign-in to continue, so it generates no such identifier/,
      /it sends us no installation identifier and no identifier read from the device itself/,
      /the iOS app has no push capability and registers nothing with Apple's push service/,
      /The iOS app asks for the camera for one purpose/,
      /reading the pairing QR code another device is showing/,
      /that happens entirely on your device/,
      /nothing the camera sees is stored by the app or sent to us as camera data/,
      /the system's own picker runs outside the app and hands it only the items you chose/,
    ],
    zh: [
      /在 iOS 上，这个标签是通用的，绝不会是你自己起的名字/,
      /「iPhone」「iPad」或「iPod touch」/,
      /不会有任何个人姓名经由这条路径从 iPhone 或 iPad 到达我们/,
      /iOS App 没有需要接续的浏览器登录流程，因此不会生成这样的标识符/,
      /既不向我们发送安装标识符，也不发送任何从设备本身读取的标识符/,
      /iOS App 根本不具备推送能力，也不会向 Apple 的推送服务注册任何东西/,
      /iOS App 申请摄像头只有一个用途/,
      /读取另一台设备正在显示的配对二维码/,
      /这完全发生在你的设备上/,
      /摄像头看到的任何内容都不会被 App 保存，也不会作为摄像头数据发送给我们/,
      /是系统自带的选择器在 App 之外运行，只把你选中的项目交给 App/,
    ],
  };

  const SHARED_FACTS = {
    en: [
      /Neither registers a push token and neither receives push notifications/,
      /Neither app tracks you across other apps or websites, and neither contains advertising or third-party analytics SDKs\./,
    ],
    zh: [
      /两者都不注册推送令牌，也都不接收推送通知/,
      /两个 App 都不会跨其他 App 或网站追踪你，也都不含广告或第三方分析 SDK。/,
    ],
  };

  for (const lang of MAINTAINED_LANGS) {
    it(`${lang} states the macOS-only facts`, () => {
      const text = textOf(lang);
      for (const re of MACOS_FACTS[lang])
        expect(re.test(text), `${lang} lost a macOS fact (${re})`).toBe(true);
    });

    it(`${lang} states the iOS facts the binary under review actually exhibits`, () => {
      const text = textOf(lang);
      for (const re of IOS_FACTS[lang])
        expect(re.test(text), `${lang} lost an iOS fact (${re})`).toBe(true);
    });

    it(`${lang} states what neither app does`, () => {
      const text = textOf(lang);
      for (const re of SHARED_FACTS[lang])
        expect(re.test(text), `${lang} lost a both-platforms fact (${re})`).toBe(true);
    });
  }

  // Structural guards, because a regex over the whole document cannot tell that
  // a claim moved to the wrong platform — only that both strings are present
  // somewhere. These assert the two halves are in the SAME bullet, which is what
  // makes the scoping readable to a person rather than merely true in aggregate.
  const bulletWith = (lang, needle) =>
    nativeSection(lang).bullets.find((b) => b.includes(needle));

  it("scopes the installation identifier to macOS and denies it for iOS in one bullet", () => {
    const en = bulletWith("en", "installation identifier");
    expect(en, "english installation-identifier bullet").toBeTruthy();
    expect(en).toContain("on macOS only");
    expect(en).toContain("no installation identifier and no identifier read from the device itself");
    // The random device id in the account list is ours, not the phone's — the
    // distinction a reader most easily collapses.
    expect(en).toContain("is not derived from your phone");

    const zh = bulletWith("zh", "安装标识符");
    expect(zh, "chinese installation-identifier bullet").toBeTruthy();
    expect(zh).toContain("仅限 macOS");
    expect(zh).toContain("既不向我们发送安装标识符");
    expect(zh).toContain("并非由你的手机推导而来");
  });

  it("puts the iOS camera purpose and the macOS camera denial in one bullet", () => {
    const en = bulletWith("en", "camera");
    expect(en, "english camera bullet").toBeTruthy();
    expect(en).toContain("The iOS app asks for the camera for one purpose");
    expect(en).toContain("The macOS app asks for no camera access at all");

    const zh = bulletWith("zh", "摄像头");
    expect(zh, "chinese camera bullet").toBeTruthy();
    expect(zh).toContain("iOS App 申请摄像头只有一个用途");
    expect(zh).toContain("macOS App 完全不申请摄像头权限");
  });

  it("puts both platforms' device labels in one bullet", () => {
    const en = bulletWith("en", "The label this device carries in your account");
    expect(en, "english device-label bullet").toBeTruthy();
    expect(en).toContain("On macOS");
    expect(en).toContain("On iOS");

    const zh = bulletWith("zh", "本设备在你账号中显示的标签");
    expect(zh, "chinese device-label bullet").toBeTruthy();
    expect(zh).toContain("在 macOS 上");
    expect(zh).toContain("在 iOS 上");
  });
});

describe("the maintained pair describes behaviour and never claims availability", () => {
  // The 5.1.1 correction is about completeness, and the cheapest way to overshoot
  // it is to let a policy imply the app is on sale. It is not: no iOS build has
  // been published and nobody can install one. A policy may say how a binary
  // behaves without saying it exists in a store, and this is the line.
  const PUBLICATION_CLAIMS = {
    en: [
      { label: "available on the App Store", re: /available (?:now )?(?:on|in|from) the App Store/i },
      { label: "download the app", re: /download (?:our|the) (?:iOS |macOS )?app/i },
      { label: "available for download", re: /available for download/i },
      { label: "published", re: /\bpublish(?:ed|es)\b/i },
      { label: "you can install", re: /you can install/i },
      { label: "get it on the App Store", re: /get it on the App Store/i },
      { label: "now shipping", re: /now (?:shipping|available)/i },
    ],
    zh: [
      { label: "上架", re: /上架/ },
      { label: "已发布/已上线", re: /已(?:发布|上线|推出)/ },
      { label: "可下载", re: /可以?下载(?:我们的)?\s*(?:iOS|macOS)?\s*App/ },
      { label: "前往 App Store 下载", re: /(?:前往|去)\s*App Store/ },
      { label: "立即下载", re: /立即下载/ },
    ],
  };

  for (const lang of MAINTAINED_LANGS) {
    it(`${lang} makes no publication, store-availability or install claim`, () => {
      const text = textOf(lang);
      for (const { label, re } of PUBLICATION_CLAIMS[lang]) {
        expect(re.test(text), `${lang} privacy policy claims the app is available (${label})`).toBe(false);
      }
    });
  }

  it("still refuses the claims that were false in the other direction", () => {
    // The 2026-08-28 defects, kept banned. Each names a data flow no build has:
    // an APNs registration, a stored push token, and photo-library access. The
    // words "push token" and "photo library" are NOT banned — the maintained copy
    // uses both to deny them, and banning the noun would force the document to
    // stop making the clearer negative statement. What is banned is the
    // affirmative shape.
    const RETIRED = {
      en: [
        { label: "APNs", re: /APNs/ },
        { label: "Apple Push Notification service", re: /Apple Push Notification service/i },
        { label: "stores a device token", re: /we store an?\b[^.]*device token/i },
        { label: "delivers notifications from a server", re: /deliver notifications to your device/i },
        // "has access to your photo library" is the DENIAL the copy makes, so the
        // ban is the transitive verb form that would be a claim.
        { label: "reads the photo library", re: /(?:accesses|reads|uses) (?:your|the) photo librar/i },
        { label: "uploads from the library", re: /uploaded from (?:your|the) (?:camera|librar)/i },
      ],
      zh: [
        { label: "APNs", re: /APNs/ },
        { label: "推送通知服务令牌", re: /存储[^。]*推送(?:通知)?(?:服务)?[^。]*令牌/ },
        { label: "访问相册", re: /访问(?:你的)?相册/ },
        { label: "从相册上传", re: /从(?:相机|相册)[^。]*上传/ },
      ],
    };
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const { label, re } of RETIRED[lang]) {
        expect(re.test(text), `${lang} privacy policy restored a false claim (${label})`).toBe(false);
      }
    }
  });

  it("dates the maintained pair to this correction and leaves the frozen seven alone", () => {
    // The visible "Last updated" line is owned by the source file, one value per
    // locale. Maintained legal prose changed here, so its date moves; a frozen
    // translation whose prose did not change must not silently claim it was
    // reviewed on a day nobody reviewed it.
    for (const lang of MAINTAINED_LANGS)
      expect(privacy.langs[lang].updated, `${lang} last-updated`).toBe(MAINTAINED_DATE);
    for (const lang of FROZEN_LANGS)
      expect(privacy.langs[lang].updated, `${lang} last-updated`).toBe(FROZEN_DATE);
  });
});

describe("the generated pages carry the correction, and only where they should", () => {
  // A corrected source with a stale `public/` page is the same wrong answer one
  // build step later — and this URL is the one submitted to App Review, so the
  // generated artifact is the thing that actually gets read.
  it("en and zh are regenerated with the new date and the iOS facts", () => {
    for (const lang of MAINTAINED_LANGS) {
      const html = generatedPrivacyPage(lang);
      expect(html, `${lang} generated date`).toContain(MAINTAINED_DATE);
      expect(html, `${lang} generated iOS mention`).toContain("iOS");
      expect(html, `${lang} generated camera scope`).toMatch(
        lang === "en" ? /asks for no camera access at all/ : /完全不申请摄像头权限/,
      );
    }
  });

  it("the seven frozen pages keep their archived date and prose", () => {
    for (const lang of FROZEN_LANGS) {
      const html = generatedPrivacyPage(lang);
      expect(html, `${lang} generated date`).toContain(FROZEN_DATE);
      expect(html, `${lang} generated date`).not.toContain(MAINTAINED_DATE);
    }
  });
});

describe("the seven frozen translations keep their archived prose", () => {
  // The exact sentence each frozen locale carried on 2026-08-28, harvested from
  // the file rather than written from the English. If a well-meaning edit
  // "corrects" one of these — in either direction, toward macOS-only or toward
  // the new two-platform text — this fails, which is the point. A frozen locale
  // is corrected by retranslating it when it is restored, and restoring a locale
  // is an owner decision (PROJECT-GOVERNANCE, supported-language policy).
  const ARCHIVED_IOS_AND_MACOS = {
    ja: "iOS および macOS アプリでは、サブスクリプションは Apple のアプリ内課金を通じて購入されます。",
    ko: "iOS 및 macOS 앱에서는 Apple 인앱 구매를 통해 구독을 구매합니다.",
    de: "In unseren iOS- und macOS-Apps werden Abonnements über den In-App-Kauf von Apple erworben.",
    fr: "Dans nos applications iOS et macOS, les abonnements sont achetés via l'achat intégré d'Apple.",
    ar: "في تطبيقَي iOS وmacOS، تُشترى الاشتراكات عبر الشراء داخل التطبيق من Apple.",
    es: "En nuestras apps de iOS y macOS, las suscripciones se compran mediante la compra dentro de la app de Apple.",
    pt: "Nos nossos apps de iOS e macOS, as assinaturas são compradas por meio da compra no app da Apple.",
  };

  // The plural device-data lead-in each frozen locale still carries. The
  // maintained pair lost it in 2026-08 and has now grown its own two-platform
  // wording; neither event reaches the archive.
  const ARCHIVED_NATIVE_APPS_PLURAL = {
    ja: "当社のネイティブアプリは、ウェブサイトでは扱わない、デバイスレベルの小さなデータを扱います：",
    ko: "저희 네이티브 앱은 웹사이트에서는 다루지 않는 소량의 기기 수준 데이터를 처리합니다:",
    de: "Unsere nativen Apps verarbeiten einige wenige geräteseitige Daten, die die Website nicht verarbeitet:",
    fr: "Nos applications natives traitent quelques données au niveau de l'appareil que le site web ne traite pas :",
    ar: "تتعامل تطبيقاتنا الأصلية مع قدر ضئيل من البيانات على مستوى الجهاز لا يتعامل معها الموقع الإلكتروني:",
    es: "Nuestras apps nativas gestionan algunos datos a nivel de dispositivo que el sitio web no gestiona:",
    pt: "Nossos aplicativos nativos lidam com alguns dados no nível do dispositivo que o site não trata:",
  };

  // The two device-data bullets the maintained pair retired. They describe an
  // APNs token and photo-library access that no shipping build has, on either
  // platform — so they are the sharpest case for the freeze rule and the reason
  // they are pinned rather than swept. A frozen locale is not live legal text: it
  // is an archived translation, labelled as one on the rendered page.
  const ARCHIVED_APNS = {
    ja: "プッシュ通知：有効にした場合、デバイスに通知を配信できるよう、Apple Push Notification service（APNs）のデバイストークンを保存します。通知はいつでもデバイスの設定でオフにできます。",
    ko: "푸시 알림: 활성화하면 기기에 알림을 전달할 수 있도록 Apple Push Notification service(APNs) 기기 토큰을 저장합니다. 알림은 언제든지 기기 설정에서 끌 수 있습니다.",
    de: "Push-Benachrichtigungen: Wenn Sie diese aktivieren, speichern wir ein Gerätetoken des Apple Push Notification service (APNs), damit wir Benachrichtigungen an Ihr Gerät zustellen können. Sie können Benachrichtigungen jederzeit in den Geräteeinstellungen deaktivieren.",
    fr: "Notifications push : si vous les activez, nous stockons un jeton d'appareil Apple Push Notification service (APNs) afin de pouvoir livrer des notifications à votre appareil. Vous pouvez désactiver les notifications à tout moment dans les réglages de votre appareil.",
    ar: "الإشعارات الفورية: إذا فعّلتها، فإننا نخزّن رمز جهاز خاص بخدمة Apple Push Notification (APNs) حتى نتمكّن من إرسال الإشعارات إلى جهازك. يمكنك إيقاف الإشعارات في أي وقت من إعدادات جهازك.",
    es: "Notificaciones push: si las activas, almacenamos un token de dispositivo del Apple Push Notification service (APNs) para poder enviar notificaciones a tu dispositivo. Puedes desactivar las notificaciones en cualquier momento en los ajustes de tu dispositivo.",
    pt: "Notificações push: se você as ativar, armazenamos um token de dispositivo do Apple Push Notification service (APNs) para podermos entregar notificações ao seu dispositivo. Você pode desativar as notificações a qualquer momento nas configurações do seu dispositivo.",
  };

  const ARCHIVED_CAMERA_AND_PHOTOS = {
    ja: "カメラと写真：QR コードのスキャンや送信するファイルの選択のためにのみ、デバイス上で使用されます。お客様が意図的に転送を選んだファイル以外、カメラやライブラリから何も取得・アップロードされません。",
    ko: "카메라 및 사진: QR 코드를 스캔하거나 전송할 파일을 선택하는 용도로만 기기에서 사용됩니다. 사용자가 의도적으로 전송을 선택한 파일을 제외하고는 카메라나 라이브러리에서 어떤 것도 캡처되거나 업로드되지 않습니다.",
    de: "Kamera und Fotos: werden ausschließlich auf Ihrem Gerät verwendet, um einen QR-Code zu scannen oder Dateien zum Versenden auszuwählen. Aus der Kamera oder Ihrer Bibliothek wird nichts erfasst oder hochgeladen außer den Dateien, die Sie bewusst zum Übertragen auswählen.",
    fr: "Appareil photo et photos : utilisés uniquement sur votre appareil pour scanner un code QR ou choisir des fichiers à envoyer. Rien n'est capturé ni téléversé depuis l'appareil photo ou votre bibliothèque, à l'exception des fichiers que vous choisissez délibérément de transférer.",
    ar: "الكاميرا والصور: تُستخدَم فقط على جهازك لمسح رمز QR أو اختيار ملفات لإرسالها. لا يُلتقَط أو يُرفَع أي شيء من الكاميرا أو مكتبتك باستثناء الملفات التي تختار عمدًا نقلها.",
    es: "Cámara y fotos: se usan solo en tu dispositivo para escanear un código QR o elegir archivos que enviar. No se captura ni se sube nada de la cámara ni de tu biblioteca, salvo los archivos que decidas transferir deliberadamente.",
    pt: "Câmera e fotos: usadas apenas no seu dispositivo para escanear um código QR ou escolher arquivos para enviar. Nada é capturado ou enviado da câmera ou da sua biblioteca, exceto os arquivos que você escolhe deliberadamente transferir.",
  };

  it("pins one archived sentence per frozen locale", () => {
    for (const map of [
      ARCHIVED_IOS_AND_MACOS,
      ARCHIVED_NATIVE_APPS_PLURAL,
      ARCHIVED_APNS,
      ARCHIVED_CAMERA_AND_PHOTOS,
    ]) {
      expect(Object.keys(map).sort()).toEqual([...FROZEN_LANGS].sort());
    }
  });

  for (const lang of FROZEN_LANGS) {
    it(`${lang} is byte-stable and was not rewritten alongside en/zh`, () => {
      const text = textOf(lang);
      expect(
        text.includes(ARCHIVED_IOS_AND_MACOS[lang]),
        `${lang} privacy prose changed; frozen locales are corrected by retranslation, not by editing`,
      ).toBe(true);
      expect(
        text.includes(ARCHIVED_NATIVE_APPS_PLURAL[lang]),
        `${lang} device-data lead-in changed; frozen locales are corrected by retranslation, not by editing`,
      ).toBe(true);
      expect(
        text.includes(ARCHIVED_APNS[lang]),
        `${lang} APNs bullet changed; the maintained pair retired it, the archive keeps it`,
      ).toBe(true);
      expect(
        text.includes(ARCHIVED_CAMERA_AND_PHOTOS[lang]),
        `${lang} camera bullet changed; the maintained pair retired it, the archive keeps it`,
      ).toBe(true);
    });
  }
});
