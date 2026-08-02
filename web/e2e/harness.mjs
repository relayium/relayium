/**
 * 两个端到端脚本共用的那一层：CDP 客户端、标签页把手、浏览器生命周期、保存对话框桩。
 *
 * 它是从 lan-transfer.mjs 里原样搬出来的，没有改行为——搬出来的唯一理由是
 * mixed-link.mjs 需要一模一样的东西：**同一个** CDP 客户端、**同一套**超时语义、
 * **同一个** evaluate 看门狗。抄一份的话，两份迟早会漂移，而漂移的那一份会安静地
 * 变成一个测不出东西的假绿。
 *
 * 这里不放任何场景断言：场景归各自的脚本，共用的只有"怎么开一个真浏览器"。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };

const argv = process.argv.slice(2);
/** `--url http://localhost:1234` 这类带值的开关。 */
export const argFlag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
/** `--keep` 这类布尔开关。 */
export const argPresent = (name) => argv.includes(name);

/**
 * 按平台列出的 Chrome 候选路径。
 *
 * 以前这里是一个写死的 macOS 路径，于是这套 harness 只能在这一台机器上跑：Linux 上
 * spawn 一个不存在的可执行文件**不会**立刻报错，脚本会转而去连 CDP 端口，连 40 次
 * 之后抛一条 fetch 失败——真正的原因（没装 Chrome）在报错里一个字都没有。
 *
 * 顺序是有意的：先 Google Chrome，再 Chromium。两者的 WebRTC 行为并不完全一致，
 * 能拿到 Chrome 就不要退到 Chromium。
 */
const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
};

/** 能不能真的把它 spawn 起来：必须是**普通文件**，而且当前用户有执行位。 */
function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 给显式指定的路径一句人话，说清它到底哪儿不能用。 */
function describeUnusable(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    return err.code === "ENOENT" ? "there is no such file" : `it cannot be read (${err.code})`;
  }
  if (stat.isDirectory()) return "that is a directory, not an executable (point at the binary inside it)";
  if (!stat.isFile()) return "that is not a regular file";
  return "it is not executable by this user (check the execute bit)";
}

/**
 * 找一个能用的浏览器，找不到就**抛错**——绝不静默跳过。
 *
 * 一套"没有浏览器就当通过"的用例，在 CI 里和"全都过了"长得一模一样，那正是这个仓库
 * 最不想要的东西。所以这里宁可红，也不给任何跳过的口子。
 *
 * `CHROME_PATH` 一旦给了就只认它：显式指定之后再偷偷回退到别的浏览器，会变成
 * "我以为在测 A，其实在测 B"。
 */
export function resolveChrome() {
  const pinned = process.env.CHROME_PATH;
  if (pinned) {
    if (isExecutableFile(pinned)) return pinned;
    // 显式指定的路径要逐条说清楚**哪里**不对。"存在"是不够的：一个目录（比如顺手填了
    // 那个 .app 包本身）或一个没有执行位的文件都能通过存在性检查，然后 spawn 抛
    // EACCES/EISDIR——那条报错里一个字都不会提到 CHROME_PATH 填错了。
    throw new Error(`CHROME_PATH is set to ${pinned} but ${describeUnusable(pinned)} — fix it or unset it`);
  }
  const tried = CHROME_CANDIDATES[process.platform] ?? [];
  // 候选路径只跳过、不报错：一个装坏了的 Chromium 不该挡住排在它后面的好 Chrome。
  for (const candidate of tried) if (isExecutableFile(candidate)) return candidate;
  throw new Error(
    `no Chrome found on platform "${process.platform}".\n` +
      (tried.length ? `    tried: ${tried.join("\n           ")}\n` : "    no candidate paths are known for this platform\n") +
      `    install Google Chrome, or point CHROME_PATH at an existing binary.`,
  );
}

export const ok = (label) => console.log(`  \x1b[32m✓\x1b[0m ${label}`);
export const fail = (label, err) => {
  console.error(`  \x1b[31m✗\x1b[0m ${label}\n    ${err?.stack ?? err}`);
  process.exitCode = 1;
};

