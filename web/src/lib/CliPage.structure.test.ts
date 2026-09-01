// /cli 的结构与产品事实契约。
//
// 这一页的内容不是文案，是**产品事实**：哪种模式需要账号、对端能不能离线、哪一种
// 真的能续传、装 Windows 该跑什么。说错任何一条，照着做的人得到的都是失败的传输或
// 一条不存在的命令。所以这里断言的是"说了什么"，也同样是"没有多说什么"。
//
// 断言全部走**键**（cli-page-data.ts 的常量 + Record 化的 i18n），不走下标：下标
// 配对能悄无声息地把 push/pull 的说明挂到 Cloud 上，而类型系统一个字都不会说。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, unmount } from "svelte";
import CliPage from "./CliPage.svelte";
import ModeSection from "./cli/ModeSection.svelte";
import { loadLang, setLang, type Lang } from "./i18n.svelte";
import {
  SECTIONS,
  CLI_MODES,
  TASK_BRANCHES,
  GUIDES,
  GUIDE_GROUPS,
  FLAG_ROWS,
  MODE_GUIDE,
  GUIDE_SLUG,
  TRUST_FILES,
  FAQ_KEYS,
  COMPARE_COLUMNS,
  COMMAND_BLOCKS,
  WINDOWS_BUILDS,
} from "./cli-page-data";
import en from "./i18n/en";
import zh from "./i18n/zh";
import type { Messages } from "./i18n/types";

const locales: Record<"en" | "zh", Messages> = { en, zh };

let app: ReturnType<typeof mount> | null = null;

async function render(code: Lang = "en") {
  await loadLang(code);
  await setLang(code); // the helper that actually switches what lang() returns
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

// ── 首屏 ────────────────────────────────────────────────────────────────────
describe("第一屏", () => {
  it("H1 和支撑句就是产品负责人定下的那两句", async () => {
    const target = await render();
    expect(target.querySelector("h1")?.textContent).toBe("Relayium CLI");
    // 支撑句是**英文原文逐字**的要求，不是"意思差不多"。
    expect(en.cliPage.heroSupport).toBe(
      "Move files between machines — directly, through your devices, or with Relayium Cloud.",
    );
    expect(target.textContent).toContain(en.cliPage.heroSupport);
  });

  it("没有 eyebrow、徽章、假指标或装饰球", async () => {
    const target = await render();
    const header = target.querySelector("header.hero") as HTMLElement;
    // 上一版的 hero 里有一个渐变方块 .logo 和一排 .badges 胶囊。它们把安装命令挤到
    // 了折叠线以下，而读者来 /cli 就是为了拿那条命令。
    expect(header.querySelector(".logo, .badges, .badge, .pill, .eyebrow")).toBeNull();
    // hero 里只允许标题和一句支撑句。
    expect(header.querySelectorAll("p")).toHaveLength(1);
  });

  it("安装紧跟在 hero 后面，而不是排在模式列表后", async () => {
    const target = await render();
    const headings = [...target.querySelectorAll("h1, h2")].map((h) => h.textContent?.trim());
    expect(headings[0]).toBe("Relayium CLI");
    expect(headings[1]).toBe(en.cliPage.sections.install);
  });
});

// ── 目录轨 / 锚点 ───────────────────────────────────────────────────────────
describe("目录轨与锚点", () => {
  it("七个入口，且每一个都指向页面上真实存在的 id", async () => {
    const target = await render();
    const nav = target.querySelector(`nav[aria-label="${en.cliPage.contentsLabel}"]`);
    expect(nav, "没有渲染目录轨").toBeTruthy();
    const links = [...nav!.querySelectorAll("a")];
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      "Install",
      "Choose by task",
      "Modes at a glance",
      "Guides",
      "Command reference",
      "Security & integrity",
      "FAQ",
    ]);
    // 指向一个不存在的 id 的锚点是一个**静默失效**的链接：点了没反应，也不报错。
    for (const a of links) {
      const id = a.getAttribute("href")!.slice(1);
      expect(target.querySelector(`[id="${id}"]`), `#${id} 这个区块不存在`).toBeTruthy();
    }
    expect(links).toHaveLength(SECTIONS.length);
  });

  it("点击锚点会把焦点也一起搬过去", async () => {
    const target = await render();
    const link = target.querySelector('nav a[href="#command-reference"]') as HTMLAnchorElement;
    link.click();
    const section = target.querySelector("#command-reference") as HTMLElement;
    // 只滚动不移焦点，键盘/读屏用户仍停在文档开头：下一次 Tab 会跳去导航，而不是
    // 进入他们刚刚要求阅读的内容。
    expect(document.activeElement).toBe(section);
    expect(section.getAttribute("tabindex")).toBe("-1");
    expect(location.hash).toBe("#command-reference");
  });

  it("带 fragment 打开时同样落到那一节（SPA 外壳的 body 在加载时是空的）", async () => {
    history.replaceState({}, "", "/cli#device-inbox");
    const target = await render();
    expect(document.activeElement).toBe(target.querySelector("#device-inbox"));
  });
});

