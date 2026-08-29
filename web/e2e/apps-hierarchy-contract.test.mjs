import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 托管 `/apps` 那一幕（`page-shell.mjs`），用一条**能跑**的门守着。
 *
 * 为什么需要这个：`appsHierarchyScenario` 现在跑在 `npm run test:e2e:page-shell`
 * 里，是一条托管 CI 门（`.github/workflows/web.yml`）；但那条门验的是它某一次的
 * 运行结果，不是它的写法。于是它的那几条纪律——从源码**推导**卡片模型、两个主题
 * 都量、可用组非空、以及把 EXERCISED / NOT EXERCISED 这条披露**钉住**而不是只
 * 打印——仍然可以被悄悄删掉几行而没有任何东西变红，只要改动没有巧到让运行结果
 * 本身也跟着变。
 *
 * 这套用例读的是 `page-shell.mjs` 的源码，不是它的运行结果——这里要守的恰恰是
 * "那一幕的形状"，不是它某一次的输出。这个场景在 2026-08-29 从 `lan-transfer.mjs`
 * 移到了这里（Phase 3D C2）；这份契约的 `SOURCE` 跟着移，否则它会一直验着一份
 * 不再执行的死代码，而真正跑在 CI 里的那一份反倒没人守。
 *
 * 刻意**不**做的事：不复制当前的卡片 id、也不复制当前的张数。那正是这一幕原本
 * 犯过的错——三张退休的卡片和 6 / 3 / 8 这组字面量在源码里当了几个月的第二份
 * 真相。一条把同样的字面量再抄一遍的门，只会把那个错误往上多搬一层。下面每一条
 * 断言问的都是**推导机制还在不在**，不是它今天推导出了什么。
 */

// `process.cwd()` 是 vitest 的 root（`web/`），和本目录其它源码契约用例同一套写法。
const SOURCE = readFileSync(resolve(process.cwd(), "e2e/page-shell.mjs"), "utf8");

