import { describe, it, expect, beforeEach } from "vitest";
import {
  LANGS, FROZEN_LANGS, isMaintainedLang, isFrozenLang, resolveLang,
  detect, pageUrl, loadLang, setLang, lang, messages as liveMessages,
  type Lang, type Messages,
} from "./i18n.svelte";
// Language tables are code-split, so `messages` is empty until loaded at runtime.
// The completeness checks want every maintained language synchronously, so
// import the split modules directly and reassemble the full record here. Two
// entries, because two is the whole maintained set — see i18n/types.ts.
import { PICK_MODES, FLAG_ROWS, TRUST_FILES, GUIDES } from "./cli-page-data";
import { TEXT_MAX_BYTES } from "./text-wire";
import zh from "./i18n/zh";
import en from "./i18n/en";

const messages: Record<Lang, Messages> = { zh, en };

// TEXT_MAX_BYTES as it can legitimately be rendered across the maintained locales:
// 65,536 · 65.536 · 65 536 (plain, NBSP or narrow NBSP group separator).
const GROUPED_MAX = new RegExp(
  String(TEXT_MAX_BYTES).replace(/^(\d+)(\d{3})$/, "$1[.,\\s\\u00a0\\u202f]?$2")
);

describe("i18n completeness", () => {
  it("every language has nav tab labels and the cross-network method names", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.verifyEmail.title, `${code}.verifyEmail.title`).toBeTruthy();
      expect(m.nav.lanTab, `${code}.nav.lanTab`).toBeTruthy();
      expect(m.nav.crossTab, `${code}.nav.crossTab`).toBeTruthy();
      expect(m.methods.realtime.name, `${code}.methods.realtime.name`).toBeTruthy();
      expect(m.methods.realtime.name, `${code}.methods.realtime.name owns no presentation glyph`).not.toContain("⚡");
      expect(m.methods.realtime.name, `${code}.methods.realtime.name is trimmed`).toBe(m.methods.realtime.name.trim());
      expect(m.crossnet.realtimeTitle, `${code}.crossnet.realtimeTitle owns no presentation glyph`).not.toContain("⚡");
      expect(m.crossnet.realtimeTitle, `${code}.crossnet.realtimeTitle is trimmed`).toBe(m.crossnet.realtimeTitle.trim());
      expect(m.compare.colLan, `${code}.compare.colLan`).toBeTruthy();
      expect(m.compare.colRealtime, `${code}.compare.colRealtime owns no presentation glyph`).not.toContain("⚡");
      expect(m.compare.colStored, `${code}.compare.colStored owns no presentation glyph`).not.toContain("📦");
      expect(m.compare.colLan, `${code}.compare.colLan is trimmed`).toBe(m.compare.colLan.trim());
      expect(m.compare.colRealtime, `${code}.compare.colRealtime is trimmed`).toBe(m.compare.colRealtime.trim());
      expect(m.compare.colStored, `${code}.compare.colStored is trimmed`).toBe(m.compare.colStored.trim());
      expect(m.methods.stored.name, `${code}.methods.stored.name`).toBeTruthy();
      expect(m.methods.stored.name, `${code}.methods.stored.name owns no presentation glyph`).not.toContain("📦");
      expect(m.methods.stored.name, `${code}.methods.stored.name is trimmed`).toBe(m.methods.stored.name.trim());
      expect(m.sharePending(3, "12.5 MB"), `${code}.sharePending count`).toMatch(/\b3\b/);
      expect(m.sharePending(3, "12.5 MB"), `${code}.sharePending size`).toContain("12.5 MB");
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

  // 统一工作区的表头把"一条链路 = 一个 SAS"这条产品规则摆在屏幕上。它按 PeerLinkStatus
  // 直接索引状态串，所以这五个键**必须是纯字符串**——取到函数就会把 "function…" 印出来。
  it("every language has the unified peer-workspace strings", () => {
    const stateKeys = [
      "stateIdle", "stateRequesting", "stateConnecting", "stateOpen", "stateFailed",
    ] as const;
    const plainKeys = [
      "heading", "disconnect", "lanesNote", "queuedHint", "queuedRemove",
      // The bounded relay lifetime and the correlated-loss boundary. A missing
      // one of these is a link that ends with no explanation at all.
      "relayExpiring", "endedRelay", "endedSignaling", "restart",
      "recoveryUnavailable", "queuedReleaseBtn",
      ...stateKeys,
    ] as const;
    for (const { code } of LANGS) {
      const m = messages[code].workspace;
      expect(m, `${code} is missing the workspace namespace`).toBeTruthy();
      for (const k of plainKeys) {
        const v = (m as Record<string, unknown>)[k];
        expect(typeof v, `${code}.workspace.${k} should be a string`).toBe("string");
        expect((v as string).trim().length, `${code}.workspace.${k} is empty`).toBeGreaterThan(0);
      }
      // The five link states must read as five distinct things, or the header
      // would say "connected" while the link is still being negotiated.
      expect(new Set(stateKeys.map((k) => m[k])).size, `${code}.workspace states are distinct`)
        .toBe(stateKeys.length);
      expect(m.peer("Alice"), `${code}.workspace.peer`).toContain("Alice");
      expect(m.queuedTitle(3), `${code}.workspace.queuedTitle`).toMatch(/\b3\b/);
      expect(m.queuedFiles(3), `${code}.workspace.queuedFiles`).toMatch(/\b3\b/);
      expect(m.queuedFiles(1), `${code}.workspace.queuedFiles`).toMatch(/\b1\b/);
      // The release control names WHAT is waiting, in both numbers: a bare
      // "files are waiting" is not enough to decide whether to send them.
      expect(m.queuedRelease(3, "12.5 MB"), `${code}.workspace.queuedRelease count`).toMatch(/\b3\b/);
      expect(m.queuedRelease(3, "12.5 MB"), `${code}.workspace.queuedRelease size`).toContain("12.5 MB");
      expect(m.queuedRelease(1, "1 kB"), `${code}.workspace.queuedRelease singular`).toContain("1 kB");
      // The two terminal reasons are different instructions ("start again" vs
      // "the pairing service is gone"), so they may never be the same sentence.
      expect(m.endedRelay, `${code}.workspace terminal reasons are distinct`).not.toBe(m.endedSignaling);
      // …and neither may be confused with the live warning that precedes one.
      expect(m.relayExpiring, `${code}.workspace.relayExpiring is not the terminal copy`)
        .not.toBe(m.endedRelay);
      // Losing signalling has a warning AND a terminal sentence, and they say
      // opposite things: one is "everything here still works, but it could not
      // come back", the other is "it is gone". Reusing one for the other tells
      // a user with a perfectly healthy connection to stop using it.
      expect(m.recoveryUnavailable, `${code}.workspace.recoveryUnavailable is not the terminal copy`)
        .not.toBe(m.endedSignaling);
    }
  });

  // Short labels with a length budget, because each sits in a row that wraps
  // beside other controls: `restart` is an inline action in the trust header,
  // and the three staging labels share one wrapping row inside the waiting
  // room's staging box, next to a per-file remove.
  //
  // `pair.sendCode` is deliberately NOT here, even though it took over the slot
  // `bareConnect` used to hold. bareConnect was a ghost button competing for
  // width in a row; sendCode is the choose screen's single full-width primary,
  // so it has the room. It could not meet this budget anyway without rewriting
  // established copy — "Crear un código de emparejamiento" is 33 characters and
  // is the correct Spanish for it.
  it("keeps the short action labels short in every language", () => {
    for (const { code } of LANGS) {
      for (const [where, label] of [
        [`${code}.pair.stageAdd`, messages[code].pair.stageAdd],
        [`${code}.pair.stageAddFolder`, messages[code].pair.stageAddFolder],
        [`${code}.pair.stageRemove`, messages[code].pair.stageRemove],
        [`${code}.workspace.restart`, messages[code].workspace.restart],
      ] as const) {
        expect(label, `${where} has copy`).toBeTruthy();
        expect(label.trim(), `${where} is trimmed`).toBe(label);
        expect(label.length, `${where} is short: ${label}`).toBeLessThanOrEqual(24);
        expect(label.endsWith("."), `${where} is not a sentence: ${label}`).toBe(false);
      }
    }
  });

  // The sender-side stop in a code room exists because the peer might be someone
  // who guessed a live code, and its entire remedy is "compare the code first".
  // A translation that drops that instruction leaves a prompt with no stated way
  // to answer it correctly — worse than no prompt, because it looks answered.
  it("every language tells the sender to compare the code before sending", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(typeof m.confirmRecvCompare, `${code}.confirmRecvCompare`).toBe("string");
      expect(m.confirmRecvCompare.trim().length, `${code}.confirmRecvCompare is empty`)
        .toBeGreaterThan(0);
      // It has to be a second sentence, not a restatement of who is asking.
      expect(m.confirmRecvCompare, `${code}.confirmRecvCompare is not confirmRecv`)
        .not.toBe(m.confirmRecv("X"));
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
      expect(m.resetPassword.title, `${code}.resetPassword.title`).toBeTruthy();
      expect(m.resetPassword.lead, `${code}.resetPassword.lead`).toBeTruthy();
      expect(m.resetPassword.submitBtn, `${code}.resetPassword.submitBtn`).toBeTruthy();
      expect(m.resetPassword.successBody, `${code}.resetPassword.successBody`).toBeTruthy();
      expect(m.resetPassword.invalidBody, `${code}.resetPassword.invalidBody`).toBeTruthy();
      expect(m.magicLink.title, `${code}.magicLink.title`).toBeTruthy();
      expect(m.download.title, `${code}.download.title`).toBeTruthy();
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
    // 保证改了 TEXT_MAX_BYTES 就会有测试红掉，而不是让维护中的两种译文里的旧数字继续骗人。
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

// The maintained/frozen split, at the type level and at the value level.
//
// `Lang` is the maintained set, not a subset of a wider union, so a frozen code
// is a compile error wherever a language is expected. TypeScript cannot be
// asked to prove that at runtime, so these check the two exported sets instead:
// they are what `LANGS`-driven selectors, the loader record and `Record<Lang,…>`
// are all built from, and a frozen code leaking into either is the defect.
describe("maintained and frozen locales are two disjoint sets", () => {
  it("offers exactly English and Simplified Chinese", () => {
    expect(LANGS.map((l) => l.code).sort()).toEqual(["en", "zh"]);
  });

  it("lists the seven frozen locales without any of them being selectable", () => {
    expect([...FROZEN_LANGS].sort()).toEqual(["ar", "de", "es", "fr", "ja", "ko", "pt"]);
    for (const frozen of FROZEN_LANGS) {
      expect(LANGS.some((l) => l.code === (frozen as string)), `${frozen} is selectable`).toBe(false);
      expect(isMaintainedLang(frozen), `${frozen} reads as maintained`).toBe(false);
      expect(isFrozenLang(frozen)).toBe(true);
    }
  });

  it("classifies both maintained languages as maintained and neither as frozen", () => {
    for (const { code } of LANGS) {
      expect(isMaintainedLang(code)).toBe(true);
      expect(isFrozenLang(code)).toBe(false);
    }
  });

  it("has a loadable table for every selectable language and no others", async () => {
    // The selector is what a reader clicks; the loaders are what answers. A code
    // in one and not the other is either a dead option or an unreachable table.
    for (const { code } of LANGS) {
      await loadLang(code);
      expect(liveMessages[code]?.tagline, `${code} has no table`).toBeTruthy();
    }
  });
});

describe("resolveLang maps any tag onto a maintained language", () => {
  it("resolves every zh variant to Simplified Chinese", () => {
    for (const tag of ["zh", "ZH", "zh-CN", "zh-Hans", "zh-Hant", "zh-TW", "zh_HK"]) {
      expect(resolveLang(tag), tag).toBe("zh");
    }
  });

  it("resolves every frozen locale to English", () => {
    for (const frozen of FROZEN_LANGS) {
      expect(resolveLang(frozen), frozen).toBe("en");
      expect(resolveLang(`${frozen}-XX`), `${frozen}-XX`).toBe("en");
    }
  });

  it("resolves unknown, empty and prototype-chain values to English", () => {
    for (const tag of ["", "klingon", "xx", "toString", "constructor", "__proto__", null, undefined]) {
      expect(resolveLang(tag), String(tag)).toBe("en");
    }
  });

  it("does not treat a tag that merely starts with the letters zh as Chinese", () => {
    // "zhuang" is a different language; prefix matching without a separator
    // would have claimed it.
    expect(resolveLang("zhuang")).toBe("en");
  });
});

describe("detect", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns a saved maintained language", () => {
    localStorage.setItem("relayium-lang", "zh");
    expect(detect()).toBe("zh");
  });

  it("falls a saved frozen language back to English", () => {
    // The migration case: a reader who chose Japanese before the freeze. The old
    // code matched "ja" against the nine-code set and selected a table that no
    // longer exists — a white screen, not a fallback.
    localStorage.setItem("relayium-lang", "ja");
    expect(detect()).toBe("en");
  });

  it("rewrites a stale saved language to what it now resolves to", () => {
    localStorage.setItem("relayium-lang", "de");
    detect();
    expect(localStorage.getItem("relayium-lang")).toBe("en");
  });

  it("leaves a still-valid saved language alone", () => {
    localStorage.setItem("relayium-lang", "zh");
    detect();
    expect(localStorage.getItem("relayium-lang")).toBe("zh");
  });

  it("ignores a prototype-chain key like 'toString' instead of white-screening", () => {
    // Regression: `saved in messages` would resolve "toString" to Object.prototype's
    // function and later crash the whole app.
    localStorage.setItem("relayium-lang", "toString");
    const l = detect();
    expect(typeof messages[l].tagline).toBe("string");
  });

  it("resolves an unknown saved language to a language that has a table", () => {
    localStorage.setItem("relayium-lang", "xx");
    expect(detect()).toBe("en");
  });
});

