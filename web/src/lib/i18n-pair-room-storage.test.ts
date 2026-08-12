// web/src/lib/i18n-pair-room-storage.test.ts — 配对房间存储那组文案在九种语言里的
// 安全断言。
//
// 和注销那组同理：这里的文案本身就是安全机制。释放是**不可逆**的，而且如果对方
// 还没下载完，那次下载会直接失败——用户是在读完这两句之后才按下去的。哪种语言丢
// 了其中一句，那种语言的用户就会在对后果的错误理解下按一个破坏性按钮，而构建、
// 类型检查和截图都发现不了：Messages 是硬接口，它只保证键在，不保证那句话还在说
// 同一件事。
//
// 两类断言：
//
//  * **必须说的**：这些是**加密**副本（服务器打不开）；服务器不知道文件名，所以
//    列表里没有；确认弹窗必须同时说清「不可逆」和「可能让对方的下载失败」；每一
//    条失败/冲突提示都必须说「什么都没有删除」——那句话留在屏幕上，缺了它，一次
//    409 会被读成「删掉了一部分」。
//  * **不能说的**：释放只动服务器上的副本。它不会取消或中断对方那条 P2P 传输
//    （服务端管不着），也没有任何"恢复/撤销/备份"可言——承诺得回来的东西，是这个
//    功能唯一不能给的。
//
// token 表一行一种语言手写：断言"某个翻译还在说这件事"，只有在有人真的读过那句
// 话、并写下了它在那种语言里的说法时才算数。
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

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
type Code = keyof typeof locales;

type Claims = {
  /** 「加密」在这门语言里的说法。副本是密文，服务器解不开——这是整段的前提。 */
  encrypted: string;
  /** 「没有文件名」——列表里为什么一个名字都没有。 */
  noNames: string;
  /** 「不可逆」。确认弹窗里必须有。 */
  irreversible: string;
  /** 「对方还没下完的话，他的下载会失败」。确认弹窗里必须有。 */
  receiverFails: string;
  /** 「什么都没有删除」。每一条失败/冲突提示里都必须有。 */
  nothingRemoved: string;
  /** 做不到的承诺：取消对方的传输、把释放掉的东西找回来。 */
  overclaims: string[];
};

const claims: Record<Code, Claims> = {
  en: {
    encrypted: "encrypted",
    noNames: "no file names",
    irreversible: "cannot be undone",
    receiverFails: "download will fail",
    nothingRemoved: "nothing was removed",
    overclaims: ["restore", "recover", "cancel the transfer", "backup"],
  },
  zh: {
    encrypted: "加密",
    noNames: "没有文件名",
    irreversible: "不可撤销",
    receiverFails: "下载会直接失败",
    nothingRemoved: "什么都没有删除",
    overclaims: ["恢复", "备份", "取消传输", "中断传输"],
  },
  ja: {
    encrypted: "暗号化",
    noNames: "ファイル名はありません",
    irreversible: "取り消せません",
    receiverFails: "ダウンロードは失敗します",
    nothingRemoved: "何も削除",
    overclaims: ["復元", "バックアップ", "転送をキャンセル"],
  },
  ko: {
    encrypted: "암호화",
    noNames: "파일 이름은 없습니다",
    irreversible: "되돌릴 수 없으며",
    receiverFails: "다운로드는 실패합니다",
    nothingRemoved: "아무것도 삭제",
    overclaims: ["복원", "백업", "전송 취소"],
  },
  de: {
    encrypted: "verschlüsselt",
    noNames: "keine dateinamen",
    irreversible: "nicht rückgängig machen",
    receiverFails: "download fehl",
    nothingRemoved: "es wurde nichts entfernt",
    overclaims: ["wiederherstell", "backup", "übertragung abbrechen"],
  },
  fr: {
    encrypted: "chiffré",
    noNames: "aucun nom de fichier",
    irreversible: "irréversible",
    receiverFails: "téléchargement échouera",
    nothingRemoved: "rien n'a été supprimé",
    overclaims: ["restaur", "sauvegarde", "annuler le transfert"],
  },
  ar: {
    encrypted: "مشفّر",
    noNames: "بلا أسماء ملفات",
    irreversible: "لا يمكن التراجع",
    receiverFails: "فسيفشل تنزيله",
    nothingRemoved: "لم يُحذف شيء",
    overclaims: ["استعادة", "نسخة احتياطية", "إلغاء النقل"],
  },
  es: {
    encrypted: "cifrad",
    noNames: "sin nombres de archivo",
    irreversible: "irreversible",
    receiverFails: "descarga fallará",
    nothingRemoved: "no se eliminó nada",
    overclaims: ["restaur", "copia de seguridad", "cancelar la transferencia"],
  },
  pt: {
    encrypted: "cifrad",
    noNames: "sem nomes de arquivo",
    irreversible: "irreversível",
    receiverFails: "download dele vai falhar",
    nothingRemoved: "nada foi removido",
    overclaims: ["restaur", "backup", "cancelar a transferência"],
  },
};

