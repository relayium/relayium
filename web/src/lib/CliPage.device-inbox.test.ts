// /cli 必须把设备收件箱讲出来。
//
// 上线时的事实是：Web → CLI 的收件箱能用，但 `/cli` 一个字都没提它。用户能读到
// push/pull、配对码、daemon direct、sync、text、up/down 六种模式，唯独读不到那个
// 专门解决"把网页上的文件放到我自己服务器上"的模式。功能等于不存在。
//
// 这里断言的既有"说了"，也有"没有多说"：容器镜像没有官方版本，`inbox run` 也不是
// 后台守护进程，这两件事不能被暗示成有。
//
// 页面结构、分类法、复制控件与其余产品事实在 CliPage.structure.test.ts。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import CliPage from "./CliPage.svelte";
import { loadLang, setLang, type Lang } from "./i18n.svelte";
import en from "./i18n/en";
import zh from "./i18n/zh";
import type { Messages } from "./i18n/types";

const locales = { en, zh };

let app: ReturnType<typeof mount> | null = null;

async function render(code: Lang = "en") {
  await loadLang(code);
  await setLang(code);
  const target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(CliPage, { target });
  return target;
}

beforeEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/cli");
});
afterEach(async () => {
  if (app) {
    unmount(app);
    app = null;
  }
  await setLang("en");
});

describe("/cli 上的设备收件箱一节", () => {
  it("有一个 My Devices 能链回来的锚点", async () => {
    const target = await render();
    const section = target.querySelector("#device-inbox");
    expect(section, "My Devices 的「去设置」链接指向 /cli#device-inbox，这个锚点必须存在").toBeTruthy();
  });

  it("在被采纳的模式顺序里排第二，并保留推荐样式", async () => {
    const target = await render();
    const order = [...target.querySelectorAll("[data-cli-mode]")].map((node) =>
      node.getAttribute("data-cli-mode"),
    );
    expect(order[1]).toBe("Device Inbox");
    // 它是"把文件弄到我自己服务器上"的答案，也是唯一发送侧不在 CLI 里的模式，所以
    // 在七行里仍然被标出来。
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
      // --service-user 决定系统级单元以哪个账号运行；此前这一页从没提过它。
      "--service-user relayium",
    ]) {
      expect(text, `收件箱一节没有提到 \`${cmd}\``).toContain(cmd);
    }
    expect(section.querySelectorAll("ol.steps > li")).toHaveLength(4);
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
    const docs = [...section.querySelectorAll("a")].find((a) =>
      a.getAttribute("href")?.includes("device-inbox-server"),
    );
    expect(docs, "完整指南仍然把普通用户赶到 GitHub，而不是站内文章").toBeTruthy();
    expect(docs!.getAttribute("href")).toBe("/guides/device-inbox-server/");
  });

  it("不承诺官方容器镜像", async () => {
    const target = await render();
    const text = target.querySelector("#device-inbox")?.textContent ?? "";
    expect(text, "没有说清楚 Relayium 不发布官方镜像").toMatch(
      /no official Relayium container image/i,
    );
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
    expect(text).toMatch(/wrote the file to disk/i);
  });
});

describe("维护中语言的收件箱文案", () => {
  for (const [code, m] of Object.entries(locales) as [keyof typeof locales, Messages][]) {
    it(`${code}: 四步齐全，每一条都是真文案`, () => {
      const inbox = m.cliPage.inbox;
      expect(inbox.steps).toHaveLength(4);
      for (const [i, step] of inbox.steps.entries()) {
        for (const [field, text] of Object.entries(step)) {
          expect(text, `${code}.inbox.steps[${i}].${field} 是空的`).toBeTruthy();
          expect(text, `${code}.inbox.steps[${i}].${field} 首尾有多余空白`).toBe(text.trim());
        }
      }
      for (const key of ["stepsLabel", "cta", "ctaHint", "docs"] as const) {
        expect(inbox[key], `${code}.inbox.${key} 是空的`).toBeTruthy();
      }
    });

    it(`${code}: 不承诺官方容器镜像`, () => {
      // 这一句是供应链承诺，不是措辞。任何一种语言里把它翻丢了，那种语言的用户
      // 就会以为存在一个 Relayium 签过名的镜像。
      const notes = m.cliPage.modes.inbox.notes.join(" ");
      expect(notes, `${code}: 没提到 container`).toMatch(/container|容器/i);
      expect(notes, `${code}: 没说"没有官方镜像"`).toMatch(/no official|没有官方/i);
    });

    it(`${code}: 说清楚 CLI 只有接收侧`, () => {
      const lead = m.cliPage.modes.inbox.lead;
      expect(lead, `${code}: 没说只有接收侧`).toMatch(/RECEIVE side only|只有接收侧/i);
    });

    it(`${code}: My Devices 的发现性三件套齐全`, () => {
      for (const key of ["sendWhere", "noneEnrolled", "setupCta"] as const) {
        const text = m.deviceInbox[key];
        expect(text, `${code}.deviceInbox.${key} 是空的`).toBeTruthy();
        expect(text, `${code}.deviceInbox.${key} 首尾有多余空白`).toBe(text.trim());
      }
      if (code !== "en") {
        expect(m.deviceInbox.sendWhere, `${code}.deviceInbox.sendWhere 还是英文原文`).not.toBe(
          en.deviceInbox.sendWhere,
        );
        expect(m.deviceInbox.noneEnrolled, `${code}.deviceInbox.noneEnrolled 还是英文原文`).not.toBe(
          en.deviceInbox.noneEnrolled,
        );
      }
    });
  }
});