describe("detect with ?lang=", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("prefers a maintained ?lang= over saved and navigator language", () => {
    localStorage.setItem("relayium-lang", "en");
    expect(detect("?lang=zh")).toBe("zh");
  });

  it("resolves a frozen ?lang= to English", () => {
    // Archived pages and old bookmarks still carry these. English is the answer,
    // not a crash and not a silently ignored parameter.
    for (const frozen of FROZEN_LANGS) {
      expect(detect(`?lang=${frozen}`), frozen).toBe("en");
    }
  });

  it("resolves a zh variant in the query to Simplified Chinese", () => {
    // Previously an exact-match check: "zh-Hans" fell through to the browser,
    // while navigator.language of "zh-Hans" matched by prefix. Same input, two
    // answers, depending only on which door it came through.
    expect(detect("?lang=zh-Hans")).toBe("zh");
    expect(detect("?lang=zh-TW")).toBe("zh");
  });

  it("resolves an unknown ?lang= to English", () => {
    expect(detect("?lang=klingon")).toBe("en");
  });

  it("ignores prototype-chain keys", () => {
    expect(detect("?lang=toString")).toBe("en");
  });

  it("falls through to the saved language when ?lang= is absent or empty", () => {
    localStorage.setItem("relayium-lang", "zh");
    expect(detect("")).toBe("zh");
    expect(detect("?lang=")).toBe("zh");
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
    await setLang("zh");
    expect(lang()).toBe("zh");
    expect(liveMessages.zh.tagline).toBeTruthy();
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
  it("--server 的说明与适用命令列都包含 text", () => {
    const serverFlag = FLAG_ROWS.findIndex((row) => row.flag === "--server <url>");
    expect(serverFlag).toBeGreaterThanOrEqual(0);
    expect(FLAG_ROWS[serverFlag].who).toContain("text");
    for (const { code } of LANGS) {
      expect(messages[code].cliPage.flagMeanings[serverFlag], `${code} 的 --server 说明遗漏 text`).toContain("text");
    }
  });
});

// v0.12.0 起 CLI 传的不只是文件，还有临时文本。但**定位性**文案（标题、副标题、
// meta、平台卡片）当时全都停留在"从终端传文件"上——功能已经发布，介绍它的那句话
// 却还在描述上一个版本。这类偏差是静默的：模式小节里写着 text，读者却在页面顶部
// 和搜索结果里读到"只能传文件"，而没有任何测试会因此变红。
//
// 所以这里把"这几个键必须提到文本"钉住。用每种语言各自的词（而不是统一匹配 Latin
// 的 "text"）：命令名 text 在每种语言里都是原样出现的，若拿它当判据，一句纯粹讲
// send/receive 的话也能蒙混过关。运行时如今只有维护中的英文与简体中文两种，冻结的
// 七种归档语言由 scripts/pages/cli-text-positioning.test.mjs 按静态页守。
const TEXT_WORD: Record<Lang, RegExp> = {
  en: /\btext\b/i,
  zh: /文本/,
};

// 同一个偏差在 /apps 上是双份的：网页版现在也能发临时文本（“发送消息”），但整页的
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

});

