#!/usr/bin/env node
/**
 * 无障碍基线扫描：在**真 Chrome** 里跑 axe-core，扫已构建产物里的一组代表页。
 *
 *   cd web && npm run build && npm run test:a11y
 *
 * 为什么必须是真浏览器：SPA 壳的 `<body>` 里只有一个 `<noscript>`，真正的界面全靠 JS
 * 挂上去。扫原始 HTML 等于在扫一段给爬虫看的备份文案——一条违规也发现不了，却会显示
 * 全绿。颜色对比度同理：它要的是**计算后**的样式，不是源码里的 CSS 变量名。
 *
 * 为什么不扫全部静态 HTML：静态页只出自 6 种模板（landing / article / guides-index /
 * legal / mode / 404），每种模板扫代表页就够；把同一份模板扫几百遍只会让 CI 变慢、让
 * 输出变得没人看。landing 与 article 的 RTL 分支也有代表目标。
 *
 * 用法：
 *   node e2e/a11y-scan.mjs                       # 自己起 vite preview 扫 dist
 *   node e2e/a11y-scan.mjs --url http://localhost:8099   # 扫一个已经跑着的服务器
 *   node e2e/a11y-scan.mjs --json a11y-report.json       # 另存一份机读结果（永远是全量）
 *   node e2e/a11y-scan.mjs --only pricing        # 只跑 id 含该子串的目标（调试用）
 *   node e2e/a11y-scan.mjs --verbose-incomplete  # 把 incomplete 也逐节点展开
 *
 * violation 永远逐节点全展开；incomplete 默认只按目标/规则聚合计数加少量样本——它们
 * 大多是同一句"背景是渐变，算不出对比度"，逐条列出来只会把真正要修的东西冲下屏幕。
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argFlag, argPresent, launchBrowser, newTab, ok, sleep, withWatchdog } from "./harness.mjs";
import { apiFixtureScript } from "./a11y-fixtures.mjs";
// 目标表住在自己的模块里，好让 a11y-core.test.mjs 能直接 import 它去断言——这个文件
// 顶层就跑完整轮扫描，谁 import 它谁就等于跑了一次 CI。
import { MOBILE, TARGETS } from "./a11y-targets.mjs";
import {
  EXTRA_RULES, WCAG_TAGS, applyAllowlist, axeVersion, colors, loadAllowlist, printGrouped,
  printIncomplete, runAxe,
} from "./a11y-core.mjs";

const { RED, YEL, DIM, OFF } = colors;
const here = fileURLToPath(new URL(".", import.meta.url));

// 和 lan-transfer(9444) / mixed-link(9445) 各用各的端口：每个脚本只 pkill 自己那一个
// 端口的残留浏览器，谁也别顺手打死对方。
const DEBUG_PORT = 9446;
const PREVIEW_PORT = Number(argFlag("--preview-port", "4183"));
const GLOBAL_TIMEOUT_MS = 8 * 60_000;
const ALLOWLIST = resolve(here, "a11y-allowlist.json");

// ── vite preview 的生命周期 ─────────────────────────────────────────────────
//
// 不自己写 HTTP 服务器：写一个就得手工重现 nginx 的 try_files 规则，而那份复制品
// 一定会和 server/spa.go 漂移，然后用一条测不准的路由给出一个测不准的结论。
// vite 本来就是开发依赖，preview 直接吐 dist。

let previewChild = null;
let previewStopping = false;

const previewAlive = (child) => child && child.exitCode === null && child.signalCode === null;

/**
 * 同步收尾，只给 process.on("exit") 用。
 *
 * 看门狗超时走的是 process.exit，那条路**不执行 finally、也不 await 任何东西**，
 * 所以这里只能是同步的一刀 SIGKILL。正常路径不走它，走下面那个会等子进程真的退出的
 * stopPreview。
 */
function killPreviewNow() {
  if (!previewAlive(previewChild)) return;
  previewStopping = true;
  try { previewChild.kill("SIGKILL"); } catch { /* 已经没了 */ }
}

