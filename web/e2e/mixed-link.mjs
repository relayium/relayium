#!/usr/bin/env node
/**
 * 端到端：两个真标签页之间跑一条真的 **统一链路**（`link/1`）。
 *
 * 这一套是**选择性**的，不在 `npm run test:e2e` 里，因为 link/1 还没被任何发行构建
 * 通告。它需要一个专门用这个能力构建出来的产物：
 *
 *   cd web    && npm run build:link-e2e                       # → web/dist-link-e2e
 *   cd server && RELAYIUM_STATIC=../web/dist-link-e2e RELAYIUM_ADDR=:8098 go run .
 *   cd web    && npm run test:e2e:mixed                       # 默认 --url :8098
 *
 * 那个构建旗标（peer-caps.svelte.ts 的 VITE_RELAYIUM_LINK_E2E）是 link/1 唯一的
 * 开关，而且是**构建期**的：默认产物把它折叠成 false，页面里没有任何查询参数、
 * 存储项或全局函数能把它打开。产物也刻意不叫 dist/，免得哪次部署顺手把它捡走。
 *
 * 脚本一上来就先确认自己确实指着那个产物（读页面真正发出去的名册通告）。不做这件事的
 * 话，"拿错了 dist" 会伪装成 "链路建不起来" —— 一条看起来像回归的假红。
 *
 * 覆盖的是单元测试碰不到的那一段：真 caps → 真 link 请求/应答 → 真 commit-reveal →
 * 一条 PeerConnection 上的两条 DataChannel → 文件与消息两条通道各自的同意状态机 →
 * 统一工作区的呈现规矩（一条链路一个 SAS）→ 显式断开。
 *
 * 只桩掉一样东西，和 lan-transfer 一样：操作系统的"另存为"对话框。
 *
 * 用法：node e2e/mixed-link.mjs [--url http://localhost:8098] [--keep] [--screenshots [dir]]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OBSERVE_CAPS, SAVE_STUB, argFlag, argPresent, fail, launchBrowser, newTab, ok,
  requireServer, setWideViewport, withWatchdog,
} from "./harness.mjs";

const BASE = argFlag("--url", "http://localhost:8098");
// 和 lan-transfer 的 9444 分开：两套用例各自 pkill 自己那一个端口的残留浏览器，
// 谁也别顺手打死对方。
const DEBUG_PORT = 9445;
const GLOBAL_TIMEOUT_MS = 12 * 60_000;

// `--screenshots` 可以不带值（用默认目录），也可以带一个目录名；跟在它后面的另一个
// 开关不算目录名。截图是**证据**，不是断言：每一条几何规矩下面都有真断言钉着。
const shotsArg = argPresent("--screenshots") ? argFlag("--screenshots", "") : null;
const SHOTS = shotsArg === null || !shotsArg || shotsArg.startsWith("--")
  ? (shotsArg === null ? null : "e2e-screenshots")
  : shotsArg;

/** 正文里每一个字符都有理由：前导空格 + tab、缩进块、空行、CJK、阿拉伯语（RTL）、
 *  星平面 emoji、行尾空格。任何一层做了 trim/规范化/折叠，都在这里现形。 */