const codes = Object.keys(locales) as Code[];

// 一门语言里 pairStorage 命名空间的全部可读文本，参数化的那几条用代表值展开。
function everything(code: Code): string {
  const m = locales[code].pairStorage;
  return [
    m.title, m.intro, m.noName, m.release, m.confirm, m.confirmAction,
    m.busy, m.errBusy, m.errWaiting, m.errFailed, m.released,
    m.totals(3, "12.5 MB"), m.objects(2), m.since("2026-01-02"),
    m.releaseAria("room-abc"), m.truncated(200),
  ].join("\n").toLowerCase();
}

describe("pairStorage copy — 必须说的", () => {
  it.each(codes)("%s 说清了这些是加密副本、而且没有文件名", (code) => {
    const m = locales[code].pairStorage;
    const c = claims[code];
    expect(m.intro.toLowerCase(), `${code}.intro 必须说明这些是加密副本`).toContain(c.encrypted.toLowerCase());
    expect(m.noName.toLowerCase(), `${code}.noName 必须解释为什么没有文件名`).toContain(c.noNames);
    // 列表里一个文件名都拿不到，所以任何一句都不能反过来暗示能按名字挑。
    expect(m.title.trim(), `${code}.title 前后不能有空白`).toBe(m.title);
  });

  it.each(codes)("%s 的确认弹窗同时说了不可逆和对方下载会失败", (code) => {
    const m = locales[code].pairStorage;
    const c = claims[code];
    const confirm = m.confirm.toLowerCase();
    expect(confirm, `${code}.confirm 必须说明这是不可逆的`).toContain(c.irreversible.toLowerCase());
    expect(confirm, `${code}.confirm 必须说明可能让对方的下载失败`).toContain(c.receiverFails.toLowerCase());
    // 弹窗按钮不能是泛化的「确定」：这句话问的是一个破坏性动作。
    expect(m.confirmAction.trim().length, `${code}.confirmAction 不能为空`).toBeGreaterThan(0);
  });

  it.each(codes)("%s 的每条失败/冲突提示都说明什么都没有删除", (code) => {
    const m = locales[code].pairStorage;
    const c = claims[code];
    for (const [key, msg] of Object.entries({ errBusy: m.errBusy, errWaiting: m.errWaiting, errFailed: m.errFailed })) {
      expect(msg.toLowerCase(), `${code}.${key} 必须说清楚什么都没有删除`).toContain(c.nothingRemoved.toLowerCase());
    }
  });

  it.each(codes)("%s 的参数化文案真的把参数印出来了", (code) => {
    const m = locales[code].pairStorage;
    expect(m.totals(3, "12.5 MB"), `${code}.totals 笔数`).toMatch(/\b3\b/);
    expect(m.totals(3, "12.5 MB"), `${code}.totals 体积`).toContain("12.5 MB");
    expect(m.objects(2), `${code}.objects`).toMatch(/\b2\b/);
    expect(m.since("2026-01-02"), `${code}.since`).toContain("2026-01-02");
    // 无障碍名必须点名是哪一笔传输——一列重复的「释放」什么也没命名。
    expect(m.releaseAria("room-abc"), `${code}.releaseAria`).toContain("room-abc");
    expect(m.truncated(200), `${code}.truncated`).toContain("200");
  });

  // 生命周期本身，正面钉住，九种语言各一条。
  //
  // 隔壁那条「不能说的」只挡住了反面：文案不许暗示这些副本会自己到期。可它挡不住
  // 文案对这件事**闭口不谈**——而沉默恰恰是最糟的那种，因为用户对"服务器上的东西"
  // 的默认预期就是"过一阵子会清掉"。一段既没说会过期、也没说不会过期的介绍，读者
  // 会自动补上错的那半句，然后什么都不做。
  //
  // 服务端 invariant 5 是字面意义的：已配对的房间没有任何时钟。副本只在三种情况下
  // 消失——对方确认收到、你自己按下释放、账号被注销。这个界面是其中第二种的唯一
  // 入口，所以这两句（"没有倒计时"和"要你来释放"）必须同时在场：只说前一句是在
  // 陈述一个无解的问题，只说后一句会被读成"我不释放也会有别的机制兜底"。
  it.each(codes)("%s 同时说清了没有倒计时、以及要由你来释放", (code) => {
    const intro = locales[code].pairStorage.intro.toLowerCase();
    // 一行一种语言手写：断言"这句话还在说这件事"，只有在有人真的读过那句译文、
    // 并写下了它在那种语言里的说法时才算数。
    const noTimer: Record<Code, string> = {
      en: "no timer",
      zh: "没有任何倒计时",
      ja: "時間で消えることはありません",
      ko: "시간이 지나도 사라지지",
      de: "keine frist",
      fr: "aucun délai",
      ar: "لا مؤقّت",
      es: "ningún temporizador",
      pt: "nenhum temporizador",
    };
    const youRelease: Record<Code, string> = {
      en: "until you release them",
      zh: "在你释放之前",
      ja: "解放するまで",
      ko: "해제할 때까지",
      de: "bis du sie freigibst",
      fr: "jusqu'à ce que vous les libériez",
      ar: "إلى أن تحرّرها",
      es: "hasta que las liberes",
      pt: "até você liberá-las",
    };
    expect(intro, `${code}.intro 必须明说没有任何倒计时会清掉它们`).toContain(noTimer[code].toLowerCase());
    expect(intro, `${code}.intro 必须明说要由用户自己释放`).toContain(youRelease[code].toLowerCase());
  });
});

