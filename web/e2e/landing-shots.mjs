/**
 * 首屏演示图：从**一次真实传输**里截出来，而不是摆拍。
 *
 * 为什么走 e2e 这条路而不是手工做图：手工素材做完那一刻就开始过期，而且没有任何东西
 * 会在 UI 变了之后告诉你它过期了。这个脚本复用 `harness.mjs`——同一个 CDP 客户端、
 * 同一套超时语义、同一个看门狗——开两个真标签页，让它们真的互相发现、真的传一个文件，
 * 在三个节点上截图。UI 一变，重跑一次就是新的图；UI 变坏了，这里会先超时。
 *
 * 三张图对应首屏想讲的三件事：
 *   1. 两台设备自己出现（不用登录、不用配对）
 *   2. 收方要确认，并且屏幕上有可比对的验证码
 *   3. 传完了
 *
 * 用法（要先起本地服务器）：
 *   cd server && RELAYIUM_ADDR=:8099 go run .
 *   cd web && npm run build && node e2e/landing-shots.mjs
 *
 * 产物写到 web/public/shots/。它们是提交进仓库的构建输入，不是临时文件——
 * 首屏引用它们，而重新生成的办法就是再跑一次这个脚本。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateTab, argFlag, argPresent, launchBrowser, newTab, ok, requireServer,
  setWideViewport, sleep, withWatchdog, SAVE_STUB, VERIFY_ON,
} from "./harness.mjs";

// withWatchdog 结尾会 process.exit()，所以它包的是整次运行，不是某个阶段——
// 按阶段用会在第一张图之后就退出。这里只在最外层用一次。

const BASE = argFlag("--url", "http://localhost:8099");
/**
 * 界面语言。图会进本地化落地页，而英文截图配中文页和英文 /pricing 配中文页脚是同一类
 * 缺陷——读者按自己的语言点进来，却看到看不懂的界面。所以每个语言各出一套。
 */
const LANG = argFlag("--lang", "en");
const LANG_INIT = `try { localStorage.setItem("relayium-lang", ${JSON.stringify(LANG)}); } catch {}`;
const DEBUG_PORT = Number(argFlag("--port", "9333"));
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "shots", LANG);

// 截图视口。用 setWideViewport 的默认值，不要自作聪明改窄：1200 宽时工作区切到
// 紧凑布局，主文件选择器 .file-pick-input 根本还没渲染出来，脚本会在第二张图上
// 报 "Cannot set properties of null"。图在首屏上是缩放展示的，宽一点无妨。
const SHOT_W = 1440;
// 视口调得比任何一屏内容都高，是为了让页面**根本不需要滚动**。
// 试过 scrollIntoView + 视口坐标，也试过 rect + scrollY 换算成页面坐标，两条路都栽在
// 同一件事上：这一页真正滚动的是工作区内部的容器，不是 window。不滚动的时候，元素
// 矩形、视口坐标、页面坐标三者相等，裁剪框就不可能指错地方。
const SHOT_H = 1800;

const PEERS_SEEN = "document.querySelectorAll('.pname').length > 0";
// 当前的统一工作区流程：名册里先出现「和 X 开一个共享工作区」，进去之后才有附件选择器。
// 别照抄已删除的 `lan-transfer.mjs`：它走的是有旧版对端在场时的降级路径，那条路上
// .file-pick-input 一开始就在，照抄会拍出一个真实用户看不到的界面。
// 按钮文案随语言变，所以按结构定位：对端卡片里那个唯一的主按钮。
const OPEN_WS = `document.querySelector('.peers .open-workspace')`;
const PICKER = "!!document.querySelector('.file-pick-input.attach-file')";
const SAS_SHOWN = "/\\d{6}/.test(document.body.textContent || '')";
// 同理：接受是请求卡片里的主按钮。要排除 .send——消息区的「发送」也是 btn-primary，
// 而它在 DOM 里就排在后面，用裸的 .btn-primary 会在某些时刻选错。
const ACCEPT_BTN = `document.querySelector('.lan-task button.btn-primary:not(.send)')`;

/** 发一个可预测的字节序列（`(i * 7 + 11) % 251`）。
 *  工作区里附加文件本身就发起了请求，不需要再点 Send（那个按钮是发文本的）。 */