/** 取一个顶层函数的函数体，好让下面的断言不会被文件里别处的同名文字满足。 */
function topLevelFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  expect(start, `${name} 在 lan-transfer.mjs 里找不到了`).toBeGreaterThan(-1);
  const rest = SOURCE.slice(start + 1);
  const end = rest.search(/\n(?:async )?function \w+\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

const CARD_MODEL = topLevelFunction("appsCardModel");
const SCENARIO = topLevelFunction("appsHierarchyScenario");

describe("the /apps card model is derived, not pinned", () => {
  it("reads both sources that own the answer", () => {
    // AppsPage.svelte 决定有哪些卡片、每张凭什么可用；native-releases.json 决定
    // macOS 那一份是不是真的。少读一个，模型就退回成一份猜测。
    expect(SOURCE).toMatch(/readFileSync\(\s*new URL\(\s*"\.\.\/src\/lib\/AppsPage\.svelte"/);
    expect(SOURCE).toMatch(/readFileSync\(\s*new URL\(\s*"\.\.\/native-releases\.json"/);
  });

  it("derives the id groups from the component rather than listing them", () => {
    // 分组是算出来的：按 AVAILABILITY 解析每张卡的 available: 表达式。
    expect(CARD_MODEL).toMatch(/AVAILABILITY\[e\.expr\]\(\)/);
    expect(CARD_MODEL).toMatch(/available[\s\S]{0,80}entries\.filter/);
    expect(CARD_MODEL).toMatch(/future[\s\S]{0,80}entries\.filter/);
  });

  it("fails closed on an availability expression it cannot resolve", () => {
    // 第四张卡带着新表达式进来时必须报错，而不是被默默归进 future 组。
    expect(CARD_MODEL).toMatch(/unrecognised availability/);
  });

  it("keeps the heading counts arithmetic rather than literal", () => {
    // h2 / h3 从组结构和卡片数算出来，所以加减一张卡不需要改这里。
    expect(CARD_MODEL).toMatch(/h2:\s*\d\s*\+/);
    expect(CARD_MODEL).toMatch(/h3:\s*ids\.length\s*\+/);
  });

  it("asserts against the derived model, with no hard-coded card-id array", () => {
    expect(SCENARIO).toMatch(/const model = appsCardModel\(\)/);
    expect(SCENARIO).toMatch(/wantAvailable\s*=\s*model\.available\.map/);
    expect(SCENARIO).toMatch(/wantFuture\s*=\s*model\.future\.map/);
    // 回退成字面量清单的样子：JSON.stringify(["app-…", …])。不点名任何具体 id,
    // 所以卡片增减不会让这条断言过期,而抄回一份清单会。
    expect(SCENARIO).not.toMatch(/JSON\.stringify\(\s*\[\s*"app-/);
  });
});

describe("the card contrast probe measures both groups in both themes", () => {
  it("switches the theme in both directions inside the page payload", () => {
    expect(SCENARIO).toMatch(/theme\s*=\s*'light'/);
    expect(SCENARIO).toMatch(/theme\s*=\s*'dark'/);
    // 量完必须把主题恢复原样,否则后面的移动端断言在一个被改过的文档上跑。
    expect(SCENARIO).toMatch(/originalTheme/);
  });

  it("captures four measurements: {available, in-development} × {light, dark}", () => {
    for (const capture of ["lightAvailable", "darkAvailable", "lightFuture", "darkFuture"]) {
      expect(SCENARIO, `${capture} 不再被采集`).toMatch(new RegExp(`${capture}\\s*=\\s*cardMetrics\\(`));
      expect(SCENARIO, `${capture} 不再被带回 Node 侧`).toMatch(new RegExp(`\\b${capture}\\b[\\s\\S]*\\b${capture}\\b`));
    }
    // 两个组各自的选择器都还在:只量其中一个,这条探针就退回成原来那个问题。
    expect(SCENARIO).toMatch(/cardMetrics\('\.future-card'\)/);
    expect(SCENARIO).toMatch(/cardMetrics\('\.available-grid \.app-card'\)/);
  });

  it("checks every captured measurement against the model's own count", () => {
    // 两个组都进同一张表,而且逐组比对"量到的张数 == 模型说的张数"——否则一个
    // 空数组会安静地通过。
    expect(SCENARIO).toMatch(/\["available",\s*model\.available,\s*desktop\.lightAvailable,\s*desktop\.darkAvailable\]/);
    expect(SCENARIO).toMatch(/\["in-development",\s*model\.future,\s*desktop\.lightFuture,\s*desktop\.darkFuture\]/);
    expect(SCENARIO).toMatch(/light\?\.length !== want\.length \|\| dark\?\.length !== want\.length/);
    // 对比度和不透明度的阈值本身还在被检查。
    expect(SCENARIO).toMatch(/contrast < 4\.5 \|\| m\.opacity !== 1/);
  });

  it("keeps the non-empty guard that proves the probe ran at all", () => {
    // 这一条是整段的地基:in-development 组随时可能为空,可用组永远不空,所以
    // "一张都没量到"必须是红的,而不是一次安静的通过。
    expect(SCENARIO).toMatch(/if \(!desktop\.lightAvailable\.length\)/);
    expect(SCENARIO).toMatch(/measured nothing at all/);
  });
});

describe("the in-development coverage disclosure is pinned, not merely printed", () => {
  it("states both branches explicitly", () => {
    expect(SCENARIO).toMatch(/NOT EXERCISED/);
    expect(SCENARIO).toMatch(/\bEXERCISED on\b/);
  });

  it("fails the run when the reported branch disagrees with what was measured", () => {
    // 这是把"披露"变成"断言"的那一行。删掉它,这一幕仍然会打印一句好看的话,
    // 但它可以在量了零张卡的同时报告 EXERCISED —— 正是这套用例要拦的退化。
    expect(
      SCENARIO,
      "EXERCISED / NOT EXERCISED 的披露不再被钉住:它现在可以和实际量到的张数不一致",
    ).toMatch(/futureCoverage\.includes\("NOT EXERCISED"\)\s*!==\s*\(desktop\.lightFuture\.length === 0\)/);
    expect(SCENARIO).toMatch(/disclosure disagrees with what the browser measured/);
  });

  it("reports the disclosure as part of the run's output", () => {
    expect(SCENARIO).toMatch(/ok\(futureCoverage\)/);
  });
});