// 这里原来是一条**负向**断言："原生卡片不许提文本，因为代码里还没有"。它当时是对的，
// 现在是反的：macOS 早就有配对码与附近传输的文件/文本，iOS 的 R3-D/E/F 也把直连
// 六位码、附近传输和账号管理全都做进去了。一条绿着的测试因此在守着过时的宣传语。
//
// 换成正向不变量：两张原生卡片都必须如实说出**已经实现**的文件与文本能力，同时守住
// 两条尚未实现的边界——公开分发（App Store / Mac App Store）和 iOS 的分享扩展。
// 用各语言自己的词，理由和 TEXT_WORD 一样：只匹配拉丁字母的话，中文那一格永远为真。
const FILE_WORD: Record<Lang, RegExp> = {
  en: /\bfiles?\b/i,
  zh: /文件/,
};

// 苹果在维护的这两种语言里都不翻译商店名，所以一条正则就够守住全部译文。
//
// 2026-08-28 改动：Mac App Store 上架是**真的**（1.3.8 自 2026-08-26 起公开，
// 记录在 web/mac-app-store-release.json），所以整页不再禁止提它——规则表
// apps-claim-rules.ts 里那条已经改成"只有 Mac App Store 这一家店可以提"。
// 这里保留的是更窄的一条：SPA 的 macOS **卡片**只有一份不分支的文案，分发状态由
// "现已可用"分组和清单驱动的 CTA 表达，所以卡片本身仍然不谈任何商店。渠道的说明
// 放在 chooser 里（见下面那条正向断言）。
const STORE_CLAIM = /app\s*store/i;

