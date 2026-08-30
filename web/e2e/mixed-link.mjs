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
  OBSERVE_CAPS, SAVE_STUB, VERIFY_DEFAULT, VERIFY_ON, activateTab, argFlag, argPresent,
  distinctLanSeed, fail, launchBrowser, newTab, ok, requireServer, setWideViewport, withWatchdog,
} from "./harness.mjs";
import { QUEUED, RECEIVE, XFER } from "./dom-contracts.mjs";
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
const SCTP_DEFAULT_MAX_MESSAGE_BYTES = 65_536;
const EXPECTED_PICKER_CANCEL_ERROR =
  "relayium mixed file picker error SaveCancelledError: save picker cancelled by the user (showSaveFilePicker)";

/**
 * Make the remote endpoint advertise no SCTP message-size extension. RFC 8841
 * assigns 65,536 bytes when the attribute is absent; this asks Chromium itself
 * to apply that default instead of handing the app a mocked number.
 *
 * Only the description passed into the WebRTC engine changes. The signalling
 * object (and its commit/reveal or resume authentication) stays byte-for-byte
 * untouched.
 */
const OMIT_REMOTE_MAX_MESSAGE_SIZE = `
  window.__e2eMaxMessageSizeRemovals = 0;
  (() => {
    const realSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (description) {
      if (description?.sdp) {
        const sdp = description.sdp.replace(/^a=max-message-size:([1-9]\\d*)\\r?\\n/gm, () => {
          window.__e2eMaxMessageSizeRemovals++;
          return '';
        });
        description = { type: description.type, sdp };
      }
      return realSetRemoteDescription.call(this, description);
    };
  })();
`;

/**
 * Every act this scenario performs, frozen, in run order.
 *
 * One scenario is not one assertion. `mixedScenario` is a single function that
 * performs twenty distinct acts against one live link, and counting
 * *scenarios* — the shape `page-shell.mjs` uses, where there are four of them —
 * would report `1/1` for a run that silently stopped asserting nineteen of these.
 * That is precisely the vacuous-count failure `page-shell-contract.test.mjs`
 * exists to forbid, reappearing one level down.
 *
 * So the count is per act, and it is recorded by the acts themselves: `act()` is
 * called at the END of each one, after its assertions, so an act that threw or
 * was edited into a no-op never lands in the ledger. `main()` then compares the
 * ledger against this list AND against a literal count, in order — an act that
 * is deleted, reordered, or quietly skipped is three different failures here,
 * and none of them can pass.
 *
 * `EXPECTED_ACT_COUNT` is a literal and must stay one. Comparing against
 * `ACTS.length` would let a deleted entry agree with itself: the array shrinks,
 * its own length shrinks with it, and the run reports a clean `16/16`.
 */
const ACTS = Object.freeze([
  "advertised-link-1",
  "peer-card-one-action",
  "one-link-one-sas",
  "sctp-default-64k-boundary",
  "chooser-hidden",
  "workspace-header",
  "text-consent",
  "file-consent-40",
  "sticky-sas",
  "queued-batch",
  "declined-batch",
  "byte-identical-text",
  "mobile-no-picker-download",
  "picker-cancel-retry",
  "live-progressbar",
  "byte-resume",
  "narrow-locale-theme",
  "pending-consent-outlives-link",
  "fresh-link-new-sas",
  "explicit-disconnect",
]);
const EXPECTED_ACT_COUNT = 20;

/**
 * The second scenario's own frozen ledger, in run order.
 *
 * Kept as a SEPARATE list rather than appended to `ACTS`, because the two
 * scenarios are independent runs against independent tabs: a single flat list
 * would make "act #21 is missing" indistinguishable from "the second scenario
 * never started", and `runScenarios` could no longer say which journey diverged.
 * Every entry is prefixed `multipage-` so the two inventories cannot be confused
 * for one another by a source contract that greps `act(` calls file-wide.
 *
 * `EXPECTED_MULTIPAGE_ACT_COUNT` is a literal for exactly the reason
 * `EXPECTED_ACT_COUNT` is: comparing a list against its own `.length` still
 * agrees with itself after somebody deletes an entry from it.
 */
const MULTIPAGE_ACTS = Object.freeze([
  "multipage-one-device",
  "multipage-focus-handover",
  "multipage-request-follows-focus",
  "multipage-fallback-on-close",
  "multipage-sibling-reachable",
]);
const EXPECTED_MULTIPAGE_ACT_COUNT = 5;

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
/**
 * The phone boundary, installed on the receiver for exactly one act.
 *
 * Four things are replaced and all four are restored by `restore()` below, which
 * is the only reason this is one script rather than four inline snippets: the
 * desktop picker-cancellation act that runs immediately afterwards depends on
 * `window.showSaveFilePicker` being the *same function object* the harness's
 * `SAVE_STUB` installed at page init — it wraps it and calls through to it. A
 * restoration that merely installed "a working picker" would leave that act
 * measuring this stub instead.
 *
 * **Both pickers here WORK, and that is the whole anti-vacuity argument.** They
 * resolve to handles whose `createWritable()` really accepts bytes and counts
 * them. So "zero picker calls and zero handle bytes, alongside a complete
 * byte-exact browser download" is a combination no broken-picker fallback can
 * produce — a fallback would have had to call one first. It is reachable only by
 * the product deciding, up front, not to open them (`pickersAllowed()` in
 * `filesink.ts`).
 *
 * The download half is captured at the two boundaries the product actually uses
 * (`filesink.ts`'s `download()`): the object URL is recorded with the Blob it was
 * minted from, and the `<a download>` click is recorded and swallowed so a
 * headless browser never starts a real download. The bytes are read off the Blob
 * itself rather than by fetching `blob:` — production CSP does not allow `blob:`
 * in `connect-src`, so a fetch would fail on the stub rather than on the product.
 */
const MOBILE_PICKER_AND_DOWNLOAD_TRAP = `
  (() => {
    const realSave = window.showSaveFilePicker;
    const realDir = window.showDirectoryPicker;
    const realCreateObjectURL = URL.createObjectURL;
    const realAnchorClick = HTMLAnchorElement.prototype.click;
    const urls = new Map();
    const state = { saveCalls: 0, dirCalls: 0, handleBytes: 0, downloads: [] };
    // A handle that would really have taken the file. See the note above.
    const writable = {
      write: async (chunk) => { state.handleBytes += chunk.byteLength ?? chunk.size ?? 0; },
      close: async () => {},
    };
    const fileHandle = { createWritable: async () => writable };
    const dirHandle = {
      getFileHandle: async () => fileHandle,
      getDirectoryHandle: async () => dirHandle,
    };
    // Counted SEPARATELY: the product has two picker branches (flat single file
    // vs. everything else), and a single counter would let a run that opened the
    // directory picker pass as "the save picker was never opened".
    window.showSaveFilePicker = async () => { state.saveCalls++; return fileHandle; };
    window.showDirectoryPicker = async () => { state.dirCalls++; return dirHandle; };
    URL.createObjectURL = function (object) {
      const url = realCreateObjectURL.call(URL, object);
      urls.set(url, object);
      return url;
    };
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return realAnchorClick.call(this);
      state.downloads.push({ name: this.download, blob: urls.get(this.href) ?? null });
      return undefined;
    };
    state.restore = () => {
      window.showSaveFilePicker = realSave;
      window.showDirectoryPicker = realDir;
      URL.createObjectURL = realCreateObjectURL;
      HTMLAnchorElement.prototype.click = realAnchorClick;
      // Identity, not shape: the next act wraps the function it gets back and
      // calls through to it, so "a picker is installed" is not the property.
      const summary = {
        save: window.showSaveFilePicker === realSave,
        dir: window.showDirectoryPicker === realDir,
        createObjectURL: URL.createObjectURL === realCreateObjectURL,
        anchorClick: HTMLAnchorElement.prototype.click === realAnchorClick,
        saveCalls: state.saveCalls,
        dirCalls: state.dirCalls,
        handleBytes: state.handleBytes,
        downloads: state.downloads.length,
      };
      // Read once, into plain numbers, and then the state itself GOES — with the
      // captured Blob and the object-URL map it was pinning. Seven acts run
      // after this one on the same page; leaving a global behind that still
      // looks installed is how a later edit comes to read a boundary that is
      // not there and gets a stale zero instead of a failure.
      urls.clear();
      state.downloads.length = 0;
      delete window.__e2eMobile;
      return summary;
    };
    window.__e2eMobile = state;
    return true;
  })()
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

/**
 * The transfer cards whose single-file counter names EXACTLY this file.
 *
 * Scoping by name became load-bearing the moment this scenario grew a second
 * successful transfer. `.xfer.ok` anywhere on the page is now satisfiable by the
 * mobile download's terminal card, so a generic "wait for a successful transfer"
 * downstream of it would return immediately and every assertion after it would
 * describe the wrong transfer — a green run over a resume that never happened.
 *
 * `.count` is queried relative to the card because `dom-contracts.mjs` names the
 * document-rooted nodes (`XFER.ok`, `XFER.status`) and the card-relative bar
 * (`XFER.bar`), and there is no card-relative counter in it. A missing counter
 * therefore THROWS rather than filtering the card out: a card that stopped
 * rendering its file name would otherwise silently reduce every name-scoped
 * check here to `cards.length === 0`, which is a wait that can only time out
 * blaming the product.
 */
const namedTransferCards = (name) => `[...document.querySelectorAll('${XFER.card}')].filter((card) => {
  const counter = card.querySelector('.count');
  if (!counter) {
    throw new Error('a transfer card carries no file counter — every name-scoped check here would be vacuous');
  }
  return counter.textContent.trim() === ${JSON.stringify(name)};
})`;

/** That card, alone, finished successfully, with no in-flight bar left in it. */
const namedTransferSucceeded = (name) => `(() => {
  const cards = ${namedTransferCards(name)};
  return cards.length === 1 && cards[0].matches('${XFER.ok}') &&
    cards[0].querySelectorAll('${XFER.bar}').length === 0;
})()`;

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
      laneSas: document.querySelectorAll('.msgpanel .sas, ${RECEIVE.card} .sas').length,
      xferCodes: document.querySelectorAll('${XFER.laneCode}').length,
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

/**
 * A scenario's execution ledger. Empty until an act finishes.
 *
 * `act()` replaces the bare `ok()` at each act boundary rather than sitting
 * beside it, so "reported success" and "recorded as performed" are the same
 * statement and cannot drift apart. Sub-steps inside an act (the three viewport
 * variants, the console-error sweep) stay plain `ok()`: they are assertions, not
 * acts, and the ledger is about the acts.
 *
 * Shared by both scenarios on purpose. Two hand-written copies of this would be
 * two places for the duplicate/unknown-name guards to drift, and the second copy
 * is exactly the one that would be written without them.
 */
function newLedger(acts) {
  const ledger = [];
  const act = (name, message) => {
    // A typo here would otherwise register an act nobody can account for, and
    // the ordered comparison in `runScenarios()` would blame the act AFTER it.
    if (!acts.includes(name)) {
      throw new Error(`act ${JSON.stringify(name)} is not one of this scenario's frozen acts`);
    }
    if (ledger.includes(name)) throw new Error(`act ${JSON.stringify(name)} was recorded twice`);
    ledger.push(name);
    ok(message);
  };
  return { ledger, act };
}

