// web/src/lib/i18n-account-devices.test.ts — 账号设备区块的文案在九种语言里的真实性断言。
//
// 这个区块列的是「能代表账号行事的、可吊销的持令牌设备」，而它有两类：CLI
// （relayium login）和 App（macOS/iOS 原生登录，服务端记的 Kind = "app"）。文案
// 原本只说 CLI——App 加进来之后，任何一种语言里留着旧说法，那种语言的用户就会：
//
//  * 在标题/空状态里读到「这里只有 CLI」，于是不去找自己丢掉的那台 iPhone；
//  * 在确认框里读到「它的 CLI 令牌会失效」，然后对着一台 App 设备按下吊销——
//    对后果的理解是错的，而且只在那一种语言里错，构建和截图都发现不了。
//
// 所以这里断言的是每种语言都还在说全两类，确认框既指名要吊销的是哪一台、又不把
// 每一份凭据都说成 CLI 令牌。token 表一行一种语言手写：断言「这句译文还在说这件
// 事」只有在有人真的读过它、并写下了它在那种语言里的说法时才算数。
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";
import type { Messages } from "./i18n/types";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
type Code = keyof typeof locales;

// 用户起的名字，故意带上撇号和非 ASCII：它要原样穿过每一种语言的模板。
const NAME = "Lily's MacBook — 家里那台";
const WHEN = "2026-08-04 10:00";

type Claims = {
  /** 这门语言里的「App」。词形不止一种（App / 应用 / アプリ…），所以用正则。 */
  app: RegExp;
  /** CLI 是产品术语，九种语言都原样保留。 */
  cli: RegExp;
  /** 「浏览器登录不在这个列表里」——这个区块唯一的排除承诺。 */
  browsers: RegExp;
  /** 确认框里说明「设备要重新登录」的那一句。 */
  signInAgain: RegExp;
  /** 类型标签：App 那一列的说法。 */
  kindApp: string;
};

const claims: Record<Code, Claims> = {
  en: {
    app: /\bapps?\b/i,
    cli: /CLI/,
    browsers: /Browser sign-ins aren't listed here/,
    signInAgain: /has to sign in again/,
    kindApp: "App",
  },
  zh: {
    app: /App/,
    cli: /CLI/,
    browsers: /浏览器登录不在此列/,
    signInAgain: /需要重新登录/,
    kindApp: "App",
  },
  ja: {
    app: /アプリ|App/,
    cli: /CLI/,
    browsers: /ブラウザのサインインはここには表示されません/,
    signInAgain: /再サインインが必要/,
    kindApp: "アプリ",
  },
  ko: {
    app: /앱/,
    cli: /CLI/,
    browsers: /브라우저 로그인은 여기에 표시되지 않습니다/,
    signInAgain: /다시 로그인해야 합니다/,
    kindApp: "앱",
  },
  de: {
    app: /App/,
    cli: /CLI/,
    browsers: /Browser-Anmeldungen stehen nicht in dieser Liste/,
    signInAgain: /muss sich neu anmelden/,
    kindApp: "App",
  },
  fr: {
    app: /[Aa]pplications?/,
    cli: /CLI/,
    browsers: /connexions par navigateur ne figurent pas ici/,
    signInAgain: /devra se reconnecter/,
    kindApp: "Application",
  },
  ar: {
    // 词根而非带冠词的形态：同一个词在标题和正文里带的前缀不同（تطبيق / التطبيقات）。
    app: /تطبيق/,
    cli: /CLI/,
    browsers: /تسجيل الدخول من المتصفح لا تظهر هنا/,
    signInAgain: /تسجيل الدخول من جديد/,
    kindApp: "تطبيق",
  },
  es: {
    app: /\bapps?\b/i,
    cli: /CLI/,
    browsers: /inicios de sesión desde el navegador no aparecen aquí/,
    signInAgain: /iniciar sesión otra vez/,
    kindApp: "App",
  },
  pt: {
    app: /\bapps?\b/i,
    cli: /CLI/,
    browsers: /pelo navegador não aparecem aqui/,
    signInAgain: /precisará entrar novamente/,
    kindApp: "App",
  },
};

/** 这一组键在界面上真正会被渲染成什么。 */
function rendered(m: Messages) {
  return {
    deviceTitle: m.me.deviceTitle,
    deviceIntro: m.me.deviceIntro,
    deviceEmpty: m.me.deviceEmpty,
    deviceLastUsed: m.me.deviceLastUsed(WHEN),
    deviceNeverUsed: m.me.deviceNeverUsed,
    deviceRevoke: m.me.deviceRevoke,
    deviceRevokeLabel: m.me.deviceRevokeLabel(NAME, m.me.deviceKindApp),
    deviceConfirmRevoke: m.me.deviceConfirmRevoke(NAME),
    deviceKindApp: m.me.deviceKindApp,
    deviceKindCli: m.me.deviceKindCli,
  };
}

