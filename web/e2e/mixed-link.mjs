#!/usr/bin/env node
/**
 * 端到端：两个真标签页之间跑一条真的 **统一链路**（`link/1`），走的是默认产物的
 * 默认 LAN UI。
 *
 *   cd web && npm run build && npm run test:e2e:mixed
 *
 * **服务器由它自己起。** 默认会用 `go-server.mjs` 从 `./server` 构建一个真服务器，
 * 起在一个自己的端口上，跑完连临时数据库一起收掉。以前这里要求人先手工在 :8098 起
 * 一个——于是这套用例"有人记得起服务器"才跑得起来，也就永远进不了托管 CI。
 *
 * 想打一个已经跑着的服务器仍然可以，显式给 `--url`：
 *
 *   cd server && RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=:8098 go run .
 *   cd web    && node e2e/mixed-link.mjs --url http://localhost:8098
 *
 * 自起模式**不会**去接管别人已经占着的端口：那个服务器有它自己的库、自己的 dist、
 * 可能还有开发者的真配置，对着它跑绿什么也证明不了。
 *
 * 它仍然和 `npm run test:e2e` 分开跑，因为它要一个自己的服务器端口和一整套自己的
 * 场景，不是因为这条协议还藏着。
 *
 * link/1 的作用域由**能力**决定，不由房间、也不由构建旗标决定：默认产物在**每一个**
 * 房间里都通告并路由它（`linkRoomActive()`，DECISION-LOG 2026-08-10 取代了更早的
 * LAN-only 作用域），配对码房间那一侧由 `code-room.mjs` 覆盖。这里开的是无配对码的
 * LAN 房间（`/`），脚本一上来先读页面**真正发出去的**名册通告确认这个产物确实在通告
 * link/1。不做这件事的话，"服务器指着旧 dist" 会伪装成 "链路建不起来" —— 一条看起来
 * 像回归的假红。
 *
 * 这里跑的就是**默认的 LAN 界面**：一个能说 link/1 的对端只提供**一个**主动作
 * （`.open-workspace`），它打开的工作区自己带着草稿框和附件控件（`.attach-file`）。
 * 老的"文件 / 文件夹 / 消息"三选一**已经不存在了**（`d175f863` 连同 `.pa-files` /
 * `.file-pick-input` 一起删的），哪个房间里都走不到：说不了这条协议的对端拿到的是
 * `.pa-unsupported` 那一句话，一个控件都没有。
 *
 * 覆盖的是单元测试碰不到的那一段：真 caps → 真 link 请求/应答 → 真 commit-reveal →
 * 一条 PeerConnection 上的两条 DataChannel → 文件与消息两条通道各自的同意状态机 →
 * 统一工作区的呈现规矩（一条链路一个 SAS）→ 显式断开。
 *
 * 只桩掉一样东西，和 lan-transfer 一样：操作系统的"另存为"对话框。
 *
 * 用法：node e2e/mixed-link.mjs [--url http://localhost:8098] [--port 8124] [--keep]
 *                              [--screenshots [dir]]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { portFromArgv, startGoServer } from "./go-server.mjs";
import {
  OBSERVE_CAPS, SAVE_STUB, VERIFY_ON, argFlag, argPresent, fail, launchBrowser, newTab, ok,
  requireServer, setWideViewport, withWatchdog,
} from "./harness.mjs";
import { QUEUED } from "./dom-contracts.mjs";
// 统一链路的同意态同样是静态扫描器到不了的地方，而且这里的规矩更紧：一条链路只有
// 一个 SAS，两条通道各自同意。哪一格长出了新的违规，都要在这里当场红。
import { scanLiveState } from "./a11y-core.mjs";

/**
 * `--url` 点名的那台服务器，或者没给这个开关时的 `null`。
 *
 * 解析在 `main()` 的 try 里，而且排在构建、浏览器、自起服务器**全部**前面。
 * 以前这里是 `argPresent("--url") ? argFlag("--url", "") : null`，于是三种写法都会
 * 悄悄换掉调用者点名的目标：`--url` 后面什么都没有给 `undefined`、`--url ""` 给
 * `""`，两个都是 falsy，这套用例转头去"自起"一台本地服务器——跑绿了，可绿的不是
 * 你要打的那台；`--url --keep` 则把下一个开关当成地址吞下去。现在三种都当场报错，
 * 报的是这套用例自己的名字。
 *
 * 合法的值一个字都不改：一个显式地址是手工快路的全部意义。
 */
