// /cli 必须把设备收件箱讲出来。
//
// 上线时的事实是：Web → CLI 的收件箱能用，但 `/cli` 一个字都没提它。用户能读到
// push/pull、配对码、daemon direct、sync、text、up/down 六种模式，唯独读不到那个
// 专门解决"把网页上的文件放到我自己服务器上"的模式。功能等于不存在。
//
// 这里断言的既有"说了"，也有"没有多说"：容器镜像没有官方版本，`inbox run` 也不是
// 后台守护进程，这两件事不能被暗示成有。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import CliPage from "./CliPage.svelte";
import { loadLang, type Lang } from "./i18n.svelte";
import { PICK_MODES, FLAG_ROWS } from "./cli-page-data";
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

let app: ReturnType<typeof mount> | null = null;

async function render(code: Lang = "en") {
  await loadLang(code);
  const target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(CliPage, { target });
  return target;
}

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { if (app) { unmount(app); app = null; } });

describe("/cli 上的设备收件箱一节", () => {
  it("有一个 My Devices 能链回来的锚点", async () => {
    const target = await render();
    const section = target.querySelector("#device-inbox");
    expect(section, "My Devices 的「去设置」链接指向 /cli#device-inbox，这个锚点必须存在").toBeTruthy();
  });

  it("正文按产品负责人指定的优先级介绍，同时保留 inbox 推荐样式", async () => {
    const target = await render();
    const order = [...target.querySelectorAll("[data-cli-mode]")].map((node) => node.getAttribute("data-cli-mode"));
    expect(order).toEqual(["up / down", "inbox", "text", "send / receive", "push / pull", "daemon direct", "sync"]);
    expect(target.querySelector("#device-inbox")?.classList.contains("featured")).toBe(true);
  });

  it("四步都在，而且每一步的命令都是真存在的", async () => {
    const target = await render();
    const section = target.querySelector("#device-inbox") as HTMLElement;
    const text = section.textContent ?? "";
    // 命令名是产品表面，不是文案：写错一个，照着做的人就会得到 "unknown
    // subcommand"。逐条对着 server/cmd/relayium/inbox.go 与 update.go。
    for (const cmd of [
      "relayium update --check",
      "relayium inbox --help",
      "relayium login --device-name",
      "sudo sh inbox-server-install.sh --dir /srv/relayium-inbox",
      "relayium inbox run",
      "relayium inbox status",
      "relayium inbox service systemd-system",
    ]) {
      expect(text, `收件箱一节没有提到 \`${cmd}\``).toContain(cmd);
    }
  });

  // CTA 指向 /device-inbox 而不是 /me：发送控件现在就在设备收件箱页上，改名和吊销
  // 才是 /me 的事。这一步讲的是「从网页发送」，把人送去 /me 等于多绕一跳。
  it("有通往设备收件箱页的 CTA，而且把账号门槛说清楚了", async () => {
    const target = await render();
    const section = target.querySelector("#device-inbox") as HTMLElement;
    const cta = section.querySelector(".cta a") as HTMLAnchorElement | null;
    expect(cta, "没有通往设备收件箱页的入口").toBeTruthy();
    expect(cta!.getAttribute("href")).toBe("/device-inbox");
    expect(cta!.textContent).toMatch(/Device Inbox/);
    expect(cta!.textContent, "CTA 仍然把人指向 My Devices").not.toMatch(/My Devices/);
    // 未登录的人点进去会看到登录门。文案必须先说出来，而不是让他们撞上去。
    expect(section.textContent).toMatch(/signed in to Relayium/i);
  });

  it("Linux 主流程是可审阅的一键常驻脚本，完整指南留在站内", async () => {
    const target = await render();
    const section = target.querySelector("#device-inbox") as HTMLElement;
    const text = section.textContent ?? "";
    expect(text).toContain("inbox-server-install.sh");
    expect(text).toContain("sudo sh inbox-server-install.sh --dir /srv/relayium-inbox");
    expect(text).toMatch(/after reboot/i);
    const docs = [...section.querySelectorAll("a")].find((a) => a.getAttribute("href")?.includes("device-inbox-server"));
    expect(docs, "完整指南仍然把普通用户赶到 GitHub，而不是站内文章").toBeTruthy();
    expect(docs!.getAttribute("href")).toBe("/guides/device-inbox-server/");
  });

  it("不承诺官方容器镜像", async () => {
    const target = await render();
    const text = target.querySelector("#device-inbox")?.textContent ?? "";
    expect(text, "没有说清楚 Relayium 不发布官方镜像").toMatch(/no official Relayium container image/i);
  });

  it("不把 inbox run 说成后台守护进程", async () => {
    const target = await render();
    const text = (target.querySelector("#device-inbox")?.textContent ?? "").toLowerCase();
    // 它是前台进程：不 fork、不写 pid 文件。说成"后台运行/自动常驻"就是在承诺
    // 一个 CLI 没有实现的东西。
    expect(text).toMatch(/foreground/);
    expect(text).not.toMatch(/runs in the background/);
    expect(text).not.toMatch(/daemonize/);
  });

  it("离线排队与「已上传 ≠ 已保存」都说到了", async () => {
    const target = await render();
    const text = target.querySelector("#device-inbox")?.textContent ?? "";
    expect(text).toMatch(/offline/i);
    // PRD §10：这两件事绝不能共用一个含糊的"已发送"。
    expect(text).toMatch(/uploaded/i);
    expect(text).toMatch(/saved/i);
  });
});

