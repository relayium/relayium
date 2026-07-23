import { describe, it, expect, beforeEach } from "vitest";
import { LANGS, detect, pageUrl, loadLang, setLang, lang, messages as liveMessages, type Lang, type Messages } from "./i18n.svelte";
// Language tables are code-split, so `messages` is empty until loaded at runtime.
// The completeness checks want every language synchronously, so import the split
// modules directly and reassemble the full record here.
import { PICK_MODES, FLAG_ROWS, TRUST_FILES, GUIDES } from "./cli-page-data";
import zh from "./i18n/zh";
import en from "./i18n/en";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const messages: Record<Lang, Messages> = { zh, en, ja, ko, de, fr, ar, es, pt };

describe("i18n completeness", () => {
  it("every language has nav tab labels and the cross-network method names", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.nav.lanTab, `${code}.nav.lanTab`).toBeTruthy();
      expect(m.nav.crossTab, `${code}.nav.crossTab`).toBeTruthy();
      expect(m.methods.realtime.name, `${code}.methods.realtime.name`).toBeTruthy();
      expect(m.methods.stored.name, `${code}.methods.stored.name`).toBeTruthy();
    }
  });

  it("every language has the stored-transfer + download strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.stored.pick, `${code}.stored.pick`).toBeTruthy();
      expect(m.stored.errQuota, `${code}.stored.errQuota`).toBeTruthy();
      expect(m.download.downloadBtn, `${code}.download.downloadBtn`).toBeTruthy();
      expect(m.download.notFound, `${code}.download.notFound`).toBeTruthy();
    }
  });

  it("every language has the pairing strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.pair.sendCode, `${code}.pair.sendCode`).toBeTruthy();
      expect(m.pair.enterCode, `${code}.pair.enterCode`).toBeTruthy();
      expect(m.pair.errExpired, `${code}.pair.errExpired`).toBeTruthy();
      expect(m.pair.expiresIn("5:00"), `${code}.pair.expiresIn`).toContain("5:00");
    }
  });

  it("every language has the change-password strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.account.changePassword, `${code}.account.changePassword`).toBeTruthy();
      expect(m.account.confirmPassword, `${code}.account.confirmPassword`).toBeTruthy();
      expect(m.account.errCurrentWrong, `${code}.account.errCurrentWrong`).toBeTruthy();
    }
  });

  it("every language has the window-drag strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.dragSendOne("Dev"), `${code}.dragSendOne`).toContain("Dev");
      expect(m.dragSendMany, `${code}.dragSendMany`).toBeTruthy();
    }
  });

  it("every language has the reconnect/leave, network-error, and upload-phase strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.reconnecting, `${code}.reconnecting`).toBeTruthy();
      expect(m.confirmLeave, `${code}.confirmLeave`).toBeTruthy();
      expect(m.account.errNetwork, `${code}.account.errNetwork`).toBeTruthy();
      expect(m.stored.encrypting, `${code}.stored.encrypting`).toBeTruthy();
      expect(m.stored.uploadingNow, `${code}.stored.uploadingNow`).toBeTruthy();
    }
  });

  it("every language has the cross-network login-gate and relay-quota strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.crossnet.signInToSend, `${code}.crossnet.signInToSend`).toBeTruthy();
      expect(m.crossnet.relayQuotaWarn, `${code}.crossnet.relayQuotaWarn`).toBeTruthy();
      expect(m.crossnet.relayQuotaFail, `${code}.crossnet.relayQuotaFail`).toBeTruthy();
    }
  });

  it("every language has the /verify-email and /reset-password strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.verifyEmail.checking, `${code}.verifyEmail.checking`).toBeTruthy();
      expect(m.verifyEmail.successBody, `${code}.verifyEmail.successBody`).toBeTruthy();
      expect(m.verifyEmail.noToken, `${code}.verifyEmail.noToken`).toBeTruthy();
      expect(m.verifyEmail.invalidTitle, `${code}.verifyEmail.invalidTitle`).toBeTruthy();
      expect(m.resetPassword.noToken, `${code}.resetPassword.noToken`).toBeTruthy();
      expect(m.resetPassword.submitBtn, `${code}.resetPassword.submitBtn`).toBeTruthy();
      expect(m.resetPassword.successBody, `${code}.resetPassword.successBody`).toBeTruthy();
      expect(m.resetPassword.invalidBody, `${code}.resetPassword.invalidBody`).toBeTruthy();
    }
  });

  it("every language has the account-page quota-meter strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.quota.title, `${code}.quota.title`).toBeTruthy();
      expect(m.quota.traffic, `${code}.quota.traffic`).toBeTruthy();
      expect(m.quota.storage, `${code}.quota.storage`).toBeTruthy();
      expect(m.quota.left("5 GB"), `${code}.quota.left`).toContain("5 GB");
      expect(m.quota.resets("Aug 1"), `${code}.quota.resets`).toContain("Aug 1");
      expect(m.quota.unlimited, `${code}.quota.unlimited`).toBeTruthy();
    }
  });

  it("every language has the transfer-surface 80%-quota-warning strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.quota.warn(80), `${code}.quota.warn`).toContain("80");
      expect(m.quota.upgrade, `${code}.quota.upgrade`).toBeTruthy();
    }
  });
});

