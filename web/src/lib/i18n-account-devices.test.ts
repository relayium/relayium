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
// 一小截设备 ID：同名两行就靠它区分，所以每种语言都得把它原样带进可访问名称和确认框。
const REF = "3f21a9";

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
    deviceNotUsedSinceSignIn: m.me.deviceNotUsedSinceSignIn,
    deviceSignedIn: m.me.deviceSignedIn(WHEN),
    deviceRef: m.me.deviceRef(REF),
    deviceRevoke: m.me.deviceRevoke,
    deviceRevokeLabel: m.me.deviceRevokeLabel(NAME, m.me.deviceKindApp, m.me.deviceRef(REF), m.me.deviceSignedIn(WHEN)),
    deviceConfirmRevoke: m.me.deviceConfirmRevoke(NAME, m.me.deviceKindApp, m.me.deviceRef(REF), m.me.deviceSignedIn(WHEN)),
    deviceKindApp: m.me.deviceKindApp,
    deviceKindCli: m.me.deviceKindCli,
    deviceEmptyHint: m.me.deviceEmptyHint,
    deviceRename: m.me.deviceRename,
    deviceRenameLabel: m.me.deviceRenameLabel(NAME),
    deviceRenameField: m.me.deviceRenameField(NAME),
    deviceRenameSave: m.me.deviceRenameSave,
    deviceRenameCancel: m.me.deviceRenameCancel,
    deviceRenameRejected: m.me.deviceRenameRejected,
    deviceRenameFailed: m.me.deviceRenameFailed,
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
      for (const key of ["deviceRevokeLabel", "deviceConfirmRevoke", "deviceRenameLabel", "deviceRenameField"] as const) {
        expect(r[key], `${code}.me.${key} 把设备名弄丢了`).toContain(NAME);
      }
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

    it(`${code}: 吊销的可访问名称与确认框都带齐了区分身份的四样`, () => {
      // 两行同名是允许的（改名之前它们**全都**叫 CLI）。所以这两句话必须同时说出
      // 标签、类型、ID 尾号和登录时间；少任何一样，用户就无从判断那个不可撤销的
      // 按钮会断掉哪一台。
      for (const key of ["deviceRevokeLabel", "deviceConfirmRevoke"] as const) {
        expect(r[key], `${code}.me.${key} 漏了设备名`).toContain(NAME);
        expect(r[key], `${code}.me.${key} 漏了类型`).toContain(r.deviceKindApp);
        expect(r[key], `${code}.me.${key} 漏了 ID 尾号`).toContain(REF);
        expect(r[key], `${code}.me.${key} 漏了登录时间`).toContain(WHEN);
      }
    });

    it(`${code}: 「自登录以来没用过」不是「从未使用」那种故障说法`, () => {
      // 刚批准完的令牌本来就还没用过。旧文案把这种正常状态说得像出了错，用户会
      // 因此去吊销一台自己刚刚登录好的机器。
      expect(r.deviceNotUsedSinceSignIn, `${code}.me.deviceNotUsedSinceSignIn 是空的`).toBeTruthy();
      expect(r.deviceSignedIn, `${code}.me.deviceSignedIn 没把时间带进去`).toContain(WHEN);
      expect(r.deviceRef, `${code}.me.deviceRef 没把 ID 尾号带进去`).toContain(REF);
    });

    it(`${code}: 改名那一组文案齐全，且失败与被拒是两句话`, () => {
      expect(r.deviceRenameLabel, `${code}.me.deviceRenameLabel 没指名哪一台`).toContain(NAME);
      expect(r.deviceRenameField, `${code}.me.deviceRenameField 没指名哪一台`).toContain(NAME);
      // 可访问名称必须含可见文字（WCAG 2.5.3 Label in Name）。
      expect(
        r.deviceRenameLabel.toLowerCase(),
        `${code}: 可访问名称里没有可见的「${r.deviceRename}」`,
      ).toContain(r.deviceRename.toLowerCase());
      // 「这个名字不能用」是用户能改的事，「请求失败了」值得重试——混成一句话，
      // 用户就会对着一个网络故障反复改名字。
      expect(
        r.deviceRenameRejected,
        `${code}: 名字被拒和请求失败是同一句话`,
      ).not.toBe(r.deviceRenameFailed);
    });

    it(`${code}: 空状态给得出下一步`, () => {
      // 空列表只说「没有设备」等于把用户留在原地：这一条得说出怎么让一台机器出现。
      expect(r.deviceEmptyHint, `${code}.me.deviceEmptyHint 是空的`).toBeTruthy();
      expect(r.deviceEmptyHint, `${code}: 空状态提示没提 relayium login`).toMatch(/relayium login/);
    });

    it(`${code}: 只说 CLI 的旧键没有残留`, () => {
      // 旧键留着就会有人继续读它，那份只说 CLI 的文案也就继续在某个角落生效。
      // deviceNeverUsed 同理：它那句「从未使用」是被这一批明确取代掉的。
      for (const stale of ["cliTitle", "cliIntro", "cliEmpty", "cliRevoke", "cliConfirmRevoke", "cliLastUsed", "cliNeverUsed", "deviceNeverUsed"]) {
        expect(stale in m.me, `${code}.me.${stale} 还在，被取代的旧文案没清干净`).toBe(false);
      }
    });
  }
});
