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
import { createHash, randomBytes } from "node:crypto";
// CDP 客户端、标签页把手、浏览器生命周期和另存为桩都在 harness.mjs 里，和
// mixed-link.mjs 共用同一份——两个脚本的超时语义和挂死检测必须是同一套。
import {
  OBSERVE_CAPS, SAVE_STUB, argFlag, argPresent, fail, launchBrowser, newTab, ok,
  requireServer, setWideViewport, sleep, withWatchdog,
} from "./harness.mjs";
// 真场景里的无障碍断言。静态扫描器扫不到这些状态：它没有对端，也没有信令服务器，
// 而"同意卡 / 进行中的进度条 / 消息记录"恰好是这个产品里最需要读屏的三个地方。
import { scanLiveState } from "./a11y-core.mjs";

const BASE = argFlag("--url", "http://localhost:8099");
const DEBUG_PORT = 9444;
const FILE_NAME = "e2e-payload.bin";
const FILE_BYTES = 3 * 1024 * 1024 + 12345; // 跨多个 192KiB 分块，且末块不对齐

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

  // 传输进行中：这是 role="progressbar" 唯一活着的时候。静态页上根本没有这个节点，
  // 所以"进度条有没有可访问名"这条只能在这里问。
  await scanLiveState(receiver, "receiver mid-transfer (live progressbar)");

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

  // 掉线→续传→完成之后的终态：断线重连会重建卡片和 live region，重建出来的那一份
  // 同样要是干净的。
  await scanLiveState(receiver, "receiver after drop + resume completed");

  const errs = [...sender.errors, ...receiver.errors].filter((e) => !/401|Failed to load resource/.test(e));
  // 掉线本身会在控制台留下预期内的噪音（"connection lost"/"resume ..."），只筛真正
  // 不该出现的：类型错误、断言、未捕获的 Reference/Type 错误。
  const bad = errs.filter((e) => /ReferenceError|TypeError|is not a function|undefined is not/.test(e));
  if (bad.length) throw new Error(`resume path raised real errors:\n    ${bad.join("\n    ")}`);
  ok("the resume path raised no ReferenceError/TypeError");

  await browser.send("Target.closeTarget", { targetId: sender.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver.targetId });
}

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
 * 收方桩件的公共部分：把浏览器下载那条回落路截下来做字节比对。
 *
 * 不 fetch(blob:) 取字节，因为线上那套 CSP 的 connect-src 不放行 blob:，测试会死在
 * 桩件上而不是产品上；Blob 本体在 createObjectURL 那一刻直接留住。
 */
const DOWNLOAD_TRAP = `
  window.__e2e = Object.assign(window.__e2e || {}, { names: [], blobs: [] });
  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj) => { window.__e2e.blobs.push(obj); return realCreate(obj); };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download) return realClick.call(this);
    window.__e2e.names.push(this.download);
    return undefined; // 别让无头浏览器真的开一个下载
  };
`;

/** 发送一个可预测的字节序列，收方按同一个公式逐字节校验。 */
const sendPayload = (tab, name, bytes) => tab.evaluate(`(() => {
  const input = document.querySelector('.file-pick-input');
  const bytes = new Uint8Array(${bytes});
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

const ACCEPT_BTN = `[...document.querySelectorAll('button')].find(b => /接受|Accept|受け取|수락|Annehmen|Accepter|قبول|Aceptar/i.test(b.textContent))`;
const CANCEL_WORDS = /取消|cancel|abgebrochen|annul|キャンセル|취소|cancelad|أُلغ/i;

/** 收方拿到的第一个 Blob 与发送端写的序列逐字节比对。 */
const readDownload = (tab) => tab.evaluate(`(async () => {
  const buf = new Uint8Array(await window.__e2e.blobs[0].arrayBuffer());
  let firstBad = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== ((i * 31 + 7) & 0xff)) { firstBad = i; break; }
  }
  return {
    name: window.__e2e.names[0],
    pickerCalls: window.__e2e.pickerCalls,
    firstBad,
    bytes: buf.length,
    status: (document.querySelector('.xfer .status')?.textContent ?? '').trim(),
  };
})()`);

/**
 * 手机：**一次保存选择器都不开**，文件走浏览器下载并且逐字节到手。
 *
 * 真机证据有两种坏法，而且同一台设备上遇到哪一种不可预测：安卓自带浏览器上
 * `showSaveFilePicker` 属性在、调用却给不出任何可用的选择界面，接收当场卡死；
 * 安卓版 Chrome 确实弹得出文件夹选择器，但那是个系统页面，一次误触返回键就把
 * 整次接收取消掉，只有正正好点中「选择此文件夹」才算成功。
 *
 * 所以手机上那条分支整条关掉。这一幕问的正是这个确定性：**选择器属性齐全、而且
 * 真调用就真能给出句柄**的情况下，调用次数必须是 0 —— 于是「0 次」不可能是失败
 * 回落的副作用，只可能是我们主动没开。单元测试只能钉住 filesink 那一层；
 * App.svelte 里的这条局域网接收管道只有这个脚本走得到。
 */
async function mobileNoPickerScenario(browser) {
  const NAME = "e2e-mobile-download.bin";
  const BYTES = 96 * 1024;
  // 关键：这两个选择器是**能用的**。它们一旦被调用就会成功并把字节吃掉，于是
  // 「pickerCalls 为 0 且 Blob 里有完整字节」是一个不可能被蒙混过去的组合。
  const WORKING_PICKERS = `
    window.__e2e = { pickerCalls: 0, pickedBytes: 0 };
    const writable = {
      write: async (chunk) => { window.__e2e.pickedBytes += chunk.byteLength; },
      close: async () => {},
    };
    const fileHandle = { createWritable: async () => writable };
    const dirHandle = {
      getFileHandle: async () => fileHandle,
      getDirectoryHandle: async () => dirHandle,
    };
    window.showSaveFilePicker = async () => { window.__e2e.pickerCalls++; return fileHandle; };
    window.showDirectoryPicker = async () => { window.__e2e.pickerCalls++; return dirHandle; };
  ` + DOWNLOAD_TRAP;
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Mobile Safari/537.36";

  const sender = await newTab(browser, BASE + "/");
  const receiver = await newTab(browser, BASE + "/", WORKING_PICKERS);
  await receiver.send("Network.enable");
  await receiver.send("Network.setUserAgentOverride", { userAgent: ANDROID_UA, platform: "Linux armv8l" });
  await setWideViewport(sender);
  await setWideViewport(receiver);
  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await sender.waitFor(peersSeen, "peers (mobile no-picker scenario)", 30_000);
  await receiver.waitFor(peersSeen, "peers (mobile no-picker scenario)", 30_000);

  await sendPayload(sender, NAME, BYTES);
  await receiver.waitFor(`!!(${ACCEPT_BTN})`, "the receive confirmation card (mobile)", 40_000);

  // 点之前必须先说清楚点下去会发生什么，而且手机上那句话只有一个正确答案：
  // 文件会保存到浏览器的下载目录。用户报的原话是「没看到任何选择器，也不知道
  // 该怎么选」——那句话缺的就是这一行。
  const hint = await receiver.evaluate("(document.querySelector('.savehint')?.textContent ?? '').trim()");
  if (!hint) throw new Error("the receive card never told the user what accepting would do");
  if (!/下载|Download|ダウンロード|다운로드|téléchargement|descargas|downloads|التنزيلات/i.test(hint)) {
    throw new Error(`on a phone the card must promise the Downloads folder, got ${JSON.stringify(hint)}`);
  }

  await receiver.evaluate(`(() => { (${ACCEPT_BTN}).click(); return true; })()`);
  await receiver.waitFor("window.__e2e.names.length === 1", "the browser download to deliver the file", 60_000);

  const got = await readDownload(receiver);
  if (got.pickerCalls !== 0) {
    throw new Error(
      `a phone opened ${got.pickerCalls} save picker(s) — this is the reported failure: ` +
      `the built-in browser shows no usable chooser, and Chrome's folder page cancels the whole ` +
      `transfer on an accidental Back`,
    );
  }
  if (got.bytes !== BYTES) throw new Error(`browser download delivered ${got.bytes} bytes, want ${BYTES}`);
  if (got.firstBad !== -1) throw new Error(`browser download delivered corrupted bytes (first mismatch at ${got.firstBad})`);
  if (got.name !== NAME) throw new Error(`browser download saved ${got.name}, want ${NAME}`);
  if (!got.status) throw new Error("the receiver card showed no status at all after the transfer");
  if (CANCEL_WORDS.test(got.status)) {
    throw new Error(`a phone receive was reported as a cancellation: ${JSON.stringify(got.status)}`);
  }
  const picked = await receiver.evaluate("window.__e2e.pickedBytes");
  if (picked !== 0) throw new Error(`bytes went through a picker handle on a phone (${picked})`);
  ok(`a phone with working save pickers opened none of them and still received ${got.bytes} exact bytes`);

  const bad = [...sender.errors, ...receiver.errors].filter((e) => /ReferenceError|TypeError|is not a function/.test(e));
  if (bad.length) throw new Error(`the mobile download path raised real errors:\n    ${bad.join("\n    ")}`);

  await browser.send("Target.closeTarget", { targetId: sender.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver.targetId });
}

