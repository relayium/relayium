#!/usr/bin/env node
/**
 * 设备发现 / 改名 / 吊销 —— 真浏览器验收。
 *
 *   cd web && npm run build && npm run test:device-discovery
 *
 * 为什么必须是真浏览器：这一批修的是**发现性**，而发现性只在渲染之后才存在。jsdom
 * 能证明某个字符串在 DOM 里，证明不了它在 390px 上没有被挤出屏幕、证明不了换一种
 * 语言之后整行还排得下、也证明不了那个 CTA 真的能把人带到 Device Inbox。
 *
 * 三种视角，同一组断言：桌面 1440×900、窄屏 390×844、中文 1440×900。
 *
 * 第三格原本是阿拉伯语 RTL。2026-08-14 语言冻结之后，应用只维护英文和简体中文，
 * 没有任何一种可选语言是从右往左的——也就是说那一格测的是用户根本到不了的状态。
 * 换成中文，保留它真正在测的东西：这些界面是**翻译出来的**而不是写死英文，而且
 * shell 命令块无论页面语言如何都仍然显式声明 dir="ltr"（真正的 RTL 渲染仍由
 * 归档的阿拉伯语静态页覆盖，见 e2e/a11y-targets.mjs 里那两格 static 阿拉伯语目标）。
 *
 * 它不碰真服务端：/api/* 走 a11y 那套 fixture 注入（GET），写操作（PATCH/DELETE）
 * 由页面内的一层 fetch 包装记录并应答。要验的是界面行为，不是后端——后端那半边由
 * server/account 的 Go 测试覆盖。
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFixtureScript } from "./a11y-fixtures.mjs";
import { argFlag, fail, launchBrowser, newTab, ok, sleep, withWatchdog } from "./harness.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
// 清理只认自己配置的那个调试端口，所以同端口的脚本绝不能并发：9447 是有意共用的，
// 本脚本、code-room 和 device-inbox 都串行执行。mixed-link 独占 9445，a11y 和
// share-target 共用 9446。9444 由已删除的 `lan-transfer.mjs` 用过，不回收。
const DEBUG_PORT = 9447;
const PREVIEW_PORT = Number(argFlag("--preview-port", "4184"));
const GLOBAL_TIMEOUT_MS = 5 * 60_000;

const DEVICE_A = "0123456789abcdef0123456789aaa111";
const DEVICE_B = "0123456789abcdef0123456789bbb222";

/** 两台**同名**设备。改名之前，一个账号里的每台 CLI 机器都叫这个名字——这正是要
 *  验的场景：可见文字完全相同，能区分它们的只有类型、ID 尾号和登录时间。 */
const ROUTES = {
  "/api/me": { user: { id: "u1", email: "owner@example.com", displayName: "Owner", hasPassword: true } },
  "/api/me/usage": {
    period: "202608", resetsAt: 1756684800,
    traffic: { used: 0, cap: 1e9 }, storage: { used: 0, cap: 1e9 },
  },
  "/api/stats": { transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 },
  "/api/files": { files: [] },
  "/api/nodes/mine": { nodes: [] },
  "/api/devices": {
    devices: [
      { ID: DEVICE_A, Name: "CLI", CreatedAt: 1_750_000_000, LastSeenAt: 0, Kind: "cli" },
      { ID: DEVICE_B, Name: "CLI", CreatedAt: 1_740_000_000, LastSeenAt: 0, Kind: "cli" },
    ],
  },
};

/** 记录写操作并给出成功应答。fixture 那一层只处理 GET，写操作要自己拦。 */
const WRITE_RECORDER = `
  window.__writes = [];
  (() => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const method = String(init?.method ?? (input && input.method) ?? "GET").toUpperCase();
      if (method === "PATCH" || method === "DELETE") {
        window.__writes.push({ url, method, body: init?.body ?? null });
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
      return real(input, init);
    };
  })();
`;

let preview = null;

