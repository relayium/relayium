import { describe, it, expect, beforeEach } from "vitest";
import { LANGS, detect, pageUrl, loadLang, setLang, lang, messages as liveMessages, type Lang, type Messages } from "./i18n.svelte";
// Language tables are code-split, so `messages` is empty until loaded at runtime.
// The completeness checks want every language synchronously, so import the split
// modules directly and reassemble the full record here.
import { PICK_MODES, FLAG_ROWS, TRUST_FILES, GUIDES } from "./cli-page-data";
import { TEXT_MAX_BYTES } from "./text-wire";
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

// TEXT_MAX_BYTES as it can legitimately be rendered across the nine locales:
// 65,536 · 65.536 · 65 536 (plain, NBSP or narrow NBSP group separator).
const GROUPED_MAX = new RegExp(
  String(TEXT_MAX_BYTES).replace(/^(\d+)(\d{3})$/, "$1[.,\\s\\u00a0\\u202f]?$2")
);

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

  // 编译期的完整性靠 `npm run check`（Messages 是硬接口），但 CI 不跑它，所以运行时
  // 这一道才是真正会拦住漏翻的。
  it("每种语言都有完整的 text 命名空间", () => {
    // errorKey 能取到的那几个键**必须是纯字符串**：面板直接 {t.text[errorKey]} 渲染，
    // 取到一个函数就会把 "function..." 印到页面上。见 TextErrorKey。
    const errorKeys = ["tooLong", "flooding", "unsupported", "peerBusy", "failed", "refused"] as const;
    const plainKeys = [
      "panelTitle", "open", "connecting", "composePlaceholder", "send", "sendHint",
      "useFileInstead", "accept", "reject", "waitingAccept", "open_", "ended",
      "copy", "copied", "clear", "clearConfirm", "emptyHistory", "you",
      "ephemeralNote", "clipboardNote", "sasCompare", ...errorKeys,
    ] as const;
    for (const { code } of LANGS) {
      const m = messages[code].text;
      expect(m, `${code} 缺少 text 命名空间`).toBeTruthy();
      for (const k of plainKeys) {
        const v = (m as Record<string, unknown>)[k];
        expect(typeof v, `${code}.text.${k} 应该是字符串`).toBe("string");
        expect((v as string).trim().length, `${code}.text.${k} 是空的`).toBeGreaterThan(0);
      }
      // 带参数的三条：确认参数真的被用上了，而不是被翻译时丢掉。
      // 分组分隔符跟运行时 locale 走，所以别把逗号钉死——只要求两个数字都出现。
      expect(m.byteCount(10, 65536), `${code}.text.byteCount`).toMatch(/\b10\b/);
      expect(m.byteCount(10, 65536), `${code}.text.byteCount`).toMatch(/65[.,\s\u00a0]?536/);
      expect(m.requestHead("Alice"), `${code}.text.requestHead`).toContain("Alice");
      expect(m.newMessageFrom("Alice"), `${code}.text.newMessageFrom`).toContain("Alice");
      expect(m.peer("Alice"), `${code}.text.peer`).toContain("Alice");
    }
  });

  // 发送快捷键和"回车换行"这条约定是内容保真的一部分：提示文案里必须真的提到回车，
  // 否则用户会以为回车就是发送，而这个功能的全部意义是保留多行。
  it("每种语言的 sendHint 都提到回车与发送快捷键", () => {
    for (const { code } of LANGS) {
      expect(messages[code].text.sendHint, `${code}.text.sendHint`).toMatch(/⌘|Ctrl/);
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

// 首页把文本摆到与文件并列的位置，靠的全是文案。这几条钉住的是**产品事实**而不是措辞：
// 少一条 point、漏译一种语言、或者上限数字跟 TEXT_MAX_BYTES 脱钩，都会让首页开始承诺
// 我们没有实现的东西（尤其"不落服务器"和"每条上限"这两条）。
describe("homepage 文本定位文案", () => {
  it("每种语言都有完整的 homeText 区块", () => {
    for (const { code } of LANGS) {
      const h = messages[code].homeText;
      expect(h, `${code} 缺少 homeText`).toBeTruthy();
      expect(h.title.trim().length, `${code}.homeText.title 是空的`).toBeGreaterThan(0);
      expect(h.sub.trim().length, `${code}.homeText.sub 是空的`).toBeGreaterThan(0);
    }
  });

  it("三条事实（会话内端到端加密 / 双方在线 / 不落服务器）一条都不能少", () => {
    const expected = messages.en.homeText.points.length;
    expect(expected).toBe(3);
    for (const { code } of LANGS) {
      const points = messages[code].homeText.points;
      expect(points.length, `${code}.homeText.points 条数不对`).toBe(expected);
      for (const [i, p] of points.entries()) {
        expect(p.trim().length, `${code}.homeText.points 第 ${i} 条是空的`).toBeGreaterThan(0);
      }
    }
  });

  it("每种语言的上限文案都印出真实的 TEXT_MAX_BYTES", () => {
    // 分组分隔符跟 locale 走（65,536 / 65.536 / 65 536），所以只要求数字本身出现。
    for (const { code } of LANGS) {
      expect(messages[code].homeText.limit(TEXT_MAX_BYTES), `${code}.homeText.limit`).toMatch(GROUPED_MAX);
    }
  });

  it("每种语言的 FAQ 都回答了「能不能只发文本」，并给出真实上限", () => {
    // 上限是硬事实：FAQ 是纯字符串（faq.items 没有函数形参），所以这里代替类型系统，
    // 保证改了 TEXT_MAX_BYTES 就会有测试红掉，而不是让九种译文里的旧数字继续骗人。
    for (const { code } of LANGS) {
      const answers = messages[code].faq.items.map((q) => q.a).join("\n");
      expect(answers, `${code}.faq.items 没有提到每条消息的字节上限`).toMatch(GROUPED_MAX);
    }
  });

  it("不把 Phase 1 文本会话写成复用文件传输的同一条连接", () => {
    // 当前实现为文本建立独立 peer connection、独立握手与 SAS。Phase 2 才计划
    // 让文件和文本共享 PeerLink；在那之前，「同一条连接」是安全语义错误。
    const forbidden: Record<Lang, RegExp> = {
      en: /same (?:encrypted |peer )?connection/i,
      zh: /同一条.*连接/u,
      ja: /同じ.*接続/u,
      ko: /같은 P2P 연결/u,
      de: /dieselbe.*verbindung/iu,
      fr: /même connexion/iu,
      ar: /(?:الاتصال|اتصال).*نفسه/u,
      es: /misma conexión/iu,
      pt: /mesma conexão/iu,
    };
    for (const { code } of LANGS) {
      const m = messages[code];
      const copy = [m.descDefault || "", m.homeText.sub, ...m.faq.items.map((q) => q.a)].join("\n");
      expect(copy, `${code} 把文本错误描述成复用文件连接`).not.toMatch(forbidden[code]);
    }
  });

  it("faq 的四组问答在每种语言里条数一致（漏译会让某语言少一条）", () => {
    for (const key of ["items", "home", "cross", "offline"] as const) {
      const expected = messages.en.faq[key].length;
      for (const { code } of LANGS) {
        expect(messages[code].faq[key].length, `${code}.faq.${key} 条数不对`).toBe(expected);
      }
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
  it("把实时文本作为独立模式，并为传输页提供非空提示", () => {
    expect(PICK_MODES.some((mode) => mode.title === "text" && mode.cmd === "relayium text [code]")).toBe(true);
    for (const { code } of LANGS) {
      expect(messages[code].text.availabilityHint.trim().length, `${code} 缺少文本功能提示`).toBeGreaterThan(0);
      expect(messages[code].cliPage.textIntro, `${code} 的 CLI 文本流程没有说明创建端与加入端`).toContain("relayium text");
      expect(messages[code].cliPage.cloudIntro, `${code} 的账号说明遗漏 text 创建配对码`).toContain("text");
    }
  });
});

// v0.12.0 起 CLI 传的不只是文件，还有临时文本。但**定位性**文案（标题、副标题、
// meta、平台卡片）当时全都停留在"从终端传文件"上——功能已经发布，介绍它的那句话
// 却还在描述上一个版本。这类偏差是静默的：模式小节里写着 text，读者却在页面顶部
// 和搜索结果里读到"只能传文件"，而没有任何测试会因此变红。
//
// 所以这里把"这几个键必须提到文本"钉住。用每种语言各自的词（而不是统一匹配 Latin
// 的 "text"）：命令名 text 在九种语言里都是原样出现的，若拿它当判据，一句纯粹讲
// send/receive 的话也能蒙混过关。
const TEXT_WORD: Record<Lang, RegExp> = {
  en: /\btext\b/i,
  zh: /文本/,
  ja: /テキスト/,
  ko: /텍스트/,
  de: /Text/,
  fr: /texte/i,
  es: /texto/i,
  pt: /texto/i,
  // منصّة（平台）里就含有 نص 这两个连续字母，而"选择你的平台"恰恰是 appsPage.subhead
  // 的结尾——直接写 /نص/ 的话，阿拉伯语那一格永远为真，等于没测。排掉前面带 م 的写法。
  ar: /(?<!م)نص/,
};

// 同一个偏差在 /apps 上是双份的：网页版也一直能发临时文本（“发送消息”），但整页的
// meta、副标题和网页版卡片同样只写文件。所以列表里既有 CLI 的键，也有 /apps 的页面级
// 与网页版键——这两个平台是文本真正发布了的地方。
describe("平台定位文案覆盖文件与临时文本", () => {
  const positioning: [string, (m: Messages) => string][] = [
    ["cli.subtitle", (m) => m.cli.subtitle],
    ["cliCallout.blurb", (m) => m.cliCallout.blurb],
    ["appsPage.metaDesc", (m) => m.appsPage.metaDesc],
    ["appsPage.subhead", (m) => m.appsPage.subhead],
    ["appsPage.cards.web.desc", (m) => m.appsPage.cards.web.desc],
    ["appsPage.cards.cli.desc", (m) => m.appsPage.cards.cli.desc],
    ["cliPage.metaTitle", (m) => m.cliPage.metaTitle],
    ["cliPage.metaDesc", (m) => m.cliPage.metaDesc],
    ["cliPage.whichIntro", (m) => m.cliPage.whichIntro],
  ];
  for (const [label, pick] of positioning) {
    it(`${label}：每种语言都提到文本，而不只是文件`, () => {
      for (const { code } of LANGS) {
        expect(pick(messages[code]), `${code} 的 ${label} 仍然只讲文件`).toMatch(TEXT_WORD[code]);
      }
    });
  }

  it("freenote 把 text 列进不经过服务器的模式", () => {
    // 这一条只能匹配命令名：freenote 列的是子命令（push/pull、send/receive…），
    // 本来就不该在里面翻译成"文本"。
    for (const { code } of LANGS) {
      expect(messages[code].cliPage.freenote, `${code} 的 freenote 漏掉了 text`).toContain("text");
    }
  });

  it("原生 macOS / iOS 卡片不跟着宣称支持文本（代码里还没有）", () => {
    for (const { code } of LANGS) {
      const { mac, ios } = messages[code].appsPage.cards;
      expect(mac.desc, `${code} 的 macOS 卡片宣称了未实现的文本能力`).not.toMatch(TEXT_WORD[code]);
      expect(ios.desc, `${code} 的 iOS 卡片宣称了未实现的文本能力`).not.toMatch(TEXT_WORD[code]);
    }
  });
});
