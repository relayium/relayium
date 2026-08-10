#!/usr/bin/env node
/**
 * 端到端：两个真标签页在**同一个配对码房间**里跑一条真的统一链路（`link/1`）。
 *
 *   cd web && npm run build && npm run test:e2e:code-room
 *
 * 为什么它必须存在：配对码房间过去**既不通告也不路由** `link/1`，那条策略只有确定性
 * 单元用例钉着（`peer-workspace.test.ts`），因为 CDP harness 加入不了一个真的配对码
 * 房间——`/api/pair` 铸码要一个登录且验证过的账号，ws 路由又会拒掉没被铸出来的码。
 * 现在这条路由的答案反过来了（DECISION-LOG 2026-08-10），而"反过来"这件事必须有一次
 * **真浏览器**的证明：默认可见的输入框、下面的发送文件/文件夹、一条链路一个 SAS、
 * 文本与文件走同一条连接、手机与 RTL 布局、以及断开之后的收尾。
 *
 * 会合与 ICE 由一份受控夹具提供（`code-room-fixture.mjs`），页面本身是原样的构建
 * 产物、跑原样的策略。**这条路径上没有 TURN**：中继凭据的有效期边界因此在这里一次
 * 都没跑到，那一半由 `src/lib/relay-deadline.test.ts` 和
 * `src/lib/mixed-link-lifecycle.test.ts` 确定性覆盖——真浏览器没有办法按需让一份
 * TURN 凭据在中途过期。这里证明的是**路由与界面**。
 *
 * 只桩掉一样浏览器的东西，和另外两套一样：操作系统的"另存为"对话框。
 *
 * 用法：node e2e/code-room.mjs [--keep] [--screenshots [dir]] [--port 4184]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SAVE_STUB, VERIFY_ON, argFlag, argPresent, fail, launchBrowser, newTab, ok,
  setWideViewport, startPreview, withWatchdog,
} from "./harness.mjs";
import {
  CODE_ROOM_ROUTES, CODE_ROOM_SIGNED_IN_ROUTES, codeRoomSignalingScript, pairMintScript,
} from "./code-room-fixture.mjs";
import { apiFixtureScript } from "./a11y-fixtures.mjs";
// 统一工作区的同意态同样是静态扫描器到不了的地方。哪一格长出了新的违规，都要在这里
// 当场红——配对码房间是这套 UI 现在的**第二**条真实路径，不是一个副本。
import { scanLiveState } from "./a11y-core.mjs";

// 和 lan-transfer(9444) / mixed-link(9445) / a11y(9446) 各用各的端口：每个脚本只
// pkill 自己那一个端口的残留浏览器，谁也别顺手打死对方。
const DEBUG_PORT = 9447;
const PREVIEW_PORT = Number(argFlag("--port", "4184"));
const GLOBAL_TIMEOUT_MS = 10 * 60_000;
/** 六位十进制，和真配对码同形。夹具不校验它，房间只是一个字符串。 */
const ROOM_CODE = "483920";
/** 第二幕自己的房间。两幕各用各的码：BroadcastChannel 是按房间字符串分的，
 *  共用一个码会让上一幕没关干净的标签页混进来，变成偶发红。 */
const PRESELECT_ROOM_CODE = "915273";
/** 第三幕的房间，同理各用各的。 */
const SIGNALING_LOSS_ROOM_CODE = "604118";

const shotsArg = argPresent("--screenshots") ? argFlag("--screenshots", "") : null;
const SHOTS = shotsArg === null || !shotsArg || shotsArg.startsWith("--")
  ? (shotsArg === null ? null : "e2e-screenshots")
  : shotsArg;

/** 正文里每一个字符都有理由：前导空格 + tab、空行、CJK、阿拉伯语（RTL）、星平面
 *  emoji、行尾空格。任何一层做了 trim/规范化/折叠，都在这里现形。 */