async function startPreview() {
  const viteBin = resolve(here, "..", "node_modules", "vite", "bin", "vite.js");
  preview = spawn(
    process.execPath,
    [viteBin, "preview", "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: resolve(here, ".."), stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${PREVIEW_PORT}`;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + "/", { redirect: "manual" });
      if (r.status < 500) return base;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error("vite preview did not come up — did you run `npm run build` first?");
}

async function stopPreview() {
  if (!preview) return;
  const exited = once(preview, "exit");
  try { preview.kill("SIGTERM"); } catch { /* 已经没了 */ }
  await Promise.race([exited, sleep(3_000)]);
  try { preview.kill("SIGKILL"); } catch { /* 已经没了 */ }
  preview = null;
}

/** 一个视角：视口 + 语言前缀。 */
const VIEWS = [
  { id: "desktop", width: 1440, height: 900, prefix: "", lang: "en", localized: false },
  { id: "mobile-390", width: 390, height: 844, prefix: "", lang: "en", localized: false },
  { id: "chinese", width: 1440, height: 900, prefix: "", lang: "zh", localized: true },
];

async function openTab(browser, base, view, path) {
  const tab = await newTab(browser, base + view.prefix + path, [
    apiFixtureScript(ROUTES),
    WRITE_RECORDER,
    // 语言由 localStorage 决定，和真实用户切换语言后的状态一致。
    `try { localStorage.setItem("relayium-lang", ${JSON.stringify(view.lang)}); } catch {}`,
  ].join("\n"));
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.width < 700,
  });
  return tab;
}