// ── 一个够用的 CDP 客户端（不引第三方依赖）───────────────────────────────────
export function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result);
    } else if (d.method) handlers.forEach((h) => h(d));
  };
  return {
    open,
    on: (h) => handlers.push(h),
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      }),
    close: () => ws.close(),
  };
}

/** 一个标签页的把手：evaluate / 等条件 / 收集 console 错误。 */
export async function newTab(browser, url, initScript) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  browser.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(
        [d?.text, d?.exception?.description ?? d?.exception?.value, d?.url && `${d.url}:${d.lineNumber}`]
          .filter(Boolean).join(" | "),
      );
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  const send = (m, p) => browser.send(m, p, sessionId);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("DOM.enable");
  if (initScript) await send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
  await send("Page.navigate", { url });

  // 每一次 evaluate 都带独立超时。**这是必须的**：页面主线程一旦被卡死（正是这套
  // 用例想抓的那类故障），CDP 的 evaluate 永远不返回，于是下面 waitFor 的超时判断
  // 根本轮不到执行——整个测试挂死，而挂死看起来和"还在跑"一模一样。宁可报一条
  // "页面没响应"，也不要一个永远不结束的 CI 任务。
  const EVAL_TIMEOUT_MS = 30_000;
  const evaluate = async (expression) => {
    const r = await Promise.race([
      send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true, // 收方的"接受"必须带用户手势，保存对话框才允许打开
      }),
      sleep(EVAL_TIMEOUT_MS).then(() => {
        throw new Error(`page stopped responding (evaluate exceeded ${EVAL_TIMEOUT_MS}ms) — its main thread is blocked`);
      }),
    ]);
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.exception?.value ?? r.exceptionDetails.text;
      throw new Error(`evaluate failed: ${detail} — ${expression}`);
    }
    return r.result?.value;
  };
  const waitFor = async (expression, what, timeoutMs = 45_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  };
  return { send, evaluate, waitFor, errors, targetId, sessionId };
}