/**
 * 桌面：在保存选择器里按取消**不是**这次接收的终局。
 *
 * 取消发生在 ACCEPT 之前，此刻线路上属于这一批的东西只有发送端那份 manifest，
 * 接收端一个字节都没往回发。所以同意卡片原地换一句话再问一次，发送端仍停在
 * waitingAccept —— 一次误按 Esc/返回不该把整次传输判死。
 *
 * 第二幕：非取消的失败（NotAllowedError）不是用户的选择，它照常回落到浏览器
 * 下载并把字节送到，绝不能被写成「已取消」。
 */
async function desktopPickerCancelScenario(browser) {
  const NAME = "e2e-desktop-retry.bin";
  const BYTES = 96 * 1024;
  // 第一次调用抛 AbortError（用户按了取消），第二次给一个真能写的句柄。
  const CANCEL_THEN_ACCEPT = `
    window.__e2e = { pickerCalls: 0, chunks: [], closed: false, name: "" };
    window.showSaveFilePicker = async ({ suggestedName }) => {
      window.__e2e.pickerCalls++;
      if (window.__e2e.pickerCalls === 1) {
        const err = new Error("The user aborted a request.");
        err.name = "AbortError";
        throw err;
      }
      window.__e2e.name = suggestedName;
      return {
        createWritable: async () => ({
          write: async (chunk) => { window.__e2e.chunks.push(chunk.slice()); },
          close: async () => { window.__e2e.closed = true; },
        }),
      };
    };
    window.showDirectoryPicker = async () => { throw new Error("e2e: directory picker not stubbed"); };
  `;

  const sender = await newTab(browser, BASE + "/");
  const receiver = await newTab(browser, BASE + "/", CANCEL_THEN_ACCEPT);
  await setWideViewport(sender);
  await setWideViewport(receiver);
  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await sender.waitFor(peersSeen, "peers (desktop cancel scenario)", 30_000);
  await receiver.waitFor(peersSeen, "peers (desktop cancel scenario)", 30_000);

  await sendPayload(sender, NAME, BYTES);
  await receiver.waitFor(`!!(${ACCEPT_BTN})`, "the receive confirmation card (desktop)", 40_000);
  const firstHint = await receiver.evaluate("(document.querySelector('.savehint')?.textContent ?? '').trim()");
  if (!firstHint) throw new Error("the receive card never told the user what accepting would do");

  await receiver.evaluate(`(() => { (${ACCEPT_BTN}).click(); return true; })()`);

  // 取消之后卡片必须还在，而且必须**说出来**——否则用户只看到「什么都没发生」。
  await receiver.waitFor(
    "!!document.querySelector('.savehint.retry')",
    "the consent card to come back after a cancelled save dialog",
    20_000,
  );
  const afterCancel = await receiver.evaluate(`(() => ({
    pickerCalls: window.__e2e.pickerCalls,
    canAccept: !!(${ACCEPT_BTN}),
    retryText: (document.querySelector('.savehint.retry')?.textContent ?? '').trim(),
    terminal: [...document.querySelectorAll('.xfer .status')].map(n => n.textContent.trim()).filter(t => /✗/.test(t)),
  }))()`);
  if (afterCancel.pickerCalls !== 1) throw new Error(`expected exactly one picker call, got ${afterCancel.pickerCalls}`);
  if (!afterCancel.canAccept) throw new Error("a cancelled save dialog left no way to accept again");
  if (!afterCancel.retryText) throw new Error("the card came back but said nothing about the cancellation");
  if (afterCancel.terminal.length) {
    throw new Error(`one Back/Escape produced a terminal failure: ${JSON.stringify(afterCancel.terminal)}`);
  }

  // 发送端还在等同一个答复：重新点「接收」就是一次全新手势、一次全新的选择器。
  await receiver.evaluate(`(() => { (${ACCEPT_BTN}).click(); return true; })()`);
  await receiver.waitFor("window.__e2e.closed === true", "the retried save to complete", 60_000);
  const saved = await receiver.evaluate(`(() => {
    const total = window.__e2e.chunks.reduce((n, c) => n + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let at = 0;
    for (const c of window.__e2e.chunks) { buf.set(new Uint8Array(c), at); at += c.byteLength; }
    let firstBad = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== ((i * 31 + 7) & 0xff)) { firstBad = i; break; }
    }
    return { bytes: total, firstBad, name: window.__e2e.name, pickerCalls: window.__e2e.pickerCalls };
  })()`);
  if (saved.pickerCalls !== 2) throw new Error(`the retry did not open a fresh picker (calls: ${saved.pickerCalls})`);
  if (saved.bytes !== BYTES) throw new Error(`the retried save wrote ${saved.bytes} bytes, want ${BYTES}`);
  if (saved.firstBad !== -1) throw new Error(`the retried save wrote corrupted bytes (first mismatch at ${saved.firstBad})`);
  if (saved.name !== NAME) throw new Error(`the retried save suggested ${saved.name}, want ${NAME}`);
  ok(`a cancelled desktop save dialog stayed retryable and the retry wrote ${saved.bytes} exact bytes`);

  await browser.send("Target.closeTarget", { targetId: sender.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver.targetId });

  // ── 第二幕：非取消的失败照常回落，绝不写成「已取消」。 ──────────────────
  const FAIL_NAME = "e2e-desktop-fallback.bin";
  const BROKEN_PICKER = `
    window.__e2e = { pickerCalls: 0 };
    window.showSaveFilePicker = async () => {
      window.__e2e.pickerCalls++;
      throw Object.assign(new Error("write access denied"), { name: "NotAllowedError" });
    };
    window.showDirectoryPicker = async () => { throw new Error("e2e: directory picker not stubbed"); };
  ` + DOWNLOAD_TRAP;

  const sender2 = await newTab(browser, BASE + "/");
  const receiver2 = await newTab(browser, BASE + "/", BROKEN_PICKER);
  await setWideViewport(sender2);
  await setWideViewport(receiver2);
  await sender2.waitFor(peersSeen, "peers (desktop fallback scenario)", 30_000);
  await receiver2.waitFor(peersSeen, "peers (desktop fallback scenario)", 30_000);

  await sendPayload(sender2, FAIL_NAME, BYTES);
  await receiver2.waitFor(`!!(${ACCEPT_BTN})`, "the receive confirmation card (desktop fallback)", 40_000);
  await receiver2.evaluate(`(() => { (${ACCEPT_BTN}).click(); return true; })()`);
  await receiver2.waitFor("window.__e2e.names.length === 1", "the browser-download fallback to deliver the file", 60_000);

  const fell = await readDownload(receiver2);
  if (fell.pickerCalls !== 1) throw new Error(`expected exactly one picker attempt, got ${fell.pickerCalls}`);
  if (fell.bytes !== BYTES) throw new Error(`fallback delivered ${fell.bytes} bytes, want ${BYTES}`);
  if (fell.firstBad !== -1) throw new Error(`fallback delivered corrupted bytes (first mismatch at ${fell.firstBad})`);
  if (fell.name !== FAIL_NAME) throw new Error(`fallback downloaded ${fell.name}, want ${FAIL_NAME}`);
  if (CANCEL_WORDS.test(fell.status)) {
    throw new Error(`a broken picker was reported as the user's cancellation: ${JSON.stringify(fell.status)}`);
  }
  ok(`a desktop picker that fails without the user's input still delivered ${fell.bytes} exact bytes`);

  const bad2 = [...sender2.errors, ...receiver2.errors].filter((e) => /ReferenceError|TypeError|is not a function/.test(e));
  if (bad2.length) throw new Error(`the desktop fallback path raised real errors:\n    ${bad2.join("\n    ")}`);

  await browser.send("Target.closeTarget", { targetId: sender2.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver2.targetId });
}

