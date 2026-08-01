#!/usr/bin/env node
/**
 * 端到端：两个真标签页之间跑一次真的 LAN 直传。
 *
 * 覆盖的是单元测试碰不到的那一段：信令握手 → commit-reveal → WebRTC DataChannel →
 * 分块加密 → 流控 ACK → 完整性校验 → 落盘。App.svelte 里的收发管道**一行都没有
 * 单元测试**（它们耦合在组件里，本来就测不了），这个脚本是它们唯一的回归网。
 *
 * 只桩掉一样东西：操作系统的"另存为"对话框（showSaveFilePicker）——它是原生 UI，
 * 无头浏览器里开不出来。桩件把字节收进内存，脚本再按 SHA-256 比对。除此之外每一步
 * 都是真的：真服务器、真 WebSocket 信令、真 RTCPeerConnection、真 AES-GCM。
 *
 * 用法：node e2e/lan-transfer.mjs [--url http://localhost:8099] [--keep]
 *   前置：web 已 build，且 Go 服务器在 --url 上跑着（它同时兜 SPA 和 /ws）。
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = flag("--url", "http://localhost:8099");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9444;
const FILE_NAME = "e2e-payload.bin";
const FILE_BYTES = 3 * 1024 * 1024 + 12345; // 跨多个 192KiB 分块，且末块不对齐

// ── 一个够用的 CDP 客户端（不引第三方依赖）───────────────────────────────────
function cdp(wsUrl) {
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
async function newTab(browser, url, initScript) {
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

async function setWideViewport(tab, width = 1440, height = 900) {
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

const FORCE_UNSUPPORTED =
  "Object.defineProperty(window, 'isSecureContext', { get: () => false });";

async function unsupportedLayoutScenario(browser) {
  const tab = await newTab(browser, BASE + "/", FORCE_UNSUPPORTED);
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('.banner')", "the unsupported-browser banner");
  const layout = await tab.evaluate(`(() => {
    const workspace = document.querySelector('.lan-workspace');
    return {
      display: getComputedStyle(workspace).display,
      twoColClass: workspace.classList.contains('two-col'),
      compactHero: document.querySelector('.hero').classList.contains('workspace'),
      banner: !!document.querySelector('.lan-task .banner'),
      peers: !!document.querySelector('.lan-task .peers'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  if (
    layout.display === "grid" || layout.twoColClass || layout.compactHero ||
    !layout.banner || layout.peers || layout.overflow !== 0
  ) {
    throw new Error(`unsupported LAN layout contract failed: ${JSON.stringify(layout)}`);
  }
  if (tab.errors.length) throw new Error(`unsupported LAN layout logged errors: ${tab.errors.join(" | ")}`);
  ok("unsupported browsers kept the established single-column failure layout");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

// 收方页面的桩：把"另存为"换成一个把字节攒进内存并算 SHA-256 的假句柄。
// 这是整个脚本里唯一一处偏离真实运行的地方。
const SAVE_STUB = `
  window.__e2e = { chunks: [], bytes: 0, closed: false, name: "" };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    window.__e2e.name = suggestedName;
    return {
      createWritable: async () => ({
        write: async (chunk) => {
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
 * 记录页面创建过的每一个 RTCPeerConnection，并给出一个"把此刻活着的那些判死"的开关。
 *
 * 为什么不是直接 pc.close()：按规范 close() **不会**触发 connectionstatechange，
 * 应用因此什么都察觉不到，也就不会进入续传流程——那样测的就不是掉线了。这里把
 * connectionState 改成 "failed" 再手动触发回调（应用在真掉线时收到的正是这一条），
 * 然后才真的 close 掉底层传输，让后续的字节确实发不出去。
 *
 * "只判死调用那一刻已存在的连接"是关键：续传会新建一个 pc，不排除掉它就会被这同一个
 * 开关顺手打死，永远续不上。
 */
const PC_TRACKER = `
  window.__pcs = [];
  (() => {
    const Real = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) {
      const pc = new Real(...a);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Real.prototype;
  })();
  window.__dropLive = () => {
    const victims = window.__pcs.slice(); // 只打此刻已存在的
    for (const pc of victims) {
      try {
        Object.defineProperty(pc, "connectionState", { get: () => "failed", configurable: true });
        pc.onconnectionstatechange?.();
        pc.close();
      } catch { /* 已经没了 */ }
    }
    return victims.length;
  };
`;

/**
 * 传输中途把连接打断，看它能不能**续上并且字节完全正确**。
 *
 * 这条路径（connectResume + checkpoint + chain hash 恢复 + pausedRecv 状态机）是
 * 整个传输里最复杂的一段，而在这个用例之前它一行覆盖都没有：单测碰不到，happy path
 * 的 E2E 也碰不到。断线续传恰恰是手机上最常发生的事（切网、锁屏、电梯）。
 *
 * 断言三件事，缺一条这个用例就可能是假绿：
 *  1. 收到的字节和发出的**逐字节一致**（按 SHA-256 比，不看进度条）；
 *  2. 收方确实**新建过至少两个 pc** —— 证明真的走了续传，而不是在掉线落地前就传完了；
 *  3. 收方写入的总字节等于文件大小 —— 续传如果从 0 重来，这里会超。
 */
