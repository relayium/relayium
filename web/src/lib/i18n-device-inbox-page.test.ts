// web/src/lib/i18n-device-inbox-page.test.ts — the /device-inbox copy, in all
// nine languages.
//
// Four sentences on this page are product requirements rather than wording, and
// a translation that loses one is a lie only speakers of that language ever see.
// So they are checked per language, with each language's own words — a regex
// that only matches Latin script is a test that passes vacuously in eight of
// nine locales (the failure mode i18n.test.ts's TEXT_WORD table already names).
//
//  1. **Uploaded is not saved** (PRD §10). The two results never share one word.
//  2. **A share link cannot write to a disk** (PRD §8). Two permissions, kept
//     apart; this is the one that stops "anyone with the link" from ever
//     becoming "anyone with the link can put files on your server".
//  3. **Receiving is enabled AT the device**, and cannot be switched on for it
//     from the web (PRD §8: automatic receive is off by default).
//  4. **Offline is a queue, not a refusal** (PRD §7.3). Copy that reads as
//     "cannot" would delete the reason the asynchronous queue exists.
//
// The structural half below is the weaker second check, not the whole of it: it
// catches a locale that was never updated, which the hand-written claims cannot,
// because those only run against strings that already exist.
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
import { REQUIRED_PLATFORM_IDS } from "./device-inbox-platforms";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
type Code = keyof typeof locales;
const CODES = Object.keys(locales) as Code[];

type Claims = {
  /** "the device wrote the file to disk" — as a thing distinct from uploading. */
  notSaved: RegExp;
  /** A link can never make one of your devices write to disk. */
  linkBoundary: RegExp;
  /** The web cannot switch receiving on for a device. */
  enableThere: RegExp;
  /** Offline means the task WAITS. */
  queues: RegExp;
};

const claims: Record<Code, Claims> = {
  en: {
    notSaved: /wrote the file to disk/i,
    linkBoundary: /never make one of your devices write to disk/i,
    enableThere: /cannot be made for it from the web/i,
    queues: /waits in the queue/i,
  },
  zh: {
    notSaved: /设备把文件写进磁盘/,
    linkBoundary: /永远不能让你的某台设备往磁盘里写/,
    enableThere: /无法从网页替它做/,
    queues: /留在队列里/,
  },
  ja: {
    notSaved: /ディスクに書き込んだ/,
    linkBoundary: /ディスク書き込みをさせることは決してありません/,
    enableThere: /ウェブ側から代行することはできません/,
    queues: /キューで待ち/,
  },
  ko: {
    notSaved: /디스크에 파일을 쓴/,
    linkBoundary: /디스크 기록을 시키는 일은 결코 없습니다/,
    enableThere: /웹에서 대신해 줄 수는 없습니다/,
    queues: /대기열에서 기다리다가/,
  },
  de: {
    notSaved: /die Datei geschrieben/i,
    linkBoundary: /niemals eines deiner Geräte dazu bringen, auf die Festplatte zu schreiben/i,
    enableThere: /kann das Web nicht stellvertretend treffen/i,
    queues: /wartet in der Warteschlange/i,
  },
  fr: {
    notSaved: /écrit le fichier sur son disque/i,
    linkBoundary: /jamais faire écrire l'un de vos appareils sur son disque/i,
    enableThere: /ne peut pas être fait à sa place depuis le web/i,
    queues: /attend dans la file/i,
  },
  ar: {
    notSaved: /كتب الجهاز الملف على القرص/,
    linkBoundary: /أن يجعل أحد أجهزتك يكتب على القرص أبدًا/,
    enableThere: /لا يمكن اتخاذه نيابة عنه من الويب/,
    queues: /تنتظر المهمة المشفّرة في الطابور/,
  },
  es: {
    notSaved: /el dispositivo escribió el archivo en disco/i,
    linkBoundary: /nunca puede hacer que uno de tus dispositivos escriba en disco/i,
    enableThere: /no se puede tomar por él desde la web/i,
    queues: /espera en la cola/i,
  },
  pt: {
    notSaved: /o dispositivo gravou o arquivo em disco/i,
    linkBoundary: /nunca pode fazer um dispositivo seu gravar em disco/i,
    enableThere: /não pode ser feita pela web em nome dele/i,
    queues: /espera na fila/i,
  },
};

