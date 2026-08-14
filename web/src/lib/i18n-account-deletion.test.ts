// web/src/lib/i18n-account-deletion.test.ts — the注销文案在每种维护中语言里的安全断言。
//
// 这是产品里唯一一个「文案本身就是安全机制」的破坏性操作：按钮按下去只发一封确认邮件，
// 真正的删除全部发生在邮件里的链接被打开之后。所以一句翻译丢了，用户就会在对后果的
// 错误理解下按下一个破坏性控件——而且只在那一种语言里错，构建和截图都发现不了。
//
// 两类断言：
//
//  * **必须说的**：确认弹窗必须说清楚「打开链接之前什么都不会删」、被撤销的是服务端
//    会话和设备凭据、被抹除的是服务器上的文件和数据、账号会在 30 天宽限期后被永久
//    删除、以及宽限期内重新登录就能开始恢复。「什么都还没删」这一句在**成功提示**里
//    也必须在——那句话会留在屏幕上，缺了它就会被读成「办完了」。
//
//  * **不能说的**：端点在真发了邮件、被节流吞掉、发信失败三种情况下回的是同一个 200，
//    所以成功提示不能声称邮件已发送、账号已删除、删除已排期或流程已完成。确认弹窗也
//    不能承诺终止已经建立的 P2P 传输（服务端管不着），更不能把这封一次性的确认邮件说成
//    后面那封带恢复链接的邮件。
//
// token 表是一行一种语言手写的：断言「某个翻译还在说这件事」只有在有人真的读过那句话、
// 并且写下了它在那种语言里的说法时才算数。
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import type { Messages } from "./i18n/types";

const locales = { en, zh };
type Code = keyof typeof locales;

const ADDRESS = "ada@example.com";

type Claims = {
  /** 这门语言里的「邮件」。确认是走邮件的，任何翻译都不能把它变成应用内确认。 */
  email: string;
  /** 「打开那个链接之前，什么都不会删」——让这次请求成为安全动作的那一句。 */
  notYet: string;
  /** 说明终局是不可逆的那个词。 */
  permanent: string;
  /** 确认之后真正被撤销的服务端访问权。 */
  revoked: string;
  /** 真正被抹除的东西：服务器上存的文件和数据。 */
  erased: string;
  /** 宽限期的长度，带这门语言的「天」。 */
  graceDays: RegExp;
  /** 宽限期内被支持的恢复路径。 */
  reactivate: string;
  /** 产品做不到的承诺：终止已建立的对等传输、以及把确认邮件说成恢复邮件。 */
  overclaims: string[];
  /** 成功提示不能声称的既成事实。 */
  doneClaim: RegExp;
};

const claims: Record<Code, Claims> = {
  en: {
    email: "email",
    notYet: "Nothing is removed until that link is opened",
    permanent: "permanent",
    revoked: "sessions and device access",
    erased: "stored on the server",
    graceDays: /30-day grace period/,
    reactivate: "sign in again",
    overclaims: ["transfers in progress", "in-progress transfer", "same email"],
    doneClaim: /\bsent\b|\bdeleted\b|\bscheduled\b|\bcomplete/i,
  },
  zh: {
    email: "邮件",
    notYet: "在打开该链接之前，不会删除任何内容",
    permanent: "永久",
    revoked: "登录会话和设备访问权限",
    erased: "服务器上存储的文件和数据",
    graceDays: /30 天宽限期/,
    reactivate: "重新登录",
    overclaims: ["进行中的传输", "同一封邮件"],
    doneClaim: /已发送|已删除|已排期|已完成/,
  },
};

/** 这批新增的键在界面上真正会被渲染成什么。 */
function rendered(m: Messages) {
  return {
    deleteTitle: m.me.deleteTitle,
    deleteBody: m.me.deleteBody(ADDRESS),
    deleteAction: m.me.deleteAction,
    deleteConfirm: m.me.deleteConfirm(ADDRESS),
    deleteConfirmAction: m.me.deleteConfirmAction,
    deleteRequesting: m.me.deleteRequesting,
    deleteRequested: m.me.deleteRequested(ADDRESS),
    deleteFailed: m.me.deleteFailed,
  };
}