async function resumeScenario(browser) {
  const NAME = "e2e-resume.bin";
  // 24MB：在本机上够慢，掉线注入落得进传输中段；PRNG 现生成，省得把几十兆
  // base64 从 CDP 灌进页面。
  const GEN = `
    window.__makePayload = (bytes) => {
      const out = new Uint8Array(bytes);
      let x = 0x9e3779b9; // 固定种子：失败可复现
      for (let i = 0; i < bytes; i++) {
        x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
        out[i] = x & 0xff;
      }
      return out;
    };
    window.__sha256 = async (u8) => {
      const h = await crypto.subtle.digest("SHA-256", u8);
      return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
    };
  `;
  const PAYLOAD_BYTES = 24 * 1024 * 1024 + 4321;

  const sender = await newTab(browser, BASE + "/", PC_TRACKER + GEN);
  const receiver = await newTab(browser, BASE + "/", PC_TRACKER + GEN + SAVE_STUB);
  await setWideViewport(sender);
  await setWideViewport(receiver);
  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await sender.waitFor(peersSeen, "peers (resume scenario)");
  await receiver.waitFor(peersSeen, "peers (resume scenario)");

  const sentHash = await sender.evaluate(`(async () => {
    const bytes = window.__makePayload(${PAYLOAD_BYTES});
    window.__file = new File([bytes], ${JSON.stringify(NAME)}, { type: 'application/octet-stream' });
    const input = document.querySelector('.file-pick-input');
    const dt = new DataTransfer();
    dt.items.add(window.__file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__sha256(bytes);
  })()`);

  const acceptBtn = `[...document.querySelectorAll('button')].find(b => /接受|Accept|受け取|수락|Annehmen|Accepter|قبول|Aceptar/i.test(b.textContent))`;
  await receiver.waitFor(`!!(${acceptBtn})`, "the confirmation card (resume scenario)");
  await receiver.evaluate(`(() => { (${acceptBtn}).click(); return true; })()`);

  // 等它真的写下去一些字节：`resumable` 要为真，续传才有意义（一个字节都没落盘时
  // 掉线按设计就是直接失败，那是另一条分支）。
  await receiver.waitFor("window.__e2e.bytes > 1024 * 1024", "the receiver to durably write the first MB");
  const midway = await receiver.evaluate("window.__e2e.bytes");

  // 两边同时判死：模拟"这条链路两头都没了"（掉 Wi-Fi）。只打一边的话，另一边要等
  // ICE consent 超时（约 30s）才察觉，测试会慢且更飘。
  await sender.evaluate("window.__dropLive()");
  await receiver.evaluate("window.__dropLive()");
  ok(`dropped the connection mid-transfer (${(midway / 1024 / 1024).toFixed(1)} MiB in)`);

  // 续上并跑完。窗口给足：发送端每次重连之间有退避。
  await receiver.waitFor("window.__e2e.closed === true", "the resumed transfer to finish", 180_000);

  const got = await receiver.evaluate(`(async () => {
    const buf = new Uint8Array(await new Blob(window.__e2e.chunks).arrayBuffer());
    return { bytes: buf.length, sha256: await window.__sha256(buf), pcs: window.__pcs.length };
  })()`);

  if (got.pcs < 2) {
    throw new Error(`no resume happened (receiver built ${got.pcs} peer connection(s)) — the drop landed after the transfer finished, so this run proved nothing`);
  }
  if (got.bytes !== PAYLOAD_BYTES) {
    throw new Error(`resumed file is ${got.bytes} bytes, want ${PAYLOAD_BYTES} (a resume restarting from 0 would overshoot)`);
  }
  if (got.sha256 !== sentHash) {
    throw new Error(`resumed file does not match what was sent: ${got.sha256} != ${sentHash}`);
  }
  ok(`resumed and delivered ${got.bytes} bytes byte-identical (receiver used ${got.pcs} connections)`);

  const errs = [...sender.errors, ...receiver.errors].filter((e) => !/401|Failed to load resource/.test(e));
  // 掉线本身会在控制台留下预期内的噪音（"connection lost"/"resume ..."），只筛真正
  // 不该出现的：类型错误、断言、未捕获的 Reference/Type 错误。
  const bad = errs.filter((e) => /ReferenceError|TypeError|is not a function|undefined is not/.test(e));
  if (bad.length) throw new Error(`resume path raised real errors:\n    ${bad.join("\n    ")}`);
  ok("the resume path raised no ReferenceError/TypeError");

  await browser.send("Target.closeTarget", { targetId: sender.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver.targetId });
}

const ok = (label) => console.log(`  \x1b[32m✓\x1b[0m ${label}`);
const fail = (label, err) => {
  console.error(`  \x1b[31m✗\x1b[0m ${label}\n    ${err?.stack ?? err}`);
  process.exitCode = 1;
};

/**
 * 故障注入：让收方的 RTCPeerConnection 在数据通道打开**之前**就 failed。
 *
 * 这一窗口曾经是个真 bug：connect() 会在建连过程中同步回调 onStateChange，而接收
 * 端的掉线处理函数当时还是个尚未初始化的 const —— 于是抛 ReferenceError，接收卡片
 * 卡死，而不是干净地报"连接失败"。真实世界里它对应的是"对端网络在握手途中断掉"，
 * 不是什么边角情况。这里把它变成可复现的一条用例。
 */