describe("detect", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns a saved language when it is a real, own key", () => {
    localStorage.setItem("relayium-lang", "de");
    expect(detect()).toBe("de");
  });

  it("ignores a prototype-chain key like 'toString' instead of white-screening", () => {
    // Regression: `saved in messages` would resolve "toString" to Object.prototype's
    // function and later crash the whole app; validating against the static code
    // set (CODES.has) rejects it.
    localStorage.setItem("relayium-lang", "toString");
    const l = detect();
    expect(typeof messages[l].tagline).toBe("string");
  });

  it("ignores an unknown saved language", () => {
    localStorage.setItem("relayium-lang", "xx");
    expect(["zh", "ja", "ko", "de", "fr", "en"]).toContain(detect());
  });
});

describe("detect with ?lang=", () => {
  it("prefers a valid ?lang= over saved and navigator language", () => {
    localStorage.setItem("relayium-lang", "fr");
    expect(detect("?lang=ja")).toBe("ja");
  });

  it("ignores an invalid ?lang= value", () => {
    localStorage.setItem("relayium-lang", "fr");
    expect(detect("?lang=klingon")).toBe("fr");
  });

  it("ignores prototype-chain keys", () => {
    localStorage.clear();
    expect(detect("?lang=toString")).not.toBe("toString");
  });
});

describe("pageUrl", () => {
  it("leaves en unprefixed and prefixes other languages", () => {
    expect(pageUrl("compare/snapdrop", "en")).toBe("/compare/snapdrop");
    expect(pageUrl("how-to/send-large-files-without-cloud", "zh")).toBe("/zh/how-to/send-large-files-without-cloud");
  });
});

describe("learn strings", () => {
  it("every language has a non-empty hub label", () => {
    for (const { code } of LANGS) {
      expect(messages[code].learn.hub.length).toBeGreaterThan(0);
    }
  });
});

describe("language code-splitting", () => {
  it("bootstrap: after loadLang(lang()), the live table has the current language", async () => {
    // Mirrors main.ts: this is exactly what guarantees no undefined read at render.
    await loadLang(lang());
    expect(liveMessages[lang()]).toBeDefined();
    expect(liveMessages[lang()].tagline).toBeTruthy();
  });

  it("loadLang lazily populates a language table on demand", async () => {
    await loadLang("en");
    expect(liveMessages.en.tagline).toBeTruthy();
  });

  it("setLang loads the target table before switching the current language", async () => {
    await setLang("ja");
    expect(lang()).toBe("ja");
    expect(liveMessages.ja.tagline).toBeTruthy();
  });
});

// /cli 页把 cli-page-data.ts 的常量和这些文案**按下标**配对渲染。类型层面已经用
// 等长元组钉死了（见 cli-page-data.ts 的 SameLength），这里再加一道运行时兜底：
// 类型错误只在有人真的跑 `npm run check` 时才会被看见，而 CI 目前只跑发布流程。
// 错位的表现是静默的——第 i 条解释配到了第 i 个 flag 上，或者干脆渲染出 undefined。
describe("/cli 页的下标配对数组与代码常量等长", () => {
  const pairs: [string, readonly unknown[], (m: Messages) => readonly string[]][] = [
    ["pickWhen ↔ PICK_MODES", PICK_MODES, (m) => m.cliPage.pickWhen],
    ["flagMeanings ↔ FLAG_ROWS", FLAG_ROWS, (m) => m.cliPage.flagMeanings],
    ["fileDescs ↔ TRUST_FILES", TRUST_FILES, (m) => m.cliPage.fileDescs],
    ["guides ↔ GUIDES", GUIDES, (m) => m.cliPage.guides],
  ];
  for (const [label, constants, pick] of pairs) {
    it(`${label}：每种语言都是 ${constants.length} 条`, () => {
      for (const { code } of LANGS) {
        expect(pick(messages[code]).length, `${code} 的 ${label} 条数不对`).toBe(constants.length);
      }
    });
  }
  it("每一条文案都非空（漏翻会渲染成一个空格）", () => {
    for (const { code } of LANGS) {
      for (const [label, , pick] of pairs) {
        for (const [i, text] of pick(messages[code]).entries()) {
          expect(text.trim().length, `${code} 的 ${label} 第 ${i} 条是空的`).toBeGreaterThan(0);
        }
      }
    }
  });
});
