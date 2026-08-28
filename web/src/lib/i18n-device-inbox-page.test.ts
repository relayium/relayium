// web/src/lib/i18n-device-inbox-page.test.ts — the /device-inbox copy, in all
// every maintained language.
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
import { REQUIRED_PLATFORM_IDS } from "./device-inbox-platforms";

const locales = { en, zh };
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
  /** This locale's name for the My Devices page.
   *
   *  Used NEGATIVELY, on the sentences that tell a signed-in owner how to send:
   *  sending happens on /device-inbox itself now, and copy that still routes
   *  them to another page is a detour only speakers of that language ever walk.
   *  A single English regex would pass vacuously in eight of nine locales — the
   *  exact failure this file's header warns about. */
  myDevices: RegExp;
};

const claims: Record<Code, Claims> = {
  en: {
    notSaved: /wrote the file to disk/i,
    linkBoundary: /never make one of your devices write to disk/i,
    enableThere: /cannot be made for it from the web/i,
    queues: /waits in the queue/i,
    myDevices: /My Devices/i,
  },
  zh: {
    notSaved: /设备把文件写进磁盘/,
    linkBoundary: /永远不能让你的某台设备往磁盘里写/,
    enableThere: /无法从网页替它做/,
    queues: /留在队列里/,
    myDevices: /我的设备/,
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
    // A locale that translated two of them identically would show "no native
    // app" and "available now" as the same badge — the one thing the badge
    // exists to do.
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

  // The page IS the send surface now. Every sentence that answers "how do I
  // send to this thing" has to answer it with this page — the whole point of
  // moving the controls here is that the journey stops needing a second one.
  it("never routes a send through My Devices", () => {
    const sendCopy = [
      d.signedOutLead,
      d.stateNone,
      d.stateUnknown,
      d.stateReady(2),
      d.stateNoInbox(2),
      d.howSteps[1],
      d.sendHereCta,
      ...REQUIRED_PLATFORM_IDS.map((id) => d.platforms[id].send),
      ...REQUIRED_PLATFORM_IDS.map((id) => d.platforms[id].setup),
    ];
    for (const [i, s] of sendCopy.entries()) {
      expect(s, `${code} sendCopy[${i}] still sends the reader to another page`).not.toMatch(c.myDevices);
    }
  });

  // The other half, so the rule above cannot be satisfied by deleting the link:
  // /me still has a job — renaming and revoking — and this page still says so.
  it("keeps a secondary route to the page that manages credentials", () => {
    expect(d.manageDevicesCta.trim().length).toBeGreaterThan(0);
    expect(d.docsMyDevices.trim().length).toBeGreaterThan(0);
    for (const s of [d.devicesH3, d.retryCta, d.refreshFailed]) {
      expect(s.trim().length, `${code} is missing an operational-block string`).toBeGreaterThan(0);
    }
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
        d.signInCta, d.createAccountCta, d.stateUnknown, d.stateNone,
        d.devicesH3, d.manageDevicesCta, d.sendHereCta, d.retryCta, d.refreshFailed,
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
// alternation over every maintained locale is the strict reading: no locale may say it
// in its own words, and none may say it in somebody else's either.
describe("no locale calls the released macOS app a pre-release artifact", () => {
  const STALE =
    /engineering build|engineering artifact|工程构建|工程产物|エンジニアリングビルド|エンジニアリング成果物|엔지니어링 빌드|엔지니어링 산출물|Entwicklungs-Build|Entwicklungsartefakt|version d'ingénierie|artefact d'ingénierie|نسخة هندسية|أثر هندسي|compilación de ingeniería|artefacto de ingeniería|compilação de engenharia|artefato de engenharia/i;

  it("keeps the macOS copy free of it in every maintained locale", () => {
    for (const code of CODES) {
      const d = locales[code].deviceInboxPage;
      const mac = [d.platforms.macos.use, d.platforms.macos.setup, d.macNoDownload].join("\n");
      expect(mac, `${code} still calls the released Mac app a pre-release build`)
        .not.toMatch(STALE);
    }
  });

  it("still names the launchd alternative in every maintained locale", () => {
    // The other half: the sentence has to keep saying what ELSE is on offer, so
    // the rule above cannot be satisfied by deleting the explanation.
    //
    // Pinned on "launchd" rather than on the full command: since 2026-08-11 the
    // sentence leads with the shipped Mac app and names the command-line
    // receiver as the unattended alternative, and the literal command lives in
    // the terminal block (device-inbox-platforms.ts) where it is byte-identical
    // in every maintained language. "launchd" is a proper noun and is untranslated in
    // every one of them, which is exactly why it is the checkable token here.
    for (const code of CODES) {
      expect(locales[code].deviceInboxPage.platforms.macos.setup, code).toContain("launchd");
    }
  });

  it("tells every locale to install the app, now that there is one to install", () => {
    // The defect this closes, found on production 2026-08-11: macOS 1.1.3 was
    // public, notarized and downloadable FROM THIS PAGE, and both maintained locales
    // still described the launchd CLI as the only way to receive on a Mac.
    // "Mac" is the shared token — every locale keeps the product's own spelling
    // of the platform — and it has to appear before "launchd", because which
    // one a reader is told to reach for first IS the claim being made.
    for (const code of CODES) {
      const setup = locales[code].deviceInboxPage.platforms.macos.setup;
      const app = setup.search(/Mac/);
      const cli = setup.search(/launchd/);
      expect(app, `${code} never mentions the Mac app`).toBeGreaterThanOrEqual(0);
      expect(cli, `${code} never mentions launchd`).toBeGreaterThanOrEqual(0);
      expect(app, `${code} still leads with the command line, not the shipped app`).toBeLessThan(cli);
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
      // Inverted 2026-08-28. This used to REQUIRE "planned, not built" and a
      // "best-effort" background story, which was an honest description of work
      // that was going to happen. It is not going to: iOS development is paused
      // and there is no Android commitment, so the same sentences became a
      // roadmap promise for apps nobody is building. What the section owes a
      // reader now is the absence, said plainly.
      expect(p.setup, id).toMatch(/Relayium publishes no (iPhone or iPad|Android) app/i);
      expect(p.setup, id).toMatch(/nothing to install here/i);
      expect(p.residency, id).toMatch(/receives nothing here/i);
    }
    expect(d.platforms.iphone.residency).toMatch(/no always-on iPhone receiver/i);
    expect(d.platforms.android.residency).toMatch(/publishes no Android app/i);
  });

  it("describes Windows as foreground-only with no service or startup entry", () => {
    const w = d.platforms.windows;
    // Also inverted 2026-08-28: the tray receiver used to be described as
    // "planned and not built". There is no Windows app commitment, so the
    // absence is the whole claim.
    expect(w.setup).toMatch(/Relayium publishes no Windows app/i);
    expect(w.setup).toMatch(/no Windows service and no startup entry/i);
    expect(w.residency).not.toMatch(/always[- ]on receiver\b(?!.{0,30}\bnot\b|:)/i);
  });

  it("explains the launchd receiver without claiming what it cannot prove", () => {
    // Inverted on 2026-08-10, when macos-v1.0 was published. This used to
    // REQUIRE "engineering build" here, which was the honest thing to say right
    // up until the release existed and then became the one false sentence on a
    // page whose whole argument is that it does not overstate anything.
    //
    // Inverted AGAIN on 2026-08-11, and for the opposite reason: the app is not
    // merely released, it is the thing this page hands you a download for, so
    // leading with the CLI was the false emphasis. The CLI is still named, as
    // what it now actually is — the unattended path.
    expect(d.platforms.macos.setup).toMatch(/download the mac app/i);
    expect(d.platforms.macos.setup).toMatch(/launchd/);

    // The residency sentence is where a Mac app is easiest to overstate. Both
    // halves are required: it stops when you quit it, and Open at Login is what
    // brings it back. The shipped app says the same two things in its own
    // `inbox.loginNote`, and this page must not promise more than that.
    expect(d.platforms.macos.residency).toMatch(/quit it and it stops receiving/i);
    expect(d.platforms.macos.residency).toMatch(/open at login/i);
    expect(d.platforms.macos.residency).toMatch(/not a system daemon/i);

    // Still true, and still worth pinning: this page proves neither of these,
    // and the release surfaces that DO prove them are the ones allowed to say
    // so. This setup surface intentionally claims neither distribution channel.
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

// ─────────────────────────────────────────────────────────────────────────────
// The roadmap ban, added 2026-08-28.
//
// Every guard above is written against a sentence that must be PRESENT. That
// shape cannot catch the defect this section exists for, because the defect is
// an extra sentence: copy that is individually true about today and still sells
// a native app that is not coming. Relayium's platforms are Web, the CLI and the
// published macOS app. iOS development is paused, and there is no Android or
// Windows app commitment — so on /device-inbox, "not yet" is not a smaller
// version of the truth, it is a different claim, and one this page has no
// authority to make.
//
// Both maintained languages are scanned with their own words. An English-only
// pattern would pass vacuously in Chinese, which is the failure mode the whole
// file is built around.
describe("maintained copy never promises a native app that is not coming", () => {
  /** Platforms Relayium publishes no app for. macOS is deliberately absent: it
   *  HAS a published app, so its section is allowed to talk about one. */
  const NO_APP = ["iphone", "android", "windows"] as const;

  /** Future-native promises, per maintained language. Each entry is a phrase
   *  that only makes sense if an unshipped native client is on its way. */
  const ROADMAP: Record<Code, { label: string; re: RegExp }[]> = {
    en: [
      { label: "planned", re: /\bplanned?\b/i },
      { label: "not built (yet)", re: /\bnot (yet )?built\b/i },
      { label: "coming soon", re: /\bcoming soon\b/i },
      { label: "not yet / yet to", re: /\b(not yet|yet to)\b/i },
      { label: "roadmap", re: /\broadmap\b/i },
      { label: "when the native app", re: /\bwhen the native app\b/i },
      { label: "wait for the app", re: /\bwait for the (native )?app\b/i },
      { label: "will be able to", re: /\bwill (be able to|receive|ship|land|support)\b/i },
      { label: "we are working on it", re: /\bwe('re| are) (working|building|planning)\b/i },
      { label: "in development", re: /\bin development\b/i },
      { label: "future", re: /\bfuture\b/i },
    ],
    zh: [
      { label: "计划中", re: /计划/ },
      { label: "尚未/暂未实现", re: /(尚未|暂未|还没)/ },
      { label: "即将", re: /即将/ },
      { label: "敬请期待", re: /敬请期待/ },
      { label: "等原生", re: /等(原生|native)/ },
      { label: "将来会", re: /将来/ },
      { label: "路线图", re: /路线图/ },
      { label: "开发中", re: /开发中/ },
    ],
  };

  for (const code of CODES) {
    const d = locales[code].deviceInboxPage;

    it(`${code}: says the app is absent, not delayed, on iPhone, Android and Windows`, () => {
      for (const id of NO_APP) {
        const p = d.platforms[id];
        const prose = [p.use, p.setup, p.files, p.residency, p.send, p.recovery, p.stop].join("\n");
        for (const { label, re } of ROADMAP[code]) {
          expect(re.test(prose), `${code}.platforms.${id} promises a future native app (${label})`).toBe(false);
        }
      }
    });

    it(`${code}: keeps the roadmap out of the shared platform framing too`, () => {
      // The badge and the section lead are rendered above every platform, so a
      // promise here reaches all six at once. `statusPlanned` is a legacy KEY
      // name — see device-inbox-platforms.ts — and its VALUE is what a reader
      // sees, so it is scanned like any other sentence.
      const shared = [d.platformsLead, d.statusPlanned].join("\n");
      for (const { label, re } of ROADMAP[code]) {
        expect(re.test(shared), `${code}: shared platform copy promises a future native app (${label})`).toBe(false);
      }
    });

    it(`${code}: names the mobile browser as the way a phone sends`, () => {
      // The positive half. Removing a promise must not leave the phone sections
      // saying nothing about what a phone owner can actually do today, and the
      // macOS section must not fill the gap by implying an iPhone app.
      for (const id of ["iphone", "android"] as const) {
        const send = [d.platforms[id].setup, d.platforms[id].send].join("\n");
        expect(send, `${code}.platforms.${id}`).toMatch(code === "en" ? /browser|safari/i : /浏览器|Safari/i);
      }
      const mac = d.platforms.macos.send;
      expect(mac, `${code}.platforms.macos.send`).toMatch(code === "en" ? /browser/i : /浏览器/);
      expect(mac, `${code}.platforms.macos.send names an iPhone app`).not.toMatch(/iPhone|iPad/i);
    });
  }

  it("english states the absence itself, so the ban cannot pass by saying nothing", () => {
    const d = locales.en.deviceInboxPage;
    expect(d.platforms.iphone.setup).toMatch(/publishes no iPhone or iPad app/i);
    expect(d.platforms.android.setup).toMatch(/publishes no Android app/i);
    expect(d.platforms.windows.setup).toMatch(/publishes no Windows app/i);
    // iPhone and Android are senders, not Inbox receivers, and both say so.
    for (const id of ["iphone", "android"] as const) {
      expect(d.platforms[id].files, id).toMatch(/not a Device Inbox receiver/i);
    }
    // Windows keeps the one receiver it really has.
    expect(d.platforms.windows.setup).toMatch(/command-line receiver running in the foreground/i);
  });

  it("chinese states the same absence in its own words", () => {
    const d = locales.zh.deviceInboxPage;
    expect(d.platforms.iphone.setup).toMatch(/不提供 iPhone \/ iPad 应用/);
    expect(d.platforms.android.setup).toMatch(/不提供 Android 应用/);
    expect(d.platforms.windows.setup).toMatch(/不提供 Windows 原生应用/);
    for (const id of ["iphone", "android"] as const) {
      expect(d.platforms[id].files, id).toMatch(/不是设备收件箱的接收端/);
    }
    expect(d.platforms.windows.setup).toMatch(/命令行接收端的前台运行/);
  });
});