async function earlyFailureScenario(browser) {
  const INJECT = `
    (() => {
      const Real = window.RTCPeerConnection;
      window.RTCPeerConnection = function (...a) {
        const pc = new Real(...a);
        // 必须在**同一批任务**里就翻 failed：晚一点数据通道就已经开了，
        // connect() 已经返回，掉线处理函数也早就初始化好，窗口就错过了。
        queueMicrotask(() => {
          try {
            Object.defineProperty(pc, "connectionState", { get: () => "failed", configurable: true });
            pc.onconnectionstatechange?.();
          } catch { /* pc 已经没了 */ }
        });
        return pc;
      };
      window.RTCPeerConnection.prototype = Real.prototype;
    })();
  ` + SAVE_STUB;

  const sender = await newTab(browser, BASE + "/");
  const receiver = await newTab(browser, BASE + "/", INJECT);
  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  try {
    await sender.waitFor(peersSeen, "peers (early-failure scenario)", 30_000);
    await receiver.waitFor(peersSeen, "peers (early-failure scenario)", 30_000);
  } catch (e) {
    for (const [who, tab] of [["sender", sender], ["receiver", receiver]]) {
      console.error(`  [${who}] ` + JSON.stringify(await tab.evaluate("document.body.innerText.replace(/\\s+/g,' ').slice(0,200)"))
        + " errors=" + JSON.stringify(tab.errors));
    }
    throw e;
  }

  await sender.evaluate(`(() => {
    const input = document.querySelector('.file-pick-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(1024)], "fail.bin"));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  // 收方必须**如实报失败**（而不是卡在一个没有任何进展的卡片上）。
  await receiver.waitFor(
    "/失败|failed|Failed|失敗|실패|fehlgeschlagen|échou|فشل|falló|falhou/i.test(document.body.innerText)",
    "the receiver to report a connection failure",
    60_000,
  );
  const tdz = [...receiver.errors, ...sender.errors].filter((e) => /ReferenceError/.test(e));
  if (tdz.length) throw new Error(`early failure raised a ReferenceError instead of failing cleanly:\n    ${tdz.join("\n    ")}`);
  ok("a connection that fails during setup is reported cleanly (no ReferenceError)");

  await browser.send("Target.closeTarget", { targetId: sender.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver.targetId });
}

/**
 * 全局看门狗。
 *
 * 单看 evaluate 的超时不够：卡住的可能是 CDP 的任意一次往返（建标签页、关标签页、
 * 附加会话），任何一处永不返回都会让整个套件静默挂死——而"挂死"在 CI 里和"还在跑"
 * 长得一模一样，比一条红色失败糟得多。实测踩过：破坏版让收方主线程卡死之后，套件
 * 跑了 9 分钟还没有任何输出。
 */
const GLOBAL_TIMEOUT_MS = 15 * 60_000;

// ── 消息会话：两个真标签页之间发一条真消息 ──────────────────────────────────
/**
 * The message payload. Every character in it is here for a reason:
 * leading spaces + a tab, a tab-indented block, a blank line, CJK, Arabic (RTL),
 * an astral emoji, and trailing spaces. If any layer trims, normalises or
 * collapses, this is where it shows.
 *
 * No `\r`: a textarea's value normalises CRLF on some paths, so including one
 * would test the DOM's newline handling rather than ours.
 */
const MSG_BODY = "  \tif x:\n\n\t\tprint('\u4f60\u597d \u0645\u0631\u062d\u0628\u0627 \ud83c\udf0d')\n   \n  trailing   ";
/** Content that would become markup if anything ever stopped escaping. */
const MSG_INJECTION = '<script>alert(1)</script><img src=x onerror=alert(2)>';

/** The only <button> among the peer actions — the file/folder controls are <label>s.
 *  Structural rather than text- or emoji-matched, so nine translations and an icon
 *  change cannot break it. */
const MSG_OPEN_BTN = ".peer-actions button";

const utf8Hex = (s) => [...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * 覆盖消息会话里单元测试碰不到的那一段：真 caps 名册通告 → 真 text 世代 offer →
 * 真 commit-reveal（自己的 SAS）→ 真 DataChannel → kind 9 帧 → 渲染。
 *
 * 断言四件事，缺一条都可能是假绿：
 *  1. 两个标签页在消息面板里显示的 SAS **一致**（和文件那一幕同一个性质）；
 *  2. 收到的正文和发出的**逐字节一致**（比 UTF-8 十六进制，不比字符串）；
 *  3. 同意之前**一个正文节点都没有**；
 *  4. 一段长得像脚本的内容渲染成文本，`.msg-body` 里**没有**任何元素。
 */
async function messageScenario(browser) {
  const a = await newTab(browser, BASE + "/");
  const b = await newTab(browser, BASE + "/");
  await setWideViewport(a);
  await setWideViewport(b);

  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await a.waitFor(peersSeen, "tab A to see tab B on the radar", 30_000);
  await b.waitFor(peersSeen, "tab B to see tab A on the radar", 30_000);

  // 等消息按钮出现 —— 这是"名册层的 caps 通告已经到了"的**正向**信号。后面那一幕
  // 断言它不出现，靠的就是这里证明过它本来会出现。
  await a.waitFor(`!!document.querySelector('${MSG_OPEN_BTN}')`, "the message control to appear once caps arrived", 30_000);
  await b.waitFor(`!!document.querySelector('${MSG_OPEN_BTN}')`, "the message control on tab B too", 30_000);
  ok("both tabs advertised text/1 and offered a message control");

  await a.evaluate(`(() => { document.querySelector('${MSG_OPEN_BTN}').click(); return true; })()`);

  // 收方先看到请求卡片，而且**此刻不能有任何正文**。
  await b.waitFor("!!document.querySelector('.msgpanel')", "tab B to show the message request", 40_000);
  const bodiesBeforeConsent = await b.evaluate("document.querySelectorAll('.msg-body').length");
  if (bodiesBeforeConsent !== 0) {
    throw new Error(`tab B rendered ${bodiesBeforeConsent} message bodies BEFORE consent`);
  }
  const hasComposerBeforeConsent = await b.evaluate("!!document.querySelector('.msgpanel textarea')");
  if (hasComposerBeforeConsent) throw new Error("tab B showed a composer before accepting");
  ok("the request card showed no content and no composer before consent");

  const acceptMsg = ".msgpanel .act button.btn-primary";
  await b.waitFor(`!!document.querySelector('${acceptMsg}')`, "the accept control on the request card");
  await b.evaluate(`(() => { document.querySelector('${acceptMsg}').click(); return true; })()`);

  // 两边都进 open：发起方靠 ACCEPT 字节翻状态，收方本地翻。用 composer 的出现当信号。
  await a.waitFor("!!document.querySelector('.msgpanel textarea')", "tab A's composer (session open)", 40_000);
  await b.waitFor("!!document.querySelector('.msgpanel textarea')", "tab B's composer (session open)");
  const messageLayout = await a.evaluate(`(() => {
    const panel = document.querySelector('.msgpanel');
    const sas = panel.querySelector('.sas');
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      sasOverflow: sas.scrollWidth - sas.clientWidth,
      taskWidth: document.querySelector('.lan-task').getBoundingClientRect().width,
    };
  })()`);
  if (
    messageLayout.pageOverflow !== 0 || messageLayout.panelOverflow > 1 ||
    messageLayout.sasOverflow > 1 || messageLayout.taskWidth < 800
  ) {
    throw new Error(`wide message panel overflowed: ${JSON.stringify(messageLayout)}`);
  }
  ok("both tabs opened the message session");

  // SAS：消息会话在 phase 1 里跑自己的握手，所以它有自己的一串码 —— 但两边必须一致。
  const msgSas = `(() => { const c = document.querySelector('.msgpanel .sas code'); return c ? c.textContent.trim() : ''; })()`;
  const sas = { a: "", b: "" };
  for (let i = 0; i < 200 && !(sas.a && sas.b); i++) {
    sas.a ||= (await a.evaluate(msgSas)) || "";
    sas.b ||= (await b.evaluate(msgSas)) || "";
    if (!(sas.a && sas.b)) await sleep(50);
  }
  if (!sas.a || !sas.b) throw new Error(`never observed the message SAS on both tabs (a=${sas.a || "-"}, b=${sas.b || "-"})`);
  if (sas.a !== sas.b) throw new Error(`message SAS mismatch: ${sas.a} vs ${sas.b}`);
  if (!/^\d{6}$/.test(sas.a)) throw new Error(`message SAS is not a 6-digit code: ${JSON.stringify(sas.a)}`);
  ok(`both tabs showed the same message SAS (${sas.a})`);

  // 发一条：真的往 textarea 里写、真的点发送。
  const send = async (tab, body) => {
    await tab.evaluate(`(() => {
      const ta = document.querySelector('.msgpanel textarea');
      if (!ta) throw new Error('no composer');
      ta.value = ${JSON.stringify(body)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 字节计数器必须跟着动 —— 它显示的就是限制在比的那个数。
    const counted = await tab.evaluate("(() => { const c = document.querySelector('.byte-count'); return c ? c.textContent : ''; })()");
    if (!counted) throw new Error("the byte counter is missing from the composer");
    await tab.evaluate(`(() => {
      const btn = document.querySelector('.msgpanel button.send');
      if (!btn) throw new Error('no send button');
      if (btn.disabled) throw new Error('send is disabled for a body inside the limit');
      btn.click();
      return true;
    })()`);
  };

  await send(a, MSG_BODY);
  await b.waitFor("document.querySelectorAll('.msg-body').length >= 1", "tab B to render the message", 40_000);

  // 逐字节比对：把页面里的 textContent 编成 UTF-8 十六进制再比，不比字符串 ——
  // 一次规范化（比如把组合字符合成）在字符串比较下可能相等，在字节下不会。
  const gotHex = await b.evaluate(`(() => {
    const el = document.querySelector('.msg-body');
    const bytes = new TextEncoder().encode(el.textContent);
    return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  })()`);
  const wantHex = utf8Hex(MSG_BODY);
  if (gotHex !== wantHex) {
    throw new Error(`message body is not byte-identical\n      got  ${gotHex}\n      want ${wantHex}`);
  }
  ok(`the received body is byte-identical (${wantHex.length / 2} UTF-8 bytes, incl. tabs, a blank line, CJK, Arabic and an emoji)`);

  // dir="auto" 是阿拉伯语正文在英文界面下读得对的原因。
  const dirs = await b.evaluate("[...document.querySelectorAll('.msg-body')].map(e => e.getAttribute('dir'))");
  if (!dirs.every((d) => d === "auto")) throw new Error(`message bodies must carry dir="auto", got ${JSON.stringify(dirs)}`);
  ok('every rendered body carries dir="auto"');

  // 长得像脚本的内容：必须是文本节点，`.msg-body` 里不能有任何元素。
  await send(a, MSG_INJECTION);
  await b.waitFor("document.querySelectorAll('.msg-body').length >= 2", "tab B to render the script-like message", 40_000);
  const injected = await b.evaluate(`(() => {
    const bodies = [...document.querySelectorAll('.msg-body')];
    const el = bodies.find(e => e.textContent.includes('alert'));
    return {
      found: !!el,
      text: el ? el.textContent : '',
      childElements: el ? el.querySelectorAll('*').length : -1,
      scriptsAnywhere: document.querySelectorAll('.msgpanel script, .msgpanel img').length,
    };
  })()`);
  if (!injected.found) throw new Error("the script-like message never rendered");
  if (injected.text !== MSG_INJECTION) {
    throw new Error(`script-like content was altered\n      got  ${JSON.stringify(injected.text)}\n      want ${JSON.stringify(MSG_INJECTION)}`);
  }
  if (injected.childElements !== 0) {
    throw new Error(`.msg-body contains ${injected.childElements} child element(s); it must be a text node only`);
  }
  if (injected.scriptsAnywhere !== 0) {
    throw new Error(`the panel contains ${injected.scriptsAnywhere} script/img element(s) from message content`);
  }
  ok("script-like content rendered as literal text, with no element created");

  const errs = [...a.errors, ...b.errors].filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`console errors during the message session:\n    ${errs.join("\n    ")}`);
  ok("no console errors during the message session");

  await browser.send("Target.closeTarget", { targetId: a.targetId });
  await browser.send("Target.closeTarget", { targetId: b.targetId });
}

/**
 * 把一个标签页的 caps 名册通告掐掉，模拟一个**跑旧版本的对端**：它从不声明 text/1。
 *
 * 对面那一页因此不该出现消息按钮 —— 这正是"新端永远不去骚扰旧端"的那条保证
 * （见 relayium-text-v1.md 的 capability negotiation）。掐的是 WebSocket.send 里
 * 那一类帧，而不是改应用代码：旧端在网络上的表现就是这样。
 */
const SUPPRESS_CAPS = `
  window.__capsSuppressed = 0;
  (() => {
    const realSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const e = JSON.parse(data);
          if (e && e.type === "signal" && e.data && Array.isArray(e.data.caps)) {
            window.__capsSuppressed++;
            return; // 旧端根本不会发这一帧
          }
        } catch { /* 不是 JSON，照发 */ }
      }
      return realSend.call(this, data);
    };
  })();
`;

async function capsSuppressedScenario(browser) {
  // old: 从不通告 caps。fresh: 正常的一页，它是被观察的那一方。
  const oldPeer = await newTab(browser, BASE + "/", SUPPRESS_CAPS);
  const fresh = await newTab(browser, BASE + "/");

  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await fresh.waitFor(peersSeen, "the fresh tab to see the old peer", 30_000);
  await oldPeer.waitFor(peersSeen, "the old peer to see the fresh tab", 30_000);

  // 确认掐真的生效了 —— 否则这一幕会因为"根本没发过 caps"而假绿。
  const suppressed = await oldPeer.evaluate("window.__capsSuppressed");
  if (!(suppressed > 0)) throw new Error("the caps announcement was never suppressed; this scenario proves nothing");
  ok(`the old peer suppressed ${suppressed} caps announcement(s)`);

  // 绝对断言要给足时间：上一幕已经证明按钮**会**在 30s 内出现，所以在这里连续
  // 采样 8 秒都没有，才算真的没有。
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await fresh.evaluate(`!!document.querySelector('${MSG_OPEN_BTN}')`)) {
      throw new Error("the fresh tab offered a message control to a peer that never announced text/1");
    }
    await sleep(250);
  }
  ok("no message control was offered to a peer that never announced text/1");

  // 而且旧端那一侧不该冒出任何"接收失败"之类的卡片，也不该有报错。
  const oldErrs = oldPeer.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (oldErrs.length) throw new Error(`the old peer logged errors:\n    ${oldErrs.join("\n    ")}`);
  const spurious = await oldPeer.evaluate("document.querySelectorAll('.xfer.bad, .msgpanel').length");
  if (spurious !== 0) throw new Error(`the old peer showed ${spurious} unexpected transfer/message card(s)`);
  ok("the old peer saw no spurious card and logged no errors");

  await browser.send("Target.closeTarget", { targetId: oldPeer.targetId });
  await browser.send("Target.closeTarget", { targetId: fresh.targetId });
}