describe("account-deletion copy keeps its safety claims in every language", () => {
  for (const [code, m] of Object.entries(locales) as [Code, Messages][]) {
    const c = claims[code];
    const r = rendered(m);

    it(`${code}: 每一条都是真文案，而且带得动地址`, () => {
      for (const [key, text] of Object.entries(r)) {
        expect(text, `${code}.me.${key} 是空的`).toBeTruthy();
        expect(text, `${code}.me.${key} 首尾有多余空白`).toBe(text.trim());
        expect(text, `${code}.me.${key} 漏了模板占位符`).not.toContain("${");
        if (code !== "en") {
          const english = rendered(en)[key as keyof typeof r];
          expect(text, `${code}.me.${key} 还是英文原文`).not.toBe(english);
        }
      }
      // 三条带地址的：地址是用户数据，必须原样出现在译文里。
      for (const key of ["deleteBody", "deleteConfirm", "deleteRequested"] as const) {
        expect(r[key], `${code}.me.${key} 把地址弄丢了`).toContain(ADDRESS);
      }
    });

    it(`${code}: 确认弹窗把后果说全了`, () => {
      const confirm = r.deleteConfirm;
      expect(confirm, `${code}: 没说确认是走邮件的`).toContain(c.email);
      expect(confirm, `${code}: 没说打开链接之前什么都不会删`).toContain(c.notYet);
      expect(confirm, `${code}: 没说被撤销的是服务端会话和设备访问权`).toContain(c.revoked);
      expect(confirm, `${code}: 没说服务器上的文件和数据会被抹除`).toContain(c.erased);
      expect(confirm, `${code}: 没说账号最终会被永久删除`).toContain(c.permanent);
      expect(confirm, `${code}: 没说宽限期有多长`).toMatch(c.graceDays);
      expect(confirm, `${code}: 没说宽限期内怎么恢复`).toContain(c.reactivate);
    });

    it(`${code}: 确认弹窗不承诺产品做不到的事`, () => {
      for (const overclaim of c.overclaims) {
        // 已经建立的 P2P 传输不归服务端管；而这封一次性的确认邮件也不是后面那封
        // 带恢复链接的邮件——把两者说成一封，用户就会去翻错的邮件。
        expect(r.deleteConfirm, `${code}: 承诺了做不到的事（${overclaim}）`).not.toContain(overclaim);
      }
    });

    it(`${code}: 按钮标签说的是它真会做的事`, () => {
      // 弹窗上面那句话刚说完「什么都还没删」，按钮就不能读成「删除」——它做的是发邮件。
      expect(r.deleteConfirmAction, `${code}: 确认按钮没说自己发的是邮件`).toContain(c.email);
      expect(r.deleteRequesting, `${code}: 在途文案没说自己在等邮件`).toContain(c.email);
    });

    it(`${code}: 成功提示只声称「已请求」`, () => {
      const requested = r.deleteRequested;
      expect(requested, `${code}: 成功提示没重申「还什么都没删」`).toContain(c.notYet);
      expect(requested, `${code}: 成功提示里没有邮件这条线索`).toContain(c.email);
      // 端点在「真发了」「被节流吞了」「发信失败」三种情况下回的是同一个 200。
      expect(requested, `${code}: 成功提示声称了界面观察不到的既成事实`).not.toMatch(c.doneClaim);
    });

    it(`${code}: 入口文案在按下之前就把安全边界说了`, () => {
      expect(r.deleteBody, `${code}: 入口没说确认走邮件`).toContain(c.email);
      expect(r.deleteBody, `${code}: 入口没说打开链接之前什么都不会删`).toContain(c.notYet);
    });
  }
});