/** `base` is a parameter now, not a module constant: it is whichever server this
 *  run is talking to — the one it started, or the one `--url` named. */
async function mixedScenario(browser, base) {
  const { ledger, act } = newLedger(ACTS);

  // A 发起，B 收（另存为被桩掉）。两边都装上只读的 caps 探针：跑任何断言之前先确认
  // 这个默认产物在这个 LAN 房间里真的通告了 link/1。
  // This scenario is about the unified workspace's verification presentation,
  // which only exists with advanced verification ON. It is off by default, so
  // both tabs opt in before boot.
  const a = await newTab(browser, base + "/", VERIFY_ON + OBSERVE_CAPS + TRACK_ANNOUNCEMENTS +TRACK_PEER_CONNECTIONS + OMIT_REMOTE_MAX_MESSAGE_SIZE);
  const b = await newTab(browser, base + "/", VERIFY_ON + OBSERVE_CAPS + TRACK_ANNOUNCEMENTS +SAVE_STUB + TRACK_PEER_CONNECTIONS + OMIT_REMOTE_MAX_MESSAGE_SIZE);
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
  act("advertised-link-1", "both tabs advertised link/1 from the default build and discovered each other");

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
  act("peer-card-one-action", "a link-capable LAN peer offered exactly one action and no file/folder/message fork");

  // A small real-Chromium boundary probe, in an existing tab rather than a
  // second full journey. The exact-limit send goes first; an oversize send is
  // allowed either to throw or to close the channel, but never to remain a
  // successful open send. These PCs are discarded from the product tracker
  // immediately afterwards so they cannot fake the resume replacement count.
  const sctpProbe = await b.evaluate(`(async () => {
    const left = new RTCPeerConnection();
    const right = new RTCPeerConnection();
    left.onicecandidate = (event) => event.candidate && right.addIceCandidate(event.candidate);
    right.onicecandidate = (event) => event.candidate && left.addIceCandidate(event.candidate);
    let remoteChannel;
    let resolveReceived;
    const received = new Promise((resolve) => { resolveReceived = resolve; });
    right.ondatachannel = (event) => {
      remoteChannel = event.channel;
      remoteChannel.onmessage = (message) => resolveReceived(message.data?.byteLength ?? message.data?.size ?? null);
    };
    const channel = left.createDataChannel('sctp-default-boundary');
    const opened = new Promise((resolve) => { channel.onopen = resolve; });
    await left.setLocalDescription(await left.createOffer());
    await right.setRemoteDescription(left.localDescription);
    await right.setLocalDescription(await right.createAnswer());
    await left.setRemoteDescription(right.localDescription);
    await opened;
    const attempt = (bytes) => {
      try { channel.send(new Uint8Array(bytes)); return 'sent'; }
      catch (error) { return error.name || 'threw'; }
    };
    const fitted = attempt(${SCTP_DEFAULT_MAX_MESSAGE_BYTES});
    const afterFitted = channel.readyState;
    const fittedReceived = await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('65,536-byte probe was not delivered')), 3_000)),
    ]);
    const oversized = attempt(${SCTP_DEFAULT_MAX_MESSAGE_BYTES + 1});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = {
      negotiated: left.sctp?.maxMessageSize ?? null,
      removals: window.__e2eMaxMessageSizeRemovals,
      fitted,
      afterFitted,
      fittedReceived,
      oversized,
      afterOversized: channel.readyState,
      remoteState: remoteChannel?.readyState ?? null,
    };
    left.close();
    right.close();
    return result;
  })()`);
  if (sctpProbe.negotiated !== SCTP_DEFAULT_MAX_MESSAGE_BYTES || sctpProbe.removals < 1 ||
      sctpProbe.fitted !== "sent" || sctpProbe.afterFitted !== "open" ||
      sctpProbe.fittedReceived !== SCTP_DEFAULT_MAX_MESSAGE_BYTES ||
      (sctpProbe.oversized === "sent" && sctpProbe.afterOversized === "open")) {
    throw new Error(`real Chromium did not enforce the absent-advertisement SCTP boundary: ${JSON.stringify(sctpProbe)}`);
  }
  const trackerBeforeProductLink = {
    a: await a.evaluate(`({ pcs: window.__e2ePeerConnections.length, removals: window.__e2eMaxMessageSizeRemovals })`),
    b: await b.evaluate(`(() => {
      const before = { pcs: window.__e2ePeerConnections.length, removals: window.__e2eMaxMessageSizeRemovals };
      window.__e2ePeerConnections.length = 0;
      window.__e2eMaxMessageSizeRemovals = 0;
      return before;
    })()`),
  };
  if (trackerBeforeProductLink.a.pcs !== 0 || trackerBeforeProductLink.a.removals !== 0 ||
      trackerBeforeProductLink.b.pcs !== 2 || trackerBeforeProductLink.b.removals < 1) {
    throw new Error(`the SCTP probe was not isolated from the product tracker: ${JSON.stringify(trackerBeforeProductLink)}`);
  }

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
  act("one-link-one-sas", `one action opened one link with one SAS on both tabs (${sasA})`);

  const initialProductCaps = {};
  for (const [who, tab] of [["a", a], ["b", b]]) {
    initialProductCaps[who] = await tab.evaluate(`({
      removals: window.__e2eMaxMessageSizeRemovals,
      sizes: window.__e2ePeerConnections.map((pc) => pc.sctp?.maxMessageSize ?? null),
    })`);
    if (initialProductCaps[who].sizes.length !== 1 ||
        initialProductCaps[who].sizes[0] !== SCTP_DEFAULT_MAX_MESSAGE_BYTES) {
      throw new Error(`tab ${who.toUpperCase()} did not build one product PC at the RFC default SCTP limit: ${JSON.stringify(initialProductCaps[who])}`);
    }
  }
  act("sctp-default-64k-boundary", `real Chromium applied the absent-advertisement default of ${SCTP_DEFAULT_MAX_MESSAGE_BYTES} bytes, rejected ${SCTP_DEFAULT_MAX_MESSAGE_BYTES + 1}, and both product PCs negotiated the same cap`);

  // 工作区一活起来，选择器和提示就整个收走。
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    await chooserHidden(tab, who, "right after the workspace opened");
  }
  act("chooser-hidden", "the chooser, the old peer actions and the availability hint all went away");

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
  act("workspace-header", "the header named the peer, the link state, one path and one explicit disconnect");

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
  act("text-consent", `${consent.who} completed the text consent without autofocus; both tabs got a composer`);

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
  await b.waitFor(`!!document.querySelector('${RECEIVE.card}')`, "tab B's file consent card", 45_000);
  await oneSas(b, "tab B", "while a 40-file batch awaits consent");

  const fileEdge = await mobileDecisionVisible(b, "tab B", RECEIVE.card, "a 40-file consent card");
  // 同一条链路的又一条边：码已经念过一次，而且一直挂在钉住的头部里，所以这里不该
  // 再念一遍。这正是那条"每条链路只念一次"的规矩，在真浏览器里验它。
  if (!fileEdge.announcement) throw new Error("the file consent edge announced nothing at all");
  if (fileEdge.announcement.includes(sasB)) {
    throw new Error(`a later edge on the SAME link re-read the code: ${JSON.stringify(fileEdge.announcement)}`);
  }
  await screenshot(b, "mobile-file-consent");
  await scanLiveState(b, "mixed file consent card (390px)");
  act("file-consent-40", "a 40-file batch chosen from the workspace stayed decidable at 390px without re-reading the code");

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
  act("sticky-sas", "the sole SAS stayed pinned after scrolling a long file manifest");

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
  act("queued-batch", "a second selection queued visibly as one batch of two named files, kept both the picker and the composer usable, and cancelled by id");

  // ── 六、文件同意可以拒绝，而链路和会话都活下来 ────────────────────────────
  // On the ordinary row the ghost button declines. This batch is 40 one-byte
  // files, so `RECEIVE.warning` cannot be raised and the row cannot be the
  // inverted one — see the note on RECEIVE, where the two buttons are named for
  // their presentation precisely because their meaning is branch-dependent.
  // Asserting the absence of the warning is what makes "ghost = decline" a fact
  // here rather than an assumption that can go stale silently.
  await b.evaluate(`(() => {
    if (document.querySelector('${RECEIVE.card} ${RECEIVE.warning}')) {
      throw new Error('the memory warning inverted the consent row; ${RECEIVE.ghost} is now "receive anyway"');
    }
    const reject = document.querySelector('${RECEIVE.card} ${RECEIVE.ghost}');
    if (!reject) throw new Error('no ghost action on the consent card');
    reject.click();
    return true;
  })()`);
  await b.waitFor(`!document.querySelector('${RECEIVE.card}')`, "the rejected file request to close");
  await a.waitFor(
    `!!document.querySelector('${XFER.card}') && !document.querySelector('${XFER.progressBar}')`,
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
  act("declined-batch", "declining a file batch ended the batch and left the one link and its conversation open");

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
  act("byte-identical-text", `text was exchanged byte-identically while the file control stayed usable, still under one SAS (${sasA})`);

  // ── 七之一、手机上一个选择器都不开，文件走浏览器下载并逐字节到手 ───────────
  //
  // Stranded unique #1, migrated here (Phase 3D C3b-6). It runs on the SAME live
  // link, between the byte-identical text act and the desktop picker act, so what
  // it proves is the unified `link/1` pipeline's mobile policy — not the retired
  // LAN fork's, which is where the assertion was written and where it has not
  // executed for weeks.
  //
  // **Be exact about what this is.** This is desktop Chromium wearing
  // a spoofed Android UA, with browser-boundary stubs. It is
  // not a real Android device, not a real system picker and not a real
  // Android download manager. What it does prove is the
  // product's own *proactive* rule: `pickersAllowed()` refuses the File System
  // Access branch on a phone before anything can go wrong, and the consent card
  // says so in advance. The reported field failures — a built-in browser whose
  // picker opens nothing, and Chrome's folder page where one stray Back cancels
  // the whole receive — are the reason that rule exists, and neither of them is
  // reproduced here. See MOBILE_PICKER_AND_DOWNLOAD_TRAP for why "zero picker
  // calls" is nonetheless not a statement about a broken picker.
  const MOBILE_NAME = "mobile-download-on-the-same-link.bin";
  const MOBILE_BYTES = 96 * 1024;
  /** The payload formula, written ONCE and interpolated into both the sending
   *  page and the verifying page. Two copies of it is how a "byte-exact"
   *  assertion quietly becomes an assertion that this file agrees with itself. */
  const MOBILE_BYTE_AT_I = "(i * 37 + 11) % 251";
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/140.0.7339.0 Mobile Safari/537.36";
  const ANDROID_PLATFORM = "Linux armv8l";
  /** The two maintained product languages. The hint must promise the Downloads
   *  directory in whichever one this run booted in — and must NOT be the picker
   *  sentence, which is the one it would say if the mobile gate had lifted. */
  const PROMISES_DOWNLOADS = /downloads|下载/i;
  const PROMISES_A_PICKER = /where to save|选择保存位置/i;

  const desktopAgent = await b.evaluate("({ userAgent: navigator.userAgent, platform: navigator.platform })");
  let restored = null;
  let cleanupFault = null;
  try {
    // The UA has to land BEFORE the batch is sent: `ReceiveActions` resolves
    // `asksWhereToSave()` when the consent card mounts, and nothing re-reads
    // `navigator` afterwards. Overriding it later would leave a desktop promise
    // on screen above a mobile code path — which is the accident, not the test.
    await b.send("Emulation.setUserAgentOverride", {
      userAgent: ANDROID_UA, platform: ANDROID_PLATFORM,
    });
    await b.waitFor(
      `navigator.userAgent === ${JSON.stringify(ANDROID_UA)} && navigator.platform === ${JSON.stringify(ANDROID_PLATFORM)}`,
      "tab B to report a phone user agent and platform",
      20_000,
    );
    await b.evaluate(MOBILE_PICKER_AND_DOWNLOAD_TRAP);

    // Prove the pickers are usable BEFORE relying on their silence, then reset
    // the counters — the same shape the SCTP probe above uses, and for the same
    // reason. "Zero picker calls" is only evidence about the product while
    // calling one would have succeeded and swallowed the bytes; over a stub that
    // throws it is a statement about the stub. Left to a source contract this
    // would be the one property of this act that no run can observe, because a
    // function nobody calls has an unobservable body.
    const pickersWork = await b.evaluate(`(async () => {
      const state = window.__e2eMobile;
      const saveHandle = await window.showSaveFilePicker({ suggestedName: 'usability-proof.bin' });
      const saveWritable = await saveHandle.createWritable();
      await saveWritable.write(new Uint8Array(3));
      await saveWritable.close();
      const dir = await window.showDirectoryPicker();
      const nested = await dir.getFileHandle('usability-proof.bin', { create: true });
      const dirWritable = await nested.createWritable();
      await dirWritable.write(new Uint8Array(5));
      await dirWritable.close();
      const proof = {
        saveCalls: state.saveCalls, dirCalls: state.dirCalls, handleBytes: state.handleBytes,
      };
      // Cleared here, so the proof cannot be mistaken for the product opening
      // one. Everything downstream reads counters that start at zero again.
      state.saveCalls = 0;
      state.dirCalls = 0;
      state.handleBytes = 0;
      return proof;
    })()`);
    if (pickersWork.saveCalls !== 1 || pickersWork.dirCalls !== 1 || pickersWork.handleBytes !== 8) {
      throw new Error(`the pickers this act proves are never opened are not usable, so their silence proves nothing: ${JSON.stringify(pickersWork)}`);
    }

    await a.evaluate(pickFiles(`
      const body = new Uint8Array(${MOBILE_BYTES});
      for (let i = 0; i < body.length; i++) body[i] = ${MOBILE_BYTE_AT_I};
      dt.items.add(new File([body], ${JSON.stringify(MOBILE_NAME)}));
    `));
    await b.waitFor(`!!document.querySelector('${RECEIVE.card}')`, "the phone's file consent card", 45_000);

    // Before the click, and this is the half the user actually complained about:
    // "no picker appeared and I had no idea what to choose". The card must say
    // where the file is going, and on a phone there is exactly one true answer.
    const mobileConsent = await b.evaluate(`(() => {
      const card = document.querySelector('${RECEIVE.card}');
      const hint = card.querySelector('${RECEIVE.saveHint}');
      const state = window.__e2eMobile;
      return {
        hint: (hint?.textContent ?? '').trim(),
        hints: card.querySelectorAll('${RECEIVE.saveHint}').length,
        // A retry hint would mean a picker was already opened and cancelled —
        // the desktop act's state, and the opposite of what this act asserts.
        retryHints: card.querySelectorAll('${RECEIVE.retryHint}').length,
        warnings: card.querySelectorAll('${RECEIVE.warning}').length,
        mobileUa: /Android/.test(navigator.userAgent),
        saveCalls: state.saveCalls,
        dirCalls: state.dirCalls,
        handleBytes: state.handleBytes,
        downloads: state.downloads.length,
      };
    })()`);
    if (
      !mobileConsent.mobileUa || mobileConsent.hints !== 1 || !mobileConsent.hint ||
      mobileConsent.retryHints !== 0 || mobileConsent.warnings !== 0 ||
      !PROMISES_DOWNLOADS.test(mobileConsent.hint) || PROMISES_A_PICKER.test(mobileConsent.hint) ||
      mobileConsent.saveCalls !== 0 || mobileConsent.dirCalls !== 0 ||
      mobileConsent.handleBytes !== 0 || mobileConsent.downloads !== 0
    ) {
      throw new Error(`the phone's consent card did not truthfully promise the Downloads directory before the click: ${JSON.stringify(mobileConsent)}`);
    }

    // 96 KiB, one flat file: far below the large-batch threshold, so this is the
    // ordinary row and its primary button accepts. Guard first, as everywhere
    // else — under the warning that very same button declines.
    await b.evaluate(`(() => {
      if (document.querySelector('${RECEIVE.card} ${RECEIVE.warning}')) {
        throw new Error('the memory warning inverted the phone consent row; ${RECEIVE.primary} is now decline');
      }
      document.querySelector('${RECEIVE.card} ${RECEIVE.primary}').click();
      return true;
    })()`);
    // The FIRST decisive boundary event, not the successful one. Waiting only
    // for the download makes this act unreadable in exactly the case it exists
    // to catch: with the mobile gate removed the product opens a picker, the
    // download is never minted, and the run spends the full 60 seconds before
    // reporting a missing download — a symptom two steps downstream of the
    // cause. Verified by temporarily bypassing `pickersAllowed()`: the act did
    // fail, correctly, but only after 60 seconds of "timed out waiting for the
    // phone's browser download".
    //
    // So both outcomes are polled together and whichever lands first decides.
    // A picker call is decisive the instant it is counted, and on the broken
    // path it is counted strictly before the download that will never arrive —
    // which turns that 60-second timeout into a near-immediate red naming the
    // picker, its branch, and the bytes the handle took.
    //
    // Order matters below: the counters are read and judged BEFORE the terminal
    // card wait and before the byte-exact assertions. Reaching those first
    // would spend another 40-second budget on a card that a picker-driven run
    // may well still complete — reporting "no download" or nothing at all,
    // rather than "a picker was opened".
    await b.waitFor(
      "window.__e2eMobile.downloads.length === 1 || window.__e2eMobile.saveCalls > 0 || window.__e2eMobile.dirCalls > 0",
      "the phone's first save decision: a browser download, or a picker it must never open",
      60_000,
    );
    const decision = await b.evaluate(`(() => {
      const state = window.__e2eMobile;
      return {
        saveCalls: state.saveCalls,
        dirCalls: state.dirCalls,
        handleBytes: state.handleBytes,
        downloads: state.downloads.length,
      };
    })()`);
    // Both branches and the handle's own byte counter, in the message: which
    // picker opened, and whether the file went into it, is the whole diagnosis.
    if (decision.saveCalls !== 0 || decision.dirCalls !== 0) {
      throw new Error(`the phone opened a save picker instead of downloading, so the mobile no-picker gate is gone: ${JSON.stringify(decision)}`);
    }
    await b.waitFor(
      namedTransferSucceeded(MOBILE_NAME),
      "the phone's own receive card to finish successfully",
      40_000,
    );

    const mobile = await b.evaluate(`(async () => {
      const state = window.__e2eMobile;
      const got = state.downloads[0];
      const blob = got?.blob ?? null;
      const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      let mismatch = -1;
      if (bytes) {
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] !== ${MOBILE_BYTE_AT_I}) { mismatch = i; break; }
        }
      }
      const cards = ${namedTransferCards(MOBILE_NAME)};
      const card = cards[0] ?? null;
      // Relative to the card for the same reason as the counter: the shared
      // constant is document-rooted, and this act is about THIS transfer.
      const status = card ? card.querySelector('.status') : null;
      if (card && !status) throw new Error('the named transfer card has no status line to read');
      return {
        downloads: state.downloads.length,
        // Zero, after a click that would have opened one on a desktop. Both
        // branches counted apart, and the handle's own byte counter with them:
        // a picker that was opened and written to cannot hide behind a Blob.
        saveCalls: state.saveCalls,
        dirCalls: state.dirCalls,
        handleBytes: state.handleBytes,
        name: got?.name ?? null,
        hasBlob: !!blob,
        declaredBytes: blob ? blob.size : -1,
        readBytes: bytes ? bytes.length : -1,
        mismatch,
        namedCards: cards.length,
        ok: card ? card.matches('${XFER.ok}') : false,
        bad: card ? card.matches('${XFER.bad}') : false,
        bars: card ? card.querySelectorAll('${XFER.bar}').length : -1,
        status: (status?.textContent ?? '').trim(),
        // The link, the conversation and the file lane all outlive it.
        heads: document.querySelectorAll('${HEAD}').length,
        composers: document.querySelectorAll('.msgpanel textarea').length,
        attachments: document.querySelectorAll('${ATTACH_FILE}').length,
        requests: document.querySelectorAll('${RECEIVE.card}').length,
      };
    })()`);
    // "No save location chosen — cancelled" / "未选择保存位置，已取消" is the exact
    // string a phone must never reach: it is what the product says when the
    // picker branch was entered and abandoned, and reporting a successful
    // receive as a cancellation is the field failure this whole policy exists to
    // prevent.
    //
    // Scoped to the two maintained runtime languages, English and Simplified
    // Chinese, because those are the only ones a run can boot in — the rest live
    // under `src/lib/i18n/archive/` and are not rendered by the product, so
    // matching their cancellation words would assert against copy that no longer
    // ships. Restoring a locale means adding its word here, next to
    // PROMISES_DOWNLOADS and PROMISES_A_PICKER, which are scoped the same way.
    const CANCEL_WORDS = /cancel|取消/i;
    if (
      mobile.saveCalls !== 0 || mobile.dirCalls !== 0 || mobile.handleBytes !== 0 ||
      mobile.downloads !== 1 || mobile.name !== MOBILE_NAME || !mobile.hasBlob ||
      mobile.declaredBytes !== MOBILE_BYTES || mobile.readBytes !== MOBILE_BYTES ||
      mobile.mismatch !== -1 || mobile.namedCards !== 1 || !mobile.ok || mobile.bad ||
      mobile.bars !== 0 || !mobile.status || CANCEL_WORDS.test(mobile.status) ||
      mobile.heads !== 1 || mobile.composers !== 1 || mobile.attachments !== 1 ||
      mobile.requests !== 0
    ) {
      throw new Error(`the phone did not receive ${MOBILE_BYTES} exact bytes through the browser download alone: ${JSON.stringify(mobile)}`);
    }
    for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
      const code = await oneSas(tab, who, "after a phone received a file with no picker");
      if (code !== sasA) throw new Error(`${who} changed the link SAS over the mobile download: ${code} vs ${sasA}`);
    }
    await screenshot(b, "mobile-no-picker-download");
  } finally {
    // Finally, and in this order: the desktop act that follows wraps the very
    // function objects this act replaced. A failure above must not leave a phone
    // UA and four stubbed browser boundaries behind for it to "prove" things on.
    //
    // Two restorations, and NEITHER may throw out of this block. A `finally`
    // that throws REPLACES the exception that sent it here — so if the act
    // failed while setting up, before the boundary existed, the run would report
    // `window.__e2eMobile is undefined` and the setup failure that is the actual
    // diagnosis would never be printed. Worse, the first fault would skip the
    // second restoration and hand the desktop acts a phone UA. So each is
    // caught, both always run, and a fault is re-raised below where it can only
    // be the whole story.
    try {
      // Conditional, because "the boundary was never installed" is the state a
      // setup failure leaves behind, and it is not a second failure.
      restored = await b.evaluate("(window.__e2eMobile ? window.__e2eMobile.restore() : null)");
    } catch (err) {
      cleanupFault = err;
    }
    try {
      await b.send("Emulation.setUserAgentOverride", {
        userAgent: desktopAgent.userAgent, platform: desktopAgent.platform,
      });
    } catch (err) {
      cleanupFault ??= err;
    }
  }
  // Outside the `finally`, so a real failure above propagates instead of being
  // masked by a restoration complaint about the state that failure left behind.
  // Reached only when the act itself succeeded, which is the only case in which
  // a cleanup fault is the most interesting thing that happened.
  if (cleanupFault) throw cleanupFault;
  if (!restored) {
    throw new Error("the phone boundary vanished before it could be restored, so the desktop acts that follow would run on a phone");
  }
  const desktopAgain = await b.evaluate(`({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    looksMobile: /Android|Mobile/i.test(navigator.userAgent),
  })`);
  if (
    !restored.save || !restored.dir || !restored.createObjectURL || !restored.anchorClick ||
    restored.saveCalls !== 0 || restored.dirCalls !== 0 || restored.handleBytes !== 0 ||
    restored.downloads !== 1 ||
    desktopAgain.userAgent !== desktopAgent.userAgent ||
    desktopAgain.platform !== desktopAgent.platform || desktopAgain.looksMobile
  ) {
    throw new Error(`the phone boundary was not exactly restored for the desktop acts that follow: ${JSON.stringify({ restored, desktopAgent, desktopAgain })}`);
  }
  act("mobile-no-picker-download",
    `a spoofed phone with two working pickers opened neither and still received ${MOBILE_BYTES} exact bytes `
    + "through the browser download, after being told in advance that it would");

  // ── 八、真传输断线后从 durable checkpoint 续传，不重新同意 ─────────────────
  const RESUME_BYTES = 5 * 1024 * 1024 + 73;
  /**
   * How long the receiver's stubbed sink sleeps per 192 KiB write — which is
   * what holds this transfer open, because the ACK credit window backpressures
   * the sender behind it.
   *
   * There are TWO of these, and the scene switches between them, because the
   * scene contains two pieces of work with budgets an order of magnitude apart.
   *
   * The arithmetic they share: `RESUME_BYTES` is ~27 chunks of `CHUNK_SIZE`
   * (192 KiB), and the gap opens after only two of them, so ~25 writes remain
   * for everything from the accept to the forced close.
   *
   * `SCAN_WRITE_DELAY_MS` covers act 八之一 only. That act injects axe (a
   * ~500 KB source string over CDP) and runs it, on two tabs — seconds of work.
   * At 20ms the remaining window is ~500ms, so the transfer would simply finish
   * first and the act would fail reporting a terminal card rather than an
   * accessibility result: a broken act wearing the costume of a real
   * regression. At 1000ms the window is ~25s for work that takes a few seconds.
   *
   * `RESUME_WRITE_DELAY_MS` is the value this scene ran at before act 八之一
   * existed, and it is restored the moment the last scan returns — deliberately
   * BEFORE the `pcCounts` read and the forced close, so nothing after the scan
   * pays the scan's throttle. Leaving the sink at 1000ms for the remaining
   * writes is what turned this scenario from ~10s into ~31s; it bought nothing,
   * because the forced close is one CDP round trip and 20ms per write is the
   * budget that was already proven sufficient for it.
   *
   * Measured, five consecutive runs: at the reset the receiver had written
   * exactly 393,216 bytes — still the two chunks it started from. Both axe
   * passes fit inside the FIRST 1000ms sleep, so all ~25 remaining writes were
   * being charged 1000ms apiece for nothing, and the runway the forced close
   * actually gets back is the full ~25 × 20ms ≈ 500ms.
   *
   * So the two numbers are not interchangeable and neither may be raised to the
   * other: lower `SCAN_WRITE_DELAY_MS` and the scan becomes timing-dependent,
   * raise `RESUME_WRITE_DELAY_MS` and the whole hosted job pays for it.
   * `go-server.test.mjs` pins both values and the order of the switch.
   */
  const SCAN_WRITE_DELAY_MS = 1000;
  const RESUME_WRITE_DELAY_MS = 20;
  await b.evaluate(`(() => {
    window.__e2e.chunks = [];
    window.__e2e.bytes = 0;
    window.__e2e.closed = false;
    window.__e2e.name = '';
    window.__e2e.opens = 0;
    window.__e2e.pickerCalls = 0;
    window.__e2e.writeDelayMs = ${SCAN_WRITE_DELAY_MS};
    const saveAfterFirstAttempt = window.showSaveFilePicker;
    window.showSaveFilePicker = async (...args) => {
      window.__e2e.pickerCalls++;
      if (window.__e2e.pickerCalls === 1) {
        throw new DOMException('e2e: user cancelled Save As', 'AbortError');
      }
      return saveAfterFirstAttempt(...args);
    };
    return true;
  })()`);
  await a.evaluate(pickFiles(`
    const body = new Uint8Array(${RESUME_BYTES});
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) % 251;
    dt.items.add(new File([body], 'resume-on-the-same-link.bin'));
  `));
  await b.waitFor(`!!document.querySelector('${RECEIVE.card}')`, "the resumable file consent card", 40_000);
  const consentBeforeCancel = await b.evaluate(`(() => ({
    head: (document.querySelector('${RECEIVE.card} ${RECEIVE.head}')?.textContent ?? '').trim(),
    files: [...document.querySelectorAll('${RECEIVE.card} ${RECEIVE.fileList} ${RECEIVE.fileName}')]
      .map((node) => node.textContent.trim()),
    badTransfers: document.querySelectorAll('${XFER.bad}').length,
  }))()`);
  const senderBeforeCancel = await a.evaluate(`({
    statuses: [...document.querySelectorAll('${XFER.status}')].map((node) => node.textContent.trim()),
    badTransfers: document.querySelectorAll('${XFER.bad}').length,
  })`);
  const pickerErrorWindow = { a: a.errors.length, b: b.errors.length };
  // One 5 MiB file: far below the large-batch threshold, so the row is the
  // ordinary one and its primary button accepts. Under `RECEIVE.warning` the
  // very same button declines, which is why the guard comes first and refuses
  // rather than adapting.
  await b.evaluate(`(() => {
    if (document.querySelector('${RECEIVE.card} ${RECEIVE.warning}')) {
      throw new Error('the memory warning inverted the consent row; ${RECEIVE.primary} is now decline');
    }
    document.querySelector('${RECEIVE.card} ${RECEIVE.primary}').click();
    return true;
  })()`);
  await b.waitFor(
    `!!document.querySelector('${RECEIVE.card} ${RECEIVE.retryHint}')`,
    "the same consent card to become retryable after the cancelled picker",
    20_000,
  );
  // Give an accidental automatic retry time to happen. The picker must remain
  // at one call until the second explicit click below supplies a new gesture.
  const afterPickerCancel = await b.evaluate(`(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const request = document.querySelector('${RECEIVE.card}');
    const retry = request?.querySelector('${RECEIVE.retryHint}');
    return {
      pickerCalls: window.__e2e.pickerCalls,
      opens: window.__e2e.opens,
      bytes: window.__e2e.bytes,
      closed: window.__e2e.closed,
      requests: document.querySelectorAll('${RECEIVE.card}').length,
      retryHints: request?.querySelectorAll('${RECEIVE.retryHint}').length ?? 0,
      retryText: (retry?.textContent ?? '').trim(),
      retryRole: retry?.getAttribute('role'),
      canAccept: !!request?.querySelector('${RECEIVE.primary}'),
      head: (request?.querySelector('${RECEIVE.head}')?.textContent ?? '').trim(),
      files: [...(request?.querySelectorAll('${RECEIVE.fileList} ${RECEIVE.fileName}') ?? [])]
        .map((node) => node.textContent.trim()),
      badTransfers: document.querySelectorAll('${XFER.bad}').length,
      composers: document.querySelectorAll('.msgpanel textarea').length,
      attachments: document.querySelectorAll('${ATTACH_FILE}').length,
    };
  })()`);
  if (
    afterPickerCancel.pickerCalls !== 1 || afterPickerCancel.opens !== 0 ||
    afterPickerCancel.bytes !== 0 || afterPickerCancel.closed ||
    afterPickerCancel.requests !== 1 || afterPickerCancel.retryHints !== 1 ||
    !afterPickerCancel.retryText || afterPickerCancel.retryRole !== "status" ||
    !afterPickerCancel.canAccept || afterPickerCancel.composers !== 1 ||
    afterPickerCancel.attachments !== 1 ||
    afterPickerCancel.head !== consentBeforeCancel.head ||
    JSON.stringify(afterPickerCancel.files) !== JSON.stringify(consentBeforeCancel.files) ||
    afterPickerCancel.badTransfers !== consentBeforeCancel.badTransfers
  ) {
    throw new Error(`picker cancellation did not preserve one retryable incoming consent: ${JSON.stringify({ consentBeforeCancel, afterPickerCancel })}`);
  }
  const senderAfterCancel = await a.evaluate(`({
    statuses: [...document.querySelectorAll('${XFER.status}')].map((node) => node.textContent.trim()),
    badTransfers: document.querySelectorAll('${XFER.bad}').length,
    composers: document.querySelectorAll('.msgpanel textarea').length,
    attachments: document.querySelectorAll('${ATTACH_FILE}').length,
  })`);
  if (JSON.stringify(senderAfterCancel.statuses) !== JSON.stringify(senderBeforeCancel.statuses) ||
      senderAfterCancel.badTransfers !== senderBeforeCancel.badTransfers ||
      senderAfterCancel.composers !== 1 || senderAfterCancel.attachments !== 1) {
    throw new Error(`picker cancellation changed the sender waiting on the same consent or killed its workspace: ${JSON.stringify({ senderBeforeCancel, senderAfterCancel })}`);
  }
  for (const [who, tab] of [["tab A", a], ["tab B", b]]) {
    const retrySas = await oneSas(tab, who, "after cancelling the save picker");
    if (retrySas !== sasA) throw new Error(`${who} changed the link SAS after picker cancellation: ${retrySas} vs ${sasA}`);
  }
  // Product code deliberately logs the classified cancellation. Consume only
  // the one exact entry caused inside this act's marked window; anything before
  // the mark, after this point, duplicated, or differently classified remains a
  // real journey failure in the final console sweep.
  const pickerWindowErrors = {
    a: a.errors.slice(pickerErrorWindow.a),
    b: b.errors.slice(pickerErrorWindow.b),
  };
  const pickerErrorLines = pickerWindowErrors.b[0]?.split("\n") ?? [];
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/$/, "");
  const builtAssetFrame = new RegExp(
    `^    at (?:async )?[A-Za-z_$][A-Za-z0-9_$]* \\(${escapedBase}/assets/index-[A-Za-z0-9_-]+\\.js:\\d+:\\d+\\)$`,
  );
  if (pickerWindowErrors.a.length !== 0 || pickerWindowErrors.b.length !== 1 ||
      pickerErrorLines.length !== 3 || pickerErrorLines[0] !== EXPECTED_PICKER_CANCEL_ERROR ||
      !pickerErrorLines.slice(1).every((line) => builtAssetFrame.test(line))) {
    throw new Error(`picker cancellation logged an unexpected error set: ${JSON.stringify(pickerWindowErrors)}`);
  }
  b.errors.splice(pickerErrorWindow.b, 1);

  // This second click is the only event allowed to reopen the picker.
  await b.evaluate(`(() => {
    if (document.querySelector('${RECEIVE.card} ${RECEIVE.warning}')) {
      throw new Error('the memory warning inverted the retry consent row; ${RECEIVE.primary} is now decline');
    }
    document.querySelector('${RECEIVE.card} ${RECEIVE.primary}').click();
    return true;
  })()`);
  await b.waitFor(
    "window.__e2e.bytes >= 393216 && !window.__e2e.closed",
    "at least two durable chunks before the forced transport gap",
    40_000,
  );
  const retriedPicker = await b.evaluate(`({
    pickerCalls: window.__e2e.pickerCalls,
    opens: window.__e2e.opens,
    name: window.__e2e.name,
    bytes: window.__e2e.bytes,
    requests: document.querySelectorAll('${RECEIVE.card}').length,
  })`);
  if (retriedPicker.pickerCalls !== 2 || retriedPicker.opens !== 1 ||
      retriedPicker.name !== "resume-on-the-same-link.bin" ||
      retriedPicker.bytes < 393216 || retriedPicker.requests !== 0) {
    throw new Error(`the explicit retry did not open one fresh picker and start the same transfer: ${JSON.stringify(retriedPicker)}`);
  }
  act("picker-cancel-retry", "a real AbortError kept one incoming consent, link, SAS and composer alive; only a second explicit click reopened the picker");

  // ── 八之一、传输**进行中**的进度条：读屏能拿到的名字和百分比 ───────────────
  //
  // Stranded unique #6, migrated here (Phase 3D C3b-1). It was the last live
  // `role="progressbar"` assertion in the repository, and it sat in
  // `lan-transfer.mjs`'s non-executing tail — written, and proving nothing.
  //
  // This is the only moment in the whole suite at which the assertion can be
  // made. The receiver is throttled by `SCAN_WRITE_DELAY_MS` (see its own note —
  // that number exists for this act, and is dropped back to
  // `RESUME_WRITE_DELAY_MS` the moment the act ends), at least two durable
  // chunks are on disk, and the forced transport gap has not been opened yet, so
  // a genuinely in-flight transfer is on both screens. Every other state this
  // scenario visits has already reached a terminal one, and the progress bar
  // renders only inside `{#if !xf.done}` (see XFER) — scanning any of them for
  // an in-flight progress bar would scan an element that is not there and pass
  // for that reason alone.
  //
  // So the subject is PROVED first and scanned second. A scoped `axe.run` over a
  // context that matches nothing reports zero violations, which is exactly the
  // shape of a clean result; without the existence proof this act would keep
  // printing "axe clean" long after the thing it is named for stopped rendering.
  for (const [who, tab, dir] of [["tab A", a, "send"], ["tab B", b, "recv"]]) {
    const live = await tab.evaluate(`(() => {
      // The card is found by DIRECTION, not by taking the first one on the page.
      // A page can legitimately hold a send card and a recv card at once, and
      // "the first .xfer" would then silently assert the wrong direction — and,
      // once one of the two finished, assert a terminal card while reporting the
      // name of the live one.
      const labelId = 'xfer-label-${dir}';
      const heading = document.getElementById(labelId);
      const card = heading ? heading.closest('${XFER.card}') : null;
      if (!card) {
        throw new Error(
          'no ${dir} transfer card on ${who}: nothing on the page is headed by ' + labelId +
          '. The transfer never started, or the per-direction heading id moved.',
        );
      }
      const bar = card.querySelector('${XFER.bar}');
      if (!bar) {
        throw new Error(
          'no in-flight progress bar in the ${dir} card on ${who}: the transfer is already ' +
          'terminal, or the bar left its {#if !xf.done} branch. Either way this act has no ' +
          'live subject left to scan.',
        );
      }
      const labelledBy = bar.getAttribute('aria-labelledby');
      const namedBy = labelledBy ? document.getElementById(labelledBy) : null;
      return {
        // In flight, not finished. The whole value of scanning HERE rather than
        // anywhere else in this scenario is that this stays false.
        terminal: card.matches('${XFER.ok}, ${XFER.bad}'),
        // One bar per card. Two would mean two progressbars claiming one name.
        bars: card.querySelectorAll('${XFER.bar}').length,
        role: bar.getAttribute('role'),
        labelledBy,
        // The accessible name axe's aria-progressbar-name rule resolves. An
        // aria-labelledby pointing at nothing reads exactly like a bare bar in
        // an axe report, so resolve it here and say which of the two broke.
        name: (namedBy?.textContent ?? '').trim(),
        valueNow: bar.getAttribute('aria-valuenow'),
        valueMin: bar.getAttribute('aria-valuemin'),
        valueMax: bar.getAttribute('aria-valuemax'),
        // What the card says is moving — the same node the name resolves to, read
        // through the shared selector so a rename breaks here and not in axe.
        label: (card.querySelector('${XFER.label}')?.textContent ?? '').trim(),
      };
    })()`);
    const pct = Number(live.valueNow);
    if (
      live.bars !== 1 || live.terminal || live.role !== "progressbar" ||
      live.labelledBy !== `xfer-label-${dir}` || !live.name || !live.label ||
      live.valueMin !== "0" || live.valueMax !== "100" ||
      !Number.isInteger(pct) || pct < 0 || pct > 100
    ) {
      throw new Error(
        `${who} had no usable in-flight progressbar (want one ${dir} bar named by ` +
        `xfer-label-${dir}, 0 ≤ aria-valuenow ≤ 100): ${JSON.stringify(live)}`,
      );
    }
    // Scoped to the card, not the page: this act is about the transfer surface
    // that only exists mid-flight, and a document-wide scan would pass on the
    // strength of the rest of the workspace even after the bar lost its name.
    await scanLiveState(tab, `${who}: live ${dir} progressbar mid-transfer`, { context: XFER.card });
  }
  act("live-progressbar", "an in-flight transfer showed one named progressbar per direction, axe clean while the bytes were moving");

  /**
   * The scan is over, so the scan's throttle goes away — here, and not one step
   * later.
   *
   * Everything below is the resume scene: read the PeerConnection counts, kill
   * both transports, wait for the rebuilt ones to carry the remaining bytes. All
   * of it ran at `RESUME_WRITE_DELAY_MS` before act 八之一 existed, and none of
   * it is faster for being throttled — the receiving sink's sleep is pure
   * wall-clock the whole scenario pays. Measured: restoring it here takes the
   * whole run from ~31s back to ~12s.
   *
   * The transfer must still be live at this point, and that is asserted rather
   * than assumed: if the two axe passes ever ran long enough to let the file
   * finish, every wait below would time out describing something else (the
   * sender "never entering resume"), and the scene would have silently degraded
   * into a plain uninterrupted transfer.
   */
  const beforeReset = await b.evaluate(`(() => {
    if (window.__e2e.closed) return { closed: true, bytes: window.__e2e.bytes };
    window.__e2e.writeDelayMs = ${RESUME_WRITE_DELAY_MS};
    return { closed: false, bytes: window.__e2e.bytes };
  })()`);
  if (beforeReset.closed) {
    throw new Error(
      `the ${RESUME_BYTES}-byte transfer finished during the live progressbar scans ` +
      `(${beforeReset.bytes} bytes written) — the forced transport gap below has nothing ` +
      `left to interrupt. Raise SCAN_WRITE_DELAY_MS or shorten the scan.`,
    );
  }
  ok(`the receiver's throttle went back to ${RESUME_WRITE_DELAY_MS}ms with `
    + `${beforeReset.bytes}/${RESUME_BYTES} bytes written`);

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
    `document.querySelector('${XFER.status}')?.textContent.includes('resume')`,
    "the sender to visibly enter resume",
    20_000,
  );
  await b.waitFor(
    `document.querySelector('${XFER.status}')?.textContent.includes('resume')`,
    "the receiver to visibly enter resume",
    20_000,
  );
  await b.waitFor(
    `window.__e2e.closed && window.__e2e.bytes === ${RESUME_BYTES}`,
    "the resumed destination to close at the exact declared size",
    90_000,
  );
  // Name-scoped, not "some successful transfer somewhere on the page". This
  // scenario now completes a 96 KiB mobile download BEFORE this point, so the
  // generic form is satisfiable by a card belonging to a different transfer —
  // and a resume that never resumed would have sailed straight through it. See
  // `namedTransferCards`.
  await a.waitFor(
    namedTransferSucceeded("resume-on-the-same-link.bin"),
    "the resumed sender's own card to complete",
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
      pickerCalls: window.__e2e.pickerCalls,
      name: window.__e2e.name,
      closed: window.__e2e.closed,
      mismatch,
      requests: document.querySelectorAll('${RECEIVE.card}').length,
      peerConnections: window.__e2ePeerConnections.length,
      messageSizes: window.__e2ePeerConnections.map((pc) => pc.sctp?.maxMessageSize ?? null),
      // 会话被传输中断关掉了（它没有前向恢复点），但**记录还在**，而且重开是一次
      // 显式动作而不是自动重连——自动重开会在对方那边再弹一次同意提示。
      transcript: document.querySelectorAll('.msg-body').length,
      restarts: document.querySelectorAll('.msgpanel .restart').length,
      attach: document.querySelectorAll('${ATTACH_FILE}').length,
    };
  })()`);
  const senderCapState = await a.evaluate(`({
    peerConnections: window.__e2ePeerConnections.length,
    messageSizes: window.__e2ePeerConnections.map((pc) => pc.sctp?.maxMessageSize ?? null),
  })`);
  const senderPcs = senderCapState.peerConnections;
  if (
    resumed.bytes !== RESUME_BYTES || resumed.opens !== 1 || resumed.pickerCalls !== 2 ||
    resumed.name !== "resume-on-the-same-link.bin" || !resumed.closed ||
    resumed.mismatch !== -1 || resumed.requests !== 0 ||
    resumed.transcript !== 1 || resumed.restarts !== 1 || resumed.attach !== 1 ||
    resumed.messageSizes.length !== resumed.peerConnections ||
    !resumed.messageSizes.every((size) => size === SCTP_DEFAULT_MAX_MESSAGE_BYTES) ||
    senderCapState.messageSizes.length !== senderCapState.peerConnections ||
    !senderCapState.messageSizes.every((size) => size === SCTP_DEFAULT_MAX_MESSAGE_BYTES)
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
  act("byte-resume", `a ${RESUME_BYTES}-byte file resumed exactly on rebuilt PeerConnections `
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
  act("narrow-locale-theme", `dark mode really repainted the header (bg ${painted.light.bg} → ${painted.dark.bg})`);
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
  await b.waitFor(`!!document.querySelector('${RECEIVE.card}')`, "a second consent card on the same link", 40_000);
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
  await b.waitFor(`!document.querySelector('${RECEIVE.card}')`, "the pending consent to die with its link");

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
  act("pending-consent-outlives-link", "Disconnect restored the one-action chooser and left no unified composer or attachment behind");

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
  act("fresh-link-new-sas", `a fresh link to the same peer announced its own code (${sasB} → ${sas2}), same reveal key`);

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
  act("explicit-disconnect", "one disconnect closed both lanes on both tabs and left the peer selectable again");

  const errs = [...a.errors, ...b.errors].filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`console errors during the mixed link:\n    ${errs.join("\n    ")}`);
  ok("no console errors on either tab");

  await browser.send("Target.closeTarget", { targetId: a.targetId });
  await browser.send("Target.closeTarget", { targetId: b.targetId });
  return ledger;
}

/**
 * Read-only probe of what the SERVER told this page: its own peer id from the
 * welcome frame, the ids in the latest roster, and every physical departure.
 *
 * Deliberately observing real frames rather than application state, and it is
 * the one place this scenario is allowed to. The defect it covers is about
 * *identity* — which page of a browser a peer is offered, and which one a
 * request reaches — and two pages of one browser carry the same device name, so
 * the DOM alone genuinely cannot tell them apart. It also lets the scenario wait
 * on an observable condition (the roster the server actually sent) instead of
 * sleeping and hoping a handover has landed.
 *
 * What it is NOT is a shortcut for the product behaviour underneath. Every
 * assertion about a request arriving is made against rendered product UI, driven
 * by the product's own `.open-workspace` control; the frames here are only used
 * to name the pages and to know when the server has finished changing its mind.
 * `go-server.test.mjs` fails if a signal-frame read is ever substituted for the
 * composer proof.
 *
 * Installed as an init script, i.e. before the app's own socket exists: a
 * `welcome` observed after the app has already joined is a `welcome` that was
 * missed, and a missed one is indistinguishable from a page that never joined.
 */
const OBSERVE_ROSTER = `
  window.__selfId = "";
  window.__roster = null;
  window.__leftPeers = [];
  (() => {
    const Real = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new Real(...a);
      ws.addEventListener("message", (ev) => {
        try {
          const e = JSON.parse(ev.data);
          if (e && e.type === "welcome") window.__selfId = e.name;
          if (e && e.type === "peers") window.__roster = e.peers.map((p) => p.id);
          if (e && e.type === "left") window.__leftPeers.push(e.peer);
        } catch { /* not a frame we read */ }
      });
      return ws;
    };
    window.WebSocket.prototype = Real.prototype;
  })();