const MSG_BODY = "  \tcode room:\n\n\t\t'你好 مرحبا 🌍'\n   \n  trailing   ";
const utf8Hex = (s) => [...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0")).join("");

const OPEN_WORKSPACE = ".open-workspace";
const CONFIRM_BAR = ".confirm-send";
/** 只有在"有码可核对"的时候才存在的那个按钮。它的**不存在**是这幕的核心断言。 */
const CONFIRM_SEND_BTN = ".confirm-send .confirm-send-btn";
const CONFIRM_OPEN_BTN = ".confirm-send .confirm-send-open";
const RELEASE_QUEUED_BTN = ".release-queued .release-queued-btn";
const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const COMPOSER = ".msgpanel textarea";
const ATTACH_FILE = ".msgpanel .attach-file";
const ATTACH_FOLDER = ".msgpanel .attach-folder";

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
 * 一条链路一个 SAS。数的是整页的 `.sas`，不是"头部有一个"——真正会出错的是别处又
 * 冒出来一个，而配对码房间过去走的是每条会话各带一串码的老路径。
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
      code: code ? code.textContent.trim() : '',
    };
  })()`);
  if (
    seen.heads !== 1 || seen.sasTotal !== 1 || seen.sasOutsideHead !== 0 ||
    seen.laneSas !== 0 || seen.xferCodes !== 0 || seen.paths > 1 || !/^\d{6}$/.test(seen.code)
  ) {
    throw new Error(`${who} showed more than one verification surface ${where}: ${JSON.stringify(seen)}`);
  }
  return seen.code;
}

const pickFiles = (build) => `(() => {
  const input = document.querySelector('${ATTACH_FILE}');
  if (!input) throw new Error('no file attachment control in the unified workspace');
  if (input.disabled) throw new Error('the unified attachment control was disabled');
  const dt = new DataTransfer();
  ${build}
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const setLocale = async (tab, code) => {
  await tab.evaluate(`(() => {
    const select = document.querySelector('select.lang');
    if (!select) throw new Error('no language selector on this page');
    select.value = ${JSON.stringify(code)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await tab.waitFor(`document.documentElement.lang === ${JSON.stringify(code)}`, `${code} locale to render`);
};

async function codeRoomScenario(browser, base) {
  // A 发起，B 收（另存为被桩掉）。两边都拿到同一份 ICE 夹具和同一条假房间。
  // peer id 是显式的：initiator/responder 按 `selfId < peerId` 定，随机 id 会让角色
  // 分配每次运行都不同，一个只在某一半角色上出现的回归就变成偶发红。
  //
  // 高级验证是**关**着出厂的，而"一条链路一个 SAS"是那条**opt-in**路径上的规矩,
  // 所以两边都在启动前显式打开它。
  const room = `${base}/cross-network#c=${ROOM_CODE}`;
  const common = VERIFY_ON + apiFixtureScript(CODE_ROOM_ROUTES);
  const a = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: "aaaa1111", name: "Tab A" }));
  const b = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: "bbbb2222", name: "Tab B" }) + SAVE_STUB);
  await setWideViewport(a, 390, 844);
  await setWideViewport(b, 390, 844);

  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await a.waitFor(peersSeen, "tab A to see tab B in the code room", 30_000);
  await b.waitFor(peersSeen, "tab B to see tab A in the code room", 30_000);
  // 房间真的是那个码的房间，不是回落到 LAN 的那一个——否则这整套断言测的是
  // `mixed-link.mjs` 已经覆盖过的东西，而配对码这条路径一行都没跑到。
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const inRoom = await tab.evaluate(`location.hash === '#c=${ROOM_CODE}'`);
    if (!inRoom) throw new Error(`${who} is not in the pairing-code room any more`);
  }
  ok(`both tabs joined pairing-code room ${ROOM_CODE} and discovered each other`);

  // ── 一、配对码房间的对端卡片，和 LAN 一样，只有**一个**动作 ───────────────
  const card = await a.evaluate(`(() => {
    const actions = document.querySelector('.peer-actions');
    return {
      open: document.querySelectorAll('${OPEN_WORKSPACE}').length,
      controls: actions ? actions.children.length : 0,
      // 老的三选一：文件 <label>、文件夹 <label>、消息 <button>。一个都不该在。
      legacyPickers: document.querySelectorAll('.peer-actions .file-pick-input').length,
      named: (document.querySelector('${OPEN_WORKSPACE}')?.textContent ?? '').trim(),
      heads: document.querySelectorAll('${HEAD}').length,
    };
  })()`);
  if (card.open !== 1 || card.controls !== 1 || card.legacyPickers !== 0 || !card.named || card.heads !== 0) {
    throw new Error(`the pairing-room peer card is not a single workspace action: ${JSON.stringify(card)}`);
  }
  await screenshot(a, "code-room-peer-card");
  ok("a link-capable peer in a code room offered exactly one action, not the legacy file/folder/message fork");

  // ── 二、一个动作 → 一条链路、一个 SAS、默认就在的输入框 ────────────────────
  await a.evaluate(`(() => { document.querySelector('${OPEN_WORKSPACE}').click(); return true; })()`);
  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab A's unified workspace header", 45_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's unified workspace header", 45_000);

  const sasA = await oneSas(a, "tab A", "on a freshly opened code-room workspace");
  const sasB = await oneSas(b, "tab B", "on a freshly opened code-room workspace");
  if (sasA !== sasB) throw new Error(`link SAS mismatch across the code room: ${sasA} vs ${sasB}`);
  ok(`one action opened one link with one SAS on both tabs (${sasA})`);

  // 输入框默认可见，发送文件/文件夹在它下面。这是这一轮产品变更的核心断言：
  // 配对码房间过去要先在"文件 / 文件夹 / 消息"里选一个，才会有任何一样东西出现。
  //
  // 先只查发起的那一边。**高级验证是开着的**（这一整套 SAS 断言要它），所以对面这
  // 一刻大概率停在文本通道的同意卡上——那是有意的一步，不是缺了输入框。两边都查在
  // 下面把同意答掉之后。
  const composerContract = async (who, tab) => {
    await tab.waitFor(`!!document.querySelector('${COMPOSER}')`, `${who}'s composer to be there by default`, 45_000);
    const layout = await tab.evaluate(`(() => {
      const composer = document.querySelector('${COMPOSER}');
      const file = document.querySelector('${ATTACH_FILE}');
      const folder = document.querySelector('${ATTACH_FOLDER}');
      const box = composer.getBoundingClientRect();
      return {
        composerVisible: box.width > 0 && box.height > 0,
        file: !!file, folder: !!folder,
        fileDisabled: !!file?.disabled, folderDisabled: !!folder?.disabled,
        // "underneath" 是字面意思，也是这条设计的原话：附件控件在输入框下面。
        fileBelowComposer: !!file && file.closest('.attach')?.getBoundingClientRect().top >= box.top,
        focusStolen: composer === document.activeElement,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    if (
      !layout.composerVisible || !layout.file || !layout.folder ||
      layout.fileDisabled || layout.folderDisabled || !layout.fileBelowComposer ||
      layout.focusStolen || layout.overflow !== 0
    ) {
      throw new Error(`${who} did not get a default composer with file and folder controls under it: ${JSON.stringify(layout)}`);
    }
  };
  await composerContract("tab A", a);
  await screenshot(a, "code-room-workspace-default");
  ok("the code room opened straight into a visible composer with Send file / Send folder underneath");

  // 选择器和"可以发消息"的提示都被工作区收走了。
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const leftovers = await tab.evaluate(`({
      peers: document.querySelectorAll('.peers').length,
      openWorkspace: document.querySelectorAll('${OPEN_WORKSPACE}').length,
      hint: document.querySelectorAll('.text-availability').length,
    })`);
    if (leftovers.peers !== 0 || leftovers.openWorkspace !== 0 || leftovers.hint !== 0) {
      throw new Error(`${who} kept a second way to start a link next to a live one: ${JSON.stringify(leftovers)}`);
    }
  }
  await scanLiveState(a, "code-room unified workspace (390px)");
  ok("the code room's chooser and availability hint went away with the workspace open");

  // ── 三、RTL：同一条工作区在阿拉伯语下不横向溢出，头部仍然只有一个 SAS ──────
  await setLocale(a, "ar");
  const rtl = await a.evaluate(`(() => {
    const head = document.querySelector('${HEAD}');
    const composer = document.querySelector('${COMPOSER}');
    return {
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      head: !!head,
      composer: !!composer,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // 断开按钮靠的是 margin-inline-start:auto（逻辑属性），RTL 下应该镜像到左边。
      disconnectAtStart: (() => {
        const btn = head.querySelector('.wh-disconnect');
        const box = btn.getBoundingClientRect();
        return box.left < innerWidth / 2;
      })(),
    };
  })()`);
  if (rtl.dir !== "rtl" || !rtl.head || !rtl.composer || rtl.overflow !== 0 || !rtl.disconnectAtStart) {
    throw new Error(`the code-room workspace did not survive RTL at 390px: ${JSON.stringify(rtl)}`);
  }
  await oneSas(a, "tab A", "in Arabic (RTL)");
  await screenshot(a, "code-room-workspace-rtl");
  await scanLiveState(a, "code-room unified workspace (Arabic RTL, 390px)");
  await setLocale(a, "en");
  ok("the same workspace held up in Arabic RTL at 390px with its single SAS");

  // ── 四、同一条连接上先文本、再文件 ────────────────────────────────────────
  // 文本通道两边都会自动开一次；哪一边收到同意提示取决于真实时序，所以先把它答掉。
  const consentOn = async () => {
    for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
      const asking = await tab.evaluate("!!document.querySelector('.msgpanel .req')");
      if (asking) return [who, tab];
    }
    return null;
  };
  for (let i = 0; i < 100; i++) {
    const asking = await consentOn();
    if (!asking) break;
    await asking[1].evaluate("(() => { document.querySelector('.msgpanel .act button.btn-primary').click(); return true; })()");
    await new Promise((r) => setTimeout(r, 200));
  }
  // Now BOTH sides are past the one verification step, so both must hold the
  // same default surface — composer first, file and folder controls under it.
  await composerContract("tab A", a);
  await composerContract("tab B", b);
  ok("both tabs settled on the same default composer + file/folder surface");

  await a.evaluate(`(() => {
    const ta = document.querySelector('${COMPOSER}');
    ta.value = ${JSON.stringify(MSG_BODY)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await a.waitFor(
    "!document.querySelector('.msgpanel button.send').disabled",
    "send to be enabled for a body inside the limit",
    10_000,
  );
  // 打着字的时候文件能力必须还在：统一工作区的整个主张就是两条通道同时可用。
  const bothLanes = await a.evaluate(`({
    attachDisabled: !!document.querySelector('${ATTACH_FILE}').disabled,
    sendDisabled: !!document.querySelector('.msgpanel button.send').disabled,
  })`);
  if (bothLanes.attachDisabled || bothLanes.sendDisabled) {
    throw new Error(`text and file intent were not simultaneously available: ${JSON.stringify(bothLanes)}`);
  }
  await a.evaluate("(() => { document.querySelector('.msgpanel button.send').click(); return true; })()");
  await b.waitFor("document.querySelectorAll('.msg-body').length >= 1", "tab B to render the message", 40_000);
  const gotHex = await b.evaluate(`(() => {
    const bytes = new TextEncoder().encode(document.querySelector('.msg-body').textContent);
    return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  })()`);
  if (gotHex !== utf8Hex(MSG_BODY)) {
    throw new Error(`message body is not byte-identical across the code room\n      got  ${gotHex}\n      want ${utf8Hex(MSG_BODY)}`);
  }
  ok("a message crossed the code room's single link byte-identically, with the file control still usable");

  // 同一条链路，第二条通道：真文件，收方独立同意，落盘字节逐一核对。
  const FILE_BYTES = 128 * 1024 + 17;
  await a.evaluate(pickFiles(`
    const body = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 37 + 11) % 251;
    dt.items.add(new File([body], 'code-room-mixed.bin'));
  `));
  await b.waitFor("!!document.querySelector('.request')", "tab B's file consent card", 45_000);
  // 收文件的同意是**独立**的一步，任何验证模式都不跳过它。
  await oneSas(b, "tab B", "while a file batch awaits its own consent");
  await scanLiveState(b, "code-room file consent card (390px)");
  await screenshot(b, "code-room-file-consent");
  await b.evaluate("(() => { document.querySelector('.request .btn-primary').click(); return true; })()");
  await b.waitFor(
    `window.__e2e.closed && window.__e2e.bytes === ${FILE_BYTES}`,
    "the receiver to close its destination at the exact declared size",
    90_000,
  );
  const digest = await b.evaluate(`(async () => {
    const blob = new Blob(window.__e2e.chunks);
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  const expected = await a.evaluate(`(async () => {
    const body = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 37 + 11) % 251;
    const hash = await crypto.subtle.digest('SHA-256', body);
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  if (digest !== expected) throw new Error(`received bytes differ: ${digest} vs ${expected}`);

  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const code = await oneSas(tab, who, "with both lanes used on one code-room link");
    if (code !== sasA) throw new Error(`${who} changed the link SAS mid-session: ${code} vs ${sasA}`);
  }
  ok(`text and a ${FILE_BYTES}-byte file crossed the SAME code-room link, still under one SAS (${sasA})`);

  // ── 五、断开：工作区收走，选择器回来，对端还在房间里 ──────────────────────
  await a.evaluate(`(() => { document.querySelector('${HEAD} .wh-disconnect').click(); return true; })()`);
  await a.waitFor(`document.querySelectorAll('${HEAD}').length === 0`, "tab A's workspace to be torn down", 20_000);
  await a.waitFor("!!document.querySelector('.peers')", "tab A's device chooser to come back", 20_000);
  const after = await a.evaluate(`({
    heads: document.querySelectorAll('${HEAD}').length,
    sas: document.querySelectorAll('.sas').length,
    composer: document.querySelectorAll('${COMPOSER}').length,
    peerCards: document.querySelectorAll('.pname').length,
    hash: location.hash,
  })`);
  if (after.heads !== 0 || after.sas !== 0 || after.composer !== 0 || after.peerCards === 0
    || after.hash !== `#c=${ROOM_CODE}`) {
    throw new Error(`teardown left the code room in a mixed state: ${JSON.stringify(after)}`);
  }
  await b.waitFor(`document.querySelectorAll('${HEAD}').length === 0`, "tab B to follow the announced departure", 30_000);
  await screenshot(a, "code-room-after-disconnect");
  ok("an explicit disconnect tore both sides down and returned the code room's chooser");

  // 这一幕自己收干净：下一幕开的是新标签页，留着的旧页仍然坐在自己的房间里，
  // 只会给后面的断言添噪音。
  for (const tab of [a, b]) await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/**
 * 第二幕：**预置队列**遇上一个统一对端。
 *
 * 这是"高级验证 + 配对码房间 + 先选文件后铸码（或 OS 分享）"三件事撞在一起时的那条
 * 真实路径，也是它曾经漏掉的那个洞：确认栏是在**对端刚进房**的那一刻就弹出来的，
 * 那时候链路还不存在，于是它让人核对的那串校验码也还不存在——而当时的"发送"按钮
 * 是可以直接按下去的。按下去，文件就交给了"第一个进房间的人"，也就是这条确认栏
 * 当初被加进来防的那种猜码者。
 *
 * 这里跑的是完整的一遍：先选文件 → 铸码进房 → 对端加入 → 确认栏出现但**没有**发送
 * 按钮 → 打开工作区（不排空队列）→ 头部出现 SAS → 现在才可以发送。中途还按一次
 * 取消，验证工作区里那条常驻的重新武装路径没有被这次改动破坏。
 */
async function preselectedSendScenario(browser, base) {
  const room = `${base}/cross-network`;
  const sender = VERIFY_ON + apiFixtureScript(CODE_ROOM_SIGNED_IN_ROUTES)
    + pairMintScript({ code: PRESELECT_ROOM_CODE });
  const a = await newTab(browser, room, sender + codeRoomSignalingScript({ selfId: "aaaa1111", name: "Tab A" }));
  await setWideViewport(a, 390, 844);

  // ── 一、先选文件、再铸码：产品里预置队列的两个来源之一，逐字走一遍 ──────────
  await a.waitFor("!!document.querySelector('.choices .file-pick-input')",
    "the signed-in sender's file picker", 30_000);
  const FILE_BYTES = 64 * 1024 + 9;
  await a.evaluate(`(() => {
    const input = document.querySelector('.choices .file-pick-input');
    const body = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 53 + 7) % 251;
    const dt = new DataTransfer();
    dt.items.add(new File([body], 'preselected.bin'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await a.waitFor(
    `document.querySelector('.pairing .code')?.textContent?.trim() === '${PRESELECT_ROOM_CODE}'`,
    "the picked batch to mint a code and enter its room",
    30_000,
  );
  await a.waitFor("document.querySelectorAll('.pending-files .file-name').length === 1",
    "the queued batch to be listed while the room waits", 15_000);
  ok("a preselected batch minted a code and waited in the room, undrained");

  // ── 二、对端进房 → 确认栏出现，但此刻还没有任何码 ─────────────────────────
  const b = await newTab(
    browser,
    `${base}/cross-network#c=${PRESELECT_ROOM_CODE}`,
    VERIFY_ON + apiFixtureScript(CODE_ROOM_ROUTES)
      + codeRoomSignalingScript({ selfId: "bbbb2222", name: "Tab B" }) + SAVE_STUB,
  );
  await setWideViewport(b, 390, 844);
  await a.waitFor(`!!document.querySelector('${CONFIRM_BAR}')`, "tab A's send confirmation", 30_000);

  const preLink = await a.evaluate(`(() => {
    const bar = document.querySelector('${CONFIRM_BAR}');
    return {
      send: document.querySelectorAll('${CONFIRM_SEND_BTN}').length,
      open: document.querySelectorAll('${CONFIRM_OPEN_BTN}').length,
      // 这一刻整页一个 SAS 都没有——这正是"发送"不该存在的理由。
      sas: document.querySelectorAll('.sas').length,
      heads: document.querySelectorAll('${HEAD}').length,
      // 栏里只有一个主按钮，而且它不是发送：任何第二条释放路径都在这里现形。
      primaries: [...bar.querySelectorAll('button.btn-primary')].map((n) => n.className),
      // 一张传输卡都没有：队列还在，没有任何东西已经上路。
      xfers: document.querySelectorAll('.xfer').length,
    };
  })()`);
  const untouched = await b.evaluate("({ request: document.querySelectorAll('.request').length, opens: window.__e2e.opens })");
  if (
    preLink.send !== 0 || preLink.open !== 1 || preLink.sas !== 0 || preLink.heads !== 0 ||
    preLink.primaries.length !== 1 || !preLink.primaries[0].includes("confirm-send-open") ||
    preLink.xfers !== 0 || untouched.request !== 0 || untouched.opens !== 0
  ) {
    throw new Error(
      "the pre-link confirmation offered a release with no code behind it: "
      + JSON.stringify({ ...preLink, ...untouched }),
    );
  }
  await scanLiveState(a, "code-room pre-link send confirmation (390px)");
  await screenshot(a, "code-room-preselected-no-code");
  ok("with a peer in the room but no link yet, the confirmation offered no way to send");

  // ── 三、打开工作区：建链路、出 SAS，但**一个字节都不排空** ────────────────
  await a.evaluate(`(() => { document.querySelector('${CONFIRM_OPEN_BTN}').click(); return true; })()`);
  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab A's workspace header", 45_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's workspace header", 45_000);
  const sasA = await oneSas(a, "tab A", "with a batch still waiting behind the confirmation");
  const sasB = await oneSas(b, "tab B", "with a batch still waiting behind the confirmation");
  if (sasA !== sasB) throw new Error(`link SAS mismatch: ${sasA} vs ${sasB}`);

  const opened = await b.evaluate(`({
    // 打开工作区绝不等于发送：收方这一刻不该有任何待同意的文件。
    request: document.querySelectorAll('.request').length,
    wrote: window.__e2e.opens,
  })`);
  if (opened.request !== 0 || opened.wrote !== 0) {
    throw new Error(`opening the workspace released the batch by itself: ${JSON.stringify(opened)}`);
  }
  await a.waitFor(`!!document.querySelector('${CONFIRM_SEND_BTN}')`, "tab A's Send to appear with the code", 20_000);
  ok(`opening the workspace put one SAS on both tabs (${sasA}) and released nothing`);

  // ── 四、取消 → 工作区里那条常驻的重新武装路径 ────────────────────────────
  await a.evaluate(`(() => {
    const cancel = [...document.querySelectorAll('${CONFIRM_BAR} button')]
      .find((n) => !n.classList.contains('btn-primary'));
    cancel.click();
    return true;
  })()`);
  await a.waitFor(`document.querySelectorAll('${CONFIRM_BAR}').length === 0`, "the confirmation to be dismissed", 15_000);
  await a.waitFor(`!!document.querySelector('${RELEASE_QUEUED_BTN}')`, "the workspace's persistent release control", 15_000);
  await a.evaluate(`(() => { document.querySelector('${RELEASE_QUEUED_BTN}').click(); return true; })()`);
  await a.waitFor(`!!document.querySelector('${CONFIRM_SEND_BTN}')`, "the re-armed confirmation, now with a code", 15_000);
  await screenshot(a, "code-room-preselected-rearmed");
  ok("Cancel left the files reachable, and the workspace's release control re-armed the same confirmation");

  // ── 五、现在——也只有现在——发送真的把字节送过去 ─────────────────────────
  await a.evaluate(`(() => { document.querySelector('${CONFIRM_SEND_BTN}').click(); return true; })()`);
  await b.waitFor("!!document.querySelector('.request')", "tab B's file consent card", 45_000);
  await b.evaluate("(() => { document.querySelector('.request .btn-primary').click(); return true; })()");
  await b.waitFor(
    `window.__e2e.closed && window.__e2e.bytes === ${FILE_BYTES}`,
    "the receiver to close its destination at the exact declared size",
    90_000,
  );
  const digest = await b.evaluate(`(async () => {
    const blob = new Blob(window.__e2e.chunks);
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  const expected = await a.evaluate(`(async () => {
    const body = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 53 + 7) % 251;
    const hash = await crypto.subtle.digest('SHA-256', body);
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  if (digest !== expected) throw new Error(`received bytes differ: ${digest} vs ${expected}`);
  ok(`the confirmed release sent the ${FILE_BYTES}-byte preselected batch over the compared link`);

  for (const tab of [a, b]) await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

/**
 * 第三幕：对端的**信令**掉了，数据通道没掉。
 *
 * 房间发出的 `left` 帧说的是"那台机器的 WebSocket 没了"，它对两个页面之间那条
 * DataChannel 什么都没说。这条不变式过去只在 `link-recovery.ts` 的注释里写着，而
 * 收到 `left` 的那一边曾经会无条件地把一条**完全健康**的链路拆掉——正在传的文件
 * 当场断在半路。
 *
 * 这里在**传输进行中**掐掉收方的信令：文件必须照样传完、字节逐一对得上，发方的
 * 工作区必须还在、SAS 还是那一个，同时如实地告诉用户这条链路已经无法重建了。
 */
async function correlatedLossScenario(browser, base) {
  const room = `${base}/cross-network#c=${SIGNALING_LOSS_ROOM_CODE}`;
  const common = VERIFY_ON + apiFixtureScript(CODE_ROOM_ROUTES);
  const a = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: "aaaa1111", name: "Tab A" }));
  const b = await newTab(browser, room, common + codeRoomSignalingScript({ selfId: "bbbb2222", name: "Tab B" }) + SAVE_STUB);
  await setWideViewport(a, 390, 844);
  await setWideViewport(b, 390, 844);

  const peersSeen = "document.querySelectorAll('.pname').length > 0";
  await a.waitFor(peersSeen, "tab A to see tab B", 30_000);
  await b.waitFor(peersSeen, "tab B to see tab A", 30_000);
  await a.evaluate(`(() => { document.querySelector('${OPEN_WORKSPACE}').click(); return true; })()`);
  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab A's workspace header", 45_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's workspace header", 45_000);
  const sas = await oneSas(a, "tab A", "before the peer's signalling is cut");

  // 先把文本通道的同意答掉：下面要证明的是"信令掐了以后还能发**新**消息"，所以这
  // 条会话必须在掐之前就已经是 open 的——否则测的是"同意卡点不动"，不是传输。
  for (let i = 0; i < 100; i++) {
    let asked = false;
    for (const tab of [a, b]) {
      if (await tab.evaluate("!!document.querySelector('.msgpanel .req')")) {
        await tab.evaluate("(() => { document.querySelector('.msgpanel .act button.btn-primary').click(); return true; })()");
        asked = true;
      }
    }
    if (!asked) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await a.waitFor(`!!document.querySelector('${COMPOSER}')`, "tab A's composer", 45_000);
  await b.waitFor(`!!document.querySelector('${COMPOSER}')`, "tab B's composer", 45_000);

  // 慢写：让收方每一块都停一下，这样"传输进行中"是一段真的有宽度的时间窗，而不是
  // 一个要靠运气命中的瞬间。
  await b.evaluate("(() => { window.__e2e.writeDelayMs = 25; return true; })()");
  const FILE_BYTES = 512 * 1024 + 13;
  await a.waitFor(`!!document.querySelector('${ATTACH_FILE}')`, "tab A's attachment control", 45_000);
  await a.evaluate(pickFiles(`
    const body = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 29 + 3) % 251;
    dt.items.add(new File([body], 'across-the-gap.bin'));
  `));
  await b.waitFor("!!document.querySelector('.request')", "tab B's file consent card", 45_000);
  await b.evaluate("(() => { document.querySelector('.request .btn-primary').click(); return true; })()");
  await b.waitFor("window.__e2e.bytes > 0", "the transfer to actually be under way", 45_000);

  // ── 掐掉收方的信令，且只掐信令 ────────────────────────────────────────────
  await b.evaluate("__e2eDropSignaling()");
  // 发方处理完那条 `left` 的直接观测点。这条路径上没有 TURN，所以头部唯一可能出现
  // 的告警就是"掉了就回不来了"这一条。
  // 两种结局都在这一个条件里：头部没了（= 链路被拆了，回归）或者头部长出了告警
  // （= 链路留着，只是不可重建）。这样下面那条断言拿到的是**结局**，报错也就说得
  // 出到底发生了什么，而不是一句"等超时了"。
  await a.waitFor(
    `!document.querySelector('${HEAD}') || !!document.querySelector('${HEAD} .wh-warn')`,
    "tab A to settle on what the peer's departure meant for this link",
    30_000,
  );

  const kept = await a.evaluate(`(() => {
    const head = document.querySelector('${HEAD}');
    if (!head) return { heads: 0, code: '', warns: 0, restart: 0 };
    return {
      heads: document.querySelectorAll('${HEAD}').length,
      code: document.querySelector('${HEAD_SAS}')?.textContent?.trim() ?? '',
      // 如实告知：这条链路还好好的，但它掉了就回不来了。
      warns: [...head.querySelectorAll('.wh-warn')].map((n) => n.textContent.trim()).length,
      // 没有终结卡：链路没有结束，结束的是别的东西。
      restart: head.querySelectorAll('.wh-restart').length,
    };
  })()`);
  if (kept.heads !== 1 || kept.code !== sas || kept.warns < 1) {
    throw new Error(`the sender did not keep its healthy link across the peer's signalling loss: ${JSON.stringify(kept)}`);
  }
  await screenshot(a, "code-room-signalling-lost-link-kept");
  ok(`the sender kept its link and its one SAS (${sas}) when the peer's signalling went away`);

  // ── 而正在传的那个文件照样传完，字节逐一对得上 ────────────────────────────
  await b.waitFor(
    `window.__e2e.closed && window.__e2e.bytes === ${FILE_BYTES}`,
    "the in-flight transfer to finish over the surviving data channel",
    120_000,
  );
  const digest = await b.evaluate(`(async () => {
    const blob = new Blob(window.__e2e.chunks);
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  const expected = await a.evaluate(`(async () => {
    const body = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 29 + 3) % 251;
    const hash = await crypto.subtle.digest('SHA-256', body);
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  if (digest !== expected) throw new Error(`bytes across the signalling gap differ: ${digest} vs ${expected}`);
  ok(`a ${FILE_BYTES}-byte transfer finished intact across the peer's signalling loss`);

  // ── 而且工作区**整个**还能用：信令掐了以后照样能发新的东西 ────────────────
  //
  // 上面证明的是"已经在飞的那一批不会断"。这一段证明的是产品方向本身：一条已经建立
  // 且健康的统一链路，对它绑定的那个对端就是权威的——名册里没有它了、它通告的
  // capability 也被 retainPeers 剪掉了，但这些都是**信令层**的事实，跟两个页面之间
  // 那条 DataChannel 无关。
  //
  // 掐之前这里是坏的，而且是三种坏法叠在一起：peer-workspace 的 routes() 变 false
  // 于是新文件走回 legacy（或者被 blocksNewIntent 直接吞掉），peer-link 的 ensure()
  // 在拿到 current 之前先查 capability 于是把自己手上那条链路 reject 掉，App 里的
  // 释放按钮还在但 releaseQueued 从名册里找不到人——点了什么也不发生。
  const SECOND_MSG = "after the cut: 新消息 🌍";
  await a.evaluate(`(() => {
    const ta = document.querySelector('${COMPOSER}');
    ta.value = ${JSON.stringify(SECOND_MSG)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await a.waitFor(
    "!document.querySelector('.msgpanel button.send').disabled",
    "tab A's send to still be available after the peer's signalling went away",
    15_000,
  );
  await a.evaluate("(() => { document.querySelector('.msgpanel button.send').click(); return true; })()");
  await b.waitFor(
    `[...document.querySelectorAll('.msg-body')].some((n) => n.textContent === ${JSON.stringify(SECOND_MSG)})`,
    "tab B to receive a message sent AFTER its own signalling was cut",
    40_000,
  );
  ok("a new message crossed the same link after the peer's signalling was gone");

  // 第二批文件，走同一条链路。pickFiles 本身就会在附件控件被禁用时抛错——那正是
  // 修复前的表现（unifiedAttachments 读 blocksNewIntent，而它当时是 true）。
  await b.evaluate(`(() => {
    Object.assign(window.__e2e, { chunks: [], bytes: 0, closed: false, writeDelayMs: 0 });
    return true;
  })()`);
  const SECOND_BYTES = 64 * 1024 + 7;
  await a.evaluate(pickFiles(`
    const body = new Uint8Array(${SECOND_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 11) % 251;
    dt.items.add(new File([body], 'after-the-cut.bin'));
  `));
  await b.waitFor("!!document.querySelector('.request')", "tab B's consent card for the SECOND batch", 45_000);
  await b.evaluate("(() => { document.querySelector('.request .btn-primary').click(); return true; })()");
  await b.waitFor(
    `window.__e2e.closed && window.__e2e.bytes === ${SECOND_BYTES}`,
    "the second batch to land whole over the surviving data channel",
    90_000,
  );
  const secondDigest = await b.evaluate(`(async () => {
    const blob = new Blob(window.__e2e.chunks);
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  const secondExpected = await a.evaluate(`(async () => {
    const body = new Uint8Array(${SECOND_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 11) % 251;
    const hash = await crypto.subtle.digest('SHA-256', body);
    return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
  })()`);
  if (secondDigest !== secondExpected) {
    throw new Error(`the post-cut batch differs: ${secondDigest} vs ${secondExpected}`);
  }
  ok(`a NEW ${SECOND_BYTES}-byte batch was sent over the same link after signalling was lost`);

  // 而这一整段里，那条链路的身份和那句告警都没变过：还是同一个 SAS，头部还是只有
  // 一个，"掉了就回不来了"那句话还在——新东西能发，不等于这条链路能重建。
  const after = await a.evaluate(`(() => {
    const head = document.querySelector('${HEAD}');
    if (!head) return { heads: 0, code: '', warns: 0, restart: 0 };
    return {
      heads: document.querySelectorAll('${HEAD}').length,
      code: document.querySelector('${HEAD_SAS}')?.textContent?.trim() ?? '',
      warns: head.querySelectorAll('.wh-warn').length,
      restart: head.querySelectorAll('.wh-restart').length,
    };
  })()`);
  if (after.heads !== 1 || after.code !== sas || after.warns < 1 || after.restart !== 0) {
    throw new Error(`new work over the surviving link changed what it says about itself: ${JSON.stringify(after)}`);
  }
  await screenshot(a, "code-room-signalling-lost-new-work");
  ok(`the link kept its one SAS (${sas}) and its unrecoverable warning while carrying new work`);

  for (const tab of [a, b]) await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

async function main() {
  const preview = await startPreview({ port: PREVIEW_PORT, distDir: "dist" });
  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT, keep: argPresent("--keep") });
  try {
    await codeRoomScenario(browser, preview.base);
    await preselectedSendScenario(browser, preview.base);
    await correlatedLossScenario(browser, preview.base);
  } catch (err) {
    fail("pairing-code room unified workspace", err);
  } finally {
    await close();
    await preview.stop();
  }
}

await withWatchdog("code-room e2e", GLOBAL_TIMEOUT_MS, main);
