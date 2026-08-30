/**
 * 所有端到端脚本共用的那一层：CDP 客户端、标签页把手、浏览器生命周期、保存对话框桩。
 *
 * 它当初是从已删除的 `lan-transfer.mjs` 里原样搬出来的，没有改行为——搬出来的唯一
 * 理由是别的脚本需要一模一样的东西：**同一个** CDP 客户端、**同一套**超时语义、
 * **同一个** evaluate 看门狗。抄一份的话，两份迟早会漂移，而漂移的那一份会安静地
 * 变成一个测不出东西的假绿。
 *
 * 这里不放任何场景断言：场景归各自的脚本，共用的只有"怎么开一个真浏览器"。
 *
 * 没有"整轮共用的默认 init 脚本"这回事。以前有一个 `setDefaultInit`，它只服务
 * `lan-transfer.mjs` 那条降级路径——把 `link/1` 从每一帧 caps 里掐掉的
 * `STRIP_LINK_CAP`。那个 runner 在阶段四删掉之后，这两样都跟着删了：留一个全局
 * 可写的、能悄悄改掉每个标签页启动状态的开关，只会让下一个场景在不知情的情况下
 * 继承别人的前提。每个标签页要什么自己传什么（`newTab` 的 `initScript`）。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { watchChromeProcess } from "./chrome-process.mjs";
import { cleanupStaleBrowsers } from "./stale-cleanup.mjs";

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

/**
 * A CDP command that came back with a protocol `error` object.
 *
 * The fields are KEPT, not flattened. `new Error(JSON.stringify(d.error))` was
 * lossless as text and useless as a value: the one decision anybody has to make
 * about a CDP failure — is this the page moving under us, or is it broken — then
 * had to be made by re-parsing our own error message, and a message is precisely
 * the half of the protocol Chrome is free to reword. `code` is the stable half.
 *
 * The printed form still carries everything, so an unhandled one reads the same
 * as before, only in a sentence rather than a JSON blob.
 */
export class CdpError extends Error {
  constructor(method, error) {
    const code = error?.code;
    const detail = error?.message ?? "";
    const data = error?.data;
    super(`CDP ${method} failed: ${code ?? "no code"} ${detail}${data === undefined ? "" : ` — ${data}`}`.trim());
    this.name = "CdpError";
    this.method = method;
    // Only a real number: a string "-32000" that compares unequal to every code
    // below would silently disable the classifier rather than fail.
    this.code = typeof code === "number" ? code : undefined;
    this.cdpMessage = detail;
    if (data !== undefined) this.data = data;
  }
}

/**
 * The exact `-32000` messages that mean "the page moved while I was asking".
 *
 * Enumerated rather than pattern-matched, and deliberately short. `-32000` alone
 * is Chrome's generic server error — it also covers a node that no longer
 * exists, a frame that was never attached and a dozen other REAL failures, so
 * retrying on the code would turn genuine regressions into 45-second timeouts
 * with the cause thrown away. Anything not on this list fails loudly, which is
 * the direction it should fail in if Chrome ever rewords one of these.
 */
const NAVIGATION_TRANSIENTS = new Set([
  "Inspected target navigated or closed",
  "Cannot find context with specified id",
  "Execution context was destroyed",
  "Execution context with given id not found",
]);

/** Chrome is inconsistent about the trailing full stop between these messages
 *  and between versions; nothing else about them is normalised. */
const cdpMessageKey = (message) => String(message ?? "").trim().replace(/\.+$/, "");

/**
 * Is this the page navigating, and nothing else?
 *
 * Note what it does NOT accept: a plain `Error` (the evaluate watchdog, a page
 * exception), a different code, or `-32001 Session with given id not found`,
 * which is a detached session — permanent, and never worth a retry.
 */
export function isNavigationTransient(err) {
  return err instanceof CdpError
    && err.code === -32000
    && NAVIGATION_TRANSIENTS.has(cdpMessageKey(err.cdpMessage));
}

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
      const { method, resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new CdpError(method, d.error)) : resolve(d.result);
    } else if (d.method) handlers.forEach((h) => h(d));
  };
  return {
    open,
    on: (h) => handlers.push(h),
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        // The method travels with the pending call: the reply carries only an
        // id, and a CDP error naming no command is one a reader cannot place.
        pending.set(i, { method, resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      }),
    close: () => ws.close(),
  };
}