export async function setWideViewport(tab, width = 1440, height = 900) {
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

// 收方页面的桩：把"另存为"换成一个把字节攒进内存并算 SHA-256 的假句柄。
// 这是整个脚本里唯一一处偏离真实运行的地方。
export const SAVE_STUB = `
  window.__e2e = { chunks: [], bytes: 0, closed: false, name: "", opens: 0, writeDelayMs: 0 };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    window.__e2e.name = suggestedName;
    window.__e2e.opens++;
    return {
      createWritable: async () => ({
        write: async (chunk) => {
          if (window.__e2e.writeDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, window.__e2e.writeDelayMs));
          }
          window.__e2e.chunks.push(chunk.slice());
          window.__e2e.bytes += chunk.byteLength;
        },
        close: async () => { window.__e2e.closed = true; },
      }),
    };
  };
  // 目录选择器也桩掉：万一批量分支被走到，别弹出真对话框把测试挂住。
  window.showDirectoryPicker = async () => { throw new Error("e2e: directory picker not stubbed"); };
`;

/**
 * 只读地记下这个 build 在**名册层**通告了哪些 capability（peer-caps 的 capsSignal）。
 *
 * 认帧的条件写得很紧：`data` 里除了 `caps` 什么都没有。SDP 的 offer/answer 上也捎带
 * 一份 caps（LOCAL_CAPS，连接级的确认），把那一份也算进来的话，这个探针就分不清
 * "这个 build 通告了什么" 和 "某条连接确认了什么"了。
 *
 * 两边都要它：默认构建那一套用它证明 link/1 **没被**通告，mixed 那一套用它在跑任何
 * 断言之前确认自己确实指着 `build:link-e2e` 的产物——否则"链路没建起来"会被误读成
 * 回归，而真正的原因只是拿错了 dist。
 */
export const OBSERVE_CAPS = `
  window.__advertisedCaps = null;
  (() => {
    const realSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const e = JSON.parse(data);
          if (e && e.type === "signal" && e.data && Array.isArray(e.data.caps)
              && Object.keys(e.data).length === 1) {
            window.__advertisedCaps = e.data.caps.slice();
          }
        } catch { /* 不是 JSON，照发 */ }
      }
      return realSend.call(this, data);
    };
  })();
`;

/** 服务器在不在。不在就直接说清楚怎么起，而不是让一堆 waitFor 慢慢超时。 */
export async function requireServer(base, hint) {
  const health = await fetch(`${base}/healthz`).then((r) => r.text()).catch(() => "");
  if (health.trim() !== "ok") throw new Error(`no server at ${base} — ${hint}`);
}

/**
 * 起一个真 Chrome 并连上 CDP，返回 `{ browser, close }`。调用方在 finally 里 close。
 *
 * 先 pkill 掉上一轮跑崩/被 kill 掉留下的浏览器：它们的标签页还挂着 WebSocket，而
 * 服务器有每 IP 的并发 /ws 上限——攒够几个之后新标签页会**静默地**连不上信令，
 * 表现成"两边互相看不见"，和真回归一模一样。这一步不是洁癖，是在保证失败信号可信。
 * 只杀同一个 debugPort 的实例，所以两个脚本各用各的端口就不会互相误伤。
 */
export async function launchBrowser({ debugPort, keep = false }) {
  // 先解析浏览器：没有浏览器就没必要 pkill、建临时 profile 或等 800ms，直接报清楚。
  const chromeBin = resolveChrome();
  try {
    spawn("pkill", ["-f", `remote-debugging-port=${debugPort}`], { stdio: "ignore" });
    await sleep(800);
  } catch { /* 没有残留就没得可杀 */ }

  const profile = mkdtempSync(join(tmpdir(), "relayium-e2e-"));
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Chrome 默认把本机 IP 藏成 mDNS（.local）候选，而无头环境里没有 mDNS
      // 解析器 —— 两个标签页于是永远配不出可用的候选对，ICE 直接 failed。
      // 关掉这个隐藏策略，host 候选就是真的 127.0.0.1，本机直连立刻成立。
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const close = async (browser) => {
    browser?.close();
    chrome.kill();
    await sleep(500); // 让 Chrome 先把 profile 目录里的文件句柄放掉
    if (!keep) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* 临时目录，留着也无妨 */ }
    }
  };

  let browser;
  try {
    // 等 CDP 端口起来。
    for (let i = 0; ; i++) {
      try {
        const v = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json());
        browser = cdp(v.webSocketDebuggerUrl);
        await browser.open;
        break;
      } catch (e) {
        if (i > 40) throw e;
        await sleep(250);
      }
    }
  } catch (err) {
    // Chrome 起来了但 CDP 连不上：进程还在，不收就会留一个孤儿浏览器和一个孤儿 profile。
    await close(browser);
    throw err;
  }
  return { browser, close: () => close(browser) };
}

/**
 * 全局看门狗。
 *
 * 单看 evaluate 的超时不够：卡住的可能是 CDP 的任意一次往返（建标签页、关标签页、
 * 附加会话），任何一处永不返回都会让整个套件静默挂死——而"挂死"在 CI 里和"还在跑"
 * 长得一模一样，比一条红色失败糟得多。实测踩过：破坏版让收方主线程卡死之后，套件
 * 跑了 9 分钟还没有任何输出。
 */
export async function withWatchdog(label, timeoutMs, run) {
  await Promise.race([
    run(),
    sleep(timeoutMs).then(() => {
      console.error(`  \x1b[31m✗\x1b[0m ${label}\n    hard timeout after ${timeoutMs / 60000} min — something hung; see the notes on the global watchdog`);
      process.exit(1);
    }),
  ]);
  // 收尾：run 的 finally 已经收过浏览器，这里只是确保进程不被 CDP 的 socket 挂住。
  process.exit(process.exitCode ?? 0);
}
