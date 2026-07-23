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
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text} — ${expression}`);
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

    // ── 两个标签页进同一个房间（都是 127.0.0.1，服务器按来源 IP 归组）────────
    const sender = await newTab(browser, BASE + "/");
    const receiver = await newTab(browser, BASE + "/", SAVE_STUB);

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
    await earlyFailureScenario(browser);
    await sleep(1000);
    await resumeScenario(browser);


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