/** localStorage key holding this browser profile's LAN seed (lan-device-id.ts).
 *  The app derives its advertised installation id from it, so the per-page test
 *  override decides which virtual tabs count as one device. */
const LAN_SEED_KEY = "relayium.lan.seed";

let lanSeedSerial = 0;
/**
 * A fresh, distinct LAN seed.
 *
 * Every tab in a run shares ONE browser profile, so without this they would all
 * derive the same installation id and the hub would correctly collapse them into
 * a single device — every existing two-tab scenario would then see zero peers.
 * The scenarios mean "two devices", so each tab gets its own seed and keeps
 * simulating an independent device. A scenario that genuinely means "two pages
 * of ONE device" passes the same seed to both tabs explicitly.
 *
 * Deterministic (a counter, not randomness) so a failing run is reproducible.
 */
export const distinctLanSeed = () => (++lanSeedSerial).toString(16).padStart(64, "0");

/**
 * Init script giving THIS page its own LAN seed, before any application code
 * runs.
 *
 * It overrides the one storage key rather than writing it, because localStorage
 * is shared by every tab of the profile: a tab that wrote its seed would
 * immediately have it overwritten by the next tab, and all of them would end up
 * one device. The override is per page, which is exactly the "different browser
 * profile" the scenarios are simulating. Everything else in storage — device
 * name, preferences — still behaves normally and is still shared.
 */
export const lanSeedScript = (seed) => `
  (() => {
    const KEY = ${JSON.stringify(LAN_SEED_KEY)};
    const SEED = ${JSON.stringify(seed)};
    const proto = Storage.prototype;
    const get = proto.getItem, set = proto.setItem, del = proto.removeItem;
    const isSeed = (store, key) => store === localStorage && key === KEY;
    proto.getItem = function (k) { return isSeed(this, k) ? SEED : get.call(this, k); };
    proto.setItem = function (k, v) { if (!isSeed(this, k)) set.call(this, k, v); };
    proto.removeItem = function (k) { if (!isSeed(this, k)) del.call(this, k); };
  })();
`;

/** Make `tab` the tab the user is looking at, and wait until the page agrees.
 *  A real activation, not a stubbed visibility flag: Chrome's --headless=new
 *  drives document.visibilityState and hasFocus() from it, so the app's own
 *  current-page logic is what runs. */
export async function activateTab(browser, tab) {
  await browser.send("Target.activateTarget", { targetId: tab.targetId });
  await tab.waitFor("document.visibilityState === 'visible'", "this tab to become the visible one");
}

/** 一个标签页的把手：evaluate / 等条件 / 收集 console 错误。
 *  `lanSeed` decides which installation this page belongs to; by default a fresh
 *  one, i.e. its own device. */