/**
 * 收掉 preview 并**等它真的退出**。
 *
 * 只发一个信号就返回是不够的：Node 在子进程句柄还活着的时候不会退出事件循环，于是
 * "脚本跑完了但命令不返回"——在 CI 里这和挂死没有区别。SIGTERM 之后给 3 秒，还赖着
 * 就 SIGKILL。
 */
async function stopPreview() {
  const child = previewChild;
  if (!child) return;
  previewStopping = true;
  if (previewAlive(child)) {
    const exited = once(child, "exit");
    try { child.kill("SIGTERM"); } catch { /* 已经没了 */ }
    let timer;
    const grace = new Promise((res) => { timer = setTimeout(res, 3_000); });
    await Promise.race([exited, grace]);
    clearTimeout(timer);
    if (previewAlive(child)) {
      try { child.kill("SIGKILL"); } catch { /* 已经没了 */ }
      await exited;
    }
  }
  previewChild = null;
  previewStopping = false;
}

async function startPreview(distDir) {
  const viteBin = resolve(here, "..", "node_modules", "vite", "bin", "vite.js");
  previewChild = spawn(
    process.execPath,
    // --host 127.0.0.1 不是可选的：vite preview 默认监听 "localhost"，而 Node 会
    // 按 DNS 顺序解析它——在这台机器上它只绑到了 ::1，于是往 127.0.0.1 发的请求
    // 一律连不上，表现成"preview 起不来"。钉死 IPv4 地址，本地和 CI 才是同一件事。
    [viteBin, "preview", "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1", "--outDir", distDir],
    { cwd: resolve(here, ".."), stdio: "ignore" },
  );
  const child = previewChild;
  let diedEarly = false;
  child.on("exit", (code) => {
    // preview 自己死掉（端口被占、dist 不存在）时不要让扫描去慢慢超时——那种失败
    // 会被读成"页面加载不出来"，指向完全错误的方向。是我们主动收的就别报这一句。
    if (!previewStopping) {
      diedEarly = true;
      console.error(`${RED}vite preview exited early with code ${code}${OFF}`);
    }
  });

  const base = `http://127.0.0.1:${PREVIEW_PORT}`;
  try {
    for (let i = 0; ; i++) {
      if (diedEarly) throw new Error(`vite preview died before serving ${distDir} — is port ${PREVIEW_PORT} taken, or is ${distDir} missing? (run \`npm run build\`)`);
      try {
        const res = await fetch(`${base}/`);
        if (res.ok) { await res.arrayBuffer(); break; }
      } catch { /* 还没起来 */ }
      if (i > 80) throw new Error(`vite preview never answered on ${base} within 20s`);
      await sleep(250);
    }
  } catch (err) {
    // 起不来也要把可能还活着的那个子进程收掉再抛：这个失败路径上还没有人接管所有权，
    // 留一个活着的 preview 会占住端口，让**下一次**运行以 "--strictPort 端口被占"
    // 收场——一个由上一轮失败造成、却指向完全无关原因的错误。
    await stopPreview();
    throw err;
  }
  return base;
}

// ── 单个目标 ────────────────────────────────────────────────────────────────