describe("pairStorage copy — 不能说的", () => {
  it.each(codes)("%s 不承诺取消对方的传输，也不承诺能找回来", (code) => {
    const all = everything(code);
    for (const claim of claims[code].overclaims) {
      expect(all, `${code} 的文案不能承诺「${claim}」——释放只删服务器上的副本，既拦不住对方那条 P2P 传输，也没有任何找回的可能`)
        .not.toContain(claim.toLowerCase());
    }
  });

  it.each(codes)("%s 不把释放说成一个会自己发生的事", (code) => {
    const m = locales[code].pairStorage;
    // 这个产品刻意没有为已配对的传输设任何到期时间（服务端 invariant 5）。文案
    // 因此不能出现"到期""过期""N 天后自动删除"之类的说法——那会让用户以为可以
    // 什么都不做地等它消失，而它永远不会。
    const forbidden: Record<Code, string[]> = {
      en: ["expire", "automatically deleted", "after 30 days"],
      zh: ["到期", "过期", "自动删除"],
      ja: ["期限切れ", "自動的に削除"],
      ko: ["만료", "자동으로 삭제"],
      de: ["läuft ab", "automatisch gelöscht"],
      fr: ["expire", "automatiquement supprim"],
      ar: ["تنتهي صلاحية", "تُحذف تلقائيًا"],
      es: ["caduca", "se elimina automáticamente"],
      pt: ["expira", "excluída automaticamente"],
    };
    const all = everything(code);
    for (const word of forbidden[code]) {
      expect(all, `${code} 的文案不能暗示这些副本会自己到期消失`).not.toContain(word.toLowerCase());
    }
    expect(m.intro.length, `${code}.intro 不能是空的`).toBeGreaterThan(0);
  });
});