const MSG_BODY = "  \tif x:\n\n\t\tprint('\u4f60\u597d \u0645\u0631\u062d\u0628\u0627 \ud83c\udf0d')\n   \n  trailing   ";
const utf8Hex = (s) => [...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0")).join("");

/** 唯一的 <button>：文件/文件夹那两个是 <label>。结构选择器，九种语言和换图标都打不断。 */
const MSG_OPEN_BTN = ".peer-actions button";
const FILE_INPUT = ".peer-actions .pa-files > .file-pick-input";
const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const TRACK_PEER_CONNECTIONS = `
  window.__e2ePeerConnections = [];
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(Target, args, NewTarget) {
      const pc = Reflect.construct(Target, args, NewTarget);
      window.__e2ePeerConnections.push(pc);
      return pc;
    },
  });
`;

let shotIndex = 0;
async function screenshot(tab, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = join(SHOTS, `${String(++shotIndex).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`      ↳ ${file}`);
}

/**
 * 一条链路一个 SAS —— 这套 UI 最核心的一条规矩，所以它是一个可以在每个阶段复用的断言。
 *
 * 不是"头部有一个 SAS"就完事：真正会出错的是**别处又冒出来一个**。所以数的是整页的
 * `.sas`，并且分别点名文件卡、请求卡和消息面板里那三个历史渲染点必须是零。路径徽标
 * 同理：一条链路只有一条路径，标签也只该有一个。
 */
async function oneSas(tab, who, where) {
  const seen = await tab.evaluate(`(() => {
    const heads = [...document.querySelectorAll('${HEAD}')];
    const all = [...document.querySelectorAll('.sas')];
    const code = document.querySelector('${HEAD_SAS}');
    return {
      heads: heads.length,
      sasTotal: all.length,
      sasOutsideHead: all.filter((el) => !heads.some((h) => h.contains(el))).length,
      laneSas: document.querySelectorAll('.msgpanel .sas, .request .sas').length,
      xferCodes: document.querySelectorAll('.xfer .status code').length,
      paths: document.querySelectorAll('.path').length,
      pathsOutsideHead: [...document.querySelectorAll('.path')]
        .filter((el) => !heads.some((h) => h.contains(el))).length,
      code: code ? code.textContent.trim() : '',
    };
  })()`);
  if (
    seen.heads !== 1 || seen.sasTotal !== 1 || seen.sasOutsideHead !== 0 ||
    seen.laneSas !== 0 || seen.xferCodes !== 0 || seen.pathsOutsideHead !== 0 ||
    seen.paths > 1 || !/^\d{6}$/.test(seen.code)
  ) {
    throw new Error(`${who} showed more than one verification surface ${where}: ${JSON.stringify(seen)}`);
  }
  return seen.code;
}

/** 手机上"下一步要做的事"必须在第一屏里，而且不能横向溢出。 */
async function mobileDecisionVisible(tab, who, cardSelector, label) {
  const layout = await tab.evaluate(`(() => {
    const head = document.querySelector('${HEAD}');
    const card = document.querySelector(${JSON.stringify(cardSelector)});
    if (!head || !card) throw new Error('missing ${cardSelector} or the workspace header');
    const sas = head.querySelector('.sas').getBoundingClientRect();
    const headBox = head.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const peers = document.querySelector('.peers');
    const actions = [...card.querySelectorAll('button')].map((el) => el.getBoundingClientRect());
    return {
      sas: { top: sas.top, bottom: sas.bottom },
      // The whole point of measuring the header: the revealed card must land
      // BELOW the pinned box, not behind it. A stale hardcoded reserve shows up
      // here as a card whose top is tucked under the header.
      cardBehindHead: cardBox.top < headBox.bottom - 1,
      headHeightPx: headBox.height,
      actionBottoms: actions.map((r) => r.bottom),
      actionCount: actions.length,
      headBeforeCard: !!(head.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
      cardBeforePeers: !peers || !!(card.compareDocumentPosition(peers) & Node.DOCUMENT_POSITION_FOLLOWING),
      activityFocused: card.contains(document.activeElement) || head.contains(document.activeElement),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewport: window.visualViewport?.height ?? innerHeight,
      announcement: document.querySelector('.activity-announcement')?.textContent ?? '',
      // 失败时最需要知道的是"高度花在哪儿了"和"页面到底滚没滚"。没有这几个数，
      // 一条 "actionBottoms 超了 35px" 只能靠猜。
      parts: {
        scrollY,
        headHeight: head.getBoundingClientRect().height,
        noteHeight: head.querySelector('.wh-note')?.getBoundingClientRect().height ?? 0,
        sasHeight: sas.height,
        cardTop: card.getBoundingClientRect().top,
        cardHeight: card.getBoundingClientRect().height,
      },
    };
  })()`);
  if (
    layout.sas.top < 0 || layout.sas.bottom > layout.viewport ||
    layout.actionCount === 0 || layout.actionBottoms.some((n) => n > layout.viewport) ||
    !layout.headBeforeCard || !layout.cardBeforePeers || layout.cardBehindHead ||
    layout.activityFocused || layout.overflow !== 0
  ) {
    throw new Error(`${who} ${label} was not decidable inside a 390px viewport: ${JSON.stringify(layout)}`);
  }
  return layout;
}

const setLocale = async (tab, code) => {
  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    select.value = ${JSON.stringify(code)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} locale to render`);
};

const setTheme = async (tab, value) => {
  await tab.evaluate(`(() => {
    const select = document.querySelector('select.theme');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  // "system" 是**移除**属性，不是把属性设成 "system"（见 theme.svelte.ts）——
  // 照着字面等一个 data-theme="system" 会永远等不到。
  await tab.waitFor(
    value === "system"
      ? "!document.documentElement.hasAttribute('data-theme')"
      : `document.documentElement.getAttribute('data-theme') === ${JSON.stringify(value)}`,
    `the ${value} theme to apply`,
  );
  // 换主题会挂 320ms 的 .theme-anim 交叉淡入（app.css）。在它还开着的时候读
  // getComputedStyle，读到的是**插值中**的颜色：第一版就这样把 #fff → #1c1d25 中间的
  // rgb(199,199,201) 当成了"深色背景"验过了。等它落定再读，也让截图是稳定的那一帧。
  await tab.waitFor(
    "!document.documentElement.classList.contains('theme-anim')",
    `the ${value} theme cross-fade to settle`,
  );
};

async function mixedScenario(browser) {
  // A 发起，B 收（另存为被桩掉）。两边都装上只读的 caps 探针：跑任何断言之前先确认
  // 这个产物真的通告了 link/1。
  const a = await newTab(browser, BASE + "/", OBSERVE_CAPS + TRACK_PEER_CONNECTIONS);
  const b = await newTab(browser, BASE + "/", OBSERVE_CAPS + SAVE_STUB + TRACK_PEER_CONNECTIONS);
  await setWideViewport(a, 390, 844);
  await setWideViewport(b, 390, 844);

  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await a.waitFor(peersSeen, "tab A to see tab B on the radar", 30_000);
  await b.waitFor(peersSeen, "tab B to see tab A on the radar", 30_000);

  for (const [who, tab] of [["A", a], ["B", b]]) {
    await tab.waitFor("Array.isArray(window.__advertisedCaps)", `tab ${who} to announce its capabilities`, 30_000);
    const advertised = await tab.evaluate("window.__advertisedCaps");
    if (!advertised.includes("link/1")) {
      throw new Error(
        `tab ${who} advertised ${JSON.stringify(advertised)} — this build does not enable link/1.\n` +
        `    Point --url at a link-enabled build, not the default dist:\n` +
        `      cd web    && npm run build:link-e2e\n` +
        `      cd server && RELAYIUM_STATIC=../web/dist-link-e2e RELAYIUM_ADDR=:8098 go run .`,
      );
    }
  }
  ok("both tabs advertised link/1 from the opt-in build and discovered each other");

  // ── 一、一批文件把链路建起来，并且是**一条**链路 ─────────────────────────
  // 40 个长名字的小文件：既是"建链"的动作，也顺手把长内容列表铺出来，好在下面检查
  // 粘性头部。
  await a.evaluate(`(() => {
    const input = document.querySelector('${FILE_INPUT}');
    if (!input) throw new Error('no file input on the peer card');
    const dt = new DataTransfer();
    for (let i = 0; i < 40; i++) {
      dt.items.add(new File(
        ['x'],
        'unified-workspace-' + String(i).padStart(2, '0') + '-with-a-deliberately-long-name.txt',
        { type: 'text/plain' },
      ));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab A's unified workspace header", 45_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's unified workspace header", 45_000);
  await b.waitFor("!!document.querySelector('.request')", "tab B's file consent card", 45_000);

  const sasA = await oneSas(a, "tab A", "while a file batch awaits consent");
  const sasB = await oneSas(b, "tab B", "while a file batch awaits consent");
  if (sasA !== sasB) throw new Error(`link SAS mismatch: ${sasA} vs ${sasB}`);
  ok(`one link, one SAS on both tabs (${sasA}) — no lane card repeated it`);

  // 头部说清楚"和谁、什么状态、走哪条路"，并且带着显式断开。
  const headContract = await b.evaluate(`(() => {
    const head = document.querySelector('${HEAD}');
    return {
      labelled: !!head.getAttribute('aria-label'),
      peer: head.querySelector('.wh-peer')?.textContent?.trim() ?? '',
      state: head.querySelector('.wh-state')?.textContent?.trim() ?? '',
      paths: head.querySelectorAll('.path').length,
      disconnect: head.querySelectorAll('.wh-disconnect').length,
      sticky: getComputedStyle(head).position,
    };
  })()`);
  if (
    !headContract.labelled || !headContract.peer || !headContract.state ||
    headContract.disconnect !== 1 || headContract.sticky !== "sticky"
  ) {
    throw new Error(`workspace header contract failed: ${JSON.stringify(headContract)}`);
  }
  await b.waitFor(`document.querySelectorAll('${HEAD} .path').length === 1`, "the header's single path badge", 20_000);
  ok("the header named the peer, the link state, one path and one explicit disconnect");

  const fileEdge = await mobileDecisionVisible(b, "tab B", ".request", "a 40-file consent card");
  // 这条链路的第一个同意边，读屏器必须听到那六位码。
  if (!fileEdge.announcement.includes(sasB)) {
    throw new Error(`the first consent edge never announced the link code: ${JSON.stringify(fileEdge.announcement)}`);
  }
  await screenshot(b, "mobile-file-consent");
  ok("a 40-file consent card stayed decidable inside a 390px viewport and announced the code");

  // ── 二、粘性：长列表滚下去，唯一的 SAS 不能滚出验证语境 ───────────────────
  // 只滚固定的一段，不滚到页面最底下：滚出粘性头部的包含块之后它本来就该松开，那时
  // 再断言"还钉着"测的就不是这条规矩了。300px 足够证明区别——一个不粘的头部这时
  // 会在 top ≈ -300 的地方。
  const SCROLL_BY = 300;
  const sticky = await b.evaluate(`(() => {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - innerHeight;
    const before = scrollY;
    scrollBy(0, ${SCROLL_BY});
    const head = document.querySelector('${HEAD}').getBoundingClientRect();
    const sas = document.querySelector('${HEAD} .sas').getBoundingClientRect();
    return {
      scrollable,
      moved: scrollY - before,
      headTop: head.top,
      sasTop: sas.top,
      sasBottom: sas.bottom,
      viewport: innerHeight,
    };
  })()`);
  if (sticky.moved < SCROLL_BY - 1) {
    throw new Error(`the 40-file workspace only scrolled ${sticky.moved}px; the sticky check proves nothing: ${JSON.stringify(sticky)}`);
  }
  if (sticky.headTop < -1 || sticky.sasTop < 0 || sticky.sasBottom > sticky.viewport) {
    throw new Error(`the sole SAS scrolled out of its verification context: ${JSON.stringify(sticky)}`);
  }
  await screenshot(b, "sticky-header-scrolled");
  await b.evaluate("scrollTo(0, 0); true");
  ok("the sole SAS stayed pinned after scrolling a long file manifest");

  // ── 三、传输中再选文件 → 可见、可取消的队列，而不是被禁用的控件 ───────────
  await a.evaluate(`(() => {
    const input = document.querySelector('${FILE_INPUT}');
    const dt = new DataTransfer();
    dt.items.add(new File(['queued-one'], 'queued-one.txt', { type: 'text/plain' }));
    dt.items.add(new File(['queued-two'], 'queued-two.txt', { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await a.waitFor("!!document.querySelector('.queued')", "tab A's visible outbound queue", 20_000);
  const queue = await a.evaluate(`(() => {
    const card = document.querySelector('.queued');
    const input = document.querySelector('${FILE_INPUT}');
    return {
      rows: card.querySelectorAll('li').length,
      cancels: card.querySelectorAll('.queued-cancel').length,
      names: [...card.querySelectorAll('.fname')].map((el) => el.textContent.trim()),
      // 关键：选了新文件之后，文件控件仍然是可用的 —— 排队正是为了不禁用它。
      pickerDisabled: !!input.disabled,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  if (queue.rows !== 1 || queue.cancels !== 1 || queue.pickerDisabled || queue.overflow !== 0
    || !queue.names[0].includes("queued-one")) {
    throw new Error(`queued-batch contract failed: ${JSON.stringify(queue)}`);
  }
  await oneSas(a, "tab A", "while a batch is queued");
  await a.evaluate("(() => { document.querySelector('.queued .queued-cancel').click(); return true; })()");
  await a.waitFor("!document.querySelector('.queued')", "the cancelled queue entry to disappear");
  ok("a second selection queued visibly, kept the picker usable and cancelled by id");

  // ── 四、文件同意可以拒绝，而链路活下来 ──────────────────────────────────
  await b.evaluate(`(() => {
    const reject = document.querySelector('.request .btn-ghost');
    if (!reject) throw new Error('no decline action on the consent card');
    reject.click();
    return true;
  })()`);
  await b.waitFor("!document.querySelector('.request')", "the rejected file request to close");
  await a.waitFor(
    "!!document.querySelector('.xfer') && !document.querySelector('.xfer .progress-bar')",
    "tab A's batch to reach a terminal state after the rejection",
    40_000,
  );
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const alive = await tab.evaluate(`document.querySelectorAll('${HEAD}').length`);
    if (alive !== 1) throw new Error(`${who} tore the link down over one rejected batch (${alive} headers)`);
    await oneSas(tab, who, "after a rejected file batch");
  }
  ok("declining a file batch ended the batch and left the one link open");

  // ── 五、真传输断线后从 durable checkpoint 续传，不重新同意 ───────────────
  const RESUME_BYTES = 5 * 1024 * 1024 + 73;
  await b.evaluate(`(() => {
    window.__e2e.chunks = [];
    window.__e2e.bytes = 0;
    window.__e2e.closed = false;
    window.__e2e.name = '';
    window.__e2e.opens = 0;
    window.__e2e.writeDelayMs = 20;
    return true;
  })()`);
  await a.evaluate(`(() => {
    const input = document.querySelector('${FILE_INPUT}');
    const body = new Uint8Array(${RESUME_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) % 251;
    const dt = new DataTransfer();
    dt.items.add(new File([body], 'resume-on-the-same-link.bin'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await b.waitFor("!!document.querySelector('.request')", "the resumable file consent card", 40_000);
  await b.evaluate("(() => { document.querySelector('.request .btn-primary').click(); return true; })()");
  await b.waitFor(
    "window.__e2e.bytes >= 393216 && !window.__e2e.closed",
    "at least two durable chunks before the forced transport gap",
    40_000,
  );
  const pcCounts = {
    a: await a.evaluate("window.__e2ePeerConnections.length"),
    b: await b.evaluate("window.__e2ePeerConnections.length"),
  };
  // This is a transport failure, not the product's explicit disconnect button:
  // both managers must hold the authenticated link and rebuild its two channels.
  // Chrome's direct pc.close() closes DataChannels but does not dispatch the
  // connectionstatechange event a real terminal network path emits, so invoke
  // the already-installed native handler after connectionState becomes closed.
  await Promise.all([
    a.evaluate("(() => { const pc = window.__e2ePeerConnections.at(-1); pc.close(); pc.onconnectionstatechange?.(); return true; })()"),
    b.evaluate("(() => { const pc = window.__e2ePeerConnections.at(-1); pc.close(); pc.onconnectionstatechange?.(); return true; })()"),
  ]);
  await a.waitFor(
    "document.querySelector('.xfer .status')?.textContent.includes('resume')",
    "the sender to visibly enter resume",
    20_000,
  );
  await b.waitFor(
    "document.querySelector('.xfer .status')?.textContent.includes('resume')",
    "the receiver to visibly enter resume",
    20_000,
  );
  await b.waitFor(
    `window.__e2e.closed && window.__e2e.bytes === ${RESUME_BYTES}`,
    "the resumed destination to close at the exact declared size",
    90_000,
  );
  await a.waitFor(
    "!!document.querySelector('.xfer.ok') && !document.querySelector('.xfer .progress-bar')",
    "the resumed sender to complete",
    40_000,
  );
  const resumed = await b.evaluate(`(() => {
    let offset = 0;
    let mismatch = -1;
    for (const chunk of window.__e2e.chunks) {
      for (let i = 0; i < chunk.length; i++, offset++) {
        if (mismatch < 0 && chunk[i] !== (offset * 31 + 7) % 251) mismatch = offset;
      }
    }
    return {
      bytes: window.__e2e.bytes,
      opens: window.__e2e.opens,
      closed: window.__e2e.closed,
      mismatch,
      requests: document.querySelectorAll('.request').length,
      peerConnections: window.__e2ePeerConnections.length,
    };
  })()`);
  const senderPcs = await a.evaluate("window.__e2ePeerConnections.length");
  if (
    resumed.bytes !== RESUME_BYTES || resumed.opens !== 1 || !resumed.closed ||
    resumed.mismatch !== -1 || resumed.requests !== 0
  ) {
    throw new Error(`byte-resume contract failed: ${JSON.stringify({ ...resumed, before: pcCounts })}`);
  }
  // The point of this scene is that the bytes crossed a *new* transport. Without
  // this assertion a run where the forced close never actually killed either
  // PeerConnection would still pass every check above, and the whole scenario
  // would quietly degrade into a plain uninterrupted transfer.
  if (senderPcs <= pcCounts.a || resumed.peerConnections <= pcCounts.b) {
    throw new Error(`no replacement PeerConnection was built: ${JSON.stringify({
      a: { before: pcCounts.a, after: senderPcs },
      b: { before: pcCounts.b, after: resumed.peerConnections },
    })}`);
  }
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const code = await oneSas(tab, who, "after a byte-level file resume");
    if (code !== sasA) throw new Error(`${who} changed SAS while resuming: ${code} vs ${sasA}`);
  }
  ok(`a ${RESUME_BYTES}-byte file resumed exactly on rebuilt PeerConnections `
    + `(A ${pcCounts.a}→${senderPcs}, B ${pcCounts.b}→${resumed.peerConnections}), `
    + "with one picker and unchanged SAS");

  // ── 六、同一条链路上开消息：同意后真的收发正文 ───────────────────────────
  await a.evaluate(`(() => {
    const button = document.querySelector('${MSG_OPEN_BTN}');
    if (!button) throw new Error('no message control on the peer card');
    button.focus();
    button.click();
    return true;
  })()`);
  await b.waitFor("!!document.querySelector('.msgpanel')", "tab B's message request", 40_000);
  const beforeConsent = await b.evaluate(`({
    bodies: document.querySelectorAll('.msg-body').length,
    composer: document.querySelectorAll('.msgpanel textarea').length,
    panelSas: document.querySelectorAll('.msgpanel .sas').length,
  })`);
  if (beforeConsent.bodies !== 0 || beforeConsent.composer !== 0 || beforeConsent.panelSas !== 0) {
    throw new Error(`text consent card leaked content or a second code: ${JSON.stringify(beforeConsent)}`);
  }
  await oneSas(b, "tab B", "on the text consent card");
  const textEdge = await mobileDecisionVisible(b, "tab B", ".msgpanel", "a text consent card");
  // 同一条链路的第二条通道：这条边要announce它自己，但**不能**再把码念一遍——码
  // 一直挂在钉住的头部里。这正是那条"每条链路只念一次"的规矩，在真浏览器里验它。
  if (!textEdge.announcement) throw new Error("the text consent edge announced nothing at all");
  if (textEdge.announcement.includes(sasB)) {
    throw new Error(`the second lane re-announced the same link's code: ${JSON.stringify(textEdge.announcement)}`);
  }
  await screenshot(b, "mobile-text-consent");
  ok("the second lane consented under the same SAS without re-reading it aloud");

  await b.evaluate("(() => { document.querySelector('.msgpanel .act button.btn-primary').click(); return true; })()");
  await a.waitFor("!!document.querySelector('.msgpanel textarea')", "tab A's composer (session open)", 40_000);
  await b.waitFor("!!document.querySelector('.msgpanel textarea')", "tab B's composer (session open)");

  // 三步，不是一步：`disabled` 是从 draft 派生出来的，而 Svelte 的更新是批处理的 ——
  // 在派发 input 的**同一个**同步块里读 btn.disabled，读到的是上一帧的值。
  await a.evaluate(`(() => {
    const ta = document.querySelector('.msgpanel textarea');
    ta.value = ${JSON.stringify(MSG_BODY)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // 字节计数器必须跟着动 —— 它显示的就是限制在比的那个数。
  const counted = await a.evaluate("(() => { const c = document.querySelector('.byte-count'); return c ? c.textContent : ''; })()");
  if (!counted) throw new Error("the byte counter is missing from the composer");
  await a.waitFor(
    "!document.querySelector('.msgpanel button.send').disabled",
    "send to be enabled for a body inside the limit",
    10_000,
  );
  await a.evaluate("(() => { document.querySelector('.msgpanel button.send').click(); return true; })()");
  await b.waitFor("document.querySelectorAll('.msg-body').length >= 1", "tab B to render the message", 40_000);
  const gotHex = await b.evaluate(`(() => {
    const bytes = new TextEncoder().encode(document.querySelector('.msg-body').textContent);
    return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  })()`);
  if (gotHex !== utf8Hex(MSG_BODY)) {
    throw new Error(`message body is not byte-identical\n      got  ${gotHex}\n      want ${utf8Hex(MSG_BODY)}`);
  }
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const code = await oneSas(tab, who, "with both lanes used on one link");
    if (code !== sasA) throw new Error(`${who} changed the link SAS mid-session: ${code} vs ${sasA}`);
  }
  ok(`text was exchanged byte-identically on the same link, still under one SAS (${sasA})`);

  // ── 七、320px、RTL 和深色：最窄的屏幕上头部仍然是可读、可操作、不溢出的 ────
  const painted = {};
  for (const variant of [
    { name: "320-ltr-light", width: 320, locale: "en", theme: "light", rtl: false },
    { name: "320-rtl-dark", width: 320, locale: "ar", theme: "dark", rtl: true },
    { name: "390-rtl-dark", width: 390, locale: "ar", theme: "dark", rtl: true },
  ]) {
    await setWideViewport(b, variant.width, 568);
    await setLocale(b, variant.locale);
    await setTheme(b, variant.theme);
    await b.waitFor(
      `document.documentElement.dir === ${JSON.stringify(variant.rtl ? "rtl" : "ltr")}`,
      `${variant.name} writing direction`,
    );
    const layout = await b.evaluate(`(() => {
      const head = document.querySelector('${HEAD}');
      const rect = head.getBoundingClientRect();
      const sas = head.querySelector('.sas').getBoundingClientRect();
      const dc = head.querySelector('.wh-disconnect').getBoundingClientRect();
      const panel = document.querySelector('.msgpanel');
      const rtl = document.documentElement.dir === 'rtl';
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        headOverflow: head.scrollWidth - head.clientWidth,
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 0,
        inside: rect.left >= -1 && rect.right <= innerWidth + 1,
        sasInside: sas.left >= -1 && sas.right <= innerWidth + 1 && sas.top >= 0,
        disconnectInside: dc.left >= -1 && dc.right <= innerWidth + 1 && dc.height >= 24,
        // 行尾就是"逻辑上的末端"：LTR 靠右、RTL 靠左。这条断言是在证明镜像真的发生了，
        // 而不是布局用了写死的 left/right。
        disconnectAtRowEnd: rtl
          ? dc.left - rect.left < rect.right - dc.right
          : rect.right - dc.right < dc.left - rect.left,
        headBackground: getComputedStyle(head).backgroundColor,
        headText: getComputedStyle(head.querySelector('.wh-state')).color,
      };
    })()`);
    if (
      layout.pageOverflow !== 0 || layout.headOverflow > 1 || layout.panelOverflow > 1 ||
      !layout.inside || !layout.sasInside || !layout.disconnectInside || !layout.disconnectAtRowEnd
    ) {
      throw new Error(`${variant.name} workspace header layout failed: ${JSON.stringify(layout)}`);
    }
    // 一个不透明的背景不是装饰：这个头部会盖在下面的内容上滚动。
    if (/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(layout.headBackground)) {
      throw new Error(`${variant.name} sticky header had no opaque background: ${layout.headBackground}`);
    }
    painted[variant.theme] = { bg: layout.headBackground, fg: layout.headText };
    await oneSas(b, "tab B", `at ${variant.name}`);
    await screenshot(b, variant.name);
    ok(`${variant.name}: the header stayed inside the viewport, mirrored correctly and kept one SAS`);
  }
  // 不这么比的话，"深色"那一格其实什么也没验证：一个只有浅色 token 的头部同样能
  // 通过上面每一条几何断言。这一条要求深浅两套真的画出了不同的东西。
  if (painted.light.bg === painted.dark.bg || painted.light.fg === painted.dark.fg) {
    throw new Error(`the header painted identically in light and dark: ${JSON.stringify(painted)}`);
  }
  ok(`dark mode really repainted the header (bg ${painted.light.bg} → ${painted.dark.bg})`);
  await setLocale(b, "en");
  await setTheme(b, "system");
  await setWideViewport(b, 390, 844);

  // ── 八、一次"活过了自己那条链路"的待决同意 ──────────────────────────────
  //
  // 这一幕针对的是一个很具体的怀疑：App 的 revealReveal 去重键是
  // `file:recv:<peer>`，**不含**链路世代。同一个对端、同一条通道，第二条链路算出来
  // 的键和第一条一模一样。如果那个键在两条链路之间没被清掉，第二次认证边就会被
  // 整个吞掉——而被吞掉的恰恰是"这是一串新的验证码"这件事，且只有读屏用户会被影响。
  //
  // 所以这里刻意把请求**挂着不答**就断链：那是唯一能让旧键还留在手上的时刻。
  const pickOne = (name) => `(() => {
    const input = document.querySelector('${FILE_INPUT}');
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], ${JSON.stringify("")} + '${name}', { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  const announcementOf = "(document.querySelector('.activity-announcement')?.textContent ?? '')";

  await a.evaluate(pickOne("outlives-its-link.txt"));
  await b.waitFor("!!document.querySelector('.request')", "a second consent card on the same link", 40_000);
  const sameLinkEdge = await b.evaluate(announcementOf);
  // 同一条链路上的又一条边：码已经念过一次，而且一直挂在钉住的头部里，所以这里
  // 不该再念一遍。
  if (!sameLinkEdge || sameLinkEdge.includes(sasB)) {
    throw new Error(`a later edge on the SAME link re-read the code: ${JSON.stringify(sameLinkEdge)}`);
  }

  await a.evaluate(`(() => { document.querySelector('${HEAD} .wh-disconnect').click(); return true; })()`);
  // 这一步现在**很慢**，而且必须慢：B 手上挂着一张待决同意卡 = 该链路有活儿，所以
  // 传输一断 B 会把链路**留住**（status=interrupted）并等一个永远不会来的重建 offer
  // ——A 是显式断开的，它不会再发。等到 LINK_RECOVERY_WINDOW_MS(90s) 走完，B 才
  // 失败关闭。把这个超时调回 90s 会变成一场必现的竞态，不是把测试变快。
  // 顺带地，这一等也是"留住的链路确实有界、确实会自己收干净"在真浏览器里的唯一验证。
  await b.waitFor(`!document.querySelector('${HEAD}')`, "the held link to time out and die", 150_000);
  await b.waitFor("!document.querySelector('.request')", "the pending consent to die with its link");

  // 同一个对端、同一条通道 → 第二条链路会算出**同一个** reveal 键。
  await a.evaluate(pickOne("after-relink.txt"));
  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "a fresh link to the same peer", 60_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's fresh link header", 60_000);
  await b.waitFor("!!document.querySelector('.request')", "a consent card on the fresh link", 40_000);
  const sas2 = await oneSas(b, "tab B", "on a fresh link to the same peer");
  if (sas2 === sasB) {
    throw new Error(`the relink reused the first link's SAS (${sas2}); this scenario proves nothing`);
  }
  const freshEdge = await b.evaluate(announcementOf);
  if (!freshEdge.includes(sas2)) {
    throw new Error(
      `a NEW link's first consent edge never announced its code — the reveal key ` +
      `(peer+lane, no generation) suppressed it: ${JSON.stringify(freshEdge)} lacks ${sas2}`,
    );
  }
  ok(`a fresh link to the same peer announced its own code (${sasB} → ${sas2}), same reveal key`);

  await b.evaluate("(() => { document.querySelector('.request .btn-ghost').click(); return true; })()");
  await b.waitFor("!document.querySelector('.request')", "the fresh link's consent to close");

  // ── 九、显式断开：整个工作区收掉，两边都收掉 ────────────────────────────
  await a.evaluate(`(() => { document.querySelector('${HEAD} .wh-disconnect').click(); return true; })()`);
  await a.waitFor(`!document.querySelector('${HEAD}')`, "tab A's workspace to tear down");
  // 对端不是靠一帧"我要断开"知道的，而是靠传输真的塌掉（DTLS 关闭 / ICE 失联）。
  // 那一段有真实的传播时间，所以这里的窗口比本地那一条宽得多。
  await b.waitFor(`!document.querySelector('${HEAD}')`, "tab B's workspace to tear down", 90_000);
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const after = await tab.evaluate(`({
      sas: document.querySelectorAll('.sas').length,
      heads: document.querySelectorAll('${HEAD}').length,
      queued: document.querySelectorAll('.queued').length,
      composers: document.querySelectorAll('.msgpanel textarea').length,
      peerActions: document.querySelectorAll('.peer-actions').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    if (
      after.sas !== 0 || after.heads !== 0 || after.queued !== 0 ||
      after.composers !== 0 || after.peerActions === 0 || after.overflow !== 0
    ) {
      throw new Error(`${who} did not tear the workspace down cleanly: ${JSON.stringify(after)}`);
    }
  }
  await screenshot(a, "after-disconnect");
  ok("one disconnect closed both lanes on both tabs and left the peer selectable again");

  const errs = [...a.errors, ...b.errors].filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`console errors during the mixed link:\n    ${errs.join("\n    ")}`);
  ok("no console errors on either tab");

  await browser.send("Target.closeTarget", { targetId: a.targetId });
  await browser.send("Target.closeTarget", { targetId: b.targetId });
}

async function main() {
  await requireServer(
    BASE,
    "start the link-enabled build with: cd web && npm run build:link-e2e, then " +
    "cd server && RELAYIUM_STATIC=../web/dist-link-e2e RELAYIUM_ADDR=:8098 go run .",
  );
  const session = await launchBrowser({ debugPort: DEBUG_PORT, keep: argPresent("--keep") });
  try {
    console.log(`\nMixed link E2E against ${BASE}`);
    await mixedScenario(session.browser);
    console.log("\n\x1b[32mMixed link E2E passed\x1b[0m\n");
  } catch (err) {
    fail("Mixed link E2E", err);
  } finally {
    await session.close();
  }
}

await withWatchdog("Mixed link E2E", GLOBAL_TIMEOUT_MS, main);