/**
 * /apps is a release surface, not a four-item wishlist. Executable choices must
 * stay ahead of future products, and a half-finished native release must not
 * leak a dead control. Exercise the real bundled manifest plus the responsive,
 * translated layout here; component tests cover the released/half-filled seams.
 */
async function appsHierarchyScenario(browser) {
  const tab = await newTab(browser, BASE + "/apps");
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('#app-web')", "apps hierarchy to render");

  const desktop = await tab.evaluate(`(() => {
    const contrast = (a, b) => {
      const lum = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const x = lum(a), y = lum(b);
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    };
    const futureMetrics = () => [...document.querySelectorAll('.future-card')].map((card) => {
      const el = card.querySelector('.card-desc');
      const foreground = getComputedStyle(el).color;
      let parent = el, background = '';
      while (parent) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') {
          background = candidate;
          break;
        }
        parent = parent.parentElement;
      }
      return { contrast: contrast(foreground, background), opacity: parseFloat(getComputedStyle(card).opacity) };
    });
    const root = document.documentElement;
    const originalTheme = root.getAttribute('data-theme');
    root.dataset.theme = 'light';
    const lightFuture = futureMetrics();
    root.dataset.theme = 'dark';
    const darkFuture = futureMetrics();
    if (originalTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', originalTheme);

    const resolveColor = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const platformCard = document.querySelector('.app-card.is-platform');
    return {
      headings: [...document.querySelectorAll('h1, h2, h3')].map((el) => el.tagName),
      available: [...document.querySelectorAll('.available-grid .app-card')].map((el) => el.id),
      future: [...document.querySelectorAll('.future-grid .app-card')].map((el) => el.id),
      actions: [...document.querySelectorAll('.available-grid .cta')].map((el) => el.getAttribute('href')),
      futureControls: document.querySelectorAll('.future-card a, .future-card button, .future-card [disabled]').length,
      sharedCards: document.querySelectorAll('.app-card.ui-card').length,
      lightFuture,
      darkFuture,
      platformMarker: {
        id: platformCard?.id,
        border: platformCard ? getComputedStyle(platformCard).borderTopColor : '',
        neutral: resolveColor('var(--control-border)'),
        accent: resolveColor('var(--accent-border)'),
      },
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  if (
    JSON.stringify(desktop.available) !== JSON.stringify(["app-web", "app-cli"]) ||
    JSON.stringify(desktop.future) !== JSON.stringify(["app-mac", "app-ios"]) ||
    desktop.headings.filter((tag) => tag === "H1").length !== 1 ||
    desktop.headings.filter((tag) => tag === "H2").length !== 2 ||
    desktop.headings.filter((tag) => tag === "H3").length !== 4 ||
    JSON.stringify(desktop.actions) !== JSON.stringify(["/", "/cli"]) || desktop.futureControls !== 0 ||
    desktop.sharedCards !== 4 ||
    [...desktop.lightFuture, ...desktop.darkFuture].some((metric) => metric.contrast < 4.5 || metric.opacity !== 1) ||
    !desktop.platformMarker.id || desktop.platformMarker.border !== desktop.platformMarker.neutral ||
    desktop.platformMarker.border === desktop.platformMarker.accent ||
    desktop.pageOverflow !== 0
  ) {
    throw new Error(`desktop apps hierarchy contract failed: ${JSON.stringify(desktop)}`);
  }

  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setWideViewport(tab, 390, 844);
  const locales = ["zh", "en", "ja", "ko", "de", "fr", "ar", "es", "pt"];
  const mobile = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} apps locale`);
    mobile.push(await tab.evaluate(`(() => {
      const cmd = document.querySelector('.cmd');
      const cmdRect = cmd.getBoundingClientRect();
      const codeRect = cmd.querySelector('code').getBoundingClientRect();
      const elements = [...document.querySelectorAll('.app-card, .cta, .cmd')];
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        elementOverflow: elements.some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -.5 || rect.right > innerWidth + .5;
        }),
        minAction: Math.min(...[...document.querySelectorAll('.cta')].map((el) => el.getBoundingClientRect().height)),
        futureControls: document.querySelectorAll('.future-card a, .future-card button, .future-card [disabled]').length,
        command: {
          dir: cmd.dir,
          tabIndex: cmd.tabIndex,
          scrollLeft: cmd.scrollLeft,
          codeStartsAt: codeRect.left - cmdRect.left,
        },
      };
    })()`));
  }
  const bad = mobile.filter((m) =>
    m.pageOverflow !== 0 || m.elementOverflow || m.minAction < 44 || m.futureControls !== 0 ||
    m.command.dir !== "ltr" || m.command.tabIndex !== 0 || m.command.scrollLeft !== 0 || m.command.codeStartsAt < 0 ||
    (m.lang === "ar" ? m.dir !== "rtl" : m.dir !== "ltr")
  );
  if (bad.length) throw new Error(`mobile apps hierarchy contract failed: ${JSON.stringify(bad)}`);

  // Put keyboard focus on the preceding Web CTA, then reach the command with a
  // real Tab key event. This catches invalid focus-token declarations that a
  // programmatic .focus() does not expose through :focus-visible.
  await tab.evaluate("document.querySelector('#app-web .cta').focus()");
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const keyboard = await tab.evaluate(`(() => {
    const cmd = document.querySelector('.cmd');
    const style = getComputedStyle(cmd);
    return { active: document.activeElement === cmd, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  })()`);
  if (!keyboard.active || keyboard.outlineStyle !== "solid" || parseFloat(keyboard.outlineWidth) < 2) {
    throw new Error(`apps command keyboard focus contract failed: ${JSON.stringify(keyboard)}`);
  }

  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after the apps sweep");

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`apps page logged errors:\n    ${errs.join("\n    ")}`);
  ok("apps separated executable choices from native futures across all nine locales");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/**
 * 定价页是购买入口：真正的方案必须先于长解释出现，而且这个层级要在九种语言和
 * RTL 下仍然成立。它跟 LAN 传输共享同一份全局样式，因此放在完整浏览器回归里，
 * 避免一个只在 jsdom 里通过的 DOM 顺序测试掩盖真实折叠线/溢出回归。
 */
