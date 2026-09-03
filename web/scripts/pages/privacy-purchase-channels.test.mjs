// web/scripts/pages/privacy-purchase-channels.test.mjs — which apps the privacy
// policy says you can buy a subscription in, and which of the nine locales is
// allowed to answer that question.
//
// The defect this file closes was live in the maintained copy on 2026-08-28: the
// policy named "our iOS and macOS apps" as the in-app-purchase surface and Apple
// as the processor for iOS purchases. There is no iOS app. iOS development is
// paused and nothing has ever been published, so the only Apple in-app purchase
// a reader can actually make is in the Mac App Store build. A privacy policy is
// the wrong document to be aspirational in: it names processors, and naming a
// processor for a channel that does not exist misdescribes where a real person's
// payment data goes.
//
// The correction has two halves that pull against each other, which is why they
// are pinned together here:
//
//   1. **Maintained en/zh must be current.** They are the product's live legal
//      text. As of 2026-09-03 that means they name Apple's App Store as the
//      native purchase channel without naming a platform at all; see the
//      superseding note on the purchase-channel block below.
//   2. **The seven frozen locales must NOT be rewritten.** They are archived
//      translations under the 2026-08-14 language freeze; their prose is
//      byte-stable and is corrected by retranslation if a locale is ever
//      restored, never by an English-speaking editor reaching into it. Each one
//      is pinned by the exact sentence it still carries, so "fixing" a frozen
//      locale fails here rather than passing quietly.
//
// Both halves apply again, unchanged, to the second correction below: the
// device-level-data section, which described an APNs token and camera/photo
// access that exist in no macOS target. Same document, same freeze rule, same
// file.
//
// maintained-frozen-split.test.mjs owns the rendered-page half of the freeze
// (selectors, hreflang, archive notices). This file owns what the maintained
// privacy policy claims about the native app, in the source of record.
import { describe, it, expect } from "vitest";

import privacy from "./content/legal/privacy.mjs";
import { MAINTAINED_LANGS, FROZEN_LANGS, LANGS } from "./shared.mjs";