/** 全局看门狗的时限。为什么必须有一个，见 harness.mjs 的 withWatchdog。 */
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
  // 顺带钉住"默认构建通告什么"。这一幕本来就要等 caps 到达，探针不额外花任何时间，
  // 而它守的是一条比消息本身更硬的规矩：link/1 还没做完，默认产物里就不能出现它。
  const a = await newTab(browser, BASE + "/", OBSERVE_CAPS);
  const b = await newTab(browser, BASE + "/", OBSERVE_CAPS);
  await setWideViewport(a, 390, 844);
  await setWideViewport(b, 390, 844);

  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await a.waitFor(peersSeen, "tab A to see tab B on the radar", 30_000);
  await b.waitFor(peersSeen, "tab B to see tab A on the radar", 30_000);

  // 等消息按钮出现 —— 这是"名册层的 caps 通告已经到了"的**正向**信号。后面那一幕
  // 断言它不出现，靠的就是这里证明过它本来会出现。
  await a.waitFor(`!!document.querySelector('${MSG_OPEN_BTN}')`, "the message control to appear once caps arrived", 30_000);
  await b.waitFor(`!!document.querySelector('${MSG_OPEN_BTN}')`, "the message control on tab B too", 30_000);
  ok("both tabs advertised text/1 and offered a message control");

  // 默认产物必须**只**通告 text/1。link/1 的两条通道、协调器和恢复还没一起做完，
  // 所以任何一个把它漏进默认构建的改动（比如把 e2e 的构建旗标写死成开）都要在这里
  // 变成红色，而不是安静地把一个半成品协议放出去。
  for (const [who, tab] of [["A", a], ["B", b]]) {
    const advertised = await tab.evaluate("window.__advertisedCaps");
    if (!Array.isArray(advertised) || advertised.length === 0) {
      throw new Error(`tab ${who} never sent a roster capability hello; this check proves nothing`);
    }
    if (JSON.stringify(advertised) !== JSON.stringify(["text/1"])) {
      throw new Error(`the default build advertised ${JSON.stringify(advertised)}, want ["text/1"]`);
    }
  }
  // 而且默认构建里那套统一工作区一个节点都不该挂出来。
  const unifiedNodes = await a.evaluate("document.querySelectorAll('.workspace-head, .queued').length");
  if (unifiedNodes !== 0) {
    throw new Error(`the default build rendered ${unifiedNodes} unified-workspace node(s)`);
  }
  ok("the default build advertised only text/1 and rendered no unified workspace");

  await a.evaluate(`(() => {
    const button = document.querySelector('${MSG_OPEN_BTN}');
    button.focus();
    button.click();
    return true;
  })()`);

  // 收方先看到请求卡片，而且**此刻不能有任何正文**。
  await b.waitFor("!!document.querySelector('.msgpanel')", "tab B to show the message request", 40_000);
  const bodiesBeforeConsent = await b.evaluate("document.querySelectorAll('.msg-body').length");
  if (bodiesBeforeConsent !== 0) {
    throw new Error(`tab B rendered ${bodiesBeforeConsent} message bodies BEFORE consent`);
  }
  const hasComposerBeforeConsent = await b.evaluate("!!document.querySelector('.msgpanel textarea')");
  if (hasComposerBeforeConsent) throw new Error("tab B showed a composer before accepting");
  ok("the request card showed no content and no composer before consent");

  // The next required security step must replace the peer card as the visible
  // task on a phone. Real DOM order matters for reading/keyboard order, and the
  // reveal must not focus an accept/send action on the user's behalf.
  await a.waitFor("!!document.querySelector('.msgpanel .sas code')", "tab A's mobile message SAS");
  await b.waitFor("!!document.querySelector('.msgpanel .sas code')", "tab B's mobile message SAS");
  const mobileMessageGeometry = async (tab) => tab.evaluate(`(() => {
    const panel = document.querySelector('.msgpanel');
    const peers = document.querySelector('.peers');
    const sas = panel.querySelector('.sas').getBoundingClientRect();
    const actions = [...panel.querySelectorAll('.act button')].map((el) => el.getBoundingClientRect());
    const active = document.activeElement;
    return {
      sas: { top: sas.top, bottom: sas.bottom },
      actionBottoms: actions.map((r) => r.bottom),
      panelBeforePeers: !!(panel.compareDocumentPosition(peers) & Node.DOCUMENT_POSITION_FOLLOWING),
      activityFocused: panel.contains(active),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewport: window.visualViewport?.height ?? innerHeight,
      announcement: document.querySelector('.activity-announcement')?.textContent ?? '',
    };
  })()`);
  const mobileMessage = { a: await mobileMessageGeometry(a), b: await mobileMessageGeometry(b) };
  for (const [who, layout] of Object.entries(mobileMessage)) {
    if (
      layout.sas.top < 0 || layout.sas.bottom > layout.viewport ||
      layout.actionBottoms.some((n) => n > layout.viewport) ||
      !layout.panelBeforePeers || layout.activityFocused || layout.overflow !== 0 ||
      !/\d{6}/.test(layout.announcement)
    ) {
      throw new Error(`${who} mobile message verification visibility failed: ${JSON.stringify(layout)}`);
    }
  }
  ok("both 390px message views promoted SAS/consent before peers without focusing an action");

  // Keep the established wide-workspace contract below in the same real session.
  await setWideViewport(a);
  await setWideViewport(b);

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

  // 消息面板带着 role="log" live-region wrapper 和内部消息列表——静态扫描器同样到不了。
  await scanLiveState(a, "message session (log + composer)");

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