async function pricingHierarchyScenario(browser) {
  const tab = await newTab(browser, BASE + "/pricing");
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('.tier:not(.tier-skeleton)')", "pricing tiers to load");

  const desktop = await tab.evaluate(`(() => {
    const first = document.querySelector('.tier').getBoundingClientRect();
    const price = getComputedStyle(document.querySelector('.tier-price:has(bdi)'));
    const title = getComputedStyle(document.querySelector('.head h1'));
    return {
      firstTierY: first.top + scrollY,
      pricePx: parseFloat(price.fontSize),
      titlePx: parseFloat(title.fontSize),
      pricingBeforeExplainer:
        !!(document.querySelector('.pricing').compareDocumentPosition(document.querySelector('.explainer')) & Node.DOCUMENT_POSITION_FOLLOWING),
      accountControl: !!document.querySelector('.account'),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  if (
    desktop.firstTierY >= 700 || desktop.pricePx !== 30 || desktop.titlePx !== 34 ||
    !desktop.pricingBeforeExplainer || !desktop.accountControl || desktop.pageOverflow !== 0
  ) {
    throw new Error(`desktop pricing hierarchy contract failed: ${JSON.stringify(desktop)}`);
  }

  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await setWideViewport(tab, 390, 844);
  const locales = ["zh", "en", "ja", "ko", "de", "fr", "ar", "es", "pt"];
  const mobile = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} pricing locale`);
    mobile.push(await tab.evaluate(`(() => {
      const first = document.querySelector('.tier').getBoundingClientRect();
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        firstTierY: first.top + scrollY,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardOverflows: [...document.querySelectorAll('.tier')].map((el) => el.scrollWidth - el.clientWidth),
        controlOverflows: [...document.querySelectorAll('.toggle-btn, .tier .btn')].map((el) => el.scrollWidth - el.clientWidth),
        cycleTargets: [...document.querySelectorAll('.toggle-btn')].map((el) => Math.round(el.getBoundingClientRect().height)),
        priceIsolates: [...document.querySelectorAll('.tier-price bdi')].map((el) => el.getAttribute('dir')),
      };
    })()`));
  }
  const bad = mobile.filter((m) =>
    m.firstTierY >= 1000 || m.pageOverflow !== 0 ||
    m.cardOverflows.some((n) => n > 1) || m.controlOverflows.some((n) => n > 1) ||
    m.cycleTargets.some((n) => n < 44) || m.priceIsolates.some((dir) => dir !== "ltr") ||
    (m.lang === "ar" ? m.dir !== "rtl" : m.dir !== "ltr")
  );
  if (bad.length) throw new Error(`mobile pricing hierarchy contract failed: ${JSON.stringify(bad)}`);

  // Locale is persisted in localStorage and therefore shared by every later tab
  // in this Chrome profile. Restore the suite's English baseline before closing
  // the pricing tab; otherwise the real transfer scenario inherits Portuguese
  // (the last sweep entry) and its language-specific action matching becomes an
  // accidental dependency of this unrelated layout check.
  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after the pricing sweep");

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`pricing page logged errors:\n    ${errs.join("\n    ")}`);
  ok("pricing exposed real tiers early across all nine locales with honest touch targets");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