/** 元素在视口里确实看得见，而且没有横向溢出。窄屏上"渲染了"和"看得见"是两件事。 */
const VISIBLE = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "missing";
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return "zero-sized";
  if (r.right > document.documentElement.clientWidth + 1) return "overflows the viewport";
  if (getComputedStyle(el).visibility === "hidden") return "visibility:hidden";
  return "";
})()`;

async function checkCliPage(browser, base, view) {
  const tab = await openTab(browser, base, view, "/cli");
  await tab.waitFor(`!!document.querySelector("#device-inbox")`, `${view.id}: /cli Device Inbox section`);

  const bad = await tab.evaluate(VISIBLE("#device-inbox"));
  if (bad) throw new Error(`${view.id}: the Device Inbox section is ${bad}`);

  const order = await tab.evaluate(
    `[...document.querySelectorAll("[data-cli-mode]")].map((e) => e.getAttribute("data-cli-mode"))`,
  );
  const expected = ["up / down", "inbox", "text", "send / receive", "push / pull", "daemon direct", "sync"];
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    throw new Error(`${view.id}: CLI mode order is ${JSON.stringify(order)}, expected ${JSON.stringify(expected)}`);
  }

  const ctaBad = await tab.evaluate(VISIBLE("#device-inbox .cta a"));
  if (ctaBad) throw new Error(`${view.id}: the Device Inbox CTA is ${ctaBad}`);

  if (view.localized) {
    // 页面语言真的跟着 localStorage 走了：<html lang> 换成了中文，而不是回落英文。
    const htmlLang = await tab.evaluate(`document.documentElement.lang`);
    if (htmlLang !== "zh") throw new Error(`chinese: <html lang> is ${htmlLang}, not zh`);
    // 这一段是翻译出来的，不是写死的英文。取标题的第一行来判：整段里混着
    // com.relayium.mac 这类不翻译的专有名词，拿整段判会被它们带偏。
    const heading = await tab.evaluate(`document.querySelector("#device-inbox h2")?.textContent ?? ""`);
    if (!/[\u4e00-\u9fff]/.test(heading)) {
      throw new Error(`chinese: the Device Inbox heading is not translated — ${JSON.stringify(heading)}`);
    }
    // 命令块必须显式声明 LTR：一条 shell 命令被镜像过来是读不了也复制不对的。
    // 查的是 <pre> 上的 dir **属性**（CommandBlock 打在它上面），不是计算样式——
    // 现在没有任何一种可选语言是 RTL，计算样式必然是 ltr，那样断言等于没测。
    // 属性还在，才意味着哪天恢复某个 RTL 语言时这层保护仍然生效。
    const cmdDirs = await tab.evaluate(
      `[...document.querySelectorAll("#device-inbox pre")].map((e) => e.getAttribute("dir"))`,
    );
    if (!cmdDirs.length) throw new Error("chinese: the Device Inbox section has no command block at all");
    if (cmdDirs.some((d) => d !== "ltr")) {
      throw new Error(`chinese: a command block declares dir=${cmdDirs.join("/")}; shell commands must stay ltr`);
    }
  }

  // CTA 真的把人带到现在可以直接操作的 Device Inbox，而不只是长得像个链接。
  await tab.evaluate(`document.querySelector("#device-inbox .cta a").click()`);
  await tab.waitFor(`location.pathname.endsWith("/device-inbox")`, `${view.id}: CTA navigates to /device-inbox`);
  ok(`${view.id}: /cli uses the product-priority order and the CTA reaches Device Inbox`);
}

async function checkMyDevices(browser, base, view) {
  const tab = await openTab(browser, base, view, "/me");
  await tab.waitFor(`document.querySelectorAll(".devicelist li").length === 2`, `${view.id}: two device rows`);

  const bad = await tab.evaluate(VISIBLE(".devicelist li"));
  if (bad) throw new Error(`${view.id}: the device row is ${bad}`);

  // 同名两行：可见文字一样，但每一行都带着自己的 ID 尾号。
  const refs = await tab.evaluate(
    `[...document.querySelectorAll(".devicelist .deviceref")].map((e) => e.textContent.trim())`,
  );
  if (refs.length !== 2 || refs[0] === refs[1]) {
    throw new Error(`${view.id}: the two identically named rows show ${JSON.stringify(refs)}`);
  }
  if (!refs[0].includes("aaa111") || !refs[1].includes("bbb222")) {
    throw new Error(`${view.id}: id fragments are wrong: ${JSON.stringify(refs)}`);
  }
  for (const ref of refs) {
    if (ref.includes(DEVICE_A) || ref.includes(DEVICE_B)) {
      throw new Error(`${view.id}: a full device id is on screen`);
    }
  }

  // 每一行的第二行都说出登录时间和"自登录以来用过没有"，而且都看得见。
  const metaBad = await tab.evaluate(VISIBLE(".devicelist li .devicemeta"));
  if (metaBad) throw new Error(`${view.id}: the signed-in / last-used line is ${metaBad}`);

  // 一台都没开收件箱 → 页面必须自己解释为什么没有发送按钮，并给出去 /cli 的入口。
  const setup = await tab.evaluate(`document.querySelector(".accountdevices .setup a")?.getAttribute("href") ?? ""`);
  if (!setup.endsWith("/cli#device-inbox")) {
    throw new Error(`${view.id}: no link back to the CLI setup section (got ${JSON.stringify(setup)})`);
  }
  const sendZone = await tab.evaluate(`!!document.querySelector(".sendzone")`);
  if (sendZone) throw new Error(`${view.id}: a send control appeared on a device with no inbox`);

  // 那个链接是真导航（不是 SPA navigate），因为要靠浏览器去滚到 #device-inbox。
  // 只断言 href 是不够的：SPA 外壳是空的，锚点元素要等 JS 挂完才存在，浏览器
  // 完全可能在它出现之前就放弃滚动，于是用户落在页面顶端——和没有锚点一样。
  await tab.evaluate(`document.querySelector(".accountdevices .setup a").click()`);
  await tab.waitFor(`location.pathname.endsWith("/cli")`, `${view.id}: setup link reaches /cli`);
  await tab.waitFor(`!!document.querySelector("#device-inbox")`, `${view.id}: the linked section`);
  await tab.waitFor(
    `(() => { const r = document.querySelector("#device-inbox").getBoundingClientRect();
              return r.top < window.innerHeight * 0.5; })()`,
    `${view.id}: the linked section is scrolled into view`,
    15_000,
  );
  ok(`${view.id}: the setup link lands on the Device Inbox section, not the top of /cli`);

  // 回到 /me 继续验改名和吊销。
  await tab.evaluate(`history.back()`);
  await tab.waitFor(`document.querySelectorAll(".devicelist li").length === 2`, `${view.id}: back on /me`);

  if (view.localized) {
    // 设备行在中文下同样是完整一行、没有横向溢出（上面的 VISIBLE 已经在查），
    // 这里再确认这一屏确实是中文渲染的，而不是悄悄回落到了英文。
    const htmlLang = await tab.evaluate(`document.documentElement.lang`);
    if (htmlLang !== "zh") throw new Error(`chinese: /me renders in ${htmlLang}, not zh`);
  }

  // ── 改名 ────────────────────────────────────────────────────────────────
  await tab.evaluate(`
    (() => {
      const row = document.querySelectorAll(".devicelist li")[1];
      const btn = [...row.querySelectorAll("button")].find((b) => b.className.includes("chk"));
      btn.click();
    })()
  `);
  await tab.waitFor(`!!document.querySelectorAll(".devicelist li")[1].querySelector(".renameinput")`, `${view.id}: rename editor`);
  const inputBad = await tab.evaluate(VISIBLE(".devicelist li .renameinput"));
  if (inputBad) throw new Error(`${view.id}: the rename field is ${inputBad}`);

  await tab.evaluate(`
    (() => {
      const row = document.querySelectorAll(".devicelist li")[1];
      const input = row.querySelector(".renameinput");
      input.value = "prod-backup-1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      row.querySelector(".renameform").requestSubmit();
    })()
  `);
  await tab.waitFor(
    `document.querySelectorAll(".devicelist li")[1].querySelector(".devicename")?.textContent.trim() === "prod-backup-1"`,
    `${view.id}: the renamed row`,
  );
  const patch = await tab.evaluate(`window.__writes.filter((w) => w.method === "PATCH")`);
  if (patch.length !== 1 || !patch[0].url.endsWith(DEVICE_B)) {
    throw new Error(`${view.id}: rename hit ${JSON.stringify(patch)}`);
  }
  const otherName = await tab.evaluate(`document.querySelectorAll(".devicelist li")[0].querySelector(".devicename").textContent.trim()`);
  if (otherName !== "CLI") throw new Error(`${view.id}: renaming one row changed the other to ${otherName}`);

  // ── 吊销 ────────────────────────────────────────────────────────────────
  // 剩下那一行仍然叫 CLI；确认框必须靠尾号说清楚要断的是哪一台。
  await tab.evaluate(`document.querySelectorAll(".devicelist li")[0].querySelector("button.del").click()`);
  await tab.waitFor(`!!document.querySelector('[role="dialog"]')`, `${view.id}: revoke confirmation`);
  const dialog = await tab.evaluate(`document.querySelector('[role="dialog"]').textContent`);
  if (!dialog.includes("aaa111")) throw new Error(`${view.id}: the confirmation does not name which device: ${dialog}`);
  if (dialog.includes("bbb222")) throw new Error(`${view.id}: the confirmation names the wrong device`);
  if (dialog.includes(DEVICE_A)) throw new Error(`${view.id}: the confirmation exposes a full device id`);

  await tab.evaluate(`
    (() => {
      const buttons = [...document.querySelectorAll('[role="dialog"] button')];
      // 肯定按钮是最后一个：取消在前。用文字匹配会在换语言之后失效。
      buttons[buttons.length - 1].click();
    })()
  `);
  await tab.waitFor(`document.querySelectorAll(".devicelist li").length === 1`, `${view.id}: the revoked row disappears`);
  const del = await tab.evaluate(`window.__writes.filter((w) => w.method === "DELETE")`);
  if (del.length !== 1 || !del[0].url.endsWith(DEVICE_A)) {
    throw new Error(`${view.id}: revoke hit ${JSON.stringify(del)}`);
  }
  const left = await tab.evaluate(`document.querySelector(".devicelist .deviceref").textContent`);
  if (!left.includes("bbb222")) throw new Error(`${view.id}: the wrong row was removed`);

  if (tab.errors.length) throw new Error(`${view.id}: page errors — ${tab.errors.join(" / ")}`);
  ok(`${view.id}: My Devices distinguishes, renames and revokes the right row`);
}

await withWatchdog("device-discovery", GLOBAL_TIMEOUT_MS, async () => {
  const base = await startPreview();
  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT });
  try {
    for (const view of VIEWS) {
      await checkCliPage(browser, base, view);
      await checkMyDevices(browser, base, view);
    }
    console.log("\n  device discovery, rename and revoke verified in a real browser at 1440×900, 390×844 and 1440×900 in Chinese\n");
  } catch (err) {
    fail("device-discovery", err);
    process.exitCode = 1;
  } finally {
    await close();
    await stopPreview();
  }
});