/** Private email landings share one trust surface, but keep independent auth
 * state machines. Fake tokens are never submitted here: the browser scenario
 * verifies presentation, URL scrubbing, private head metadata and responsive
 * geometry; component tests own the request/security transitions. */
async function authLandingScenario(browser) {
  const tab = await newTab(browser, BASE + "/magic-link?token=e2e-presentation-only");
  await setWideViewport(tab);
  await tab.waitFor("!!document.querySelector('.auth-card h1')", "magic-link trust surface");
  const magic = await tab.evaluate(`(() => ({
    path: location.pathname,
    search: location.search,
    title: document.title,
    h1: [...document.querySelectorAll('.auth-card h1')].map((el) => el.textContent.trim()),
    headingPx: parseFloat(getComputedStyle(document.querySelector('.auth-card h1')).fontSize),
    sharedCard: document.querySelector('.auth-card').classList.contains('ui-card'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    robots: document.querySelector('meta[name="robots"]')?.content || '',
  }))()`);
  if (
    magic.path !== "/magic-link" || magic.search !== "" ||
    JSON.stringify(magic.h1) !== JSON.stringify(["Sign in"]) || magic.headingPx !== 30 ||
    !magic.sharedCard || magic.canonical !== null || magic.alternates !== 0 ||
    magic.robots !== "noindex, nofollow"
  ) throw new Error(`magic-link landing contract failed: ${JSON.stringify(magic)}`);

  for (const [route, labels] of [
    ["verify-email", ["verify-password"]],
    ["reset-password", ["reset-new-password", "reset-confirm-password"]],
  ]) {
    await tab.evaluate(`location.href = ${JSON.stringify(`${BASE}/${route}?token=e2e-presentation-only`)}`);
    await tab.waitFor(`location.pathname === '/${route}' && !!document.querySelector('.auth-card h1')`, `${route} trust surface`);
    const state = await tab.evaluate(`(() => ({
      search: location.search,
      h1s: document.querySelectorAll('.auth-card h1').length,
      labelTargets: [...document.querySelectorAll('.ui-field > label')].map((el) => el.htmlFor),
      inputBorders: [...document.querySelectorAll('.ui-input')].map((el) => getComputedStyle(el).borderTopColor),
      neutralBorder: (() => { const p = document.createElement('span'); p.style.color = 'var(--control-border)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
      alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    }))()`);
    if (
      state.search !== "" || state.h1s !== 1 ||
      JSON.stringify(state.labelTargets) !== JSON.stringify(labels) ||
      state.inputBorders.some((color) => color !== state.neutralBorder) ||
      state.canonical !== null || state.alternates !== 0
    ) throw new Error(`${route} landing contract failed: ${JSON.stringify(state)}`);
  }

  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await setWideViewport(tab, 320, 844);
  const locales = ["zh", "en", "ja", "ko", "de", "fr", "ar", "es", "pt"];
  const mobile = [];
  for (const code of locales) {
    await tab.evaluate(`(() => {
      const select = document.querySelector('select.lang');
      select.value = ${JSON.stringify(code)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} auth locale`);
    mobile.push(await tab.evaluate(`(() => {
      const card = document.querySelector('.auth-card').getBoundingClientRect();
      const action = document.querySelector('.auth-action').getBoundingClientRect();
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardLeft: card.left,
        cardRight: card.right,
        actionHeight: action.height,
        h1s: document.querySelectorAll('.auth-card h1').length,
      };
    })()`));
  }
  const bad = mobile.filter((m) =>
    m.pageOverflow !== 0 || m.cardLeft < -.5 || m.cardRight > 320.5 ||
    m.actionHeight < 44 || m.h1s !== 1 || (m.lang === "ar" ? m.dir !== "rtl" : m.dir !== "ltr")
  );
  if (bad.length) throw new Error(`mobile auth landing contract failed: ${JSON.stringify(bad)}`);

  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await tab.waitFor("document.documentElement.lang === 'en'", "English locale after auth sweep");
  await tab.evaluate("([...document.querySelectorAll('nav button, nav a')].find((element) => element.textContent.trim() === 'LAN'))?.click()");
  await tab.waitFor("location.pathname === '/'", "auth landing to return to LAN");
  const publicHead = await tab.evaluate(`(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    og: document.querySelector('meta[property="og:url"]')?.content || null,
    alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    robots: document.querySelector('meta[name="robots"]')?.content || '',
  }))()`);
  if (
    publicHead.canonical !== `${BASE}/` || publicHead.og !== `${BASE}/` ||
    publicHead.alternates !== 10 || !publicHead.robots.startsWith("index, follow")
  ) throw new Error(`private-to-public head restoration failed: ${JSON.stringify(publicHead)}`);

  const errs = tab.errors.filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`auth landing pages logged errors:\n    ${errs.join("\n    ")}`);
  ok("auth landings stayed named, private, labelled and responsive across all nine locales");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
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