export async function newTab(browser, url, initScript, { lanSeed = distinctLanSeed() } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  /**
   * Why the tab's death is TRACKED rather than read out of the error text.
   *
   * A target that has been closed and a target that is mid-navigation answer
   * the same `Runtime.evaluate` with the same words: `-32000 Inspected target
   * navigated or closed`. That sentence names both, and Chrome will not tell
   * them apart for us. Retrying the navigation is the entire point of the wait
   * below; retrying the closed one is a 45-second wait for a tab that is never
   * coming back, ending in a timeout that blames the assertion instead of the
   * close. The Target events are the only thing that knows which happened, so
   * the first one that arrives wins and every later wait fails at once.
   */
  let gone = null;
  const markGone = (reason) => { if (gone === null) gone = reason; };
  browser.on((msg) => {
    // Before the session filter, deliberately: a flat session's detach is
    // reported on the BROWSER session, so `msg.sessionId` is undefined on the
    // one event that matters most here and the filter would drop it.
    if (msg.method === "Target.detachedFromTarget"
        && (msg.params?.sessionId === sessionId || msg.params?.targetId === targetId)) {
      markGone(`was detached from the debugger (${msg.params?.reason ?? "no reason given"})`);
    }
    if (msg.method === "Target.targetCrashed" && msg.params?.targetId === targetId) {
      markGone("crashed");
    }
    if (msg.method === "Target.targetDestroyed" && msg.params?.targetId === targetId) {
      markGone("was closed");
    }
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
  // The seed goes first and unconditionally: a tab with no init script of its
  // own still has to be an independent device. The scenario's own script is
  // layered on top of it, never instead of it.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: [lanSeedScript(lanSeed), initScript].filter(Boolean).join("\n"),
  });
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
  /**
   * The one way a wait ends because the tab itself ended.
   *
   * `err` is whatever the poll was holding when the lifecycle state was read: a
   * protocol error when the poll threw, and nothing at all when it answered
   * normally or had not been issued yet. It is passed through, never invented.
   * A `cause` the run did not actually produce — a synthetic error, or the
   * transient from some earlier poll — would send a reader looking for a
   * protocol failure that never happened, and the tab's ending is already the
   * whole diagnosis.
   */
  const tabIsGone = (what, err) => (err === undefined
    ? new Error(`gave up waiting for ${what}: the tab ${gone}`)
    : new Error(`gave up waiting for ${what}: the tab ${gone} — ${err.message}`, { cause: err }));

  /**
   * Poll `expression` until it is truthy, or the budget runs out.
   *
   * The retry lives HERE and nowhere else. A wait is by definition a statement
   * that the page is still settling, so a poll that lands in the middle of a
   * navigation has learned nothing and asking again is honest. `evaluate` is the
   * opposite: a single question at a single moment, whose caller wrote the line
   * because it believed the page was already there. Retrying that one would turn
   * "your assumption about the page was wrong" into a silent second chance.
   *
   * Hosted run 32619074912 is the failure this exists for: `history.back()`,
   * then the very next poll on the /me device list, and Chrome answered `-32000
   * Inspected target navigated or closed`. The same source had passed the same
   * job on the PR minutes earlier — the back navigation and the poll are simply
   * racing, and the loser was whichever the runner happened to schedule first.
   */
  const waitFor = async (expression, what, timeoutMs = 45_000) => {
    // Computed once, and never again. Recomputing it after a retry is what
    // would turn a page that navigates every 200ms into a wait with no end —
    // a transient has to cost budget exactly like any other unsuccessful poll.
    const deadline = Date.now() + timeoutMs;
    let lastTransient = null;
    let transients = 0;
    for (;;) {
      // The tab's death is checked around the poll, not only inside its catch.
      // A `Target` event is not something the next `Runtime.evaluate` is
      // obliged to report: it can arrive while this loop is sleeping, and a
      // poll issued afterwards may still answer an ordinary `false` — from a
      // renderer that Chrome has already told us is detached, destroyed or
      // crashed. Reading the lifecycle state only when a poll happens to throw
      // makes a real close indistinguishable from a slow page, and turns it
      // into a timeout blaming the assertion. So: before every poll…
      if (gone !== null) throw tabIsGone(what);
      let observed = false;
      try {
        observed = Boolean(await evaluate(expression));
      } catch (err) {
        // Lifecycle first, wording second, never the other way round. This is
        // the case where the message is actively misleading: a closed tab says
        // it "navigated or closed" too, and reading the message first would
        // spend the whole budget retrying a target that no longer exists.
        if (gone !== null) throw tabIsGone(what, err);
        // Everything else — a page exception, the evaluate watchdog, any other
        // CDP failure — is the caller's answer, and it gets it immediately.
        if (!isNavigationTransient(err)) throw err;
        lastTransient = err;
        transients++;
      }
      // A condition that was actually observed is the answer, even if the tab
      // ended a moment later: the wait got the thing it was waiting for, and
      // failing it on the ending would be inventing a failure.
      if (observed) return;
      // …and after every poll that did not observe it. This is the half the
      // catch cannot reach: the event landed DURING the poll and the poll still
      // returned normally, so nothing threw and nothing else will look.
      if (gone !== null) throw tabIsGone(what);
      if (Date.now() > deadline) {
        // A wait that ended in transients did NOT observe the condition, and
        // says so with the reason attached. Without the count and the last
        // error this reads as an ordinary product failure, which is exactly the
        // misdiagnosis the hosted run above cost.
        throw new Error(lastTransient === null
          ? `timed out waiting for ${what}`
          : `timed out waiting for ${what} after ${timeoutMs}ms — the page kept navigating out from under the check `
            + `(${transients} transient CDP error${transients === 1 ? "" : "s"}, last: ${lastTransient.message})`);
      }
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
 * 一份 caps（localCaps()，连接级的确认），把那一份也算进来的话，这个探针就分不清
 * "这个 build 通告了什么" 和 "某条连接确认了什么"了。
 *
 * `mixed-link.mjs` 用它在跑任何断言之前确认这个产物真的通告了 link/1 —— 否则
 * "链路没建起来"会被误读成回归，而真正的原因可能只是指错了服务器/构建。
 */

/** Turn ON the advanced-verification preference before the app boots.
 *
 * The SAS presentation rules ("one link, one SAS", stickiness, the announced
 * code) are rules about the OPT-IN path — the shipped default shows no code at
 * all. A scenario that asserts them has to say so, rather than silently
 * depending on a default that has since changed. Written as an init script so
 * it lands before the module reads localStorage at import time.
 *
 * Key must match verify-pref.svelte.ts's ON_KEY. */
export const VERIFY_ON = `
  try { localStorage.setItem("relayium.verify.on", "1"); } catch { /* private mode */ }
`;

/** The opposite, and NOT the same as injecting nothing.
 *
 * Every tab in a run shares one browser profile, so the first scenario that
 * injects VERIFY_ON leaves the key in localStorage for the whole origin. A
 * later tab that injects nothing therefore inherits verification ON — a
 * "default path" scenario written that way silently tests the opt-in path
 * instead, and hangs waiting for a consent gate it claimed would not appear.
 * Removing the key is what actually reproduces a device that has never touched
 * the preference. */
export const VERIFY_DEFAULT = `
  try { localStorage.removeItem("relayium.verify.on"); } catch { /* private mode */ }
`;

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
 * How long a launch waits for Chrome's debug port to answer, in wall-clock ms.
 *
 * This used to be a probe COUNT (41 sleeps at 250ms). A count answers the wrong
 * question: hosted run 31554507246 attempt 4 gave up after exactly 42 refused
 * probes in ~10.3s, with the child still alive and its stderr empty — and
 * nothing in that log said whether Chrome was slow or stuck, because the limit
 * it hit was an artefact of the loop rather than a budget anyone had chosen.
 *
 * A wall-clock deadline is the number a human can actually reason about, and it
 * is directly comparable to the readiness line a green run prints. 45s is
 * deliberately far above a healthy launch: the point is to stop turning "a slow
 * hosted runner" into a red build, while still bounding the wait so a genuinely
 * stuck browser cannot hang CI.
 */
export const CDP_READY_TIMEOUT_MS = 45_000;

/**
 * Marks the error a readiness phase throws when it ran out of budget.
 *
 * A flag rather than `waitedMs >= readyTimeoutMs`: the numeric comparison is a
 * re-derivation of a fact the timer already knows, and it disagrees with the
 * timer near the boundary (the timer may fire a hair before `performance.now()`
 * agrees the budget is spent). Getting that wrong would report a genuine
 * deadline as an ordinary probe failure, i.e. drop the one line that says
 * whether waiting longer would have helped.
 */
const DEADLINE_HIT = Symbol("cdp readiness deadline");

/**
 * Reject a deadline that would make the wait meaningless, before spawning
 * anything.
 *
 * The two failure modes are opposite and both bad: `Infinity`/`NaN` never
 * expires, so a stuck browser hangs the job forever with no diagnostic at all
 * (`NaN >= x` is false, so the loop would simply never end), while `0` or a
 * negative would give up on the very first refusal — which, on a healthy but
 * cold runner, looks exactly like a real regression. A string sneaks past both
 * checks by comparing fine and then printing as `"20000"ms`.
 */
function checkedReadyTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw new Error(
      `cdpReadyTimeoutMs must be a finite number of milliseconds greater than 0 — got ${shown}`,
    );
  }
  return value;
}

/**
 * 起一个真 Chrome 并连上 CDP，返回 `{ browser, close }`。调用方在 finally 里 close。
 *
 * 先 pkill 掉上一轮跑崩/被 kill 掉留下的浏览器：它们的标签页还挂着 WebSocket，而
 * 服务器有每 IP 的并发 /ws 上限——攒够几个之后新标签页会**静默地**连不上信令，
 * 表现成"两边互相看不见"，和真回归一模一样。这一步不是洁癖，是在保证失败信号可信。
 * 只杀同一个 debugPort 的实例，所以两个脚本各用各的端口就不会互相误伤。
 *
 * `cdpReadyTimeoutMs` is an option rather than an environment variable on
 * purpose: a test that has to mutate `process.env` to pick a deadline leaks that
 * setting into every other test sharing the process, and the harness would have
 * to parse and validate a string that any surrounding shell could also set by
 * accident. An argument is passed by exactly one caller and validated once.
 *
 * `cleanup` is the seam that lets that first step be tested (see
 * stale-cleanup.mjs). No e2e script passes it; it exists so the tests never have
 * to depend on this machine's real `pkill` — which cannot be made slow, broken
 * or absent on demand.
 */
export async function launchBrowser({ debugPort, keep = false, cdpReadyTimeoutMs = CDP_READY_TIMEOUT_MS, cleanup = {} }) {
  // Before the cleanup, the profile and the spawn: an unusable deadline is a
  // programming error, and reporting it after killing browsers and creating a
  // temp directory would mean cleaning up work that never should have started.
  const readyTimeoutMs = checkedReadyTimeout(cdpReadyTimeoutMs);
  // 先解析浏览器：没有浏览器就没必要 pkill、建临时 profile，直接报清楚。
  const chromeBin = resolveChrome();
  // Awaited, and NOT wrapped in a try/catch: the cleanup command matches the
  // command line of the Chrome spawned below, so a cleanup that is still running
  // can kill the browser this run just started. Waiting for it to be over is the
  // whole point, and the one case it refuses to swallow — a cleanup still alive
  // at its deadline — is the one where continuing would reintroduce that race.
  // `debugPort` last: the seam may choose the timeouts and the command, but not
  // which port's leftovers this is — that is the launch's own business.
  await cleanupStaleBrowsers({ ...cleanup, debugPort });

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
    // stderr is piped rather than ignored ONLY so a failed launch can quote it:
    // this is where Chrome says "Failed to move to new namespace", "cannot open
    // display", "Failed to create a ProcessSingleton". Ignoring it is what
    // reduced two hosted failures to a bare `TypeError: fetch failed`. It is
    // drained continuously by the watcher below and reported bounded — an
    // undrained pipe would fill its 64KB buffer and block Chrome itself.
    // stdout stays ignored: headless Chrome puts nothing there worth a log line.
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Same tick as the spawn, deliberately: `error` (ENOENT/EACCES/EAGAIN) can
  // arrive on the next one, and with no listener it is an uncaught exception.
  const watch = watchChromeProcess(chrome, { executable: chromeBin, debugPort });

  const close = async (browser) => {
    browser?.close();
    chrome.kill();
    watch.dispose();
    await sleep(500); // 让 Chrome 先把 profile 目录里的文件句柄放掉
    if (!keep) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* 临时目录，留着也无妨 */ }
    }
  };

  let browser;
  // Monotonic, not `Date.now()`: this is a duration, and a wall-clock step (NTP
  // correcting a fresh runner's drift, a suspended VM resuming) would otherwise
  // silently shorten the budget or extend it past the job's own timeout.
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  // ONE absolute deadline, and every blocking phase of the wait gets only what
  // is left of it. A per-phase timeout would multiply: fetch, handshake and
  // sleep would each be allowed the full budget, so the total wait would be a
  // number nobody configured. And a deadline checked only BETWEEN phases bounds
  // nothing at all — a server that accepts the connection and then never
  // answers, or an upgrade that never completes, leaves the harness blocked
  // inside a phase that the check after it will never get to run.
  const remainingMs = () => readyTimeoutMs - elapsed();

  const deadlineExceeded = (what) => {
    const err = new Error(`${what} did not finish within the ${readyTimeoutMs}ms CDP readiness deadline`);
    err[DEADLINE_HIT] = true;
    return err;
  };

  /**
   * Await one blocking phase — never past the shared deadline, and never past
   * the death of the child.
   *
   * `abandon` is how the phase stops costing something after we stop waiting for
   * it: an un-aborted `fetch` holds a socket (and an unread body) open, and an
   * un-closed WebSocket holds the event loop. The rejection handler on `work` is
   * equally load-bearing — abandoning a promise we raced against and never
   * catching it is an unhandled rejection that lands long after the failure it
   * belongs to, attributed to whatever test happens to be running then.
   */
  const bounded = (work, what, abandon) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const rejectOnce = finish(reject);
      const giveUp = (err) => {
        if (settled) return;
        rejectOnce(err);
        try { abandon?.(); } catch { /* 已经没了 */ }
      };
      // Re-arm rather than trust one firing: libuv counts whole milliseconds
      // against its own loop clock, so a timer can come back a hair before
      // `performance.now()` agrees the budget is spent — and a failure that
      // reports "waited ~799ms" against an 800ms deadline is a diagnostic
      // contradicting itself in the same line.
      const arm = () => setTimeout(() => {
        if (remainingMs() > 0) { timer = arm(); return; }
        giveUp(deadlineExceeded(what));
      }, Math.max(0, remainingMs()));
      let timer = arm();
      // The child dying mid-phase must not cost the rest of the budget: the
      // cause of death is already in hand, and waiting out 45s to print it is
      // exactly the "slow or stuck?" ambiguity this whole deadline exists to end.
      watch.died.then(() => giveUp(new Error(`Chrome exited while waiting for ${what}`)));
      work.then(finish(resolve), rejectOnce);
    });

  let attempts = 0;
  let readyMs = 0;
  try {
    // 等 CDP 端口起来。节奏和以前一模一样（250ms）；变的是**什么时候放弃**：一个墙钟
    // 预算，而不是一个数出来的次数。
    for (;;) {
      attempts++;
      // Per attempt, and closed by whichever path ends this iteration: a client
      // whose handshake failed still owns a socket, and simply reassigning the
      // variable on the next attempt would leak one per retry — up to ~180 of
      // them at the default deadline.
      let client = null;
      try {
        // The body is inside the phase, not after it: `fetch` resolving means
        // the headers arrived, and a port that answers with headers and then
        // stalls forever would hang in `.json()` — past every check below.
        const probe = new AbortController();
        const v = await bounded(
          fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: probe.signal }).then((r) => r.json()),
          "the /json/version probe",
          () => probe.abort(),
        );
        client = cdp(v.webSocketDebuggerUrl);
        await bounded(client.open, "the CDP websocket handshake", () => client.close());
        readyMs = elapsed();
        browser = client;
        break;
      } catch (e) {
        try { client?.close(); } catch { /* 已经没了 */ }
        // 先探测、后看进程，顺序是有意的：一次答上来的探测永远算成功，哪怕我们
        // spawn 的那个进程自己已经退了（包装脚本、二次 exec 都可能这样）。诊断只在
        // 真的连不上时才介入，所以成功路径一个字节都没变。
        const waitedMs = elapsed();
        // 进程已经不在了：把整个预算等满也只会拿到同一条 ECONNREFUSED，而死因就在
        // 手里。这个短路必须排在超时前面——否则一个"启动就死"会被报成"太慢"，而这
        // 正是拉长等待之后最容易犯的错。
        const dead = watch.deadState();
        if (dead || e?.[DEADLINE_HIT] === true || waitedMs >= readyTimeoutMs) {
          // 抛之前给 stderr 一点时间到齐：'exit' 完全可能跑在最后几行输出前面，而
          // 那几行往往就是死因本身。只在失败路径上等，且有上限。
          await watch.drain(250);
          // `deadlineMs` only when the deadline is what we actually hit: a dead
          // child says "exited", and adding "…and the deadline passed" to that
          // would send the reader looking for slowness instead of a cause of death.
          throw watch.failure({ attempts, waitedMs, cause: e, deadlineMs: dead ? null : readyTimeoutMs });
        }
        // 还是 250ms 的节奏——但也被同一个 deadline 夹住，否则最后一轮 sleep 能把
        // 实际等待推到预算之外，报出一个比配置值还大的 "waited"。
        const pause = Math.min(250, remainingMs());
        if (pause > 0) await Promise.race([sleep(pause), watch.died]);
      }
    }
  } catch (err) {
    // Chrome 起来了但 CDP 连不上：进程还在，不收就会留一个孤儿浏览器和一个孤儿 profile。
    // 半个 CDP 客户端已经在上面那轮的 catch 里关掉了；这里收的是进程和 profile。
    await close(browser);
    throw err;
  }
  // The evidence a GREEN run contributes. A timeout is only ever readable
  // against a known distribution: without this line, the first hosted failure at
  // 45s would again be a number with nothing to compare it to. Deliberately just
  // the two figures — no DevTools URL (its UUID controls this browser), no
  // profile path, no argv, no environment.
  console.log(`  chrome CDP ready in ${Math.round(readyMs)}ms after ${attempts} probe${attempts === 1 ? "" : "s"}`);
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