/** Every string in a locale's document, flattened, so a sentence cannot hide
 *  from this file by moving between `body` and `bullets`. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

const textOf = (lang) => strings(privacy.langs[lang]).join("\n");

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

  it("does not rewrite the seven frozen translations", () => {
    for (const lang of FROZEN_LANGS) {
      expect(privacy.langs[lang].updated).toBe("2026-08-13");
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
  // iOS purchase the moment one is possible — while "our iOS app" today would
  // advertise an app nobody can install.
  //
  // Platform-neutral wording is the only phrasing true in both states: the
  // store is Apple's App Store, the seller is Apple, and the policy names
  // neither a platform that cannot buy nor one that does not ship. Both halves
  // are pinned below, so neither the retired macOS-only wording nor a premature
  // iOS-availability claim can come back. This bridge deliberately changes the
  // purchase channel ONLY; the macOS-specific device-data section is a separate
  // claim and is pinned unchanged in the next block.
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

  it("does not restore the macOS-only purchase channel", () => {
    // Scoped to the purchase claim. "macOS" is still a legitimate — and
    // required — word elsewhere in this policy: the device-level-data section
    // is macOS-specific and is pinned as such in the next block. What may not
    // come back is a sentence that makes macOS the place a subscription is
    // bought.
    const RETIRED_MACOS_ONLY = {
      en: [
        { label: "purchased inside our macOS app", re: /purchased inside our macOS app/i },
        { label: "In our macOS app, subscriptions are bought", re: /In our macOS app, subscriptions are bought/i },
        { label: "macOS scoped to a purchase", re: /macOS[^.]{0,60}(in-app purchase|subscriptions are bought)/i },
      ],
      zh: [
        { label: "在我们的 macOS App 内通过应用内购买", re: /在我们的 macOS App 内通过应用内购买/ },
        { label: "在我们的 macOS App 内，订阅", re: /在我们的 macOS App 内，订阅/ },
        { label: "macOS App 作用域内的购买", re: /macOS App[^。]{0,40}应用内购买/ },
      ],
    };
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const { label, re } of RETIRED_MACOS_ONLY[lang]) {
        expect(
          re.test(text),
          `${lang} privacy policy restored the macOS-only purchase channel (${label})`,
        ).toBe(false);
      }
    }
  });

  it("still does not claim a publicly available iOS app", () => {
    // Unchanged in intent from the 2026-08-28 correction, and the reason this
    // bridge is narrow: going platform-neutral must not become a back door for
    // the iOS wording. No iOS app is published, so the policy may not put a
    // Relayium app on iOS — in the purchase section or anywhere else. The
    // `macOS or iOS` shapes are added because that is exactly the phrasing the
    // iOS feature branch carries, and it must not arrive early through here.
    const BANNED = {
      en: [
        { label: "our iOS app(s)", re: /\bour iOS\b/i },
        { label: "iOS and macOS apps", re: /iOS and macOS apps?/i },
        { label: "macOS or iOS", re: /macOS or iOS/i },
        { label: "iOS app", re: /\biOS app\b/i },
        { label: "purchases on iOS", re: /\biOS\b.{0,40}\b(in-app purchase|App Store)\b/ },
      ],
      zh: [
        { label: "我们的 iOS App", re: /我们的\s*iOS/ },
        { label: "iOS 与/或 macOS App", re: /iOS\s*[与和及或]\s*macOS/ },
        { label: "macOS 与/或 iOS App", re: /macOS\s*[与和及或]\s*iOS/ },
        { label: "iOS App", re: /iOS\s*App/ },
      ],
    };
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const { label, re } of BANNED[lang]) {
        expect(re.test(text), `${lang} privacy policy sells an iOS app (${label})`).toBe(false);
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
});

describe("maintained copy describes one native app, because there is one", () => {
  // Same defect family as the purchase channel above, found in the same sweep:
  // the section that introduces device-level data said "Our native apps" and
  // then described an APNs token. There is one native app. `apps/ios` is paused
  // and has never been published, so a plural here tells an iPhone owner that a
  // Relayium app on their phone is storing a push token for them.
  //
  // Narrowing the lead-in to macOS was only HALF the correction, and on its own
  // it made the document worse rather than better: it took three bullets written
  // about the paused iOS app and re-attached them to macOS, where two of them are
  // false. The macOS targets have no `aps-environment` in any of their
  // entitlements files, no `registerForRemoteNotifications` call anywhere under
  // `apps/mac` or `apps/RelayiumKit/Sources`, and no `NSCameraUsageDescription`
  // or `NSPhotoLibraryUsageDescription` in either Info.plist. A policy that
  // claims a push token and camera access the code cannot exercise is not
  // conservative — it is a false statement about where a real person's data goes,
  // in the one document that exists to answer that.
  it("english and chinese name macOS and do not pluralise", () => {
    const leadIns = {
      en: "Our macOS app handles a little device-level data that the website does not:",
      zh: "我们的 macOS App 会处理少量网站不涉及的设备级数据：",
    };
    for (const lang of MAINTAINED_LANGS) {
      expect(strings(privacy.langs[lang]), `${lang} device-data lead-in`).toContain(leadIns[lang]);
    }
    // The exact retired sentences, and the shape they could come back as.
    expect(textOf("en")).not.toContain("Our native apps");
    expect(textOf("en")).not.toMatch(/\b(our|the) native apps\b/i);
    expect(textOf("zh")).not.toContain("我们的原生 App");
    expect(textOf("zh")).not.toMatch(/原生\s*App\s*(们|们的)?[会都]/);
  });

  // The three bullets that replaced them, each traced to the call site and the
  // server column that keeps the value — the same discipline
  // `apps/mac/Relayium/PrivacyInfo.xcprivacy` is held to, because the manifest
  // and this policy are two public statements about one app and must not
  // disagree. Narrowing the lead-in only helps if what it introduces is true AND
  // still says something; an empty section would be a different failure.
  const PRESENT_MACOS_FACTS = {
    en: [
      // AppEnvironment.deviceName() reads Host.current().localizedName;
      // AccountClient.login sends it as `deviceName` into `devices.name`, and
      // LanDiscovery announces it to the same-network room.
      /computer name from your Mac's Sharing settings/,
      /tell your devices apart and you can sign one out/,
      // InstallationIdentity: 32 bytes from SecRandomCopyBytes, kept in the
      // keychain, posted as `install_id` by HTTPDeviceAuthClient.start.
      /32 random bytes the app generates on this Mac and keeps in its keychain/,
      /never derived from your hardware/,
      // UNUserNotificationCenter only: InboxNotifier and TransferNotifier compose
      // and post locally. NSPrivacyTracking is false and there is no third-party
      // network destination.
      /registers no push token and receives no push notifications/,
      /no advertising or third-party analytics SDKs/,
    ],
    zh: [
      /「共享」设置中的电脑名称/,
      /区分各台设备并注销其中一台/,
      /32 字节随机值并保存在本机钥匙串中/,
      /绝不由硬件推导/,
      /不注册推送令牌，也不接收推送通知/,
      /不含广告或第三方分析 SDK/,
    ],
  };

  it("states only device data the macOS build actually handles", () => {
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const re of PRESENT_MACOS_FACTS[lang]) {
        expect(re.test(text), `${lang} privacy policy dropped a present macOS fact (${re})`).toBe(true);
      }
    }
  });

  it("no longer claims a push token, a camera or a photo library on macOS", () => {
    // The retired iOS-derived claims, banned in the maintained pair only. The
    // frozen seven keep them and are pinned below — that asymmetry is the freeze
    // working, not an inconsistency.
    //
    // "push token" itself is NOT banned: the surviving bullet uses the words to
    // deny one, and banning the noun would force the policy to stop making the
    // clearer negative statement. What is banned is the service that would issue
    // it and the two device permissions the app never requests.
    const RETIRED = {
      en: [
        { label: "APNs", re: /APNs/ },
        { label: "Apple Push Notification service", re: /Apple Push Notification service/i },
        { label: "stores a device token", re: /we store an?\b[^.]*device token/i },
        { label: "camera", re: /\bcamera\b/i },
        { label: "photo library", re: /photo librar/i },
        { label: "your photos", re: /\bphotos\b/i },
      ],
      zh: [
        { label: "APNs", re: /APNs/ },
        { label: "推送通知服务", re: /推送通知服务/ },
        { label: "相机", re: /相机/ },
        { label: "相册", re: /相册/ },
        { label: "扫描二维码", re: /扫描二维码/ },
      ],
    };
    for (const lang of MAINTAINED_LANGS) {
      const text = textOf(lang);
      for (const { label, re } of RETIRED[lang]) {
        expect(re.test(text), `${lang} privacy policy restored a retired iOS claim (${label})`).toBe(false);
      }
    }
  });

  it("dates the maintained pair to this correction and leaves the frozen seven alone", () => {
    // The visible "Last updated" line is owned by this source file, one value
    // per locale. Maintained legal prose changed here, so its date moves; a
    // frozen translation whose prose did not change must not silently claim it
    // was reviewed on a day nobody reviewed it.
    for (const lang of MAINTAINED_LANGS)
      expect(privacy.langs[lang].updated, `${lang} last-updated`).toBe("2026-09-03");
    for (const lang of FROZEN_LANGS)
      expect(privacy.langs[lang].updated, `${lang} last-updated`).toBe("2026-08-13");
  });
});

describe("the seven frozen translations keep their archived prose", () => {
  // The exact sentence each frozen locale carried on 2026-08-28, harvested from
  // the file rather than written from the English. If a well-meaning edit
  // "corrects" one of these to macOS, this fails — which is the point. A frozen
  // locale is corrected by retranslating it when it is restored, and restoring a
  // locale is an owner decision (PROJECT-GOVERNANCE, supported-language policy).
  const ARCHIVED_IOS_AND_MACOS = {
    ja: "iOS および macOS アプリでは、サブスクリプションは Apple のアプリ内課金を通じて購入されます。",
    ko: "iOS 및 macOS 앱에서는 Apple 인앱 구매를 통해 구독을 구매합니다.",
    de: "In unseren iOS- und macOS-Apps werden Abonnements über den In-App-Kauf von Apple erworben.",
    fr: "Dans nos applications iOS et macOS, les abonnements sont achetés via l'achat intégré d'Apple.",
    ar: "في تطبيقَي iOS وmacOS، تُشترى الاشتراكات عبر الشراء داخل التطبيق من Apple.",
    es: "En nuestras apps de iOS y macOS, las suscripciones se compran mediante la compra dentro de la app de Apple.",
    pt: "Nos nossos apps de iOS e macOS, as assinaturas são compradas por meio da compra no app da Apple.",
  };

  // The plural device-data lead-in each frozen locale still carries. It is the
  // same sentence the maintained pair just lost, and it stays: a frozen locale
  // is corrected by retranslation when it is restored, not by an editor who
  // does not read it.
  const ARCHIVED_NATIVE_APPS_PLURAL = {
    ja: "当社のネイティブアプリは、ウェブサイトでは扱わない、デバイスレベルの小さなデータを扱います：",
    ko: "저희 네이티브 앱은 웹사이트에서는 다루지 않는 소량의 기기 수준 데이터를 처리합니다:",
    de: "Unsere nativen Apps verarbeiten einige wenige geräteseitige Daten, die die Website nicht verarbeitet:",
    fr: "Nos applications natives traitent quelques données au niveau de l'appareil que le site web ne traite pas :",
    ar: "تتعامل تطبيقاتنا الأصلية مع قدر ضئيل من البيانات على مستوى الجهاز لا يتعامل معها الموقع الإلكتروني:",
    es: "Nuestras apps nativas gestionan algunos datos a nivel de dispositivo que el sitio web no gestiona:",
    pt: "Nossos aplicativos nativos lidam com alguns dados no nível do dispositivo que o site não trata:",
  };

  // The two device-data bullets the maintained pair just retired, still standing
  // in each frozen locale. They are the sharpest case for the freeze rule and
  // the reason they are pinned rather than swept: they are WRONG about macOS,
  // and an editor who has just proved that has every reason to reach in and fix
  // seven translations they cannot read. A frozen locale is not live legal text
  // — it is an archived translation, labelled as one on the rendered page, and
  // it is corrected by retranslating it when the owner restores that locale.
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