/**
 * 手机 + 跨网中继形态：一台安卓手机在只有中继池、而中继测速探测又打不通的情况下，
 * 到底拿到了什么 RTCConfiguration。
 *
 * 这条用例对的是一个真实故障：跨网传输在手机上一直显示"正在建立加密连接"、进度 0%，
 * 30 秒后报"建立连接失败"，而服务端日志干干净净。原因不在超时，在于**中继被丢掉了**。
 * App 只有在 measureRelay 成功选出一台中继时才用中继池；测速超时（手机上因为射频唤醒 +
 * TURN 长期凭据的两轮 Allocate 而常态发生）就退回去看顶层 iceServers 里那条遗留 TURN。
 * 而"只用我自己的节点"的用户、以及任何靠节点池发中继的部署，顶层根本没有 TURN——于是
 * 策略退回 "all"、只剩 STUN，跨网必然连不上。
 *
 * 这里每一样都是真的：真安卓 UA + 触摸视口、真 /api/ice 形状（STUN 顶层 + 中继池）、
 * 真 RTCPeerConnection 去 allocate 一台不存在的 TURN（所以探测是真的超时，不是打桩）。
 * 断言落在应用交给 RTCPeerConnection 的那份配置上——修复前那份配置里一条 turn: 都没有。
 */