function manualUrlFromArgv(argv) {
  const i = argv.indexOf("--url");
  if (i < 0) return null;
  const value = argv[i + 1];
  const refuse = (why) => {
    throw new Error(
      // 和 `--port` 那条报错同一个形状（`… — got X`）：两个开关坏掉的时候读起来
      // 应该是一回事，`go-server.test.mjs` 也就能对着同一个形状钉住它们。
      `--url ${why} — got ${value === undefined ? "undefined" : JSON.stringify(value)}. ` +
      "Give it a running server's address (e.g. --url http://localhost:8098), or drop --url " +
      "entirely and let this suite start its own. Treating it as absent is the worst option " +
      "available: the run would silently target a server nobody named, and pass.",
    );
  };
  if (value === undefined || value.trim() === "") refuse("has no address after it");
  if (value.startsWith("-")) refuse("is followed by the next switch rather than an address");
  return value;
}
/** 自起端口。刻意不用文档里手工那台的 8098，也不用 device-inbox 的 8123：默认跑法
 *  不该和一台开发者可能正开着的服务器抢端口。 */
const DEFAULT_SELF_PORT = 8124;
/**
 * `--port` 同样在 `main()` 的 try 里解析。
 *
 * 两个理由。一，把这个开关直接 `Number(...)` 一下，对 `--port`（后面什么都没有）
 * 和 `--port --keep` 都给 `NaN`，而 `listen(NaN)` 抛的是一条 `RangeError`：它确实
 * 在 Go 构建之前就红了，但既没说 `--port`，也没说这是哪套用例；现在这两种写法都在
 * 同一个位置报出它们各自那个值。二，给了 `--url` 的手工跑法根本用不到端口，不该被
 * 一个用不上的开关挡下——而一个模块加载期的抛出还会绕开 `fail`，打出的是一条 Node
 * 裸栈，不是这套用例的名字。
 */
const selfPort = () => portFromArgv(process.argv.slice(2), { dflt: DEFAULT_SELF_PORT });
// 和 lan-transfer 的 9444 分开：两套用例各自 pkill 自己那一个端口的残留浏览器，
// 谁也别顺手打死对方。
const DEBUG_PORT = 9445;
const KEEP = argPresent("--keep");
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

/** 默认 LAN UI 的**唯一**主动作。语义选择器，中英文或换图标都打不断。 */
const OPEN_WORKSPACE = ".open-workspace";
/** 附件住在统一工作区里，不在对端卡片上——工作区一开，卡片就整个收走了。 */
const ATTACH_FILE = ".msgpanel .attach-file";
const HEAD = ".workspace-head";
const HEAD_SAS = ".workspace-head .sas code";
const TEXT_CONSENT = ".msgpanel .req";
/**
 * 记下 live region 说过的**每一句**话。
 *
 * 光读"此刻 live region 里是什么"是不够的：一条链路只念一次码（见
 * activity-announcement.ts），而那一次落在这条链路的**第一条**边上——那条边未必就是
 * 最后停在屏幕上的那一张卡片。两边都会自动开一次文本通道，所以输掉 glare 的那一边
 * 真实的序列是「等待对方接受（含码）」→「X 想给你发消息」。只看后者会得出"这条链路
 * 从来没念过码"的错误结论。
 *
 * 所以这里记全序列，断言"这条链路念过它自己的码"，同时另外单独断言"同一条链路上后来
 * 的边不再念一遍"。
 *
 * **安装是异步的，所以它必须自己举手。** live region 要等 App 挂载出来才存在，这里靠
 * 50ms 轮询等它；在它出现之前，这份记录是空的，而且**看起来**和"什么都没念过"一模一样。
 * 一台被别的 E2E 压满的机器上，第一条链路可以在观察器装上之前就把码念完——那正是
 * 2026-08-29 那次并发跑挂在 `this link never announced its code ... []` 的原因：链路和
 * SAS 都是真的对上了，只有仪表盘迟到了。所以旗子在 `observe()` **之后**才落下，而调用方
 * 在划任何一条 mark、点开任何一条链路之前必须先等这面旗子。旗子为真 ⇒ 不存在"已经念过
 * 但没记下"的窗口。
 */
const TRACK_ANNOUNCEMENTS = `
  window.__e2eAnnouncements = [];
  window.__e2eAnnouncementsReady = false;
  (function install() {
    const el = document.querySelector('.activity-announcement');
    if (!el) { setTimeout(install, 50); return; }
    const push = () => {
      const text = (el.textContent || '').trim();
      if (text && window.__e2eAnnouncements[window.__e2eAnnouncements.length - 1] !== text) {
        window.__e2eAnnouncements.push(text);
      }
    };
    push();
    new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true });
    // 最后一行，而且只能是最后一行：这面旗子的全部含义就是"观察器已经在听了"。
    // 把它挪到 observe() 之前，等它就再次变成等一个空承诺。
    window.__e2eAnnouncementsReady = true;
  })();
`;
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
 * 从统一工作区里选文件。**只有这一条路**：默认 LAN UI 上的对端卡片没有文件控件，
 * 工作区一活起来连卡片本身都收走了。顺手断言控件是可用的——传输中再选文件要排队，
 * 不是把控件禁掉，所以一个 disabled 的附件按钮本身就是回归。
 */
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