describe("模式选择器", () => {
  it("按产品负责人指定的优先级排列", () => {
    expect(PICK_MODES.map((mode) => mode.title)).toEqual([
      "up / down", "inbox", "text", "send / receive", "push / pull", "daemon direct", "sync",
    ]);
  });

  it("每种语言的第二条说明讲的都是收件箱那张卡", () => {
    // pickWhen 和 PICK_MODES 是**按下标**配对的。产品顺序改变时，SameLength 只保证
    // 长度相等；这条语义断言防止某一种语言仍留在旧顺序，导致后续解释全部串位。
    const claims: Record<keyof typeof locales, RegExp> = {
      en: /server or NAS/i,
      zh: /服务器或 NAS/,
      ja: /サーバーや NAS/,
      ko: /서버나 NAS/,
      de: /Server oder ein NAS/,
      fr: /serveur ou un NAS/,
      ar: /خادم أو NAS/,
      es: /servidor o NAS/,
      pt: /servidor ou NAS/,
    };
    for (const [code, m] of Object.entries(locales) as [keyof typeof locales, Messages][]) {
      expect(m.cliPage.pickWhen, `${code}: pickWhen 与 PICK_MODES 不等长`).toHaveLength(PICK_MODES.length);
      expect(
        m.cliPage.pickWhen[1],
        `${code}: 第二条说明讲的不是收件箱 —— 优先级重排后文案串位了`,
      ).toMatch(claims[code]);
    }
  });

  it("最后一条 flag 说明讲的是 --device-name", () => {
    const last = FLAG_ROWS.length - 1;
    expect(FLAG_ROWS[last].flag).toBe("--device-name <label>");
    for (const [code, m] of Object.entries(locales) as [keyof typeof locales, Messages][]) {
      expect(m.cliPage.flagMeanings, `${code}: flagMeanings 与 FLAG_ROWS 不等长`).toHaveLength(FLAG_ROWS.length);
      expect(m.cliPage.flagMeanings[last], `${code}: 最后一条 flag 说明是空的`).toBeTruthy();
    }
  });
});

describe("九种语言的收件箱文案", () => {
  const KEYS = [
    "inboxH2", "inboxTag", "inboxIntro",
    "inboxStep1Label", "inboxStep1Body", "inboxStep2Label", "inboxStep2Body",
    "inboxStep3Label", "inboxStep3Body", "inboxStep4Label", "inboxStep4Body",
    "inboxServiceNote", "inboxNoImageNote", "inboxQueueNote", "inboxPrivacyNote",
    "inboxCta", "inboxCtaHint", "inboxDocs",
  ] as const;

  for (const [code, m] of Object.entries(locales) as [keyof typeof locales, Messages][]) {
    it(`${code}: 每一条都是真文案，不是占位也不是英文原文`, () => {
      for (const key of KEYS) {
        const text = m.cliPage[key];
        expect(text, `${code}.cliPage.${key} 是空的`).toBeTruthy();
        expect(text, `${code}.cliPage.${key} 首尾有多余空白`).toBe(text.trim());
        expect(text, `${code}.cliPage.${key} 漏了模板占位符`).not.toContain("${");
      }
      if (code !== "en") {
        // 说明性的长句照抄英文就是没翻译。命令名和 CTA 不在此列：前者本来就是
        // 英文标识符，后者可能与产品名同形。
        for (const key of ["inboxH2", "inboxIntro", "inboxNoImageNote", "inboxQueueNote", "inboxPrivacyNote"] as const) {
          expect(m.cliPage[key], `${code}.cliPage.${key} 还是英文原文`).not.toBe(en.cliPage[key]);
        }
      }
    });

    it(`${code}: 不承诺官方容器镜像`, () => {
      // 这一句是供应链承诺，不是措辞。任何一种语言里把它翻丢了，那种语言的用户
      // 就会以为存在一个 Relayium 签过名的镜像。
      expect(m.cliPage.inboxNoImageNote, `${code}: 没提到 container`).toMatch(/container|容器|コンテナ|컨테이너|conteneur|contenedor|contêiner|حاوية/i);
    });

    it(`${code}: My Devices 的发现性三件套齐全`, () => {
      for (const key of ["sendWhere", "noneEnrolled", "setupCta"] as const) {
        const text = m.deviceInbox[key];
        expect(text, `${code}.deviceInbox.${key} 是空的`).toBeTruthy();
        expect(text, `${code}.deviceInbox.${key} 首尾有多余空白`).toBe(text.trim());
      }
      if (code !== "en") {
        expect(m.deviceInbox.sendWhere, `${code}.deviceInbox.sendWhere 还是英文原文`).not.toBe(en.deviceInbox.sendWhere);
        expect(m.deviceInbox.noneEnrolled, `${code}.deviceInbox.noneEnrolled 还是英文原文`).not.toBe(en.deviceInbox.noneEnrolled);
      }
    });
  }
});