async function mobileRelayFallbackScenario(browser) {
  // /api/ice 的形状：顶层只有 STUN，中继全在 relays 池里。这正是严格模式用户和
  // 节点池部署看到的响应。TURN 主机指向一个黑洞地址，所以 measureRelay 必然测空。
  const POOL_ONLY_ICE = `
    window.__configs = [];
    (() => {
      const Real = window.RTCPeerConnection;
      window.RTCPeerConnection = function (cfg, ...rest) {
        window.__configs.push(JSON.parse(JSON.stringify(cfg ?? {})));
        return new Real(cfg, ...rest);
      };
      window.RTCPeerConnection.prototype = Real.prototype;
      const realFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input?.url ?? "";
        if (url.startsWith("/api/ice")) {
          return Promise.resolve(new Response(JSON.stringify({
            iceServers: [{ urls: "stun:127.0.0.1:3478" }],
            relays: [{
              id: "pool-a",
              region: "test",
              iceServers: [{ urls: ["turn:192.0.2.1:3478"], username: "u", credential: "c" }],
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        return realFetch(input, init);
      };
    })();
  `;
  // A real Pixel-class Android: touch viewport plus the UA the app would see.
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Mobile Safari/537.36";

  const phone = await newTab(browser, BASE + "/", POOL_ONLY_ICE + SAVE_STUB);
  await phone.send("Network.enable");
  await phone.send("Network.setUserAgentOverride", { userAgent: ANDROID_UA, platform: "Linux armv8l" });
  await phone.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true,
  });
  await phone.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  const peer = await newTab(browser, BASE + "/", POOL_ONLY_ICE + SAVE_STUB);
  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await phone.waitFor(peersSeen, "peers (mobile relay scenario)", 30_000);
  await peer.waitFor(peersSeen, "peers (mobile relay scenario)");

  // The probe is genuinely running against an unreachable TURN host; wait past
  // its budget so the app is in the "no relay selected" state the bug needed.
  await sleep(10_000);
  const selected = await phone.evaluate(`(() => {
    // No relay may have been selected — that is the precondition, not a failure.
    return window.__configs.length;
  })()`);
  if (!selected) throw new Error("the phone never built a peer connection — the relay probe did not run");

  // From here on, only configs built for the transfer itself count.
  await phone.evaluate("window.__configs.length = 0; true");

  await phone.evaluate(`(() => {
    const input = document.querySelector('.file-pick-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(1024)], 'mobile-relay.bin', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await phone.waitFor("window.__configs.length > 0", "the phone to build a transfer peer connection", 30_000);

  const cfg = await phone.evaluate("window.__configs[0]");
  const urls = (cfg.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  const turn = urls.filter((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  if (turn.length === 0) {
    throw new Error(
      `the phone built a transfer connection with NO relay: ${JSON.stringify(cfg)} — ` +
      `this is the reported failure: relay-pool credentials were issued and then discarded, ` +
      `so a cross-network transfer sits at 0% until the connect timeout`,
    );
  }
  if (cfg.iceTransportPolicy !== "relay") {
    throw new Error(`relay was present but policy was ${cfg.iceTransportPolicy ?? "all"}, want "relay": ${JSON.stringify(cfg)}`);
  }
  ok(`an Android phone with an unmeasurable relay pool still relays (${turn.join(", ")}, policy ${cfg.iceTransportPolicy})`);

  // And the failure that follows must be a bounded, named one rather than an
  // endless 0%: the relay is a black hole, so this connection cannot succeed.
  // What it must NOT do is stay at "connecting" forever.
  const failed = `[...document.querySelectorAll('.status')].some(n => /✗/.test(n.textContent))`;
  await phone.waitFor(failed, "the unreachable-relay transfer to fail rather than hang at 0%", 70_000);
  ok("an unreachable relay produced a terminal failure instead of an endless 0%");

  await browser.send("Target.closeTarget", { targetId: phone.targetId });
  await browser.send("Target.closeTarget", { targetId: peer.targetId });
}

/**
 * A peer that only accepts 64 KiB SCTP messages — the reported Android failure.
 *
 * A DataChannel's maximum message size is negotiated, not a property of the
 * local browser: it is the smaller of what this end can send and what the peer
 * advertised as `a=max-message-size` (64 KiB by default, per RFC 8841, when the
 * peer advertises nothing). Old Chromium-based Android WebViews land there.
 * Text frames are small and sail through; a 192 KiB file chunk does not — which
 * is exactly why text worked and every file transfer failed.
 *
 * Nothing here is emulated away. Both tabs run real Chromium and a real
 * PeerConnection; the only intervention is rewriting the advertised limit in
 * the SDP each side receives, which is precisely what such a peer would send.
 * Part one measures what a real Chromium does at that limit; part two runs an
 * actual multi-chunk transfer through it and compares SHA-256.
 */
async function smallMessageCapScenario(browser) {
  const CAP = 65536;
  // Rewrite the limit the peer advertises. Applied to what goes into the WebRTC
  // engine only — the signalling bytes (and any signature over them) are
  // untouched.
  const CAP_SDP = `
    window.__capBytes = ${CAP};
    (() => {
      const capSdp = (sdp) => /a=max-message-size:/.test(sdp)
        ? sdp.replace(/a=max-message-size:\\d+/g, 'a=max-message-size:' + window.__capBytes)
        : sdp.replace(/(a=sctp-port:\\d+\\r?\\n)/, '$1a=max-message-size:' + window.__capBytes + '\\r\\n');
      const real = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (desc) {
        if (desc && desc.sdp) desc = { type: desc.type, sdp: capSdp(desc.sdp) };
        return real.call(this, desc);
      };
      window.__negotiated = () => window.__pcs.map((pc) => pc.sctp && pc.sctp.maxMessageSize);
    })();
  `;

  // ── 1. what a real Chromium does at a 64 KiB negotiated limit ──────────────
  const probeTab = await newTab(browser, BASE + "/", PC_TRACKER + CAP_SDP);
  const probe = await probeTab.evaluate(`(async () => {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const ch = a.createDataChannel('probe');
    const open = new Promise((r) => { ch.onopen = r; });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    await open;
    const attempt = (n) => {
      try { ch.send(new Uint8Array(n)); return 'sent'; } catch (err) { return err.name || 'threw'; }
    };
    const chunkFrame = attempt(192 * 1024 + 21);  // what the file protocol used to send, always
    const afterChunk = ch.readyState;
    const fitted = attempt(${CAP} - 21);          // what it sends now
    const out = { negotiated: a.sctp.maxMessageSize, chunkFrame, afterChunk, fitted, afterFitted: ch.readyState };
    a.close(); b.close();
    return out;
  })()`);

  if (probe.negotiated !== CAP) {
    throw new Error(`the cap did not take: sctp.maxMessageSize is ${probe.negotiated}, want ${CAP}`);
  }
  if (probe.chunkFrame === "sent" && probe.afterChunk === "open") {
    throw new Error(
      `this Chromium accepted a ${192 * 1024 + 21}-byte message at a ${CAP}-byte limit, so this ` +
      `run cannot demonstrate the defect — the scenario needs revisiting`,
    );
  }
  if (probe.fitted !== "sent" || probe.afterFitted !== "open") {
    throw new Error(`a message inside the limit should go through, got ${probe.fitted}/${probe.afterFitted}`);
  }
  ok(`a real 64 KiB-capped channel refuses the old 192 KiB chunk frame (${probe.chunkFrame}, channel ${probe.afterChunk}) and takes a fitted one`);
  await browser.send("Target.closeTarget", { targetId: probeTab.targetId });

  // ── 2. an actual multi-chunk file through that same limit ─────────────────
  const NAME = "e2e-small-cap.bin";
  const BYTES = 3 * 192 * 1024 + 7777; // several logical chunks, and a partial tail
  const GEN = `
    window.__makePayload = (n) => {
      const out = new Uint8Array(n);
      let x = 0x2545f491;
      for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
      return out;
    };
    window.__sha256 = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  `;

  const sender = await newTab(browser, BASE + "/", PC_TRACKER + CAP_SDP + GEN);
  const receiver = await newTab(browser, BASE + "/", PC_TRACKER + CAP_SDP + GEN + SAVE_STUB);
  await setWideViewport(sender);
  await setWideViewport(receiver);
  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await sender.waitFor(peersSeen, "peers (small message cap)");
  await receiver.waitFor(peersSeen, "peers (small message cap)");

  const sentHash = await sender.evaluate(`(async () => {
    const bytes = window.__makePayload(${BYTES});
    const input = document.querySelector('.file-pick-input');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(NAME)}, { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__sha256(bytes);
  })()`);

  const acceptBtn = `[...document.querySelectorAll('button')].find(b => /接受|Accept|受け取|수락|Annehmen|Accepter|قبول|Aceptar/i.test(b.textContent))`;
  await receiver.waitFor(`!!(${acceptBtn})`, "the confirmation card (small message cap)");
  await receiver.evaluate(`(() => { (${acceptBtn}).click(); return true; })()`);

  // The failure this replaces was an indefinite 0%, so the window is deliberately
  // finite: not finishing inside it IS the regression.
  await receiver.waitFor("window.__e2e.closed === true", "the capped transfer to finish", 120_000);

  const got = await receiver.evaluate(`(async () => {
    const buf = new Uint8Array(await new Blob(window.__e2e.chunks).arrayBuffer());
    return { bytes: buf.length, sha256: await window.__sha256(buf), negotiated: window.__negotiated() };
  })()`);
  const senderNegotiated = await sender.evaluate("window.__negotiated()");

  const live = [...got.negotiated, ...senderNegotiated].filter((n) => typeof n === "number");
  if (!live.length || live.some((n) => n !== CAP)) {
    throw new Error(`both peers must have negotiated ${CAP}, got ${JSON.stringify(live)}`);
  }
  if (got.bytes !== BYTES) throw new Error(`received ${got.bytes} bytes, want ${BYTES}`);
  if (got.sha256 !== sentHash) throw new Error(`received file differs: ${got.sha256} != ${sentHash}`);
  ok(`${BYTES} bytes delivered byte-identical over a ${CAP}-byte message limit`);

  // Truthfulness: the receiver's card must say "done", not sit on a stale
  // progress state, and no lane may have reported a failure.
  const finalState = await receiver.evaluate(`(() => ({
    bad: document.querySelectorAll('.xfer.bad').length,
    text: [...document.querySelectorAll('.xfer .status')].map((n) => n.textContent.trim()).join(' | '),
  }))()`);
  if (finalState.bad > 0) {
    throw new Error(`the transfer succeeded but the card reports failure: ${finalState.text}`);
  }
  ok(`the capped transfer's final state is truthful (${finalState.text || "no status row"})`);

  const bad = [...sender.errors, ...receiver.errors]
    .filter((e) => /ReferenceError|TypeError|is not a function|too large|Message too big/i.test(e));
  if (bad.length) throw new Error(`the capped path raised real errors:\n    ${bad.join("\n    ")}`);
  ok("the capped path raised no oversize-send or reference errors");

  await browser.send("Target.closeTarget", { targetId: sender.targetId });
  await browser.send("Target.closeTarget", { targetId: receiver.targetId });

  // ── 3. a resume whose replacement connection allows LESS than the first ────
  // The adversarial case: the receiver's checkpoint and hash chain were built on
  // a connection that carried whole 192 KiB chunks, and the replacement carries
  // 64 KiB messages. Both must still agree on every byte and on the file hash.
  const RESUME_BYTES = 8 * 1024 * 1024 + 321;
  const NO_CAP = 262144; // Chromium's own ceiling: capping to it changes nothing
  const bigSender = await newTab(browser, BASE + "/", PC_TRACKER + CAP_SDP + GEN);
  const bigReceiver = await newTab(browser, BASE + "/", PC_TRACKER + CAP_SDP + GEN + SAVE_STUB);
  await setWideViewport(bigSender);
  await setWideViewport(bigReceiver);
  for (const tab of [bigSender, bigReceiver]) {
    await tab.evaluate(`(() => { window.__capBytes = ${NO_CAP}; return true; })()`);
    await tab.waitFor(peersSeen, "peers (resume under a smaller cap)");
  }
  // Slow the receiver's writes so the drop lands mid-file instead of after it.
  await bigReceiver.evaluate("window.__e2e.writeDelayMs = 25; true");

  const resumeHash = await bigSender.evaluate(`(async () => {
    const bytes = window.__makePayload(${RESUME_BYTES});
    const input = document.querySelector('.file-pick-input');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'e2e-cap-resume.bin', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__sha256(bytes);
  })()`);
  await bigReceiver.waitFor(`!!(${acceptBtn})`, "the confirmation card (resume under a smaller cap)");
  await bigReceiver.evaluate(`(() => { (${acceptBtn}).click(); return true; })()`);
  await bigReceiver.waitFor("window.__e2e.bytes > 1024 * 1024", "the receiver to durably write the first MB");

  // From here every new connection negotiates 64 KiB — including the resume.
  for (const tab of [bigSender, bigReceiver]) {
    await tab.evaluate(`(() => { window.__capBytes = ${CAP}; return true; })()`);
  }
  await bigReceiver.evaluate("window.__e2e.writeDelayMs = 0; true");
  await bigSender.evaluate("window.__dropLive()");
  await bigReceiver.evaluate("window.__dropLive()");
  ok("dropped mid-transfer, then narrowed the message limit for the replacement connection");

  await bigReceiver.waitFor("window.__e2e.closed === true", "the resumed capped transfer to finish", 180_000);
  const resumed = await bigReceiver.evaluate(`(async () => {
    const buf = new Uint8Array(await new Blob(window.__e2e.chunks).arrayBuffer());
    return { bytes: buf.length, sha256: await window.__sha256(buf), pcs: window.__pcs.length, negotiated: window.__negotiated() };
  })()`);

  if (resumed.pcs < 2) {
    throw new Error(`no resume happened (receiver built ${resumed.pcs} connection(s)) — this run proved nothing`);
  }
  if (!resumed.negotiated.includes(CAP)) {
    throw new Error(`the replacement connection should have negotiated ${CAP}, got ${JSON.stringify(resumed.negotiated)}`);
  }
  if (resumed.bytes !== RESUME_BYTES) {
    throw new Error(`resumed file is ${resumed.bytes} bytes, want ${RESUME_BYTES} — bytes were skipped or duplicated`);
  }
  if (resumed.sha256 !== resumeHash) {
    throw new Error(`resumed file does not match what was sent: ${resumed.sha256} != ${resumeHash}`);
  }
  ok(`resumed across a narrowed message limit and delivered ${resumed.bytes} bytes byte-identical`);

  await browser.send("Target.closeTarget", { targetId: bigSender.targetId });
  await browser.send("Target.closeTarget", { targetId: bigReceiver.targetId });
}