`;

/**
 * The background page's latch, armed BEFORE the request is sent.
 *
 * A card that appeared and then vanished is the same defect as one that stayed —
 * the user was looking at another page either way — so a single read after the
 * fact would miss precisely the transient case. Hence a MutationObserver that
 * counts, rather than a final `querySelector`.
 *
 * `chooser` is the anti-vacuity half and is not optional. Every other counter
 * here is asserted to be **zero**, and zero is also what a latch that was never
 * installed, or whose selectors no longer match anything, reports. `chooser`
 * counts a control the background page certainly does have, so a run can only
 * reach "composer 0, chooser > 0" by the observer genuinely looking at a live
 * DOM with working selectors and finding no request there.
 *
 * `look` is exposed so the scenario can take one final, timing-independent
 * sample after the foreground assertions have passed, rather than trusting that
 * a mutation happened to fire last.
 */
const ARM_BACKGROUND_LATCH = `(() => {
  window.__e2eBackground = { panel: 0, composer: 0, request: 0, head: 0, chooser: 0, ticks: 0 };
  const look = () => {
    const seen = window.__e2eBackground;
    seen.ticks++;
    if (document.querySelector('.msgpanel')) seen.panel++;
    if (document.querySelector('.msgpanel textarea')) seen.composer++;
    if (document.querySelector('${TEXT_CONSENT}')) seen.request++;
    if (document.querySelector('${HEAD}')) seen.head++;
    if (document.querySelector('${OPEN_WORKSPACE}')) seen.chooser++;
  };
  window.__e2eBackgroundLook = look;
  new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
  look();
  return true;
})()`;

/** The chooser is BACK — not merely somewhere on the page.
 *
 *  Both halves are load-bearing. The workspace head has to be gone, because the
 *  head and a chooser button can be mounted in the same frame while the
 *  workspace is still holding the screen; and the count has to be exactly one,
 *  because "a chooser exists" would also be satisfied by a roster that grew a
 *  duplicate entry for the device this scenario has just proved is one device. */
const CHOOSER_ONLY =
  `!document.querySelector('${HEAD}') && document.querySelectorAll('${OPEN_WORKSPACE}').length === 1`;

/** Every control the workspace head can offer, in the order to prefer them.
 *
 *  `WorkspaceHeader.svelte` renders exactly one of these at a time, off its
 *  `terminal` derivation: a named `endReason` or a plain `failed` status gets
 *  `.wh-restart`, which answers the explanation and tears nothing down
 *  (`restartWorkspace` → `dismissLinkEnd`); anything still live — including the
 *  `interrupted` hold that a page-close leaves behind — gets `.wh-disconnect`,
 *  which ends the link (`disconnectWorkspace` → `workspace.disconnect`).
 *
 *  BOTH are enumerated because which one a page-close leaves on screen is a
 *  product race this scenario has no business pinning — not because a recovery
 *  is expected to answer them in sequence. Restart is listed first so that a
 *  read which somehow observes both takes the one belonging to a link that no
 *  longer exists.
 *
 *  Frozen, and shared with the source contract in `go-server.test.mjs`: a third
 *  control appearing in that header is a product change this helper has to be
 *  taught, not one it may walk past. */
const HEAD_CONTROLS = Object.freeze([
  Object.freeze({ action: "restart", selector: `${HEAD} .wh-restart` }),
  Object.freeze({ action: "disconnect", selector: `${HEAD} .wh-disconnect` }),
]);

/** The budget for the whole recovery: finding the control, and the chooser
 *  coming back after it is answered. One deadline shared by both waits rather
 *  than a literal on each, so what this helper can cost is the number written
 *  here and not a multiple of it. */
const CHOOSER_RECOVERY_BUDGET_MS = 40_000;

/**
 * What the page is actually showing — read while the tab is still alive, for a
 * failure message.
 *
 * `unsupported` is here because of what two real acceptance runs turned out to
 * be. B ended up with **no** head, **no** chooser and one `.pa-unsupported`
 * line: the product had decided the surviving sibling was too old to talk to,
 * because its capability hello had been pruned along with the roster entry the
 * closed page owned. A bare "chooser never came" timeout cannot tell that apart
 * from a dozen unrelated faults, and the first diagnosis made from one was
 * wrong.
 */
const HEAD_STATE = `(() => {
  const selectors = ${JSON.stringify(HEAD_CONTROLS.map((c) => c.selector))};
  return {
    head: !!document.querySelector('${HEAD}'),
    chooser: document.querySelectorAll('${OPEN_WORKSPACE}').length,
    unsupported: document.querySelectorAll('.pa-unsupported').length,
    controls: ${JSON.stringify(HEAD_CONTROLS.map((c) => c.action))}
      .filter((_, i) => !!document.querySelector(selectors[i])),
  };
})()`;

/**
 * Answer the one control the workspace head is offering, and get the one-action
 * chooser back — entirely through the product's own controls.
 *
 * A page-close leaves the surviving side holding a link whose peer is gone, and
 * the header it renders for that is not one settled state: `.wh-disconnect`
 * while `mixed-session.svelte.ts` still holds the link `interrupted`,
 * `.wh-restart` once it has settled terminally. Both are legitimate starting
 * points, so both are enumerated and whichever is on screen is answered.
 *
 * It is deliberately ONE answer, not a loop. An earlier revision of this helper
 * kept clicking, on a theory that Disconnect was asynchronously followed by a
 * terminal `.wh-restart` card the first click could not have reached. A run with
 * a diagnostic disproved that: after Disconnect the head is simply gone, and
 * what was missing was the chooser's action, because the peer read as
 * unsupported. Machinery built for a transition that does not happen is not free
 * — it is a second place for this journey to hang, and prose asserting a product
 * behaviour nobody observed.
 *
 * The bounds that do matter are kept:
 *
 *  - **one deadline** for the whole recovery, shared by both waits rather than
 *    restarted per wait;
 *  - **no sleeps** — every wait is a condition on real product DOM, because a
 *    pause "to let it settle" passes on a build where the chooser never returns;
 *  - **it refuses to succeed by doing nothing** — a head with no control, or a
 *    page with neither head nor chooser, is an explicit error rather than a
 *    return that hands the caller a click on a control that is not there;
 *  - **the failing state is reported**, not just the timeout.
 */
async function returnToChooser(tab, who) {
  const deadline = Date.now() + CHOOSER_RECOVERY_BUDGET_MS;
  const left = () => Math.max(1, deadline - Date.now());
  const onScreen = async () => {
    try { return JSON.stringify(await tab.evaluate(HEAD_STATE)); }
    catch { return "unavailable"; } // the tab is gone; the timeout is the honest part
  };

  const anyControl = HEAD_CONTROLS.map((c) => `!!document.querySelector('${c.selector}')`).join(" || ");
  try {
    await tab.waitFor(
      `(${CHOOSER_ONLY}) || (${anyControl})`,
      `${who}'s one-action chooser, or one workspace control to answer`,
      left(),
    );
  } catch (err) {
    throw new Error(`${err.message}; nothing answered yet; on screen: ${await onScreen()}`);
  }

  const took = await tab.evaluate(`(() => {
    if (!document.querySelector('${HEAD}')) {
      return document.querySelectorAll('${OPEN_WORKSPACE}').length === 1 ? 'chooser' : 'nothing';
    }
    for (const control of ${JSON.stringify(HEAD_CONTROLS.map(({ action, selector }) => ({ action, selector })))}) {
      const el = document.querySelector(control.selector);
      if (el) { el.click(); return control.action; }
    }
    return 'nothing';
  })()`);

  if (took === "chooser") return "already-chooser";
  if (took === "nothing") {
    throw new Error(
      `${who} showed neither the chooser nor an answerable workspace head; on screen: ${await onScreen()}`,
    );
  }
  // The two generated lists disagreeing would mean a click this helper cannot
  // account for. Unreachable while they are generated from one frozen roster,
  // which is the point of asserting it rather than assuming it.
  if (!HEAD_CONTROLS.some((c) => c.action === took)) {
    throw new Error(`${who} answered an unknown workspace control ${JSON.stringify(took)}`);
  }

  try {
    await tab.waitFor(CHOOSER_ONLY, `${who}'s one-action chooser after "${took}"`, left());
  } catch (err) {
    throw new Error(`${err.message}; answered: ${took}; on screen: ${await onScreen()}`);
  }
  return took;
}