async function scanTarget(browser, base, target) {
  // 夹具走 addScriptToEvaluateOnNewDocument，而 newTab 在导航之前就下发它——所以它在
  // 页面第一行脚本之前就位，`onMount` 里那次 `/api/plans` 一定落在补丁上。它是**这个
  // 标签页会话**的东西，下一格换新标签页就没有了。
  const tab = await newTab(browser, "about:blank", target.fixture ? apiFixtureScript(target.fixture) : undefined);
  const waitReady = (selector, count, what) => tab.waitFor(
    `document.querySelectorAll(${JSON.stringify(selector)}).length >= ${count ?? 1}`,
    `${target.id} → ${what ?? selector}${count > 1 ? ` ×${count}` : ""}`,
    30_000,
  );
  try {
    // 先钉死渲染环境再导航：配色方案和动效偏好必须在**首次绘制之前**就位，
    // 不然扫到的是一张"从浅色跳到深色"的中间态。runner 的默认值也不能信——
    // 本地和 CI 的系统偏好并不一样，那正是"我这儿是绿的"的经典来源。
    await tab.send("Emulation.setDeviceMetricsOverride", {
      ...target.viewport, deviceScaleFactor: 1, mobile: target.viewport === MOBILE,
    });
    await tab.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: target.scheme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });

    await tab.send("Page.navigate", { url: base + target.url });
    await waitReady(target.ready, target.readyCount);

    // 一串有序的步骤，而不是一次点击：内联档位要两步（打开弹窗 → 展开 Pricing），
    // 而每一步都必须等到位再走下一步——上一步还没渲染完就去找下一个按钮，失败会
    // 报成"没有这个按钮"，指向一个根本不存在的选择器问题。
    for (const step of target.drive ?? []) {
      await tab.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(step.click)});
        if (!el) throw new Error("nothing to click: " + ${JSON.stringify(step.click)});
        el.click();
        return true;
      })()`);
      await waitReady(step.ready, step.readyCount);
    }

    const result = await runAxe(tab);
    return { ...result, consoleErrors: tab.errors.slice() };
  } finally {
    // 一格一个标签页并且当场关掉：15 个活标签页会一直挂着 WebSocket 和定时器，
    // 后面的目标就不是在一个干净的浏览器里跑了。
    try { await browser.send("Target.closeTarget", { targetId: tab.targetId }); } catch { /* 已经关了 */ }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const distDir = argFlag("--dist", "dist");
  const only = argFlag("--only", "");
  const jsonOut = argFlag("--json", "");
  const externalUrl = argFlag("--url", "");
  const targets = only ? TARGETS.filter((t) => t.id.includes(only)) : TARGETS;
  if (!targets.length) throw new Error(`--only ${only} matched no target`);

  const allowlist = loadAllowlist(ALLOWLIST);
  const started = Date.now();
  const failuresByTarget = new Map();
  const incompleteByTarget = new Map();
  const allowedByTarget = new Map();
  const errors = [];
  const machine = [];
  let chrome = "unknown";
  let engine = "unknown";
  let ruleCount = 0;
  let base = externalUrl;

  // 两样要收的东西（preview 子进程、浏览器）在**同一个** try 里获取，finally 里各自
  // 按"拿到了才收"释放。之前 startPreview 在 try 之外：Chrome 解析失败（CHROME_PATH
  // 指错、Linux 上没装）时 launchBrowser 抛在 finally 建立之前，preview 就成了孤儿——
  // 它还占着 4183，还 ref 着事件循环，于是 node 连退出都不退出。
  let closeBrowser = null;
  try {
    if (!base) base = await startPreview(distDir);
    const launched = await launchBrowser({ debugPort: DEBUG_PORT, keep: argPresent("--keep") });
    const browser = launched.browser;
    closeBrowser = launched.close;

    chrome = (await browser.send("Browser.getVersion")).product ?? "unknown";
    console.log(`\n  axe-core ${axeVersion()} · ${chrome} · ${process.platform} · ${base}`);
    console.log(`  ${DIM}scope: WCAG A/AA (${WCAG_TAGS.join(", ")}) + ${Object.keys(EXTRA_RULES).length} named best-practice rules${OFF}`);
    console.log(`  ${DIM}allowlist: ${allowlist.entries.length} entr${allowlist.entries.length === 1 ? "y" : "ies"}${OFF}\n`);

    for (const target of targets) {
      // 每个目标独立成败：一格挂了就记下来继续跑完，否则第一处失败会把后面所有格
      // 的证据一起吃掉——而这一轮要的正是**完整**的清单。
      try {
        const res = await scanTarget(browser, base, target);
        engine = res.engine;
        ruleCount = res.ruleCount;
        const { failures, allowed } = applyAllowlist(target.id, res.violations, allowlist);
        failuresByTarget.set(target.id, failures);
        allowedByTarget.set(target.id, allowed);
        incompleteByTarget.set(
          target.id,
          res.incomplete.flatMap((rule) => rule.nodes.map((node) => ({ targetId: target.id, rule, node }))),
        );
        machine.push({
          target: target.id, url: target.url, viewport: target.viewport, scheme: target.scheme,
          violations: res.violations, incomplete: res.incomplete, consoleErrors: res.consoleErrors,
        });
        const n = failures.length;
        const inc = incompleteByTarget.get(target.id).length;
        const line = `${target.id} ${DIM}(${target.viewport.width}×${target.viewport.height}, ${target.scheme})${OFF}`;
        if (n) console.log(`  ${RED}✗${OFF} ${line} — ${n} violation node(s), ${inc} incomplete`);
        else ok(`${line} — clean${inc ? `, ${inc} incomplete` : ""}`);
      } catch (err) {
        errors.push({ target: target.id, message: err?.message ?? String(err) });
        console.log(`  ${RED}✗${OFF} ${target.id} — ${err?.message ?? err}`);
      }
    }
  } finally {
    // Cleanup responsibilities are independent: even an unexpected browser-close
    // failure must not strand the preview process and keep the Node event loop alive.
    try {
      if (closeBrowser) await closeBrowser();
    } finally {
      await stopPreview();
    }
  }

  // ── 判决 ────────────────────────────────────────────────────────────────
  // violation 永远逐节点全展开——那是要照着修的清单。incomplete 默认只聚合。
  const failures = printGrouped("VIOLATIONS", failuresByTarget, RED);
  const incomplete = printIncomplete(incompleteByTarget, { verbose: argPresent("--verbose-incomplete") });

  const stale = allowlist.entries.filter((e) => e.matched === 0);
  const expired = allowlist.expired;
  if (expired.length) {
    console.log(`\n${RED}EXPIRED ALLOWLIST ENTRIES (${expired.length})${OFF}`);
    for (const e of expired) console.log(`    ${e.target} / ${e.rule} — expired ${e.expires} (owner: ${e.owner})`);
  }
  if (stale.length && !only) {
    console.log(`\n${RED}STALE ALLOWLIST ENTRIES (${stale.length}) — matched nothing this run; delete them${OFF}`);
    for (const e of stale) console.log(`    ${e.target} / ${e.rule} / ${e.selector}`);
  }

  const allowed = [...allowedByTarget.values()].reduce((n, l) => n + l.length, 0);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n  ${targets.length} target(s) · ${ruleCount} rules · axe ${engine} · ${seconds}s` +
      ` — ${failures} violation node(s), ${allowed} allowlisted, ${incomplete} incomplete, ${errors.length} scan error(s)`,
  );

  if (jsonOut) {
    writeFileSync(resolve(process.cwd(), jsonOut), JSON.stringify({
      axe: axeVersion(), engine, chrome, platform: process.platform, base,
      scope: { tags: WCAG_TAGS, extraRules: Object.keys(EXTRA_RULES), ruleCount },
      targets: machine, errors,
    }, null, 2) + "\n");
    console.log(`  ${DIM}machine-readable inventory → ${jsonOut}${OFF}`);
  }

  // --only 是调试用的部分跑，用它去判"陈旧条目"会把好条目误杀，所以这一条跳过。
  if (failures || errors.length || expired.length || (stale.length && !only)) process.exitCode = 1;
}

// vite preview 是子进程：看门狗走 process.exit 硬退时不会执行 finally，
// 只有 "exit" 事件还能跑。Chrome 同理，按 harness 自己的办法用 pkill 收尾。
process.on("exit", () => {
  killPreviewNow();
  spawnSync("pkill", ["-f", `remote-debugging-port=${DEBUG_PORT}`], { stdio: "ignore" });
});

await withWatchdog("a11y scan", GLOBAL_TIMEOUT_MS, async () => {
  try {
    await main();
  } catch (err) {
    console.error(`  ${RED}✗${OFF} a11y scan\n    ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
});