const pickOne = (name) => pickFiles(
  `dt.items.add(new File(['x'], ${JSON.stringify(name)}, { type: 'text/plain' }));`,
);

const announcementOf = "(document.querySelector('.activity-announcement')?.textContent ?? '')";
/** 见 TRACK_ANNOUNCEMENTS：只有 `observe()` 之后这句才为真。 */
const ANNOUNCEMENTS_READY = "window.__e2eAnnouncementsReady === true";
/** 在这一步之前拿到的任何"念过什么"都不作数——它记的是仪表盘的年纪，不是产品的行为。 */
const announcementsReady = (tab, who) => tab.waitFor(
  ANNOUNCEMENTS_READY, `the live-region observer on ${who} to be installed`, 30_000,
);
/**
 * 这个标签页到目前为止说过多少句——拿来给"从这一刻起"的断言划一条线。
 *
 * 划线本身就要求观察器已经在听：一条在观察器装上之前划下的线，会把它之前的所有话
 * 一起算成"没说过"。所以这里不是等，是直接判死——等是调用方的事（`announcementsReady`），
 * 而一个漏掉了等待的调用点应该当场以它自己的名字报错，而不是在几十秒后伪装成一条
 * "产品从没念过码"的断言失败。
 */
const announcedCount = (tab) => tab.evaluate(`(() => {
  if (!(${ANNOUNCEMENTS_READY})) {
    throw new Error('announcement mark taken before the live-region observer was installed');
  }
  return window.__e2eAnnouncements.length;
})()`);
const announcedSince = (tab, mark) => tab.evaluate(`window.__e2eAnnouncements.slice(${mark})`);

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

/**
 * 工作区一活起来，设备选择器和那条"可以发消息"的提示就该整个收走：它们描述的是一台
 * 你**还没**连上的设备，留在活着的工作区旁边等于给出第二条互相矛盾的入口。
 */