/**
 * Two pages of one browser are ONE device, and a request lands on the page the
 * user is actually looking at.
 *
 * This is the reported defect: several identically named pages of one phone were
 * offered as separate devices, so the other device could pick one, and the
 * request would land on a page nobody was looking at — one side sat on "waiting
 * for the other device to accept…" forever while another page of the same
 * browser was perfectly able to start its own session.
 *
 * It is a second, independent scenario rather than more acts on the first one
 * because it needs three tabs with deliberately chosen installation identities,
 * and because it must run with advanced verification OFF: the property under
 * test is *where the request arrives*, and a consent gate would turn every
 * arrival assertion into an assertion about a human clicking Accept.
 *
 * It is driven entirely through the current `link/1` surface — the single
 * `.open-workspace` action and the workspace's own composer. The legacy
 * per-peer-card message control this defect was originally found on no longer
 * exists in the product, and asserting against a control no user can reach would
 * be worse than asserting nothing. `go-server.test.mjs` fails if one reappears
 * here.
 *
 * Asserts, in order:
 *  1. an independently seeded device sees the two-page browser exactly ONCE, and
 *     neither page lists its own sibling as a target;
 *  2. focus decides the representative, in BOTH directions, and doing so is not
 *     a departure — no page physically leaves the room to make it happen;
 *  3. the request opened from the other device reaches the focused page and the
 *     opener, and the background page never renders one, not even briefly;
 *  4. closing the represented page reports exactly that page as gone and falls
 *     back to the live sibling — one entry, never a duplicate, never the dead id;
 *  5. the device is still genuinely usable afterwards: B regains exactly one
 *     enabled action for the surviving page, and a second workspace opened
 *     through that control reaches it. This is where the roster's fallback stops
 *     being cosmetic — the surviving page's capability hello was pruned along
 *     with the roster entry its sibling owned, and until becoming the current
 *     page re-stated it, B rendered the survivor as a peer too old to talk to.
 */