describe("账号设备区块的文案在每种语言里都覆盖 App 和 CLI", () => {
  for (const [code, m] of Object.entries(locales) as [Code, Messages][]) {
    const c = claims[code];
    const r = rendered(m);

    it(`${code}: 每一条都是真文案，而且带得动设备名`, () => {
      for (const [key, text] of Object.entries(r)) {
        expect(text, `${code}.me.${key} 是空的`).toBeTruthy();
        expect(text, `${code}.me.${key} 首尾有多余空白`).toBe(text.trim());
        expect(text, `${code}.me.${key} 漏了模板占位符`).not.toContain("${");
      }
      // 设备名是用户数据：两处带名字的都必须原样嵌进译文里。
      for (const key of ["deviceRevokeLabel", "deviceConfirmRevoke"] as const) {
        expect(r[key], `${code}.me.${key} 把设备名弄丢了`).toContain(NAME);
      }
      expect(r.deviceRevokeLabel, `${code}.me.deviceRevokeLabel 漏了设备类型`).toContain(r.deviceKindApp);
    });

    it(`${code}: 标题、导语、空状态都说全了 App 和 CLI 两类`, () => {
      for (const key of ["deviceTitle", "deviceIntro", "deviceEmpty"] as const) {
        expect(r[key], `${code}.me.${key} 没提 App —— 原生登录会被读成不在这里`).toMatch(c.app);
        expect(r[key], `${code}.me.${key} 没提 CLI`).toMatch(c.cli);
      }
    });

    it(`${code}: 导语说清楚浏览器登录不在这个列表里`, () => {
      // 区块名叫「已登录的设备」，但浏览器会话确实不在这儿。不说，用户会以为
      // 自己已经看到了全部登录。
      expect(r.deviceIntro, `${code}: 导语没说浏览器登录不在此列`).toMatch(c.browsers);
    });

    it(`${code}: 确认框指名道姓，且不把每一份凭据都说成 CLI 令牌`, () => {
      expect(r.deviceConfirmRevoke, `${code}: 确认框没说要吊销的是哪一台`).toContain(NAME);
      expect(
        r.deviceConfirmRevoke,
        `${code}: 对着一台 App 设备也说「它的 CLI 令牌会失效」`,
      ).not.toMatch(/CLI/i);
      expect(r.deviceConfirmRevoke, `${code}: 没说那台设备要重新登录`).toMatch(c.signInAgain);
    });

    it(`${code}: 吊销按钮的可访问名称包含它的可见文字`, () => {
      // WCAG 2.5.3 Label in Name：aria-label 会盖掉可见文字，语音控制的用户只能
      // 念出他们看得见的那个词。可访问名称里不含它，"点击 吊销" 就点不动。
      expect(
        r.deviceRevokeLabel.toLowerCase(),
        `${code}: 可访问名称里没有可见的「${r.deviceRevoke}」`,
      ).toContain(r.deviceRevoke.toLowerCase());
    });

    it(`${code}: 类型标签两类各有各的说法`, () => {
      expect(r.deviceKindApp, `${code}: App 标签不是这门语言的说法`).toBe(c.kindApp);
      expect(r.deviceKindCli, `${code}: CLI 标签变了样`).toMatch(c.cli);
      expect(r.deviceKindApp, `${code}: 两个类型标签一模一样，标了等于没标`).not.toBe(
        r.deviceKindCli,
      );
    });

    if (code !== "en") {
      it(`${code}: 不是照抄英文`, () => {
        const english = rendered(en);
        for (const key of ["deviceTitle", "deviceIntro", "deviceEmpty", "deviceConfirmRevoke"] as const) {
          expect(r[key], `${code}.me.${key} 还是英文原文`).not.toBe(english[key]);
        }
      });
    }

    it(`${code}: 只说 CLI 的旧键没有残留`, () => {
      // 旧键留着就会有人继续读它，那份只说 CLI 的文案也就继续在某个角落生效。
      for (const stale of ["cliTitle", "cliIntro", "cliEmpty", "cliRevoke", "cliConfirmRevoke", "cliLastUsed", "cliNeverUsed"]) {
        expect(stale in m.me, `${code}.me.${stale} 还在，只说 CLI 的旧文案没清干净`).toBe(false);
      }
    });
  }
});