// ── 静态产物的 HTTP 生命周期 ────────────────────────────────────────────────
//
// `vite preview` 直接吐 `dist`，所以不需要手写一个 HTTP 服务器去复制 nginx 的
// try_files 规则——那份复制品迟早会和 `server/spa.go` 漂移，然后用一条测不准的路由
// 给出一条测不准的结论。vite 本来就是开发依赖。
//
// `a11y-scan.mjs` 有它自己的一份：它还要处理 `--url`（扫一个已经跑着的服务器）和
// `--preview-port`，那些开关只有它需要。这一份是给"只想要 dist 起在一个端口上"的
// 脚本用的最小实现。

/**
 * 起一个 `vite preview` 并等它真的开始应答，返回 `{ base, stop }`。
 *
 * `--host 127.0.0.1` 不是可选的：vite preview 默认监听 "localhost"，而 Node 按 DNS
 * 顺序解析它——某些机器上它只绑到 ::1，于是发往 127.0.0.1 的请求一律连不上，表现成
 * "preview 起不来"。钉死 IPv4，本地和 CI 才是同一件事。
 */
export async function startPreview({ port, distDir = "dist", cwd }) {
  // fileURLToPath, not `.pathname`: the latter keeps percent-encoding, so any
  // checkout path containing a space resolves to a directory that does not exist.
  const root = cwd ?? fileURLToPath(new URL("..", import.meta.url));
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [viteBin, "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1", "--outDir", distDir],
    { cwd: root, stdio: "ignore" },
  );
  let stopping = false;
  let diedEarly = false;
  child.on("exit", (code) => {
    // preview 自己死掉（端口被占、dist 不存在）时不要让场景去慢慢超时——那种失败会
    // 被读成"页面加载不出来"，指向完全错误的方向。
    if (!stopping) diedEarly = true;
    if (!stopping) console.error(`vite preview exited early with code ${code}`);
  });

  const alive = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    stopping = true;
    if (!alive()) return;
    const exited = new Promise((res) => child.once("exit", res));
    try { child.kill("SIGTERM"); } catch { /* 已经没了 */ }
    // 只发信号就返回是不够的：子进程句柄还活着的时候 Node 不会退出事件循环，于是
    // "脚本跑完了但命令不返回"——在 CI 里这和挂死没有区别。
    let timer;
    await Promise.race([exited, new Promise((res) => { timer = setTimeout(res, 3_000); })]);
    clearTimeout(timer);
    if (alive()) { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } await exited; }
  };

  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      if (diedEarly) {
        throw new Error(`vite preview died before serving ${distDir} — is port ${port} taken, or is ${distDir} missing? (run \`npm run build\`)`);
      }
      try {
        const res = await fetch(`${base}/`);
        if (res.ok) { await res.arrayBuffer(); break; }
      } catch { /* 还没起来 */ }
      if (i > 80) throw new Error(`vite preview never answered on ${base} within 20s`);
      await sleep(250);
    }
  } catch (err) {
    // 起不来也要把可能还活着的子进程收掉再抛：留一个活着的 preview 会占住端口，让
    // **下一次**运行以 "--strictPort 端口被占" 收场——一个由上一轮失败造成、却指向
    // 完全无关原因的错误。
    await stop();
    throw err;
  }
  return { base, stop };
}