async function main() {
  // 前置检查：服务器在不在，dist 是不是新的（旧 dist 会测出一个假绿）。
  const health = await fetch(`${BASE}/healthz`).then((r) => r.text()).catch(() => "");
  if (health.trim() !== "ok") {
    throw new Error(`no server at ${BASE} — start it with: cd server && RELAYIUM_ADDR=:8099 go run .`);
  }

  // 先收掉上一轮跑崩/被 kill 掉留下的浏览器。它们的标签页还挂着 WebSocket，而服务器
  // 有每 IP 的并发 /ws 上限——攒够几个之后新标签页会**静默地**连不上信令，表现成
  // "两边互相看不见"，和真回归一模一样。这一步不是洁癖，是在保证失败信号可信。
  try {
    spawn("pkill", ["-f", `remote-debugging-port=${DEBUG_PORT}`], { stdio: "ignore" });
    await sleep(800);
  } catch { /* 没有残留就没得可杀 */ }

  const profile = mkdtempSync(join(tmpdir(), "relayium-e2e-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
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

  let browser;
  try {
    // 等 CDP 端口起来。
    for (let i = 0; ; i++) {
      try {
        const v = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json());
        browser = cdp(v.webSocketDebuggerUrl);
        await browser.open;
        break;
      } catch (e) {
        if (i > 40) throw e;
        await sleep(250);
      }
    }

    console.log(`\nLAN transfer E2E against ${BASE}`);

    await appsHierarchyScenario(browser);
    await pricingHierarchyScenario(browser);

    // ── 两个标签页进同一个房间（都是 127.0.0.1，服务器按来源 IP 归组）────────
    const sender = await newTab(browser, BASE + "/");
    // Batch-3 desktop-workspace contract. Keep the sender wide for the whole
    // transfer so requests/progress/completion exercise the real two-column path,
    // not merely a static screenshot. The later scenarios still cover Chrome's
    // default single-column viewport independently.
    await setWideViewport(sender);
    await sender.waitFor(
      "!!document.querySelector('.lan-workspace') && getComputedStyle(document.querySelector('.lan-workspace')).display === 'grid'",
      "the wide LAN identity/task workspace",
    );
    await sender.waitFor("!!document.querySelector('.statusbar .ip')", "wide LAN connection metadata");
    const wideWorkspace = await sender.evaluate(`(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(selector + ' missing');
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width };
      };
      const status = document.querySelector('.statusbar');
      const ip = status.querySelector('.ip');
      const originalIP = ip.textContent;
      // Deliberately one unbreakable token wider than the rail content box. A
      // shorter, space-separated sample would pass even if overflow-wrap were
      // removed, making this regression guard a false positive.
      ip.textContent = 'public IP ::ffff:2001:0db8:85a3:0000:0000:8a2e:0370:7334:192.0.2.128';
      const statusRect = status.getBoundingClientRect();
      const ipRect = ip.getBoundingClientRect();
      const ipInside = ipRect.left >= statusRect.left - 1 && ipRect.right <= statusRect.right + 1;
      ip.textContent = originalIP;
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        hero: rect('.hero'),
        task: rect('.lan-task'),
        empty: rect('.empty'),
        history: rect('.history'),
        h1s: document.querySelectorAll('h1').length,
        logo: getComputedStyle(document.querySelector('.hero .logo')).display,
        ipInside,
      };
    })()`);
    if (
      wideWorkspace.overflow !== 0 ||
      Math.abs(wideWorkspace.hero.top - wideWorkspace.task.top) > 2 ||
      wideWorkspace.task.top > 180 ||
      wideWorkspace.task.width < 800 ||
      wideWorkspace.empty.width < 600 ||
      wideWorkspace.empty.width > 641 ||
      wideWorkspace.history.bottom > 900 ||
      wideWorkspace.h1s !== 1 ||
      wideWorkspace.logo !== "none" ||
      !wideWorkspace.ipInside
    ) {
      throw new Error(`wide LAN workspace contract failed: ${JSON.stringify(wideWorkspace)}`);
    }
    ok("the wide LAN workspace exposed the task in the first viewport without overflow");

    await setWideViewport(sender, 1180);
    const boundary = await sender.evaluate(`({
      display: getComputedStyle(document.querySelector('.lan-workspace')).display,
      taskWidth: document.querySelector('.lan-task').getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    if (boundary.display !== "grid" || boundary.taskWidth < 735 || boundary.overflow !== 0) {
      throw new Error(`1180px LAN workspace boundary failed: ${JSON.stringify(boundary)}`);
    }
    await setWideViewport(sender);
    ok("the 1180px workspace boundary retained a usable task column");

    // Batch-2 chooser contract, zero peers: the live scanning signal belongs
    // inside the empty state and is compact/decorative; no selectable blip or
    // second full radar may precede the CTA.
    await sender.waitFor(
      "!!document.querySelector('.empty .radar.compact')",
      "the zero-peer compact scanning state (close other LAN test pages if this times out)",
    );
    const zeroChooser = await sender.evaluate(`({
      compact: document.querySelectorAll('.empty .radar.compact').length,
      blips: document.querySelectorAll('.empty button.blip').length,
      full: document.querySelectorAll('.peers > .radar:not(.compact)').length,
    })`);
    if (zeroChooser.compact !== 1 || zeroChooser.blips !== 0 || zeroChooser.full !== 0) {
      throw new Error(`zero-peer chooser contract failed: ${JSON.stringify(zeroChooser)}`);
    }
    ok("the zero-peer state used one compact scanner and no selectable radar");

    const receiver = await newTab(browser, BASE + "/", SAVE_STUB);
    await setWideViewport(receiver);

    const peersSeen = `(() => {
      const names = [...document.querySelectorAll('.pname')].map(e => e.textContent);
      return names.length > 0;
    })()`;
    try {
      await sender.waitFor(peersSeen, "the sender to see the receiver on the radar", 30_000);
    } catch (e) {
      const dump = async (tab, who) => console.error(`  [${who}] ` + JSON.stringify(await tab.evaluate(
        `({
           status: (document.body.innerText.match(/Connecting[^\\n]*|Connected[^\\n]*|Reconnecting[^\\n]*/) || ["?"])[0],
           peers: document.querySelectorAll('.pname').length,
         })`)) + " errors=" + JSON.stringify(tab.errors));
      await dump(sender, "sender");
      await dump(receiver, "receiver");
      throw e;
    }
    await receiver.waitFor(peersSeen, "the receiver to see the sender on the radar");
    ok("both tabs joined the room and discovered each other");

    // Exactly one peer is already selected by App's effectiveSelected rule, so
    // the chooser must be inert PeerLink decoration followed by the existing
    // actionable peer card — never a redundant radar button.
    for (const [who, tab] of [["sender", sender], ["receiver", receiver]]) {
      const oneChooser = await tab.evaluate(`({
        links: document.querySelectorAll('.peerlink').length,
        radars: document.querySelectorAll('.peers > .radar').length,
        peerCards: document.querySelectorAll('.peers .pname').length,
      })`);
      if (oneChooser.links !== 1 || oneChooser.radars !== 0 || oneChooser.peerCards !== 1) {
        throw new Error(`${who} one-peer chooser contract failed: ${JSON.stringify(oneChooser)}`);
      }
    }
    ok("both one-peer states used PeerLink followed by one actionable peer card");

    const fileAction = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const action = input?.parentElement;
      const header = document.querySelector('.peer .pcard');
      const labels = [...document.querySelectorAll('.peer-actions .pa-label')];
      const icons = [...document.querySelectorAll('.peer-actions .pa-icon')];
      const namedBy = input?.getAttribute('aria-labelledby') || '';
      const describedBy = input?.getAttribute('aria-describedby') || '';
      return {
        exists: !!input,
        namedBy,
        visibleLabel: action?.querySelector('.pa-label')?.textContent?.trim() || '',
        namedByText: document.getElementById(namedBy)?.textContent?.trim() || '',
        describedBy,
        describedByExists: !!document.getElementById(describedBy),
        headerFor: header?.htmlFor || '',
        inputId: input?.id || '',
        messageButtons: document.querySelectorAll('.peer-actions button').length,
        labelRects: labels.map(label => label.getClientRects().length),
        iconSvgs: icons.map(icon => icon.querySelectorAll('svg').length),
        iconText: icons.map(icon => icon.textContent?.trim() || ''),
      };
    })()`);
    if (
      !fileAction.exists || !fileAction.namedBy || !fileAction.visibleLabel ||
      fileAction.namedByText !== fileAction.visibleLabel ||
      !fileAction.describedBy || !fileAction.describedByExists ||
      fileAction.headerFor !== fileAction.inputId ||
      fileAction.messageButtons !== 1 || fileAction.labelRects.some((n) => n !== 1) ||
      fileAction.iconSvgs.length !== 3 || fileAction.iconSvgs.some((n) => n !== 1) ||
      fileAction.iconText.some(Boolean)
    ) {
      throw new Error(`peer file-action accessibility contract failed: ${JSON.stringify(fileAction)}`);
    }
    ok("the peer file action owned its picker and visible-label accessible name");

    // Put focus on the real preceding tab stop, then use a genuine keyboard Tab.
    // Programmatic input.focus() would not prove the :focus-visible ring that the
    // visible label receives through :has().
    const focusSetup = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const candidates = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.getClientRects().length || el === input);
      const index = candidates.indexOf(input);
      const previous = candidates[index - 1];
      previous?.focus();
      return { index, previous: previous?.tagName || '', focused: document.activeElement === previous };
    })()`);
    if (focusSetup.index < 1 || !focusSetup.focused) {
      throw new Error(`could not establish peer picker keyboard order: ${JSON.stringify(focusSetup)}`);
    }
    await sender.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await sender.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const keyboardFocus = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const action = input?.parentElement;
      return {
        input: document.activeElement === input,
        visible: input?.matches(':focus-visible') || false,
        actionRing: action?.matches(':has(> .file-pick-input:focus-visible)') || false,
      };
    })()`);
    if (!keyboardFocus.input || !keyboardFocus.visible || !keyboardFocus.actionRing) {
      throw new Error(`peer picker focus-visible contract failed: ${JSON.stringify(keyboardFocus)}`);
    }
    ok("a real Tab focused the picker and painted the ring on its visible file action");

    // Exercise the rules that are easiest to accidentally defeat with scoped CSS:
    // the coarse-pointer floor, the three narrow rows and long localized labels.
    await sender.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await setWideViewport(sender, 390, 844);
    for (const code of ["en", "fr", "pt", "de", "ar", "zh", "ja", "ko", "es"]) {
      await sender.evaluate(`(() => {
        const select = document.querySelector('select.lang');
        select.value = ${JSON.stringify(code)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sender.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} locale to render`);
      const narrow = await sender.evaluate(`(() => {
        const actions = [...document.querySelectorAll('.peer-actions > .btn')];
        const rects = actions.map(el => el.getBoundingClientRect());
        const labels = actions.map(el => el.querySelector('.pa-label'));
        return {
          coarse: matchMedia('(pointer: coarse)').matches,
          count: actions.length,
          heights: rects.map(r => r.height),
          widths: rects.map(r => r.width),
          tops: rects.map(r => Math.round(r.top)),
          labelRects: labels.map(el => el?.getClientRects().length || 0),
          fileBottom: rects[0]?.bottom || Infinity,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`);
      if (
        !narrow.coarse || narrow.count !== 3 ||
        narrow.heights.some((n) => n < 43.5) || new Set(narrow.tops).size !== 3 ||
        Math.max(...narrow.widths) - narrow.widths[0] > 1 ||
        narrow.labelRects.some((n) => n !== 1) ||
        narrow.fileBottom > 844 || narrow.overflow !== 0
      ) {
        throw new Error(`${code} narrow peer-action geometry failed: ${JSON.stringify(narrow)}`);
      }
    }
    await setWideViewport(sender, 430, 844);
    for (const code of ["en", "fr", "pt", "de", "ar", "zh", "ja", "ko", "es"]) {
      await sender.evaluate(`(() => {
        const select = document.querySelector('select.lang');
        select.value = ${JSON.stringify(code)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sender.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} shared-row locale to render`);
      const shared = await sender.evaluate(`(() => {
        const actions = [...document.querySelectorAll('.peer-actions > .btn')];
        const rects = actions.map(el => el.getBoundingClientRect());
        return {
          heights: rects.map(r => r.height),
          widths: rects.map(r => r.width),
          tops: rects.map(r => Math.round(r.top)),
          labelRects: actions.map(el => el.querySelector('.pa-label')?.getClientRects().length || 0),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`);
      if (
        shared.tops.length !== 3 || shared.tops[0] === shared.tops[1] || shared.tops[1] !== shared.tops[2] ||
        shared.widths[1] < 165 || shared.widths[2] < 165 ||
        shared.heights.some((n) => n < 43.5) || shared.labelRects.some((n) => n !== 1) ||
        shared.overflow !== 0
      ) {
        throw new Error(`${code} shared peer-action row failed: ${JSON.stringify(shared)}`);
      }
    }
    await sender.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sender.waitFor("document.documentElement.lang === 'en'", "English locale to return");
    await sender.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await setWideViewport(sender);
    ok("all nine locales kept honest 390px rows and unbroken 430px shared rows with 44px touch targets");

    const widePeerCard = await sender.evaluate("document.querySelector('.peers li.peer').getBoundingClientRect().width");
    if (widePeerCard < 500 || widePeerCard > 561) {
      throw new Error(`wide LAN peer card track contract failed: ${widePeerCard}px`);
    }
    await setWideViewport(sender, 1180);
    const boundaryPeerCard = await sender.evaluate("document.querySelector('.peers li.peer').getBoundingClientRect().width");
    if (boundaryPeerCard < 500 || boundaryPeerCard > 561) {
      throw new Error(`1180px LAN peer card track contract failed: ${boundaryPeerCard}px`);
    }
    await setWideViewport(sender);
    ok("the 1180px and 1440px LAN selected-peer action stayed on one capped track");

    // 首页折叠线以下的营销区块是懒加载的（HomeSections）。它在首屏之外，坏掉了
    // 不会有任何报错——页面只是从此少了一半内容。这里明确等它出现。
    // 用结构选择器而不是文案匹配：文案有 9 种语言、还会改，拿它当断言只会制造
    // 假红——第一版就踩了（英文标题是 "Frequently asked questions"，并不含 "FAQ"）。
    // .how / .crosscta / .faq 分别来自 HomeSections 里的三个子组件，三个都在才说明
    // 这个懒加载边界整块挂上了。
    await sender.waitFor(
      "['.how', '.crosscta', '.faq'].every((sel) => document.querySelector(sel))",
      "the lazily-loaded home sections to render",
    );
    ok("the lazy home sections rendered on the LAN page");

    // ── 发送：真的往那个 file input 里塞一个文件（CDP 的原生入口）──────────
    const payload = randomBytes(FILE_BYTES);
    const expected = createHash("sha256").update(payload).digest("hex");

    // 把字节交给页面，再由页面构造一个真 File 塞进 input —— setFileInputFiles 需要
    // 磁盘路径，而我们要的是确定性内容，所以走 DataTransfer 这条同样真实的路径。
    await sender.evaluate(`
      window.__payload = Uint8Array.from(atob("${payload.toString("base64")}"), c => c.charCodeAt(0));
      true
    `);
    await sender.evaluate(`(() => {
      const input = document.querySelector('.file-pick-input');
      if (!input) throw new Error('no file input on the page');
      const file = new File([window.__payload], ${JSON.stringify(FILE_NAME)}, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    ok(`sender picked a ${(FILE_BYTES / 1024 / 1024).toFixed(1)} MiB file`);

    // ── 接收：等确认卡片，按接受 ────────────────────────────────────────────
    const acceptBtn = `[...document.querySelectorAll('button')].find(b => /接受|Accept|受け取|수락|Annehmen|Accepter|قبول|Aceptar/i.test(b.textContent))`;
    try {
      await receiver.waitFor(`!!(${acceptBtn})`, "the receive confirmation card", 40_000);
    } catch (e) {
      for (const [who, tab] of [["sender", sender], ["receiver", receiver]]) {
        console.error(`  [${who}] ` + JSON.stringify(await tab.evaluate("document.body.innerText.replace(/\\s+/g,' ').slice(0, 400)"))
          + "\n         errors=" + JSON.stringify(tab.errors));
      }
      throw e;
    }
    // 确认卡片上必须显示文件名 —— 它是用户做信任决策的地方。
    const cardText = await receiver.evaluate("document.body.innerText");
    if (!cardText.includes(FILE_NAME)) throw new Error("the confirmation card never showed the filename");
    const requestLayout = await receiver.evaluate(`(() => {
      const card = document.querySelector('.request');
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
      };
    })()`);
    if (requestLayout.pageOverflow !== 0 || requestLayout.cardOverflow > 1) {
      throw new Error(`wide incoming request overflowed: ${JSON.stringify(requestLayout)}`);
    }
    ok("receiver got the confirmation card with the filename");

    await receiver.evaluate(`(() => { (${acceptBtn}).click(); return true; })()`);

    // SAS 只在传输**进行中**显示，传完就没了：从点下接受的那一刻起在后台采样，
    // 别等传完再读（读到的必然是空，那种"检查"等于没有）。
    const sasOf = `(() => { const c = document.querySelector('.status code'); return c ? c.textContent.trim() : ''; })()`;
    const sasSeen = { sender: "", receiver: "" };
    const sampling = (async () => {
      for (let i = 0; i < 400 && !(sasSeen.sender && sasSeen.receiver); i++) {
        sasSeen.sender ||= (await sender.evaluate(sasOf)) || "";
        sasSeen.receiver ||= (await receiver.evaluate(sasOf)) || "";
        await sleep(50);
      }
    })();

    // ── 等落盘完成，比对 ────────────────────────────────────────────────────
    await receiver.waitFor("window.__e2e.closed === true", "the file to finish writing", 120_000);
    const got = await receiver.evaluate(`(async () => {
      const blob = new Blob(window.__e2e.chunks);
      const buf = new Uint8Array(await blob.arrayBuffer());
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return {
        bytes: buf.length,
        name: window.__e2e.name,
        sha256: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join(''),
      };
    })()`);

    if (got.bytes !== FILE_BYTES) throw new Error(`byte count mismatch: got ${got.bytes}, want ${FILE_BYTES}`);
    if (got.sha256 !== expected) throw new Error(`content mismatch: sha256 ${got.sha256} != ${expected}`);
    if (got.name !== FILE_NAME) throw new Error(`filename mismatch: ${got.name}`);
    ok(`received ${got.bytes} bytes, sha256 matches`);

    // ── 双方 UI 都得如实报成功（进度条卡在 99% 也算失败）──────────────────
    const doneText = `/完成|Done|Sent|Received|完了|완료|Fertig|Terminé|اكتمل|Completado|Concluído/i.test(document.body.innerText)`;
    await sender.waitFor(doneText, "the sender's card to report completion");
    await receiver.waitFor(doneText, "the receiver's card to report completion");
    for (const [who, tab] of [["sender", sender], ["receiver", receiver]]) {
      const doneLayout = await tab.evaluate(`({
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardOverflows: [...document.querySelectorAll('.xfer')].map(card => card.scrollWidth - card.clientWidth),
      })`);
      if (doneLayout.pageOverflow !== 0 || doneLayout.cardOverflows.some((n) => n > 1)) {
        throw new Error(`${who} wide completed transfer overflowed: ${JSON.stringify(doneLayout)}`);
      }
    }
    ok("both cards report completion");

    // SAS：两边算出来的短认证码必须一致（中间人防护里用户看得见的那一半）。
    await sampling;
    if (!sasSeen.sender || !sasSeen.receiver) {
      throw new Error(`never observed the SAS on both sides (sender=${sasSeen.sender || "-"}, receiver=${sasSeen.receiver || "-"})`);
    }
    if (sasSeen.sender !== sasSeen.receiver) {
      throw new Error(`SAS mismatch: ${sasSeen.sender} vs ${sasSeen.receiver}`);
    }
    ok(`both sides showed the same SAS (${sasSeen.sender})`);

    const errs = [...sender.errors, ...receiver.errors].filter(
      (e) => !/401|Failed to load resource/.test(e),
    );
    if (errs.length) throw new Error(`console errors:\n    ${errs.join("\n    ")}`);
    ok("no console errors on either tab");

    // 关掉第一幕的两个标签页再开第二幕：同一个房间里留着旧设备会让"谁是对端"
    // 变得不确定，而这一幕要的是一对一。
    await browser.send("Target.closeTarget", { targetId: sender.targetId });
    await browser.send("Target.closeTarget", { targetId: receiver.targetId });
    await sleep(1000);
    await unsupportedLayoutScenario(browser);
    await sleep(1000);
    await earlyFailureScenario(browser);
    await sleep(1000);
    await resumeScenario(browser);
    await sleep(1000);
    await messageScenario(browser);
    await sleep(1000);
    await capsSuppressedScenario(browser);


    console.log("\n\x1b[32mLAN transfer E2E passed\x1b[0m\n");
  } catch (err) {
    fail("LAN transfer E2E", err);
  } finally {
    browser?.close();
    chrome.kill();
    await sleep(500); // 让 Chrome 先把 profile 目录里的文件句柄放掉
    if (!args.includes("--keep")) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* 临时目录，留着也无妨 */ }
    }
  }
}

await Promise.race([
  main(),
  sleep(GLOBAL_TIMEOUT_MS).then(() => {
    console.error(`  \x1b[31m✗\x1b[0m LAN transfer E2E\n    hard timeout after ${GLOBAL_TIMEOUT_MS / 60000} min — something hung; see the notes on the global watchdog`);
    process.exit(1);
  }),
]);
// 收尾：main 的 finally 已经收过浏览器，这里只是确保进程不被 CDP 的 socket 挂住。
process.exit(process.exitCode ?? 0);