async function chooserHidden(tab, who, where) {
  const seen = await tab.evaluate(`({
    peers: document.querySelectorAll('.peers').length,
    openWorkspace: document.querySelectorAll('${OPEN_WORKSPACE}').length,
    peerActions: document.querySelectorAll('.peer-actions').length,
    hint: document.querySelectorAll('.text-availability').length,
  })`);
  if (seen.peers !== 0 || seen.openWorkspace !== 0 || seen.peerActions !== 0 || seen.hint !== 0) {
    throw new Error(`${who} kept the device chooser up while the workspace owned the screen ${where}: ${JSON.stringify(seen)}`);
  }
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

/**
 * 等文本同意卡出现，但**不预设它落在哪一边**。
 *
 * 两边的工作区都会为这条链路自动开一次文本通道（否则只有点了按钮的那一边有草稿框，
 * 另一边连一个能点的东西都没有——卡片已经收走了）。两个请求撞在一起时，协议按
 * link.role 收敛成**一个**会话、**一次**同意提示，而那一次落在哪一边取决于真实的
 * 网络时序。所以这里等的是"有且只有一边在问"，不是"B 在问"。
 */
async function awaitTextConsent(tabs, timeoutMs = 45_000) {
  const started = Date.now();
  for (;;) {
    const asking = [];
    for (const [who, tab] of tabs) {
      if (await tab.evaluate(`!!document.querySelector('${TEXT_CONSENT}')`)) asking.push([who, tab]);
    }
    if (asking.length === 1) {
      const [who, tab] = asking[0];
      const other = tabs.find(([name]) => name !== who);
      return { who, tab, otherWho: other[0], other: other[1] };
    }
    if (asking.length > 1) {
      throw new Error(`both tabs raised a text consent prompt: the simultaneous-open collision did not converge`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no text consent prompt appeared on either tab within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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

/** `base` is a parameter now, not a module constant: it is whichever server this
 *  run is talking to — the one it started, or the one `--url` named. */
async function mixedScenario(browser, base) {
  // A 发起，B 收（另存为被桩掉）。两边都装上只读的 caps 探针：跑任何断言之前先确认
  // 这个默认产物在这个 LAN 房间里真的通告了 link/1。
  // This scenario is about the unified workspace's verification presentation,
  // which only exists with advanced verification ON. It is off by default, so
  // both tabs opt in before boot.
  const a = await newTab(browser, base + "/", VERIFY_ON + OBSERVE_CAPS + TRACK_ANNOUNCEMENTS +TRACK_PEER_CONNECTIONS);
  const b = await newTab(browser, base + "/", VERIFY_ON + OBSERVE_CAPS + TRACK_ANNOUNCEMENTS +SAVE_STUB + TRACK_PEER_CONNECTIONS);
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
        `tab ${who} advertised ${JSON.stringify(advertised)} — no link/1 in the code-less LAN room.\n` +
        `    A self-started run refuses a stale dist before it spawns, so on the default path this\n` +
        `    means the build stopped advertising it. Against --url it can still be a stale dist:\n` +
        `      cd web && npm run build`,
      );
    }
  }
  ok("both tabs advertised link/1 from the default build and discovered each other");

  // ── 一、默认 LAN 卡片只有**一个**动作，它打开的就是整个工作区 ─────────────
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
    throw new Error(`the default LAN peer card is not a single workspace action: ${JSON.stringify(card)}`);
  }
  await screenshot(a, "peer-card-one-action");
  ok("a link-capable LAN peer offered exactly one action and no file/folder/message fork");

  // 先确认两边的 live region 观察器都装上了，再划线、再点开第一条链路。这两句不是
  // 等待时间，是等待一个事实：漏掉它们，一台负载重的机器就能在仪表盘出现之前把第一条
  // 链路的码念完，于是下面那条"这条链路念过它自己的码"会以空数组失败——而链路和 SAS
  // 其实完全正常。见 TRACK_ANNOUNCEMENTS。
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) await announcementsReady(tab, who);
  const firstLinkMark = { a: await announcedCount(a), b: await announcedCount(b) };
  await a.evaluate(`(() => { document.querySelector('${OPEN_WORKSPACE}').click(); return true; })()`);
  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab A's unified workspace header", 45_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's unified workspace header", 45_000);

  const sasA = await oneSas(a, "tab A", "on a freshly opened workspace");
  const sasB = await oneSas(b, "tab B", "on a freshly opened workspace");
  if (sasA !== sasB) throw new Error(`link SAS mismatch: ${sasA} vs ${sasB}`);
  ok(`one action opened one link with one SAS on both tabs (${sasA})`);

  // 工作区一活起来，选择器和提示就整个收走。
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    await chooserHidden(tab, who, "right after the workspace opened");
  }
  ok("the chooser, the old peer actions and the availability hint all went away");

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

  await scanLiveState(a, "mixed workspace header (one authenticated link)");

  // ── 二、这条链路的第一次同意：文本通道，无自动聚焦，念一次码 ───────────────
  const consent = await awaitTextConsent([["tab A", a], ["tab B", b]]);
  const quiet = await consent.tab.evaluate(`({
    bodies: document.querySelectorAll('.msg-body').length,
    composer: document.querySelectorAll('.msgpanel textarea').length,
    panelSas: document.querySelectorAll('.msgpanel .sas').length,
  })`);
  if (quiet.bodies !== 0 || quiet.composer !== 0 || quiet.panelSas !== 0) {
    throw new Error(`text consent card leaked content or a second code: ${JSON.stringify(quiet)}`);
  }
  await oneSas(consent.tab, consent.who, "on the text consent card");
  // activityFocused 是这里的重点之一：同意界面不许把焦点抢走，决定是用户按下去的。
  const textEdge = await mobileDecisionVisible(consent.tab, consent.who, ".msgpanel", "a text consent card");
  if (!textEdge.announcement) throw new Error("the text consent edge announced nothing at all");
  // 这条链路必须念过它自己那串码——但念的是它的**第一条**边，而那条边未必是最后停在
  // 屏幕上的这张卡片（见 TRACK_ANNOUNCEMENTS）。所以查的是这条链路建立以来说过的全部。
  const mark = consent.who === "tab A" ? firstLinkMark.a : firstLinkMark.b;
  const spoken = await announcedSince(consent.tab, mark);
  if (!spoken.some((line) => line.includes(sasA))) {
    throw new Error(`this link never announced its code on ${consent.who}: ${JSON.stringify(spoken)}`);
  }
  await screenshot(consent.tab, "mobile-text-consent");
  await scanLiveState(consent.tab, "mixed text consent card (390px)");

  await consent.tab.evaluate("(() => { document.querySelector('.msgpanel .act button.btn-primary').click(); return true; })()");
  await a.waitFor("!!document.querySelector('.msgpanel textarea')", "tab A's composer (session open)", 40_000);
  await b.waitFor("!!document.querySelector('.msgpanel textarea')", "tab B's composer (session open)");
  ok(`${consent.who} completed the text consent without autofocus; both tabs got a composer`);

  // ── 三、40 个文件，从统一工作区的附件控件里选 ─────────────────────────────
  // 既是"这条链路还能开第二条通道"的动作，也顺手把长内容列表铺出来，好在下面检查
  // 粘性头部。
  await a.evaluate(pickFiles(`
    for (let i = 0; i < 40; i++) {
      dt.items.add(new File(
        ['x'],
        'unified-workspace-' + String(i).padStart(2, '0') + '-with-a-deliberately-long-name.txt',
        { type: 'text/plain' },
      ));
    }
  `));
  await b.waitFor("!!document.querySelector('.request')", "tab B's file consent card", 45_000);
  await oneSas(b, "tab B", "while a 40-file batch awaits consent");

  const fileEdge = await mobileDecisionVisible(b, "tab B", ".request", "a 40-file consent card");
  // 同一条链路的又一条边：码已经念过一次，而且一直挂在钉住的头部里，所以这里不该
  // 再念一遍。这正是那条"每条链路只念一次"的规矩，在真浏览器里验它。
  if (!fileEdge.announcement) throw new Error("the file consent edge announced nothing at all");
  if (fileEdge.announcement.includes(sasB)) {
    throw new Error(`a later edge on the SAME link re-read the code: ${JSON.stringify(fileEdge.announcement)}`);
  }
  await screenshot(b, "mobile-file-consent");
  await scanLiveState(b, "mixed file consent card (390px)");
  ok("a 40-file batch chosen from the workspace stayed decidable at 390px without re-reading the code");

  // ── 四、粘性：长列表滚下去，唯一的 SAS 不能滚出验证语境 ───────────────────
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

  // ── 五、传输中再选文件 → 可见、可取消的队列，而不是被禁用的控件 ───────────
  // pickFiles 自己就会在附件控件是 disabled 的时候抛错，所以"排队而不是禁用"这条
  // 规矩在选之前和选之后各钉了一次。
  await a.evaluate(pickFiles(`
    dt.items.add(new File(['queued-one'], 'queued-one.txt', { type: 'text/plain' }));
    dt.items.add(new File(['queued-two'], 'queued-two.txt', { type: 'text/plain' }));
  `));
  //
  // 这里的两个数**不是**一回事，早先那版把它们混成了一个 `li` 计数：一次选择是一个
  // 批次（`.batch`），批次里有 N 个文件行（`.file-list li`）。`QueuedBatches` 改成
  // 组合 `PendingFiles` 之后，两个文件的一次选择渲染出 1 + 2 = 3 个 `li`，于是
  // "rows !== 1" 红了，而 `.fname`（名字已经搬去 `.file-name`）返回空数组、
  // `names[0].includes` 直接抛 TypeError —— 一条什么也没说清楚的失败。
  //
  // 选择器现在只有一份，在 `dom-contracts.mjs` 里，`QueuedBatches.test.ts` 对着真
  // 渲染出来的组件钉着同一份。DOM 再漂移，先红的是每次推送都跑的那条单测。
  await a.waitFor(`!!document.querySelector('${QUEUED.card}')`, "tab A's visible outbound queue", 20_000);
  const queue = await a.evaluate(`(() => {
    const card = document.querySelector('${QUEUED.card}');
    const batches = [...card.querySelectorAll('${QUEUED.batch}')];
    const input = document.querySelector('${ATTACH_FILE}');
    return {
      // 一次选择 = 一个批次。
      batches: batches.length,
      // 批次里的文件行，按批次分开数——摊平成一个总数就又回到了那个混淆。
      fileRows: batches.map((b) => b.querySelectorAll('${QUEUED.fileRow}').length),
      cancels: card.querySelectorAll('${QUEUED.cancel}').length,
      names: batches.flatMap(
        (b) => [...b.querySelectorAll('${QUEUED.fileName}')].map((el) => el.textContent.trim()),
      ),
      // 关键：选了新文件之后，附件控件仍然是可用的 —— 排队正是为了不禁用它。
      pickerDisabled: !!input.disabled,
      // 文本仍然可用：两条通道互不阻塞。
      composer: document.querySelectorAll('.msgpanel textarea').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  // `.some` 而不是 `names[0].includes`：名字选择器万一再漂走，这里要报的是"名字读不到"
  // 这件事本身，不是一个 TypeError。
  const queuedNames = ["queued-one.txt", "queued-two.txt"];
  if (
    queue.batches !== 1 || queue.fileRows.length !== 1 || queue.fileRows[0] !== 2 ||
    queue.cancels !== 1 || queue.pickerDisabled || queue.composer !== 1 || queue.overflow !== 0 ||
    !queuedNames.every((want) => queue.names.some((got) => got.includes(want)))
  ) {
    throw new Error(
      "queued-batch contract failed — expected 1 batch of 2 named file rows with 1 cancel: " +
      JSON.stringify(queue),
    );
  }
  await oneSas(a, "tab A", "while a batch is queued");
  await a.evaluate(`(() => { document.querySelector('${QUEUED.card} ${QUEUED.cancel}').click(); return true; })()`);
  await a.waitFor(`!document.querySelector('${QUEUED.card}')`, "the cancelled queue entry to disappear");
  ok("a second selection queued visibly as one batch of two named files, kept both the picker and the composer usable, and cancelled by id");

  // ── 六、文件同意可以拒绝，而链路和会话都活下来 ────────────────────────────
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
    const alive = await tab.evaluate(`({
      heads: document.querySelectorAll('${HEAD}').length,
      composers: document.querySelectorAll('.msgpanel textarea').length,
    })`);
    if (alive.heads !== 1 || alive.composers !== 1) {
      throw new Error(`${who} lost the link or the conversation over one rejected batch: ${JSON.stringify(alive)}`);
    }
    await oneSas(tab, who, "after a rejected file batch");
  }
  ok("declining a file batch ended the batch and left the one link and its conversation open");

  // ── 七、正文逐字节一致，同时文件能力仍然可用 ──────────────────────────────
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
    throw new Error(`message body is not byte-identical\n      got  ${gotHex}\n      want ${utf8Hex(MSG_BODY)}`);
  }
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const code = await oneSas(tab, who, "with both lanes used on one link");
    if (code !== sasA) throw new Error(`${who} changed the link SAS mid-session: ${code} vs ${sasA}`);
  }
  await scanLiveState(b, "mixed workspace with both lanes live");
  ok(`text was exchanged byte-identically while the file control stayed usable, still under one SAS (${sasA})`);

  // ── 八、真传输断线后从 durable checkpoint 续传，不重新同意 ─────────────────
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
  await a.evaluate(pickFiles(`
    const body = new Uint8Array(${RESUME_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) % 251;
    dt.items.add(new File([body], 'resume-on-the-same-link.bin'));
  `));
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
      // 会话被传输中断关掉了（它没有前向恢复点），但**记录还在**，而且重开是一次
      // 显式动作而不是自动重连——自动重开会在对方那边再弹一次同意提示。
      transcript: document.querySelectorAll('.msg-body').length,
      restarts: document.querySelectorAll('.msgpanel .restart').length,
      attach: document.querySelectorAll('${ATTACH_FILE}').length,
    };
  })()`);
  const senderPcs = await a.evaluate("window.__e2ePeerConnections.length");
  if (
    resumed.bytes !== RESUME_BYTES || resumed.opens !== 1 || !resumed.closed ||
    resumed.mismatch !== -1 || resumed.requests !== 0 ||
    resumed.transcript !== 1 || resumed.restarts !== 1 || resumed.attach !== 1
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
    await chooserHidden(tab, who, "after a byte-level file resume");
  }
  ok(`a ${RESUME_BYTES}-byte file resumed exactly on rebuilt PeerConnections `
    + `(A ${pcCounts.a}→${senderPcs}, B ${pcCounts.b}→${resumed.peerConnections}), `
    + "keeping the transcript, the attachments and the SAS, and offering one explicit restart");

  // ── 九、320px、中英文和深色：最窄屏幕上头部仍可读、可操作、不溢出 ──────
  const painted = {};
  for (const variant of [
    { name: "320-ltr-light", width: 320, locale: "en", theme: "light" },
    { name: "320-zh-dark", width: 320, locale: "zh", theme: "dark" },
    { name: "390-zh-dark", width: 390, locale: "zh", theme: "dark" },
  ]) {
    await setWideViewport(b, variant.width, 568);
    await setLocale(b, variant.locale);
    await setTheme(b, variant.theme);
    await b.waitFor(
      "document.documentElement.dir === 'ltr'",
      `${variant.name} writing direction`,
    );
    const layout = await b.evaluate(`(() => {
      const head = document.querySelector('${HEAD}');
      const rect = head.getBoundingClientRect();
      const sas = head.querySelector('.sas').getBoundingClientRect();
      const dc = head.querySelector('.wh-disconnect').getBoundingClientRect();
      const panel = document.querySelector('.msgpanel');
      const attach = document.querySelector('.msgpanel .attach');
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        headOverflow: head.scrollWidth - head.clientWidth,
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 0,
        attachOverflow: attach ? attach.scrollWidth - attach.clientWidth : 0,
        inside: rect.left >= -1 && rect.right <= innerWidth + 1,
        sasInside: sas.left >= -1 && sas.right <= innerWidth + 1 && sas.top >= 0,
        disconnectInside: dc.left >= -1 && dc.right <= innerWidth + 1 && dc.height >= 24,
        // 两种维护语言都是 LTR；断开操作必须留在这一行的末端。
        disconnectAtRowEnd: rect.right - dc.right < dc.left - rect.left,
        headBackground: getComputedStyle(head).backgroundColor,
        headText: getComputedStyle(head.querySelector('.wh-state')).color,
      };
    })()`);
    if (
      layout.pageOverflow !== 0 || layout.headOverflow > 1 || layout.panelOverflow > 1 ||
      layout.attachOverflow > 1 ||
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
    await scanLiveState(b, `mixed workspace at ${variant.name}`);
    await screenshot(b, variant.name);
    ok(`${variant.name}: the workspace stayed inside the viewport, kept its row-end action and one SAS`);
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

  // ── 十、一次"活过了自己那条链路"的待决同意 ───────────────────────────────
  //
  // 这一幕针对的是一个很具体的怀疑：App 的 reveal 去重键是 `file:recv:<peer>` /
  // `text:<status>:<peer>`，**不含**链路世代。同一个对端、同一条通道，第二条链路
  // 算出来的键和第一条一模一样。如果那个键在两条链路之间没被清掉，第二次认证边就会
  // 被整个吞掉——而被吞掉的恰恰是"这是一串新的验证码"这件事，且只有读屏用户会被影响。
  //
  // 所以这里刻意把请求**挂着不答**就断链：那是唯一能让旧键还留在手上的时刻。
  await a.evaluate(pickOne("outlives-its-link.txt"));
  await b.waitFor("!!document.querySelector('.request')", "a second consent card on the same link", 40_000);
  const sameLinkEdge = await b.evaluate(announcementOf);
  if (!sameLinkEdge || sameLinkEdge.includes(sasB)) {
    throw new Error(`a later edge on the SAME link re-read the code: ${JSON.stringify(sameLinkEdge)}`);
  }

  await a.evaluate(`(() => { document.querySelector('${HEAD} .wh-disconnect').click(); return true; })()`);
  // B 手上挂着一张待决同意卡 = 该链路有活儿，所以传输一断 B 本来会把链路**留住**
  // （status=interrupted）等一个永远不会来的重建 offer——A 是显式断开的，它不会再发。
  // 现在 A 在断开的同一次调用里发出了一条认证过的 leave 信令，B 因此立刻拆掉，而不是
  // 白等满 LINK_RECOVERY_WINDOW_MS(90s)。这里给的余量是给信令往返和 HMAC 的，不是
  // 给那个窗口的：如果 leave 丢了或没被认可，这一步会退化成 90s，超时就会抓到。
  //
  // 窗口本身"有界、会取消、只发一次拆除"由 peer-link.test.ts 的假时钟用例钉住
  // （"leaves no timer or retry behind after an honoured leave" 及其邻居），
  // 不再靠在真浏览器里干等 90 秒来证明。
  await b.waitFor(`!document.querySelector('${HEAD}')`, "the announced departure to tear the held link down", 30_000);
  await b.waitFor("!document.querySelector('.request')", "the pending consent to die with its link");

  // 断开之后选择器立刻回来，而且回来的是同一个单动作卡片。
  await a.waitFor(`document.querySelectorAll('${OPEN_WORKSPACE}').length === 1`, "tab A's chooser to come back", 20_000);
  const afterDisconnect = await a.evaluate(`({
    heads: document.querySelectorAll('${HEAD}').length,
    // 统一草稿框不许活过一次显式断开：它是为上一条链路、上一个对端打的字。
    composers: document.querySelectorAll('.msgpanel textarea').length,
    attach: document.querySelectorAll('${ATTACH_FILE}').length,
    queued: document.querySelectorAll('${QUEUED.card}').length,
    sas: document.querySelectorAll('.sas').length,
  })`);
  if (afterDisconnect.heads !== 0 || afterDisconnect.composers !== 0 || afterDisconnect.attach !== 0
    || afterDisconnect.queued !== 0 || afterDisconnect.sas !== 0) {
    throw new Error(`tab A kept unified workspace state after Disconnect: ${JSON.stringify(afterDisconnect)}`);
  }
  ok("Disconnect restored the one-action chooser and left no unified composer or attachment behind");

  // 同一个对端、同一条通道 → 第二条链路会算出**同一个** reveal 键。
  //
  // 这里是新链路，不是新页面：两个标签页从头到尾没导航过，观察器早就在听，所以这两句
  // 会在第一次轮询就返回。留着它们是因为这条规矩属于"划线之前"，不属于"页面加载之后"
  // ——哪天这一幕改成重开页面或刷新，缺的那句等待必须在这里就被挡住。
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) await announcementsReady(tab, who);
  const relinkMark = { a: await announcedCount(a), b: await announcedCount(b) };
  await a.evaluate(`(() => { document.querySelector('${OPEN_WORKSPACE}').click(); return true; })()`);
  await a.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "a fresh link to the same peer", 60_000);
  await b.waitFor(`!!document.querySelector('${HEAD_SAS}')`, "tab B's fresh link header", 60_000);
  const relinked = await awaitTextConsent([["tab A", a], ["tab B", b]]);
  const sas2 = await oneSas(relinked.tab, relinked.who, "on a fresh link to the same peer");
  if (sas2 === sasB) {
    throw new Error(`the relink reused the first link's SAS (${sas2}); this scenario proves nothing`);
  }
  const freshSpoken = await announcedSince(
    relinked.tab, relinked.who === "tab A" ? relinkMark.a : relinkMark.b,
  );
  if (!freshSpoken.some((line) => line.includes(sas2))) {
    throw new Error(
      `a NEW link never announced its own code — the reveal key (peer+lane, no ` +
      `generation) suppressed it: ${JSON.stringify(freshSpoken)} lacks ${sas2}`,
    );
  }
  ok(`a fresh link to the same peer announced its own code (${sasB} → ${sas2}), same reveal key`);

  await relinked.tab.evaluate("(() => { document.querySelector('.msgpanel .act button.btn-ghost').click(); return true; })()");
  await relinked.tab.waitFor(`!document.querySelector('${TEXT_CONSENT}')`, "the fresh link's text consent to close");

  // ── 十一、显式断开：整个工作区收掉，两边都收掉 ───────────────────────────
  await a.evaluate(`(() => { document.querySelector('${HEAD} .wh-disconnect').click(); return true; })()`);
  await a.waitFor(`!document.querySelector('${HEAD}')`, "tab A's workspace to tear down");
  // 对端有两条路知道：A 断开时发出的那条认证 leave 信令，以及传输真的塌掉
  // （DTLS 关闭 / ICE 失联）。两条都有真实的传播时间，而且此刻 B 没有活跃的
  // lane、本来就不会留住链路，所以这里的窗口只是宽余量，不是在等谁超时。
  await b.waitFor(`!document.querySelector('${HEAD}')`, "tab B's workspace to tear down", 90_000);
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const after = await tab.evaluate(`({
      sas: document.querySelectorAll('.sas').length,
      heads: document.querySelectorAll('${HEAD}').length,
      queued: document.querySelectorAll('${QUEUED.card}').length,
      composers: document.querySelectorAll('.msgpanel textarea').length,
      attach: document.querySelectorAll('${ATTACH_FILE}').length,
      // 选择器回来了，而且回来的仍然是那一个动作。
      openWorkspace: document.querySelectorAll('${OPEN_WORKSPACE}').length,
      legacyPickers: document.querySelectorAll('.peer-actions .file-pick-input').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    if (
      after.sas !== 0 || after.heads !== 0 || after.queued !== 0 ||
      after.composers !== 0 || after.attach !== 0 ||
      after.openWorkspace !== 1 || after.legacyPickers !== 0 || after.overflow !== 0
    ) {
      throw new Error(`${who} did not tear the workspace down cleanly: ${JSON.stringify(after)}`);
    }
  }
  await screenshot(a, "after-disconnect");
  await scanLiveState(a, "chooser restored after an explicit disconnect");
  ok("one disconnect closed both lanes on both tabs and left the peer selectable again");

  const errs = [...a.errors, ...b.errors].filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`console errors during the mixed link:\n    ${errs.join("\n    ")}`);
  ok("no console errors on either tab");

  await browser.send("Target.closeTarget", { targetId: a.targetId });
  await browser.send("Target.closeTarget", { targetId: b.targetId });
}

async function main() {
  // 两条路，只有第一条要求外面有东西：`--url` 是显式的"打那台正在跑的"，其余一切
  // 都由这次运行自己拥有——自己构建、自己起、自己收。
  let server = null;
  let session = null;
  // 启动失败也要走 `fail`：它以前在 try 外面，于是"服务器起不来"会变成一个顶层未捕获
  // 拒绝，红是红了，但打印的是一条 Node 的栈，不是这套用例的名字。
  try {
    let base;
    // 目标先定下来，排在构建、浏览器和自起之前：坏掉的 `--url` 必须在这里红，而不是
    // 掉进自起那条路，去打一台调用者根本没有点名的服务器。
    const target = manualUrlFromArgv(process.argv.slice(2));
    if (target) {
      base = target;
      await requireServer(
        base,
        "start it with: cd web && npm run build, then " +
        "cd server && RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=:8098 go run . " +
        "(or drop --url and let this script start its own)",
      );
    } else {
      server = await startGoServer({ port: selfPort(), keep: KEEP, report: ok, label: "the mixed-link server" });
      base = server.base;
    }

    session = await launchBrowser({ debugPort: DEBUG_PORT, keep: KEEP });
    console.log(`\nMixed link E2E against ${base}${target ? " (--url)" : " (self-started)"}`);
    await mixedScenario(session.browser, base);
    console.log("\n\x1b[32mMixed link E2E passed\x1b[0m\n");
  } catch (err) {
    fail("Mixed link E2E", err);
  } finally {
    // 先浏览器后服务器，而且无论上面怎么结束都要收：一个活下来的服务器会占住端口，
    // 让**下一次**运行以一条指向完全无关原因的冲突收场。
    try { await session?.close(); } catch { /* best effort */ }
    try { await server?.stop(); } catch { /* best effort */ }
  }
}

await withWatchdog("Mixed link E2E", GLOBAL_TIMEOUT_MS, main);