async function multiPageDeviceScenario(browser, base) {
  const { ledger, act } = newLedger(MULTIPAGE_ACTS);

  // One installation, two pages — and the shared seed is the ONLY thing making
  // them one device. `newTab` hands every other tab in this file its own seed,
  // so a scenario that forgot to pass this would quietly be testing three
  // independent devices and every grouping assertion below would be vacuous.
  // B's seed is passed explicitly rather than left to the default for the same
  // reason in reverse: "distinct" is load-bearing here, not incidental.
  const installation = distinctLanSeed();
  const otherDevice = distinctLanSeed();
  if (installation === otherDevice) {
    throw new Error(`the two-page browser and the third device were given the same seed ${installation}`);
  }
  const boot = VERIFY_DEFAULT + OBSERVE_ROSTER;
  const a1 = await newTab(browser, base + "/", boot, { lanSeed: installation });
  const a2 = await newTab(browser, base + "/", boot, { lanSeed: installation });
  const b = await newTab(browser, base + "/", boot, { lanSeed: otherDevice });
  for (const tab of [a1, a2, b]) await setWideViewport(tab);

  const joined = "!!window.__selfId && Array.isArray(window.__roster)";
  for (const [who, tab] of [["A1", a1], ["A2", a2], ["B", b]]) {
    await tab.waitFor(joined, `page ${who} to join the LAN room`, 30_000);
  }
  const ids = {
    a1: await a1.evaluate("window.__selfId"),
    a2: await a2.evaluate("window.__selfId"),
    b: await b.evaluate("window.__selfId"),
  };
  // Three distinct connections. If the server ever handed two of them the same
  // peer id, every roster assertion below would be comparing a name to itself.
  if (new Set(Object.values(ids)).size !== 3) {
    throw new Error(`the three pages were not given three distinct peer ids: ${JSON.stringify(ids)}`);
  }

  // Departures, restricted to the three pages this scenario owns.
  //
  // NOT a softening of the exactness below — it is what makes it possible. This
  // is the second scenario in the run, and the first one closes its own two tabs
  // immediately before this one opens its three. The server's `left` frames for
  // those can legitimately land after B's observer is already listening, so an
  // unrestricted ledger would carry a straggler that has nothing to do with the
  // property under test. Scoped this way, "exactly one page left, and it is the
  // one that was closed" stays an exact claim about the subject.
  const owned = JSON.stringify([ids.a1, ids.a2, ids.b]);
  const departuresOfOurs = () => b.evaluate(`window.__leftPeers.filter((id) => ${owned}.includes(id))`);

  // ── 1. Grouping, from both sides ─────────────────────────────────────────
  const rosterIs = (id) => `JSON.stringify(window.__roster) === ${JSON.stringify(JSON.stringify([id]))}`;
  await b.waitFor("window.__roster.length === 1", "device B to see the two pages as ONE device", 30_000);
  for (const [who, tab] of [["A1", a1], ["A2", a2]]) {
    // Exact, not "includes B": a page that listed its own sibling alongside B
    // would satisfy a membership check and is the other half of this defect.
    await tab.waitFor(rosterIs(ids.b), `page ${who} to see only the other device (never its own sibling)`, 30_000);
  }
  const bSees = await b.evaluate("window.__roster");
  if (bSees.length !== 1 || (bSees[0] !== ids.a1 && bSees[0] !== ids.a2)) {
    throw new Error(`B was offered ${JSON.stringify(bSees)}, want exactly one of A's two pages`);
  }
  act("multipage-one-device", "two pages of one browser were advertised as a single device, and never to each other");

  // ── 2. Focus decides the representative, both ways, without a departure ───
  // Both directions, so a one-way "whichever joined last wins" cannot pass. The
  // departure ledger is read on both sides of the handover: re-representing a
  // device must be a change of which page speaks for it, NOT the old page
  // leaving the room and the new one arriving. A product that achieved the
  // roster shape by dropping and rejoining would satisfy every assertion above
  // and would drop live links every time the user switched tabs.
  const leftBeforeHandover = await departuresOfOurs();
  if (leftBeforeHandover.length !== 0) {
    throw new Error(`a page left the room before the handover even started: ${JSON.stringify(leftBeforeHandover)}`);
  }
  await activateTab(browser, a2);
  await b.waitFor(rosterIs(ids.a2), "the device to be represented by the page the user switched to (A2)", 30_000);
  await activateTab(browser, a1);
  await b.waitFor(rosterIs(ids.a1), "the representative to hand back to A1 on focus", 30_000);
  const leftAfterHandover = await departuresOfOurs();
  if (leftAfterHandover.length !== 0) {
    throw new Error(
      `moving the representative reported ${leftAfterHandover.length} physical departure(s) ` +
      `${JSON.stringify(leftAfterHandover)} — a focus change must not present as a device leaving`,
    );
  }
  act("multipage-focus-handover", "focus moved the device's representative in both directions, always as one entry and with nobody leaving");

  // ── 3. The request follows focus, and no other page of that browser sees it ─
  // A1 is the focused page after the handover above. The latch goes on A2 BEFORE
  // the request is sent, so a card that appeared and vanished still fails.
  await a2.evaluate(ARM_BACKGROUND_LATCH);
  await b.waitFor(
    `document.querySelectorAll('${OPEN_WORKSPACE}').length === 1` +
    ` && !document.querySelector('${OPEN_WORKSPACE}').disabled`,
    "B's single workspace action for the A device",
    30_000,
  );
  await b.evaluate(`(() => { document.querySelector('${OPEN_WORKSPACE}').click(); return true; })()`);

  // Verification is off (VERIFY_DEFAULT), so the receiving page auto-accepts the
  // text session (`autoAcceptsIncomingText`) and both sides land in the
  // composer. A request routed to the background page would leave B waiting here
  // instead — which is exactly the reported failure.
  await a1.waitFor("!!document.querySelector('.msgpanel textarea')", "the FOCUSED page (A1) to receive the request", 40_000);
  await b.waitFor("!!document.querySelector('.msgpanel textarea')", "B's composer (the request was accepted, not left waiting)", 40_000);
  const background = await a2.evaluate("(() => { window.__e2eBackgroundLook(); return window.__e2eBackground; })()");
  if (!(background.ticks > 0) || !(background.chooser > 0)) {
    throw new Error(
      `the background latch on A2 never observed a live DOM, so its zeroes mean nothing: ` +
      `${JSON.stringify(background)}`,
    );
  }
  if (background.panel !== 0 || background.composer !== 0 || background.request !== 0 || background.head !== 0) {
    throw new Error(`the background page rendered a request: ${JSON.stringify(background)}`);
  }
  act("multipage-request-follows-focus", "the request reached the page the user was looking at, and no other page of that browser");

  // ── 4. The represented page goes away mid-session ────────────────────────
  await browser.send("Target.closeTarget", { targetId: a1.targetId });
  await b.waitFor(
    `window.__leftPeers.includes(${JSON.stringify(ids.a1)})`,
    "the server's physical-leave event for the closed page",
    30_000,
  );
  // Exactly that page, and only it. `includes` alone would also pass if the
  // surviving sibling had been reported gone too — which is how "the device fell
  // back" and "the device disappeared and something else took its place" get
  // confused. This is the assertion a fabricated or over-broad leave fails.
  const departed = await departuresOfOurs();
  if (JSON.stringify(departed) !== JSON.stringify([ids.a1])) {
    throw new Error(
      `B saw departures ${JSON.stringify(departed)}; want exactly the page that was closed ` +
      `${JSON.stringify([ids.a1])}`,
    );
  }
  await b.waitFor(rosterIs(ids.a2), "the device to fall back to its surviving page, still as one entry", 30_000);
  // Read back exactly, after the wait: the wait proves it arrived, this proves
  // it is still the whole roster and not one entry beside a stale dead id.
  const afterClose = await b.evaluate("window.__roster");
  if (JSON.stringify(afterClose) !== JSON.stringify([ids.a2])) {
    throw new Error(`B's roster settled on ${JSON.stringify(afterClose)}; want exactly ${JSON.stringify([ids.a2])}`);
  }
  act("multipage-fallback-on-close", "closing the represented page reported exactly that page gone and handed the device to its sibling");

  // ── 5. Still reachable: a second workspace, through the product's control ──
  //
  // The activation is not cosmetic and is not merely "give A2 the focus it
  // needs to receive". It is the product path this act exists to prove. B pruned
  // A2's capability hello while A1 represented the installation (`retainPeers`
  // is per-roster, and the two pages are ONE roster entry), and A2's own roster
  // never changed, so nothing in `CapsAnnouncer`'s roster path would ever send
  // it again — B would show A2 as a peer it has no announcement for, i.e. "too
  // old", with no action on the card, permanently. Becoming the current page
  // re-states it (`refreshPresent`, sent alongside `sendActivate`). Two real
  // runs failed here before that existed, and the chooser assertion below is the
  // one that catches it: the head goes away on Disconnect either way, but the
  // action only comes back if B knows what A2 speaks.
  await activateTab(browser, a2);
  // B is still holding the workspace its now-closed peer was on. That reads as
  // interrupted (`.wh-disconnect`) or as ended (`.wh-restart`) depending on how
  // far the link has settled, which is a race this scenario has no business
  // pinning — so the chooser is recovered through whichever control the product
  // is actually offering, under one bounded deadline, and the act records which.
  const answered = await returnToChooser(b, "B");
  // Exactly ONE action, on a page with no workspace head left, and enabled.
  // This is the capability assertion in product terms: a B that had lost A2's
  // hello reaches this line with zero actions and a `.pa-unsupported` line where
  // the button should be. Restated at the call site rather than left to
  // `returnToChooser` alone, because regaining the action for the SURVIVING page
  // is what this act is for, not an incidental step towards the click below.
  await b.waitFor(
    `(${CHOOSER_ONLY}) && !document.querySelector('${OPEN_WORKSPACE}').disabled`,
    "B to be offered exactly one enabled action for the surviving page",
    30_000,
  );
  await b.evaluate(`(() => { document.querySelector('${OPEN_WORKSPACE}').click(); return true; })()`);
  try {
    await a2.waitFor("!!document.querySelector('.msgpanel textarea')", "the surviving page to receive the next request", 40_000);
    await b.waitFor("!!document.querySelector('.msgpanel textarea')", "B's composer on the second workspace", 40_000);
  } catch (err) {
    // The failure this scenario exists to catch looks identical to a timeout
    // from a dozen unrelated causes, so the diagnosis is captured while the
    // pages are still alive rather than reconstructed from a bare timeout.
    const snapshot = (tab) => tab.evaluate(`({
      roster: window.__roster,
      left: window.__leftPeers,
      head: !!document.querySelector('${HEAD}'),
      chooser: document.querySelectorAll('${OPEN_WORKSPACE}').length,
      unsupported: document.querySelectorAll('.pa-unsupported').length,
      panel: document.querySelector('.msgpanel')?.textContent ?? '',
    })`);
    throw new Error(`${err.message}; diagnostics=${JSON.stringify({ b: await snapshot(b), a2: await snapshot(a2) })}`);
  }
  act("multipage-sibling-reachable", `closing the represented page left the device usable: a second workspace opened after "${answered}" and reached the sibling`);

  const errs = [...a2.errors, ...b.errors].filter((e) => !/401|Failed to load resource/.test(e));
  if (errs.length) throw new Error(`console errors during the multi-page scenario:\n    ${errs.join("\n    ")}`);
  ok("no console errors on either surviving tab");

  await browser.send("Target.closeTarget", { targetId: a2.targetId });
  await browser.send("Target.closeTarget", { targetId: b.targetId });
  return ledger;
}