// macOS 卡片过去写着"已签名并通过公证，可一键安装"。被公证的是**更早一个构建**的
// DMG，而当时的 native-releases.json 是 available:false——页面上既没有下载，也没有
// 当前构建的公证结论。在没有下载的卡片上写"公证过、一键装"，读起来就是"现在就能装"。
// 清单如今是 available:true（macOS 1.2.3 已公开），但这条守卫仍然成立：SPA 卡片只有
// 一份不分支的文案，分发状态由"现已可用"分组和清单驱动的 CTA 表达，卡片只讲能力。
//
// 静态孪生页（scripts/pages/content/apps.mjs）由 macos-release-surface.test.mjs
// 管：那里同样禁止 MAC_AVAILABLE=false 分支使用签名/公证措辞，同时要求
// MAC_AVAILABLE=true 分支保留它——即真发布时该说的话不会被这条守卫删掉。这里之所以
// 单列一份，是因为 SPA 卡片只有一份文案、没有按清单分支，两边的判据不能共用。
const NOTARY_CLAIM: Record<Lang, RegExp> = {
  en: /notariz|one-click install/i,
  zh: /公证/,
};

describe("原生 macOS 卡片如实描述已实现的能力", () => {
  // 2026-08-28：iOS / Android / Windows 三张卡片已经删掉，所以这一组里原本
  // 逐条断言 cards.ios 的用例也一并删掉了——不是放宽，而是它们守的那段文案
  // 不该再存在。apps/ 下压根没有 Android 或 Windows 目标；iOS 开发已暂停，
  // 也没有公开上架。"这一页不许重新长出这三个 App"这条，由
  // apps-claim-rules.ts 里的新规则在两个渲染面上一起守。
  it("macOS 卡片不把公证/一键安装写成当前可得的分发状态", () => {
    for (const { code } of LANGS) {
      expect(messages[code].appsPage.cards.mac.desc, `${code} 的 macOS 卡片宣称了当前并不存在的公证下载`)
        .not.toMatch(NOTARY_CLAIM[code]);
    }
  });

  it("macOS 卡片在每种语言里都同时讲文件与临时文本", () => {
    for (const { code } of LANGS) {
      const { mac } = messages[code].appsPage.cards;
      expect(mac.desc, `${code} 的 macOS 卡片漏掉了已实现的文本能力`).toMatch(TEXT_WORD[code]);
      expect(mac.desc, `${code} 的 macOS 卡片漏掉了文件能力`).toMatch(FILE_WORD[code]);
    }
  });

  it("macOS 卡片本身不谈商店，渠道说明留给 chooser", () => {
    // 卡片文案不分支，清单一旦翻回 available:false 它也不会改一个字；商店与
    // 直接下载这两条渠道的差别属于"该选哪个"，放在 chooser 里说才不会变成
    // 一句随时可能过期的分发承诺。
    for (const { code } of LANGS) {
      expect(messages[code].appsPage.cards.mac.desc, `${code} 的 macOS 卡片把渠道写进了能力描述`)
        .not.toMatch(STORE_CLAIM);
    }
  });

  it("chooser 如实点出 Mac App Store 这条真实存在的渠道", () => {
    // 正向断言，因为这一整轮修的就是"页面被禁止说出一件真事"：上架是公开的，
    // 记录在 web/mac-app-store-release.json，app-store-release.test.mjs 守着它。
    for (const { code } of LANGS) {
      const points = messages[code].appsPage.chooser.mac.points.join("\n");
      expect(points, `${code} 的 chooser 没有提到 Mac App Store 这条渠道`)
        .toMatch(/Mac App Store/);
    }
  });

  it("chooser 的“其他平台”一句把浏览器说成正解，而不是某个 App 的替代品", () => {
    for (const { code } of LANGS) {
      const note = messages[code].appsPage.chooser.elsewhereNote;
      expect(note, `${code} 的说明漏掉了 Android`).toMatch(/Android/);
      expect(note, `${code} 的说明漏掉了 Windows`).toMatch(/Windows/);
      expect(note, `${code} 的说明没有指向浏览器/网页版`).toMatch(/browser|浏览器|网页版/i);
    }
  });

  // 英文是母本：把"哪些话不能说"钉在这里，跨语言的正则只需要守住上面那几条真正
  // 跨语言成立的判据，不必逐句复制译文（那等于把文案抄进测试）。
  it("英文原生文案保持已实现能力与未实现能力的边界", () => {
    const a = messages.en.appsPage;
    // macOS 的浏览器设备批准不是原生 Sign in with Apple，别把它写成后者。
    expect(a.cards.mac.desc).not.toMatch(/sign in with apple/i);
    // 整页定位曾把临时文本限定在网页版与命令行，而原生端现在两样都有。
    expect(a.metaDesc).not.toMatch(/text in the web app and the CLI/i);
    expect(a.subhead).not.toMatch(/text in the web app and the CLI/i);
    // 标题与描述曾经把 iOS / Android / Windows 列成"可获取的平台"。
    expect(a.metaTitle).not.toMatch(/\biOS\b|\bAndroid\b/i);
    expect(a.metaDesc).not.toMatch(/\biOS\b|\bAndroid\b/i);
  });
});