const sendPayload = (tab, name, bytes) => tab.evaluate(`(() => {
  const input = document.querySelector('.file-pick-input.attach-file');
  const bytes = new Uint8Array(${bytes});
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

/**
 * 按元素算裁剪框，而不是写死一个矩形。
 *
 * 写死过一版 {x:0,y:0,h:640}，结果第二、三张图顶上是一大片空白——clip 用的是**页面
 * 坐标**，而那两个时刻页面已经滚下去了，y=0 指的是内容上方。所以这里取目标元素的
 * rect 再加上 scrollY 换算回页面坐标，顺带留一点内边距。
 */
async function clipFor(tab, elExpr) {
  // 用 DOM.getBoxModel 拿盒模型，而不是自己拿 getBoundingClientRect 去换算。
  //
  // 这一处错了三次，每次都是坐标空间的问题：视口坐标当页面坐标用、scrollIntoView 与
  // 量尺寸挤在同一次 evaluate 里、以为页面没滚而其实滚了 271px。三次的共同表现都是
  // 图恒定偏移，而断言查的是元素文本不是像素，所以一路都绿。getBoxModel 直接给页面
  // 空间的四边形，是 CDP 为这件事准备的 API，不需要我再算一遍。
  // 先把窗口滚回顶部，量尺寸和截图才在同一个坐标空间里。
  //
  // captureBeyondViewport 会以**未滚动**的状态重新渲染整页，而 getBoxModel 给的是当前
  // 滚动状态下的视口坐标——两者不在一个空间，差值就是当时的 scrollY（实测 271）。滚到
  // 顶之后两者重合，这个类问题就不存在了。这一处前后错了四次，每次的表现都是"图整体
  // 偏移一屏"，而断言查的是元素文本不是像素，所以一路都是绿的。
  await tab.evaluate("window.scrollTo(0, 0); true");
  await sleep(250);
  // requestNode 需要节点映射先建起来，否则报 "Could not find node with given id"。
  await tab.send("DOM.getDocument", { depth: -1 });
  const { result } = await tab.send("Runtime.evaluate", {
    expression: `(() => {
      const got = (${elExpr});
      const els = (Array.isArray(got) ? got : [got]).filter(Boolean);
      if (!els.length) return null;
      // 一组元素时用它们的共同祖先，这样"验证码卡片 + 请求卡片"能进同一张图。
      let el = els[0];
      while (el && !els.every((e) => el.contains(e))) el = el.parentElement;
      return el;
    })()`,
  });
  if (!result?.objectId) throw new Error(`nothing matched ${elExpr} — the shot would have been of blank page`);
  const { nodeId } = await tab.send("DOM.requestNode", { objectId: result.objectId });
  const { model } = await tab.send("DOM.getBoxModel", { nodeId });
  const q = model.border; // [x1,y1, x2,y2, x3,y3, x4,y4]，页面坐标
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const text = await tab.evaluate(`(() => {
    const got = (${elExpr});
    const els = (Array.isArray(got) ? got : [got]).filter(Boolean);
    return els.map((e) => e.textContent.replace(/\\s+/g, " ").trim()).join(" | ");
  })()`);
  const pad = 20;
  return {
    clip: {
      x: Math.max(0, Math.round(Math.min(...xs) - pad)),
      y: Math.max(0, Math.round(Math.min(...ys) - pad)),
      width: Math.min(SHOT_W, Math.round(Math.max(...xs) - Math.min(...xs) + pad * 2)),
      // 上限：工作区里消息区可以很长，整条拍下来缩到首屏就没法看了。
      height: Math.min(620, Math.round(Math.max(...ys) - Math.min(...ys) + pad * 2)),
      scale: 1,
    },
    text,
  };
}

/**
 * 拍一张，并且**断言拍到的是什么**。
 *
 * 一张框错了元素的图不会报错，它只是看起来很正常——第一版的 03-done 就框到了连接卡片
 * 而不是完成行，肉眼看图才发现。expect 让这种错误变成一条失败，而不是一张要人去看的
 * 坏图。
 */
async function shoot(browser, tab, name, elExpr, expect) {
  // 必须先把这个标签页切到前台。captureScreenshot 拍的是合成器的输出，后台标签页
  // 没有合成器输出，CDP 直接回 "Unable to capture screenshot" ——而这三张图里有两张
  // 来自当时不在前台的那个标签页。
  await activateTab(browser, tab);
  await sleep(250);
  const { clip, text } = await clipFor(tab, elExpr);
  if (!expect.test(text)) {
    throw new Error(`${name}: framed the wrong thing — expected ${expect}, got ${JSON.stringify(text.slice(0, 120))}`);
  }
  const { data } = await tab.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true, // clip 是页面坐标，见 clipFor 的注释
    clip,
  });
  const file = join(OUT_DIR, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  const kb = Math.round(Buffer.from(data, "base64").length / 1024);
  ok(`${name} — ${kb} kB`);
  return kb;
}

async function main() {
  console.log(`\n首屏演示图：真实传输，${BASE}，界面语言 ${LANG}\n`);
  await requireServer(BASE, "start it with: cd server && RELAYIUM_ADDR=:8099 go run .");
  mkdirSync(OUT_DIR, { recursive: true });

  const session = await launchBrowser({ debugPort: DEBUG_PORT, keep: argPresent("--keep") });
  const { browser } = session;
  const sizes = [];
  try {
    // 收方开着验证码：第二张图要拍的就是"有东西可以比对"。
    const sender = await newTab(browser, BASE + "/", LANG_INIT + VERIFY_ON);
    const receiver = await newTab(browser, BASE + "/", LANG_INIT + VERIFY_ON + SAVE_STUB);
    await setWideViewport(sender, SHOT_W, SHOT_H);
    await setWideViewport(receiver, SHOT_W, SHOT_H);

    await sender.waitFor(PEERS_SEEN, "peers on the sender");
    await receiver.waitFor(PEERS_SEEN, "peers on the receiver");
    // 名册刚出现的那一帧还在做入场动画，截下来是半透明的。
    await sleep(600);
    sizes.push(await shoot(browser, sender, "01-devices.png",
      "document.querySelector('.peers')", /./));

    await sender.evaluate(`(() => { (${OPEN_WS}).click(); return true; })()`);
    await sender.waitFor(PICKER, "the attach picker inside the workspace");
    await receiver.waitFor(SAS_SHOWN, "the verification code on the receiver");
    await sendPayload(sender, "quarterly-report.pdf", 3 * 1024 * 1024);
    await receiver.waitFor(`!!(${ACCEPT_BTN})`, "the confirmation card");
    await sleep(400);
    // 请求卡片没有稳定的类名，从 Accept 按钮往上找它所在的卡片——这比钉一个
    // 会被重构改掉的类名更耐用，也保证框住的一定是那张卡。
    sizes.push(await shoot(browser, receiver, "02-confirm.png",
      `[document.querySelector('.lan-task .ui-card'), (${ACCEPT_BTN}).closest('.ui-card')]`,
      /\d{6}/));

    await receiver.evaluate(`(() => { (${ACCEPT_BTN}).click(); return true; })()`);
    await receiver.waitFor("window.__e2e.closed === true", "the receiver to finish writing");
    // 收方的 .xfer 行才是"传完了"。发送方这时界面已经切到消息会话邀请，拍它会拍出
    // 一个和"完成"无关的画面——第一版正是这么错的。
    await receiver.waitFor("[...document.querySelectorAll('.xfer')].some(x => /✓/.test(x.textContent))", "the completed transfer row");
    await sleep(800);
    sizes.push(await shoot(browser, receiver, "03-done.png",
      "[...document.querySelectorAll('.xfer')].find(x => /✓/.test(x.textContent))", /✓/));

    // 页面报错会静静地毁掉一张图（半渲染的卡片看起来只是"设计如此"），所以出图前
    // 先要求这一次运行是干净的。
    const errs = [...sender.errors, ...receiver.errors];
    if (errs.length) throw new Error(`console errors during the run:\n  ${errs.join("\n  ")}`);

    console.log(`\n三张图共 ${sizes.reduce((a, b) => a + b, 0)} kB，写入 public/shots/\n`);
  } finally {
    await session.close();
  }
}

withWatchdog("首屏演示图", 5 * 60_000, () =>
  main().catch((err) => {
    console.error(`\n\x1b[31m✗\x1b[0m ${err.message}\n`);
    process.exitCode = 1;
  }),
);