/**
 * The runner inventory. Two scenarios, each with its own frozen act ledger.
 *
 * `page-shell.mjs` can count scenarios because it has four independent ones. A
 * count of `1/1` would survive `mixedScenario` being edited down to its first
 * assertion, so the literals that actually protect this suite are the per-act
 * counts, and `runScenarios` checks the scenario count and both of them.
 *
 * Each entry carries the list its ledger is compared against AND the fixed
 * literal that list's length must equal. Never `SCENARIOS.length` /
 * `acts.length`: an array and its own length always agree, including after
 * somebody deletes an entry from it.
 */
const EXPECTED_SCENARIO_COUNT = 2;
const SCENARIOS = [
  { label: "mixed link", run: mixedScenario, acts: ACTS, expectedActs: EXPECTED_ACT_COUNT },
  {
    label: "multi-page device identity",
    run: multiPageDeviceScenario,
    acts: MULTIPAGE_ACTS,
    expectedActs: EXPECTED_MULTIPAGE_ACT_COUNT,
  },
];

async function runScenarios(browser, base) {
  let ran = 0;
  const results = [];
  for (const scenario of SCENARIOS) {
    // No catch here, deliberately: a swallowed scenario that still reached
    // `ran++` is the failure this counter exists to make impossible.
    results.push({ scenario, ledger: await scenario.run(browser, base) });
    ran++;
  }
  if (ran !== EXPECTED_SCENARIO_COUNT) {
    throw new Error(`ran ${ran}/${EXPECTED_SCENARIO_COUNT} mixed-link scenarios — expected exactly ${EXPECTED_SCENARIO_COUNT}`);
  }
  for (const { scenario, ledger } of results) {
    // Order as well as membership: an act that moved is an act whose
    // preconditions moved with it — the resume/progressbar pair, and the
    // multi-page focus handover that has to happen before the page it elected is
    // closed, only mean anything in the order they are written.
    const expected = scenario.acts;
    const drift = expected.findIndex((name, i) => ledger[i] !== name);
    if (ledger.length !== scenario.expectedActs || drift !== -1) {
      throw new Error(
        `performed ${ledger.length}/${scenario.expectedActs} ${scenario.label} acts` +
        (drift === -1 ? "" : `, first divergence at #${drift + 1}: expected ${JSON.stringify(expected[drift])}, got ${JSON.stringify(ledger[drift])}`) +
        `\n    performed: ${JSON.stringify(ledger)}` +
        `\n    expected:  ${JSON.stringify([...expected])}`,
      );
    }
    console.log(`\n${ledger.length}/${scenario.expectedActs} ${scenario.label} acts performed, in order`);
  }
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
    await runScenarios(session.browser, base);
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