describe("定价页把临时文本纳入免费与计量边界", () => {
  const pricingCopy: [string, (m: Messages) => string][] = [
    ["subtitle", (m) => m.pricingPage.subtitle],
    ["freeLead", (m) => m.pricingPage.freeLead],
    ["free2", (m) => m.pricingPage.free2],
    ["free3", (m) => m.pricingPage.free3],
    ["freeWhy", (m) => m.pricingPage.freeWhy],
    ["paid1", (m) => m.pricingPage.paid1],
    ["a1", (m) => m.pricingPage.a1],
    ["a2", (m) => m.pricingPage.a2],
  ];

  for (const [label, pick] of pricingCopy) {
    it(`${label}：每种语言都明确覆盖文本`, () => {
      for (const { code } of LANGS) {
        expect(pick(messages[code]), `${code}.pricingPage.${label} 仍然只讲文件`).toMatch(TEXT_WORD[code]);
      }
    });
  }

  it("英文文案保持文本传输和计费的关键边界", () => {
    const p = messages.en.pricingPage;
    expect(p.free2).toMatch(/send or text code/);
    expect(p.free2).toMatch(/joining one never/i);
    expect(p.free3).toMatch(/servers keep no message bodies or history/i);
    expect(p.free3).toMatch(/either endpoint may retain/i);
    expect(p.a1).toMatch(/both devices online/i);
    expect(p.paid1).toMatch(/browser/i);
    expect(p.paid1).toMatch(/file or text/i);
  });
});