async function main() {
  // 前置检查：服务器在不在，dist 是不是新的（旧 dist 会测出一个假绿）。
  await requireServer(BASE, "start it with: cd server && RELAYIUM_ADDR=:8099 go run .");

  // launchBrowser 负责 pkill 残留、临时 profile 和等 CDP 端口；收尾还在下面的 finally。
  const session = await launchBrowser({ debugPort: DEBUG_PORT, keep: argPresent("--keep") });
  const browser = session.browser;
  try {
    console.log(`\nLAN transfer E2E against ${BASE}`);

    await authLandingScenario(browser);
    await appsHierarchyScenario(browser);
    await pricingHierarchyScenario(browser);
    await mobileRelayFallbackScenario(browser);
    await smallMessageCapScenario(browser);

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

    // The picker must be claimed by exactly one label — the visible action that
    // names it. The peer card used to be a second `<label for>` for the same
    // input, which is what axe reports as form-field-multiple-labels: the name
    // then depends on which of the two a given AT happens to prefer.
    const fileAction = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const action = input?.parentElement;
      const card = document.querySelector('.peer .pcard');
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
        labelCount: input?.labels?.length ?? -1,
        labelIsAction: input?.labels?.[0] === action,
        cardTag: card?.tagName || '',
        cardFor: card?.getAttribute('for') || '',
        cardTabbable: !!card?.querySelector('a[href], button, input, select, textarea, [tabindex]'),
        cardIsTabStop: card?.matches('a[href], button, input, select, textarea, [tabindex]') || false,
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
      fileAction.labelCount !== 1 || !fileAction.labelIsAction ||
      fileAction.cardTag !== "DIV" || fileAction.cardFor !== "" ||
      fileAction.cardTabbable || fileAction.cardIsTabStop || !fileAction.inputId ||
      fileAction.messageButtons !== 1 || fileAction.labelRects.some((n) => n !== 1) ||
      fileAction.iconSvgs.length !== 3 || fileAction.iconSvgs.some((n) => n !== 1) ||
      fileAction.iconText.some(Boolean)
    ) {
      throw new Error(`peer file-action accessibility contract failed: ${JSON.stringify(fileAction)}`);
    }
    ok("the peer file action was the picker's one label and its visible accessible name");

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

    // Losing the `<label for>` must not lose the shortcut it paid for: the whole
    // card and the visible action both still activate the same one input. The
    // guard counts that activation and cancels it — letting a real file chooser
    // open would block this tab for the rest of the run.
    const forwardingTargets = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const card = document.querySelector('.peer .pcard');
      const action = document.querySelector('.peer-actions .pa-files');
      const center = (el) => {
        const r = el?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      };
      window.__peerPickerHits = 0;
      window.__peerPickerGuard = (e) => { window.__peerPickerHits++; e.preventDefault(); };
      input.addEventListener('click', window.__peerPickerGuard, true);
      return { card: center(card), action: center(action), cardNestsInput: card.contains(input) };
    })()`);
    if (!forwardingTargets.card || !forwardingTargets.action || forwardingTargets.cardNestsInput) {
      throw new Error(`peer pointer targets were not rendered independently: ${JSON.stringify(forwardingTargets)}`);
    }
    const trustedClick = async ({ x, y }) => {
      await sender.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sender.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await sender.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    };
    await trustedClick(forwardingTargets.card);
    const afterCard = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const action = input?.parentElement;
      return {
        hits: window.__peerPickerHits,
        focused: document.activeElement === input,
        focusVisible: input?.matches(':focus-visible') || false,
        actionRing: action?.matches(':has(> .file-pick-input:focus-visible)') || false,
      };
    })()`);
    await trustedClick(forwardingTargets.action);
    const afterAction = await sender.evaluate("window.__peerPickerHits");
    const forwarding = await sender.evaluate(`(() => {
      const input = document.querySelector('.peer-actions .pa-files > .file-pick-input');
      const card = document.querySelector('.peer .pcard');
      const beforeSelection = window.__peerPickerHits;
      // A click that only ends a selection drag over the peer name must not open
      // a chooser — the <label> this replaced suppressed that activation itself.
      const range = document.createRange();
      range.selectNodeContents(card.querySelector('.pname'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      card.click();
      const viaSelectionDrag = window.__peerPickerHits - beforeSelection;
      sel.removeAllRanges();
      card.click();
      const afterSelectionCleared = window.__peerPickerHits - beforeSelection - viaSelectionDrag;
      input.removeEventListener('click', window.__peerPickerGuard, true);
      delete window.__peerPickerGuard;
      delete window.__peerPickerHits;
      return { viaSelectionDrag, afterSelectionCleared };
    })()`);
    if (
      afterCard.hits !== 1 || !afterCard.focused || afterCard.focusVisible || afterCard.actionRing ||
      afterAction - afterCard.hits !== 1 ||
      forwarding.viaSelectionDrag !== 0 || forwarding.afterSelectionCleared !== 1 ||
      forwardingTargets.cardNestsInput
    ) {
      throw new Error(`peer pointer shortcut contract failed: ${JSON.stringify({ afterCard, viaAction: afterAction - afterCard.hits, ...forwarding })}`);
    }
    ok(
      "both the whole peer card and its visible action still open the same picker on pointer input" +
      " (card focus retained without a keyboard-only ring)",
    );

    // Scoped at the peer list rather than the document: this is a named check on
    // one control, added next to the structural assertions above. The full-page
    // live scans elsewhere in this file keep their document scope.
    const peerAxe = await scanLiveState(sender, "peer card with the primary file picker", { context: ".peers" });
    // scanLiveState already throws on every violation. This explicit check is for
    // the rule's current incomplete/manual-review classification.
    const multiLabel = peerAxe.incomplete.filter((r) => r.id === "form-field-multiple-labels");
    if (multiLabel.length) {
      throw new Error(`the primary picker is still claimed by more than one label: ${JSON.stringify(multiLabel)}`);
    }

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

    // A long manifest used to reveal a zero-height marker at the request card's
    // top. The marker could already be visible while the capped, scrollable file
    // list still pushed the actual SAS and consent buttons below the phone fold.
    // Exercise that exact edge before the byte-integrity transfer, then reject it
    // so the established single-file payload remains independently verifiable.
    await setWideViewport(sender, 390, 844);
    await setWideViewport(receiver, 390, 844);
    await sender.evaluate(`(() => {
      const input = document.querySelector('.file-pick-input');
      if (!input) throw new Error('no file input for long-manifest visibility check');
      const dt = new DataTransfer();
      for (let i = 0; i < 40; i++) {
        dt.items.add(new File(
          ['x'],
          'verification-boundary-' + String(i).padStart(2, '0') + '-with-a-deliberately-long-name.txt',
          { type: 'text/plain' },
        ));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await receiver.waitFor("!!document.querySelector('.request .sas code')", "the long-manifest mobile SAS", 40_000);
    const longManifestLayout = await receiver.evaluate(`(() => {
      const card = document.querySelector('.request');
      const sas = card.querySelector('.sas').getBoundingClientRect();
      const actions = [...card.querySelectorAll('button')].map((el) => el.getBoundingClientRect());
      return {
        files: card.querySelectorAll('.filelist li').length,
        sas: { top: sas.top, bottom: sas.bottom },
        actionBottoms: actions.map((r) => r.bottom),
        viewport: window.visualViewport?.height ?? innerHeight,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    if (
      longManifestLayout.files !== 40 ||
      longManifestLayout.sas.top < 0 || longManifestLayout.sas.bottom > longManifestLayout.viewport ||
      longManifestLayout.actionBottoms.some((n) => n > longManifestLayout.viewport) ||
      longManifestLayout.overflow !== 0
    ) {
      throw new Error(`long-manifest mobile verification visibility failed: ${JSON.stringify(longManifestLayout)}`);
    }
    await receiver.evaluate(`(() => {
      const reject = document.querySelector('.request .btn-ghost');
      if (!reject) throw new Error('long-manifest reject action missing');
      reject.click();
      return true;
    })()`);
    await receiver.waitFor("!document.querySelector('.request')", "the rejected long manifest to close");
    await sender.waitFor("!!document.querySelector('.xfer .x:not(.cancel)')", "the sender to observe long-manifest rejection");
    ok("a 40-file request kept its SAS and consent actions inside the 390px viewport");

    // ── 发送：真的往那个 file input 里塞一个文件（CDP 的原生入口）──────────
    // Reproduce the phone flow that motivated this batch. The initiating picker
    // begins below the first viewport; once the exchange gains a SAS, both sides
    // must promote the activity card and reveal its security step.
    await setWideViewport(sender, 390, 844);
    await setWideViewport(receiver, 390, 844);
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
    await sender.waitFor("!!document.querySelector('.xfer .status code')", "the sender's mobile file SAS");
    await receiver.waitFor("!!document.querySelector('.request .sas code')", "the receiver's mobile file SAS");
    const mobileFileGeometry = async (tab, selector) => tab.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(selector)});
      const peers = document.querySelector('.peers');
      const sas = card.querySelector('.sas, .status').getBoundingClientRect();
      const actions = [...card.querySelectorAll('button')].map((el) => el.getBoundingClientRect());
      return {
        card: (() => { const r = card.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })(),
        sas: { top: sas.top, bottom: sas.bottom },
        actionBottoms: actions.map((r) => r.bottom),
        cardBeforePeers: !!(card.compareDocumentPosition(peers) & Node.DOCUMENT_POSITION_FOLLOWING),
        activityFocused: card.contains(document.activeElement),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewport: window.visualViewport?.height ?? innerHeight,
        announcement: document.querySelector('.activity-announcement')?.textContent ?? '',
      };
    })()`);
    const mobileFile = {
      sender: await mobileFileGeometry(sender, ".xfer"),
      receiver: await mobileFileGeometry(receiver, ".request"),
    };
    for (const [who, layout] of Object.entries(mobileFile)) {
      if (
        layout.sas.top < 0 || layout.sas.bottom > layout.viewport ||
        layout.actionBottoms.some((n) => n > layout.viewport) ||
        !layout.cardBeforePeers || layout.activityFocused || layout.overflow !== 0 ||
        !/\d{6}/.test(layout.announcement)
      ) {
        throw new Error(`${who} mobile file verification visibility failed: ${JSON.stringify(layout)}`);
      }
    }
    ok("both 390px file views promoted SAS/consent before peers without focusing an action");

    // Continue the large-payload correctness checks in the established wide
    // workspace so this addition does not reduce the existing desktop coverage.
    await setWideViewport(sender);
    await setWideViewport(receiver);
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

    // 同意卡是整个产品里最要紧的一屏：用户在这里凭 SAS 决定要不要收下这些字节。
    await scanLiveState(receiver, "file consent card (pre-accept)");

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
    await mobileNoPickerScenario(browser);
    await sleep(1000);
    await desktopPickerCancelScenario(browser);
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
    await session.close();
  }
}

await withWatchdog("LAN transfer E2E", GLOBAL_TIMEOUT_MS, main);