// ── 三条任务分支 ────────────────────────────────────────────────────────────
describe("按任务选择", () => {
  it("就是被采纳的连通性/归属分类，不是另一套人群分类", () => {
    expect(TASK_BRANCHES.map((b) => en.cliPage.tasks[b.key].title)).toEqual([
      "Another device can be offline",
      "Both devices are online",
      "Machines I manage",
    ]);
  });

  it("每种模式恰好出现在一条分支里", () => {
    const listed = TASK_BRANCHES.flatMap((b) => [...b.modes]);
    // 一种模式出现在两条分支里，等于这一页回答不了"我该用哪个"。
    expect([...listed].sort()).toEqual([...CLI_MODES.map((m) => m.key)].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("分支里的模式链接指向对应的模式区块", async () => {
    const target = await render();
    const section = target.querySelector("#choose-by-task") as HTMLElement;
    for (const branch of TASK_BRANCHES) {
      for (const key of branch.modes) {
        const mode = CLI_MODES.find((m) => m.key === key)!;
        const link = section.querySelector(`a[href="#${mode.id}"]`);
        expect(link, `分支里没有通往 ${mode.name} 的链接`).toBeTruthy();
        expect(link!.textContent?.trim()).toBe(mode.name);
      }
    }
  });
});

// ── 七种模式 ────────────────────────────────────────────────────────────────
describe("模式区块", () => {
  it("恰好七个，按被采纳的顺序，名字是命令本身", async () => {
    const target = await render();
    const rendered = [...target.querySelectorAll("[data-cli-mode]")].map((n) =>
      n.getAttribute("data-cli-mode"),
    );
    expect(rendered).toEqual([
      "Cloud",
      "Device Inbox",
      "text",
      "send / receive",
      "push / pull",
      "serve",
      "sync",
    ]);
    expect(rendered).toEqual(CLI_MODES.map((m) => m.name));
  });

  it("每一个都有自己的锚点，收件箱仍然是 #device-inbox", async () => {
    const target = await render();
    for (const mode of CLI_MODES) {
      expect(target.querySelector(`#${mode.id}`), `${mode.name} 没有锚点`).toBeTruthy();
    }
    // 「我的设备」里的"去设置"链接指向 /cli#device-inbox，是产品里已经存在的入站
    // 链接；改掉这个 id 就是把它打断。
    expect(CLI_MODES.find((m) => m.key === "inbox")!.id).toBe("device-inbox");
  });

  it("对比表覆盖七种模式 × 四个维度，没有空格子", async () => {
    const target = await render();
    const rows = [...target.querySelectorAll("#modes table tbody tr")];
    expect(rows).toHaveLength(CLI_MODES.length);
    for (const [code, m] of Object.entries(locales) as ["en" | "zh", Messages][]) {
      for (const mode of CLI_MODES) {
        for (const col of COMPARE_COLUMNS) {
          const cell = m.cliPage.compare[mode.key][col];
          expect(cell, `${code}: compare.${mode.key}.${col} 是空的`).toBeTruthy();
          expect(cell, `${code}: compare.${mode.key}.${col} 首尾有多余空白`).toBe(cell.trim());
        }
      }
    }
  });
});

// ── 模式 → 指南 ─────────────────────────────────────────────────────────────
//
// 每个模式区块结尾恰好一条通往它自己那篇教程的链接。之前只有 Device Inbox 有一条
// 手写的，其余六个都在最后一个命令块处断掉：读者刚知道 sync 存在，接下来只能一路
// 滚过剩下的模式、再从九篇里挑对一篇。写在页面标记里的链接就是会被一行一行漏掉，
// 所以配对是**数据**（MODE_GUIDE），由 ModeSection 统一渲染。
describe("模式 → 指南", () => {
  it("就是被采纳的那张映射表，七个模式一个不多一个不少", () => {
    expect(Object.keys(MODE_GUIDE).sort()).toEqual([...CLI_MODES.map((m) => m.key)].sort());
    expect(MODE_GUIDE).toEqual({
      cloud: "cloudAsync",
      inbox: "deviceInboxServer",
      text: "terminal",
      sendReceive: "sendToSomeone",
      pushPull: "backupSsh",
      serve: "serverToServer",
      sync: "syncLargeFolder",
    });
    // 映射的右边必须是真存在的指南键，否则 href 会渲染成 /undefined/。
    for (const key of Object.values(MODE_GUIDE)) {
      expect(GUIDES.map((g) => g.key), `${key} 不是一篇真指南`).toContain(key);
    }
  });

  it("每个模式区块里恰好一条指南链接，指向映射表说的那一篇", async () => {
    const target = await render();
    for (const mode of CLI_MODES) {
      const section = target.querySelector(`#${mode.id}`) as HTMLElement;
      const links = [...section.querySelectorAll("a[data-mode-guide]")] as HTMLAnchorElement[];
      // 两条 = 又回到"这一行还要再选一次"，零条 = 这一行没有出口。
      expect(links, `${mode.name} 的指南链接不是恰好一条`).toHaveLength(1);
      const guide = MODE_GUIDE[mode.key];
      expect(links[0].getAttribute("data-mode-guide")).toBe(guide);
      // 结尾斜杠：文章页是目录，少一个斜杠每个读者都多花一次跳转。
      expect(links[0].getAttribute("href")).toBe(`/${GUIDE_SLUG[guide]}/`);
      expect(links[0].textContent).toContain(en.cliPage.guides[guide]);
    }
    // 七行，七条，页面上再没有第八条。
    expect(target.querySelectorAll("#modes a[data-mode-guide]")).toHaveLength(CLI_MODES.length);
  });

  it("中文页链进中文文章，仍然带斜杠，标题也是中文的", async () => {
    const target = await render("zh");
    for (const mode of CLI_MODES) {
      const guide = MODE_GUIDE[mode.key];
      const link = target.querySelector(
        `#${mode.id} a[data-mode-guide="${guide}"]`,
      ) as HTMLAnchorElement;
      expect(link, `zh ${mode.name} 没有指南链接`).toBeTruthy();
      expect(link.getAttribute("href")).toBe(`/zh/${GUIDE_SLUG[guide]}/`);
      expect(link.textContent).toContain(zh.cliPage.guides[guide]);
    }
  });

  it("是原生链接：能被键盘聚焦，不靠 click 处理器", async () => {
    const target = await render();
    // 指南是静态文章页而不是 SPA 路由，所以正确的行为就是浏览器自己的导航——
    // 中键、"在新标签页打开"、回车都因此免费拿到。加一个 preventDefault 的
    // onclick 会把这三样一起弄坏。
    const links = [...target.querySelectorAll("#modes a[data-mode-guide]")] as HTMLAnchorElement[];
    for (const a of links) {
      expect(a.tagName).toBe("A");
      expect(a.getAttribute("href")?.startsWith("/")).toBe(true);
      expect(a.getAttribute("tabindex")).toBeNull(); // 天然可聚焦，不需要也不该加
      expect(a.hasAttribute("target")).toBe(false);
    }
    // 七个可及名字互不相同：读屏用户的元素列表里不能是七条"指南"。
    const names = links.map((a) => a.textContent?.replace(/\s+/g, " ").trim());
    expect(new Set(names).size).toBe(names.length);
  });

  it("设备收件箱只剩这一条指南链接，不再有手写的第二条", async () => {
    const target = await render();
    const section = target.querySelector("#device-inbox") as HTMLElement;
    const toGuide = [...section.querySelectorAll("a")].filter((a) =>
      a.getAttribute("href")?.includes("guides/device-inbox-server"),
    );
    // 同一行里两条指向同一篇文章的链接，是读屏用户要读两遍才知道它们一样。
    expect(toGuide).toHaveLength(1);
    expect(toGuide[0].getAttribute("data-mode-guide")).toBe("deviceInboxServer");
  });

  it("那条手写链接的文案键也一并删了，没留下没人读的 cliPage.inbox.docs", () => {
    // 统一链接把这个键变成死的。留着的代价不是体积，而是下一个人：一个还在
    // Messages 上、两个维护语言都翻译了、却没有任何渲染路径的键，读起来像是
    // "某处漏渲染了"，于是被重新接上——正是这一批要去掉的那条重复链接。
    for (const [name, table] of Object.entries(locales)) {
      expect(Object.keys(table.cliPage.inbox), `${name} 仍留着 cliPage.inbox.docs`).not.toContain(
        "docs",
      );
    }
    // 类型侧同样：types.ts 上还留着 `docs: string` 的话，上面两条只是恰好没填。
    // @ts-expect-error cliPage.inbox.docs 已从 Messages 上移除
    expect(en.cliPage.inbox.docs).toBeUndefined();
  });
});

// ── 行末箭头的方向 ──────────────────────────────────────────────────────────
//
// 箭头是装饰性的（aria-hidden），但装饰画错方向仍然是错的：它指的是"链接去的
// 那边"，而在从右向左的文字里，那边在读者的左手边。动态 /cli 目前只有 en/zh，
// 两个都是 LTR——可 ModeSection 收的是 `lang: string`，dir() 也照样能回答 "ar"，
// 静态 /cli 外壳和归档的阿拉伯语页面此刻就在渲染 dir="rtl"。所以这里直接按组件
// 测，而不是等某个语言回来的那天才发现新加的这一行是反的。
describe("模式行末箭头", () => {
  const rows: ReturnType<typeof mount>[] = [];

  const row = (lang: string) => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    rows.push(mount(ModeSection, { target, props: { cli: en.cliPage, lang, mode: CLI_MODES[0] } }));
    return target.querySelector(".arrow") as HTMLElement;
  };

  afterEach(() => {
    while (rows.length) unmount(rows.pop()!);
  });

  it("从左向右的语言里不翻转", () => {
    for (const lang of ["en", "zh"]) {
      const arrow = row(lang);
      expect(arrow, `${lang} 没有箭头`).toBeTruthy();
      expect(arrow.classList.contains("flip"), lang).toBe(false);
    }
  });

  it("阿拉伯语里翻转，箭头指向行进方向", () => {
    const arrow = row("ar");
    expect(arrow).toBeTruthy();
    expect(arrow.classList.contains("flip")).toBe(true);
    // 仍然是同一个字形、仍然对读屏隐藏：翻转是视觉的，不是换一个可被朗读的符号。
    expect(arrow.textContent).toBe("→");
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
  });

  it("翻转规则来自 dir()，不是本组件自己列的一张 RTL 语言表", () => {
    // 一张抄一份的语言表会和 i18n.svelte.ts 那张分叉，而分叉的那天没人会发现。
    const src = readFileSync(resolve(process.cwd(), "src/lib/cli/ModeSection.svelte"), "utf8");
    expect(src).toContain('dir(lang) === "rtl"');
    expect(src).not.toMatch(/\bRTL\s*=|\["ar"\]|'ar'/);
  });
});

// ── 九篇指南 ────────────────────────────────────────────────────────────────
describe("指南", () => {
  // GUIDES 与权威 slug 集合（cli-articles.mjs 的 CLI_ARTICLES）之间的锁在
  // scripts/pages/cli-shell.test.mjs —— 那边同时能导入两侧，而 tsconfig.app 只
  // 收 src/，从这里跨出去导入 .mjs 会把它拖进类型检查程序。

  it("九条全部渲染，全部带结尾斜杠", async () => {
    const target = await render();
    const links = [...target.querySelectorAll("#guides a")] as HTMLAnchorElement[];
    expect(links).toHaveLength(9);
    for (const g of GUIDES) {
      const href = `/${g.slug}/`;
      const link = links.find((a) => a.getAttribute("href") === href);
      // 静态文章页是目录：少一个斜杠，每个读者和每个爬虫都要多花一次跳转。
      expect(link, `没有指向 ${href} 的链接（或缺了结尾斜杠）`).toBeTruthy();
      expect(link!.textContent).toContain(en.cliPage.guides[g.key]);
    }
  });

  it("中文页链接进中文文章，仍然带斜杠", async () => {
    const target = await render("zh");
    const hrefs = [...target.querySelectorAll("#guides a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/zh/guides/transfer-files-from-terminal/");
    for (const href of hrefs) expect(href!.endsWith("/")).toBe(true);
  });

  it("每篇指南都归入恰好一个分组", () => {
    const grouped = GUIDE_GROUPS.flatMap((g) => [...g.guides]);
    expect([...grouped].sort()).toEqual([...GUIDES.map((g) => g.key)].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

// ── 复制控件 ────────────────────────────────────────────────────────────────
describe("复制控件", () => {
  it("每一个命令块都渲染出来了，数量和数据一致", async () => {
    const target = await render();
    const buttons = [...target.querySelectorAll("button.copy")];
    expect(COMMAND_BLOCKS).toHaveLength(17);
    expect(buttons).toHaveLength(COMMAND_BLOCKS.length);
  });

  it("每个复制按钮的可及名字都不同，而且指名它复制的是哪条命令", async () => {
    const target = await render();
    const labels = [...target.querySelectorAll("button.copy")].map((b) =>
      b.getAttribute("aria-label"),
    );
    // 17 个按钮视觉上都写着"Copy"。名字不带命令名，读屏用户的元素列表里就是 17 个
    // 同名控件，选哪个只能靠把整页再读一遍。
    expect(new Set(labels).size).toBe(labels.length);
    for (const block of COMMAND_BLOCKS) {
      expect(labels, `没有指向 ${block.name} 的复制按钮`).toContain(
        `${en.cliPage.copy.aria}: ${block.name}`,
      );
    }
  });

  it("复制反馈是本地化的，命令本身不是", async () => {
    const target = await render("zh");
    const button = target.querySelector("button.copy")!;
    expect(button.textContent?.trim()).toBe(zh.cliPage.copy.label);
    expect(button.getAttribute("aria-label")).toContain(zh.cliPage.copy.aria);
    // 命令是代码：翻译过的命令是一条跑不起来的命令。
    expect(button.getAttribute("aria-label")).toContain(COMMAND_BLOCKS[0].name);
    expect(target.textContent).toContain("curl -fsSL https://relayium.com/install.sh | sh");
  });
});

// ── 键盘可达 ────────────────────────────────────────────────────────────────
describe("横向滚动区域可以用键盘到达", () => {
  it("两张表都是键盘停靠点，并且有可及名字", async () => {
    const target = await render();
    const wraps = [...target.querySelectorAll(".wrap")];
    expect(wraps).toHaveLength(2); // 模式对比表 + 参数表
    for (const wrap of wraps) {
      expect(wrap.getAttribute("tabindex")).toBe("0");
      const labelledBy = wrap.getAttribute("aria-labelledby")!;
      expect(target.querySelector(`#${labelledBy}`)?.textContent?.trim()).toBeTruthy();
    }
  });

  it("命令块的 <pre> 是键盘停靠点，并且强制 LTR", async () => {
    const target = await render();
    const pres = [...target.querySelectorAll(".term pre")];
    expect(pres.length).toBe(COMMAND_BLOCKS.length);
    for (const pre of pres) {
      expect(pre.getAttribute("tabindex")).toBe("0");
      // 阿拉伯语下整页是 RTL；被双向重排过的 shell 命令是读者既没法重打、也没法和
      // 自己粘贴的内容对照的东西。
      expect(pre.getAttribute("dir")).toBe("ltr");
    }
  });

  it("目录轨自身不加多余的 tabindex —— 它的子元素全是链接", async () => {
    const target = await render();
    const nav = target.querySelector("nav[aria-label]")!;
    expect(nav.getAttribute("tabindex")).toBeNull();
    expect(nav.querySelectorAll("a").length).toBeGreaterThan(0);
  });
});

// ── 键化完整性 ──────────────────────────────────────────────────────────────
describe("两种维护中语言的文案都是齐的", () => {
  const recordKeys = {
    sections: SECTIONS.map((s) => s.key),
    tasks: TASK_BRANCHES.map((b) => b.key),
    modes: CLI_MODES.map((m) => m.key),
    guides: GUIDES.map((g) => g.key),
    guideGroups: GUIDE_GROUPS.map((g) => g.key),
    flags: FLAG_ROWS.map((f) => f.key),
    trustFiles: TRUST_FILES.map((f) => f.key),
    compareColumns: [...COMPARE_COLUMNS],
    faq: [...FAQ_KEYS],
  } as const;

  for (const [code, m] of Object.entries(locales) as ["en" | "zh", Messages][]) {
    it(`${code}: 每个 Record 的键集合与数据完全一致`, () => {
      for (const [field, keys] of Object.entries(recordKeys)) {
        const table = m.cliPage[field as keyof typeof recordKeys] as Record<string, unknown>;
        // 多一个键是死文案，少一个键是渲染出 undefined。两种都要拦。
        expect(Object.keys(table).sort(), `${code}.cliPage.${field}`).toEqual([...keys].sort());
      }
    });

    it(`${code}: 没有空文案、没有首尾空白、没有漏掉的模板占位符`, () => {
      const strings: [string, string][] = [];
      const walk = (path: string, v: unknown) => {
        if (typeof v === "string") strings.push([path, v]);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(`${path}[${i}]`, x));
        else if (v && typeof v === "object")
          for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x);
      };
      walk("cliPage", m.cliPage);
      expect(strings.length).toBeGreaterThan(100);
      for (const [path, s] of strings) {
        expect(s, `${code}.${path} 是空的`).toBeTruthy();
        expect(s, `${code}.${path} 首尾有多余空白`).toBe(s.trim());
        expect(s, `${code}.${path} 漏了模板占位符`).not.toContain("${");
      }
    });

    it(`${code}: 每种模式都有 tag、lead 和至少两条边界说明`, () => {
      for (const mode of CLI_MODES) {
        const copy = m.cliPage.modes[mode.key];
        expect(copy.tag, `${code}.${mode.key}.tag`).toBeTruthy();
        expect(copy.lead, `${code}.${mode.key}.lead`).toBeTruthy();
        expect(copy.notes.length, `${code}.${mode.key}.notes 太少`).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it("zh 的解释性长句不是照抄英文", () => {
    for (const key of ["heroSupport", "tasksIntro", "modesIntro", "securityIntro"] as const) {
      expect(zh.cliPage[key], `zh.cliPage.${key} 还是英文原文`).not.toBe(en.cliPage[key]);
    }
    for (const mode of CLI_MODES) {
      expect(zh.cliPage.modes[mode.key].lead, `zh ${mode.key}.lead 还是英文原文`).not.toBe(
        en.cliPage.modes[mode.key].lead,
      );
    }
    for (const key of FAQ_KEYS) {
      expect(zh.cliPage.faq[key].a, `zh faq.${key} 还是英文原文`).not.toBe(en.cliPage.faq[key].a);
    }
  });
});

// ── 产品事实 ────────────────────────────────────────────────────────────────
describe("产品事实", () => {
  it("安装：shell 脚本只归 macOS/Linux，Windows 是一等的免安装 ZIP", async () => {
    const target = await render();
    const install = target.querySelector("#install") as HTMLElement;
    expect(install.textContent).toContain("macOS and Linux");
    // install.sh 是 POSIX sh。把它说成"适配你的操作系统"，Windows 读者就会去粘贴它。
    expect(install.textContent).toMatch(/POSIX shell script and does not run on Windows/i);

    const zips = [...install.querySelectorAll("a[download]")] as HTMLAnchorElement[];
    expect(zips).toHaveLength(WINDOWS_BUILDS.length);
    for (const b of WINDOWS_BUILDS) {
      const link = zips.find((a) => a.getAttribute("href")?.endsWith(b.file));
      expect(link, `没有 ${b.file} 的下载入口`).toBeTruthy();
      // latest/download 是 GitHub 的"最新发布"重定向：链接保持动态，不写死版本号。
      expect(link!.getAttribute("href")).toContain("/releases/latest/download/");
      expect(link!.textContent).toContain(b.label);
    }
  });

  it("整页不写死任何版本号", async () => {
    const target = await render();
    const text = target.textContent ?? "";
    const hrefs = [...target.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").join(" ");
    // v0.24.0 是发布那一刻的事实，不是这一页的事实。写进来它就会烂在这里。
    // 只匹配带 v 前缀的形式：命令块里有 127.0.0.1 和 203.0.113.7 这样的示例地址。
    expect(text, "页面正文写死了版本号").not.toMatch(/\bv\d+\.\d+\.\d+\b/);
    expect(text, "页面正文写死了 0.24.0").not.toContain("0.24.0");
    expect(hrefs, "链接里写死了版本号").not.toMatch(/\/(?:v)?\d+\.\d+\.\d+(?:\/|$)/);
    expect(hrefs).toContain("/releases/latest");
  });

  it("设备收件箱只讲接收侧，并且把发送侧指去别处", async () => {
    const target = await render();
    const text = target.querySelector("#device-inbox")!.textContent ?? "";
    expect(text).toMatch(/RECEIVE side only/);
    expect(text).toMatch(/no CLI command that sends into an inbox/i);
    // 两台自己的服务器之间搬文件不是收件箱的事，要说清楚去哪。
    expect(text).toMatch(/serve with push or sync/i);
    expect(text).toMatch(/no official Relayium container image/i);
    // inbox run 是前台进程：不 fork、不写 pid 文件。
    expect(text).toMatch(/foreground/i);
    expect(text.toLowerCase()).not.toMatch(/runs in the background|daemonize/);
    // 排队与"已上传 ≠ 已保存"。
    expect(text).toMatch(/offline/i);
    expect(text).toMatch(/uploaded/i);
    expect(text).toMatch(/wrote the file to disk|saved/i);
  });

  // "链接丢了文件就找不回来了"读起来像"文件已经不在了"，而它不成立：密文一直留在
  // Relayium 上，直到留存到期为止；链接带走的是**唯一能解密它的那把密钥**。这个差别
  // 决定两件事——读者要不要另外再留一份，以及已经丢了链接的人该不该来找支持恢复。
  // 谁都恢复不了，原因是密钥，不是存储。维护中的英文/中文文案与真正渲染出来的页面
  // 必须说同一件事（getting-started 指南、/cli 爬虫外壳也一样），所以正反两面都断言：
  // 只删掉那句过头话而不补上留存的事实，就会变成第二种误导。
  for (const [code, m] of Object.entries(locales) as ["en" | "zh", Messages][]) {
    it(`${code}: 云端丢的是密钥，不是"文件没了"`, async () => {
      const notes = m.cliPage.modes.cloud.notes.join(" ");
      expect(notes, `${code} 又把丢链接说成丢文件`).not.toMatch(
        code === "en"
          ? /los(?:ing|es|t) the link loses the file/i
          : /链接丢了[，,]?\s*文件就(?:找不回来|丢|没)/,
      );
      expect(notes).toMatch(
        code === "en" ? /stays stored until its retention expires/i : /加密副本会一直存到留存到期/,
      );
      expect(notes).toMatch(
        code === "en" ? /only key that can decrypt it/i : /能解密它的唯一密钥/,
      );

      // 渲染出来的那一节要和文案源一致：文案改对了但没进页面，读者读到的还是旧话。
      const target = await render(code);
      const text = target.querySelector("#cloud")!.textContent ?? "";
      expect(text, `${code} 的 #cloud 没渲染出留存事实`).toMatch(
        code === "en" ? /stays stored until its retention expires/i : /加密副本会一直存到留存到期/,
      );
      expect(text).not.toMatch(
        code === "en"
          ? /los(?:ing|es|t) the link loses the file/i
          : /链接丢了[，,]?\s*文件就(?:找不回来|丢|没)/,
      );
    });
  }

  it("不再有跨模式的通用续传 / SHA-256 承诺", async () => {
    const target = await render();
    const text = target.textContent ?? "";
    // 这一句曾经在页面上，对所有模式都成立地写着。两半都不真：tar 退化路径什么都
    // 不校验，而续传根本不是一个跨模式的统一属性。
    expect(text).not.toMatch(/Every file is verified end-to-end with SHA-256/i);
    expect(text).not.toMatch(/an interrupted transfer resumes from where it stopped/i);
    // 取而代之的是分模式的说法。
    expect(text).toMatch(/tar fallback/i);
  });

  // 第一次修正把通用承诺换成了"Resume is a sync feature"——那是**另一句错话**。
  // server/internal/cloud/transfer.go 的 Download 循环最多重试五次，用
  // `Range: bytes=<consumed>-` 从 Decryptor 收下的最后一个完整帧继续
  // （TestDownloadResumesAfterMidStreamDrop 就是它的证据）。区别不在"有没有"，
  // 而在**作用域**：sync 是跨运行续传，Cloud 是同一次调用内重连，尝试用尽后还会
  // 把半截输出删掉。照着假的通用句去做的人，会以为重跑 relayium down 能接着下。
  it("续传按作用域分开说：sync 跨运行，Cloud 在单次运行内", async () => {
    const target = await render();
    const text = target.textContent ?? "";
    expect(text, "sync-only 的通用句又回来了").not.toMatch(/Resume is a sync feature/i);
    expect(text).toMatch(/sync resumes across runs/i);
    expect(text).toMatch(/relayium down resumes within a single run/i);
    expect(text).toMatch(/HTTP Range/);
    expect(text).toMatch(/five attempts/i);
    // 进程退出后并不保留：这是最容易被读多的一半。
    expect(text).toMatch(/deletes the partial output|delete[sd]? the partial output/i);
    expect(text).not.toMatch(/relayium down[^.]{0,80}resumes? on the next run/i);
    // sync 那一侧要说的是"目标端的半截文件"，而不是同一次运行内的重连。
    expect(target.querySelector("#sync")!.textContent).toMatch(
      /partial file left at the destination/i,
    );
  });

  it("push/pull 的冲突与 --no-resume 语义是对的", async () => {
    const target = await render();
    const text = target.querySelector("#push-pull")!.textContent ?? "";
    expect(text).toMatch(/refused by the collision check/i);
    expect(text).toMatch(/--no-resume is accepted here and does nothing/i);
  });

  it("sync 说的是 size+mtime，而不是校验和比对", async () => {
    const target = await render();
    const text = target.querySelector("#sync")!.textContent ?? "";
    expect(text).toMatch(/size and modification time/i);
    expect(text).toMatch(/not a versioned backup/i);
  });

  it("登录不等于文件系统权限", async () => {
    const target = await render();
    expect(target.querySelector("#security")!.textContent).toMatch(
      /Logging in grants no one filesystem access/i,
    );
    expect(target.querySelector("#serve")!.textContent).toMatch(
      /grants no one filesystem access/i,
    );
  });

  it("参数表的作用域和二进制一致（三处曾经是错的）", () => {
    const scope = Object.fromEntries(FLAG_ROWS.map((f) => [f.flag, f.who]));
    // 曾经写作 "serve / push / sync / id / authorize"，漏掉了凭据目录那一半。
    for (const cmd of ["login", "logout", "inbox <any>"]) {
      expect(scope["--config-dir <d>"], `--config-dir 漏了 ${cmd}`).toContain(cmd);
    }
    // 曾经写作 "send / receive"。text 也吃这个参数，而 text 恰恰是最想用它的地方。
    expect(scope["--verify"]).toBe("send · receive · text");
    // 曾经写作 "serve, relayium://"。push 根本没有 --port，端口写在 URL 里。
    expect(scope["--port <n>"]).toBe("serve");
    // 这四个此前完全缺席，而它们正是装服务的人要问的。
    for (const flag of ["--bind <addr>", "--local-only", "--check", "--service-user <u>"]) {
      expect(Object.keys(scope), `参数表缺少 ${flag}`).toContain(flag);
    }
  });

  it("--advertise 不进通用表，只在正文里出现一次并带上可达性前提", async () => {
    const target = await render();
    // 二进制自己的顶层表也刻意排除它（help_flagscope_test.go）：它只有在地址真的
    // 可达时才有意义，放进"大家先读的那张表"是误导。
    expect(FLAG_ROWS.map((f) => f.flag)).not.toContain("--advertise");
    const table = target.querySelector("#command-reference table")!.textContent ?? "";
    expect(table).not.toContain("--advertise");
    const note = en.cliPage.advertiseNote;
    expect(note).toContain("--advertise");
    expect(note).toMatch(/really be reachable/i);
    expect(note).toMatch(/forwarded port/i);
    expect(target.querySelector("#command-reference")!.textContent).toContain(note);
  });

  it("FAQ 就是被采纳的那四个问题", async () => {
    const target = await render();
    expect(FAQ_KEYS.map((k) => en.cliPage.faq[k].q)).toEqual([
      "Do I need an account?",
      "Can the other device be offline?",
      "Which transfers can resume?",
      "How does verification differ by mode?",
    ]);
    const faqHeadings = [...target.querySelectorAll("#faq h3")].map((h) => h.textContent);
    expect(faqHeadings).toEqual(FAQ_KEYS.map((k) => en.cliPage.faq[k].q));
  });
});