describe.each(CODES)("%s /device-inbox copy", (code) => {
  const d = locales[code].deviceInboxPage;
  const c = claims[code];

  it("keeps 'uploaded to Relayium' apart from 'saved on the device'", () => {
    expect(d.notSavedBody).toMatch(c.notSaved);
    expect(d.notSavedH3.trim().length).toBeGreaterThan(0);
  });

  it("states that a share link can never make a device write to disk", () => {
    expect(d.linkBoundary).toMatch(c.linkBoundary);
  });

  it("says receiving is switched on at the device, not from the web", () => {
    expect(d.prereqEnable).toMatch(c.enableThere);
  });

  it("says an offline device queues rather than refuses", () => {
    expect(d.prereqOffline).toMatch(c.queues);
  });

  it("interpolates the values the dynamic states are about", () => {
    expect(d.signedInLead("a@b.c")).toContain("a@b.c");
    expect(d.stateNoInbox(3)).toMatch(/\b3\b/);
    expect(d.stateReady(2)).toMatch(/\b2\b/);
    expect(d.statusLabel("X")).toContain("X");
  });

  it("gives the three release statuses three distinct words", () => {
    // A locale that translated two of them identically would show "planned" and
    // "available now" as the same badge — the one thing the badge exists to do.
    const set = new Set([d.statusAvailable, d.statusTesting, d.statusPlanned]);
    expect(set.size).toBe(3);
  });

  it("writes a full section for every platform the page names", () => {
    for (const id of REQUIRED_PLATFORM_IDS) {
      const p = d.platforms[id];
      expect(p, `${code}.platforms.${id}`).toBeTruthy();
      for (const [field, value] of Object.entries(p)) {
        expect(typeof value, `${code}.platforms.${id}.${field}`).toBe("string");
        expect(value.trim().length, `${code}.platforms.${id}.${field} is empty`).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(d.platforms).sort()).toEqual([...REQUIRED_PLATFORM_IDS].sort());
  });

  it("carries every list the page iterates, non-empty", () => {
    for (const [name, list] of [
      ["badges", d.badges],
      ["howSteps", d.howSteps],
      ["safetyPoints", d.safetyPoints],
    ] as const) {
      expect(list.length, `${code}.${name}`).toBeGreaterThan(0);
      for (const [i, s] of list.entries()) {
        expect(s.trim().length, `${code}.${name}[${i}] is empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the nine locales are nine translations, not nine copies of English", () => {
  it("keeps every list the same length across locales", () => {
    for (const key of ["badges", "howSteps", "safetyPoints"] as const) {
      const want = en.deviceInboxPage[key].length;
      for (const code of CODES) {
        expect(locales[code].deviceInboxPage[key].length, `${code}.${key}`).toBe(want);
      }
    }
  });

  it("has no locale sharing a translated sentence with another", () => {
    // A locale filled in by copy-pasting its neighbour passes every structural
    // check above. Comparing long, distinctive sentences is what catches it.
    for (const pick of [
      (c: Code) => locales[c].deviceInboxPage.subhead,
      (c: Code) => locales[c].deviceInboxPage.notSavedBody,
      (c: Code) => locales[c].deviceInboxPage.linkBoundary,
      (c: Code) => locales[c].deviceInboxPage.platforms.server.residency,
    ]) {
      const values = CODES.map(pick);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("never leaves the English string in a translated slot", () => {
    // Every non-English locale must differ from English in every prose field of
    // the section. Commands and paths are NOT here — they live in
    // device-inbox-platforms.ts precisely because they must stay invariant.
    const prose = (c: Code) => {
      const d = locales[c].deviceInboxPage;
      return [
        d.metaTitle, d.metaDesc, d.heading, d.subhead, d.howLead, d.notSavedH3, d.notSavedBody,
        d.prereqAccount, d.prereqSameAccount, d.prereqEnable, d.prereqOffline,
        d.linkBoundaryH3, d.linkBoundary, d.startH2, d.startChecking, d.signedOutLead,
        d.signInCta, d.createAccountCta, d.myDevicesCta, d.stateUnknown, d.stateNone,
        d.setUpServerCta, d.platformsH2, d.platformsLead,
        d.statusAvailable, d.statusTesting, d.statusPlanned,
        d.labelUse, d.labelSetup, d.labelFiles, d.labelResidency, d.labelSend,
        d.labelRecovery, d.labelStop, d.macNoDownload, d.macDownloadCta,
        d.safetyH2, d.docsH2, d.docsServerGuide, d.docsCli, d.docsMyDevices,
        ...REQUIRED_PLATFORM_IDS.flatMap((id) => {
          const p = d.platforms[id];
          return [p.use, p.setup, p.files, p.residency, p.send, p.recovery, p.stop];
        }),
      ];
    };
    const english = prose("en");
    for (const code of CODES.filter((c) => c !== "en")) {
      const mine = prose(code);
      const untranslated = mine
        .map((v, i) => (v === english[i] ? i : -1))
        .filter((i) => i >= 0);
      expect(untranslated, `${code} left ${untranslated.length} English strings in place`).toEqual([]);
    }
  });

  it("names all six platforms distinctly within each locale", () => {
    for (const code of CODES) {
      const names = REQUIRED_PLATFORM_IDS.map((id) => locales[code].deviceInboxPage.platforms[id].name);
      expect(new Set(names).size, `${code} reuses a platform name`).toBe(names.length);
    }
  });

  it("gives the nav label its own short string in every locale", () => {
    for (const code of CODES) {
      const label = locales[code].nav.deviceInboxTab;
      expect(label.trim(), `${code}.nav.deviceInboxTab`).toBe(label);
      expect(label.length, `${code}.nav.deviceInboxTab is empty`).toBeGreaterThan(0);
      // It shares a scrolling rail with five other destinations; a paragraph
      // here is a rail nobody can read on a phone.
      expect(label.length, `${code}.nav.deviceInboxTab is too long for the rail`).toBeLessThanOrEqual(24);
    }
    expect(new Set(CODES.map((c) => locales[c].nav.deviceInboxTab)).size).toBeGreaterThan(1);
  });
});

// A truthfulness rule, so it belongs in every language rather than in the
// English master.
//
// The first version of this check lived in the English-only block below and
// passed while a deliberately reverted German sentence still called the shipped
// app an Entwicklungs-Build — the exact failure this file's header warns about,
// reproduced by the test written to prevent it. Negative direction, so one
// alternation over all nine locales is the strict reading: no locale may say it
// in its own words, and none may say it in somebody else's either.
describe("no locale calls the released macOS app a pre-release artifact", () => {
  const STALE =
    /engineering build|engineering artifact|工程构建|工程产物|エンジニアリングビルド|エンジニアリング成果物|엔지니어링 빌드|엔지니어링 산출물|Entwicklungs-Build|Entwicklungsartefakt|version d'ingénierie|artefact d'ingénierie|نسخة هندسية|أثر هندسي|compilación de ingeniería|artefacto de ingeniería|compilação de engenharia|artefato de engenharia/i;

  it("keeps the macOS copy free of it in all nine", () => {
    for (const code of CODES) {
      const d = locales[code].deviceInboxPage;
      const mac = [d.platforms.macos.use, d.platforms.macos.setup, d.macNoDownload].join("\n");
      expect(mac, `${code} still calls the released Mac app a pre-release build`)
        .not.toMatch(STALE);
    }
  });

  it("still names the launchd receiver in all nine", () => {
    // The other half: the sentence has to keep saying what it DOES set up, so
    // the rule above cannot be satisfied by deleting the explanation.
    for (const code of CODES) {
      expect(locales[code].deviceInboxPage.platforms.macos.setup, code)
        .toContain("relayium inbox service launchd");
    }
  });
});

// The page's own honesty rules, expressed against the English master. The other
// eight are translations of these sentences; the cross-locale checks above are
// what keep them from drifting into something else.
describe("English keeps the availability boundaries it is the master of", () => {
  const d = en.deviceInboxPage;

  it("never promises an always-on receiver on iPhone or Android", () => {
    for (const id of ["iphone", "android"] as const) {
      const p = d.platforms[id];
      const all = [p.use, p.setup, p.files, p.residency, p.send].join("\n");
      // "always-on" may appear ONLY as something being denied. A blanket ban
      // would forbid the sentence that does the actual work ("never always-on"),
      // so the assertion is about every occurrence being negated, not absent.
      for (const m of all.matchAll(/(\w+\s+){0,2}always[- ]on/gi)) {
        expect(m[0], `${id}: an unnegated always-on claim`).toMatch(/\b(never|not|no)\b/i);
      }
      for (const m of all.matchAll(/(\w+\s+){0,2}guaranteed/gi)) {
        expect(m[0], `${id}: an unnegated guarantee`).toMatch(/\b(never|not|no)\b/i);
      }
      expect(p.setup, id).toMatch(/planned, not built/i);
      expect(p.residency, id).toMatch(/best[- ]effort/i);
    }
    expect(d.platforms.iphone.residency).toMatch(/never always-on/i);
  });

  it("describes Windows as foreground-only with no service or startup entry", () => {
    const w = d.platforms.windows;
    expect(w.setup).toMatch(/planned and not built/i);
    expect(w.setup).toMatch(/no Windows service and no startup entry/i);
    expect(w.residency).not.toMatch(/always[- ]on receiver\b(?!.{0,30}\bnot\b|:)/i);
  });

  it("explains the launchd receiver without claiming what it cannot prove", () => {
    // Inverted on 2026-08-10, when macos-v1.0 was published. This used to
    // REQUIRE "engineering build" here, which was the honest thing to say right
    // up until the release existed and then became the one false sentence on a
    // page whose whole argument is that it does not overstate anything.
    //
    // What this page sets up did not change: the command-line receiver under
    // launchd, which is the one that runs unattended whether or not the app is
    // installed. What it may no longer do is explain that choice by calling the
    // shipped app unreleased. The "no longer" half is checked across all nine
    // locales below, not here — see the note on that test.
    expect(d.platforms.macos.setup).toContain("relayium inbox service launchd");

    // Still true, and still worth pinning: this page proves neither of these,
    // and the release surfaces that DO prove them are the ones allowed to say
    // so. There is also no Mac App Store listing to claim.
    const mac = [d.platforms.macos.setup, d.macNoDownload].join("\n");
    expect(mac).not.toMatch(/app\s*store/i);
    expect(mac).not.toMatch(/notariz/i);
  });

  it("leads the server section with the inspectable installer, not a foreground run", () => {
    const s = d.platforms.server;
    expect(s.setup).toMatch(/read it before it gets root/i);
    expect(s.setup).toMatch(/low-privilege/i);
    expect(s.residency).toMatch(/survives.*reboot/i);
    expect(s.files).toContain("/srv/relayium-inbox");
  });

  it("distinguishes the Linux desktop user service from the server one", () => {
    expect(d.platforms.linux.residency).toMatch(/stops when you log out/i);
    expect(d.platforms.linux.residency).toMatch(/linger/i);
  });
});
