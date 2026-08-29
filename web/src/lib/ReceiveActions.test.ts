// 实时接收侧的内存提示。比异步下载页那条更危险：req.files 带 path（文件夹拖放
// 产出的），无 File System Access API 时 pickSaveTarget 会走 ZipWriter —— 每个
// 文件先攒 parts[]、close 时 concat 复制一份进 zip、finish 再拼出完整 zip 缓冲，
// 峰值约 2× 批次总量。而下载页那条永远进不到 ZIP 分支（StoredManifest 无 path）。
//
// 核心行为：提示显示时，一个字节都不开始接收 —— 接受传输的按钮根本不存在，
// 只有明确的「仍要接收」才走 onAccept。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";

import ReceiveActions from "./ReceiveActions.svelte";
import { loadLang, messages, setLang } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES } from "./filesink";
// The strings `web/e2e/mixed-link.mjs` clicks in a real browser. Import, do not
// retype — see the last describe block for why the primary/ghost pair in
// particular cannot be left to two private copies, and why they are not named
// for what they do.
import { RECEIVE } from "../../e2e/dom-contracts.mjs";

let target: HTMLDivElement;
let app: unknown;
let onAccept: ReturnType<typeof vi.fn<() => void>>;
let onReject: ReturnType<typeof vi.fn<() => void>>;
let restorePickers: () => void;

/** 装/卸假的 File System Access 选择器（与 filesink.test.ts 同一手法）。 */
function stubPickers(on: boolean): () => void {
  const w = window as unknown as Record<string, unknown>;
  const had = { save: "showSaveFilePicker" in w, dir: "showDirectoryPicker" in w };
  if (on) {
    w.showSaveFilePicker = async () => ({});
    w.showDirectoryPicker = async () => ({});
  } else {
    delete w.showSaveFilePicker;
    delete w.showDirectoryPicker;
  }
  return () => {
    if (!had.save) delete w.showSaveFilePicker;
    if (!had.dir) delete w.showDirectoryPicker;
  };
}

async function mountActions(o: {
  canStream: boolean;
  files: { name: string; size: number; path?: string }[];
  retry?: boolean;
}) {
  await loadLang("en");
  restorePickers = stubPickers(o.canStream);
  const total = o.files.reduce((n, f) => n + f.size, 0);
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ReceiveActions, {
    target,
    props: { files: o.files, total, retry: o.retry === true, onAccept, onReject },
  });
  flushSync();
}

const t = () => messages.en;
const buttons = () => Array.from(target.querySelectorAll("button"));
const byText = (label: string) => buttons().find((b) => b.textContent!.trim() === label);

const BIG = LARGE_DOWNLOAD_WARN_BYTES + 1;
const SMALL = 1024 * 1024;
const flat = (size: number) => [{ name: "big.mp4", size }];
const folder = (size: number) => [{ name: "big.mp4", size, path: "trip/big.mp4" }];

/** 把 navigator.userAgent 换成手机的；返回还原函数。 */
function stubUA(ua: string): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  return () => {
    if (had) Object.defineProperty(navigator, "userAgent", had);
    else delete (navigator as unknown as Record<string, unknown>).userAgent;
  };
}

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Mobile Safari/537.36";

let restoreUA: () => void;
/** `setLang` mutates module state that outlives one test, so the one case that
 *  renders in zh puts it back rather than leaving the rest of the file to
 *  depend on the order it happens to run in. */
let restoreLang: () => Promise<void>;

beforeEach(() => {
  onAccept = vi.fn();
  onReject = vi.fn();
  restorePickers = () => {};
  restoreUA = () => {};
  restoreLang = async () => {};
});

afterEach(async () => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  restorePickers();
  restoreUA();
  await restoreLang();
});

describe("ReceiveActions 实时接收的内存提示", () => {
  it("无流式落盘能力 + 大文件夹：显示提示，且一个字节都不开始接收", async () => {
    await mountActions({ canStream: false, files: folder(BIG) });

    const warn = target.querySelector(".memwarn");
    expect(warn, "应显示内存提示").not.toBeNull();
    expect(warn!.textContent!.trim().length).toBeGreaterThan(0);
    // 核心断言：提示不是装饰。接受传输的按钮必须不存在，onAccept 也不能被调用。
    expect(byText(t().accept), "提示状态下不应存在直接接收的按钮").toBeUndefined();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("提示后点「仍要接收」，接收真的开始", async () => {
    await mountActions({ canStream: false, files: folder(BIG) });
    expect(onAccept).not.toHaveBeenCalled();

    byText(t().recvMemWarnAccept)!.click();
    flushSync();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("有流式落盘能力 + 大文件夹：照常接收，不提示", async () => {
    await mountActions({ canStream: true, files: folder(BIG) });

    expect(target.querySelector(".memwarn"), "桌面 Chrome 那条路多大都行").toBeNull();
    byText(t().accept)!.click();
    flushSync();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("无流式落盘能力 + 小文件：照常接收，不提示", async () => {
    await mountActions({ canStream: false, files: flat(SMALL) });

    expect(target.querySelector(".memwarn")).toBeNull();
    byText(t().accept)!.click();
    flushSync();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("文件夹按 2× 峰值判断：扁平不提示的量，作为文件夹就提示", async () => {
    const half = 130 * 1024 * 1024;
    await mountActions({ canStream: false, files: flat(half) });
    expect(target.querySelector(".memwarn"), "扁平批次峰值 1×，不越线").toBeNull();

    unmount(app as never);
    app = null;
    target.remove();
    restorePickers();

    await mountActions({ canStream: false, files: folder(half) });
    expect(target.querySelector(".memwarn"), "ZIP 分支峰值 2×，越线").not.toBeNull();
  });

  // 用户的原话是「没看到任何选择器，也不知道该怎么选」。所以点之前必须先说清楚
  // 点下去会发生什么，而且这句话得跟着真实分支走，不能跟着「API 属性在不在」走。
  it("桌面（选择器可用）：先告诉用户会弹出保存位置选择器", async () => {
    await mountActions({ canStream: true, files: flat(SMALL) });
    const hint = target.querySelector(".savehint");
    expect(hint?.textContent!.trim()).toBe(t().recvSaveHintPicker);
  });

  it("没有 File System Access API：先告诉用户会保存到下载目录", async () => {
    await mountActions({ canStream: false, files: flat(SMALL) });
    expect(target.querySelector(".savehint")?.textContent!.trim()).toBe(t().recvSaveHintDownload);
  });

  it("手机上即使属性存在也说「保存到下载目录」——手机上一次选择器都不开，事实就是如此", async () => {
    restoreUA = stubUA(ANDROID_UA);
    await mountActions({ canStream: true, files: flat(SMALL) }); // 两个选择器属性都在
    expect(target.querySelector(".savehint")?.textContent!.trim()).toBe(t().recvSaveHintDownload);
  });

  it("手机 + 大批次：内存提示不再被「选择器属性存在」悄悄摘掉", async () => {
    // 事故设备上的真实组合：showSaveFilePicker 存在（于是旧代码判定能流式落盘、
    // 不提示），实际却走内存分支。最需要提示的设备恰好一句都没有。
    restoreUA = stubUA(ANDROID_UA);
    await mountActions({ canStream: true, files: folder(BIG) });
    expect(target.querySelector(".memwarn"), "手机上未经证实的选择器不该关掉内存提示").not.toBeNull();
    expect(byText(t().accept)).toBeUndefined();
  });

  // 桌面上按了取消之后卡片会**原地再问一次**。如果它长得和第一次一模一样，用户
  // 就只会看到「什么都没发生」，而这正是「一次误按返回键把整次传输判死」的另一
  // 张脸：这次传输其实还活着，界面必须说出来。
  it("重问一次：换成「你取消了，还能再来」，接收按钮照旧可用", async () => {
    await mountActions({ canStream: true, files: flat(SMALL), retry: true });
    const hint = target.querySelector(RECEIVE.retryHint);
    expect(hint?.textContent!.trim()).toBe(t().recvSaveRetry);
    // 活动区域一直在（见组件注释），所以这次文案替换才播报得出来。
    expect(hint?.getAttribute("role")).toBe("status");
    byText(t().accept)!.click();
    flushSync();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("重问一次时拒绝仍然可用", async () => {
    await mountActions({ canStream: true, files: flat(SMALL), retry: true });
    byText(t().decline)!.click();
    flushSync();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("提示状态下拒绝仍然可用，且不触发接收", async () => {
    await mountActions({ canStream: false, files: folder(BIG) });

    byText(t().decline)!.click();
    flushSync();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });
});

// --- 带目录层级的单文件：卡片说的话必须和真的会发生的事一致 -------------------
//
// 只有一个文件、但它在一个文件夹里（solo/only.txt）。这一批以前会被当成「单文件」，
// 于是卡片按「有 showSaveFilePicker」承诺了一个保存位置选择器 —— 而真实路径根本
// 弹不出选择器：带路径的单文件走不了 Save As，没有目录选择器时它被打成 ZIP 落到
// 下载目录。用户看着「浏览器会问你把文件存到哪里」，然后什么都没弹出来。
describe("ReceiveActions × 带目录层级的单文件", () => {
  /** 只装 Save As，不装目录选择器 —— 正是承诺落空的那台机器。 */
  function stubSaveOnly(): () => void {
    const w = window as unknown as Record<string, unknown>;
    const had = { save: "showSaveFilePicker" in w, dir: "showDirectoryPicker" in w };
    w.showSaveFilePicker = async () => ({});
    delete w.showDirectoryPicker;
    return () => {
      if (!had.save) delete w.showSaveFilePicker;
      if (!had.dir) delete w.showDirectoryPicker;
    };
  }

  const nestedSingle = [{ name: "only.txt", size: SMALL, path: "solo/only.txt" }];
  const hint = () => target.querySelector(".savehint")!.textContent!.trim();

  it("只有 Save As 时不再承诺选择器 —— 真实结果是 ZIP 落到下载目录", async () => {
    await loadLang("en");
    restorePickers = stubSaveOnly();
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(ReceiveActions, {
      target,
      props: { files: nestedSingle, total: SMALL, retry: false, onAccept, onReject },
    });
    flushSync();
    expect(hint()).toBe(t().recvSaveHintDownload);
    expect(hint()).not.toBe(t().recvSaveHintPicker);
  });

  it("扁平单文件在同一台机器上照旧承诺选择器 —— 只收紧带路径的那一类", async () => {
    await loadLang("en");
    restorePickers = stubSaveOnly();
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(ReceiveActions, {
      target,
      props: {
        files: [{ name: "only.txt", size: SMALL }],
        total: SMALL, retry: false, onAccept, onReject,
      },
    });
    flushSync();
    expect(hint()).toBe(t().recvSaveHintPicker);
  });

  it("有目录选择器时确实会问存哪里（那条路真的弹选择器）", async () => {
    await mountActions({ canStream: true, files: nestedSingle });
    expect(hint()).toBe(t().recvSaveHintPicker);
  });

  it("内存提示按 ZIP 的 2× 峰值算，不再被「单文件」判定摘掉", async () => {
    // 总量没过线，2× 之后过了。以前按数量问会答「能流式落盘」并把提示吞掉。
    const size = LARGE_DOWNLOAD_WARN_BYTES * 0.6;
    await mountActions({
      canStream: false,
      files: [{ name: "big.bin", size, path: "solo/big.bin" }],
    });
    expect(target.querySelector(".memwarn"), "带路径的单文件必须按 ZIP 估算").not.toBeNull();
    expect(byText(t().accept), "提示状态下接收按钮不该存在").toBeUndefined();
  });
});

/**
 * The SAME strings `web/e2e/mixed-link.mjs` clicks in a real browser, asserted
 * against the markup this component actually renders.
 *
 * Same reasoning as `QueuedBatches.test.ts`, and the same accident waiting to
 * happen: the browser runner needs a Go server and a headless Chrome, so it is
 * not what fails first when this markup moves. This file runs on every push.
 *
 * The part that makes it worth writing down rather than assuming is the
 * **inversion**. `RECEIVE.primary` is `.btn-primary` — which accepts, but only
 * in the ordinary branch. Under the large-batch memory warning the two swap:
 * `.btn-primary` becomes *decline*, and the only way forward is an explicit
 * `.btn-ghost` "receive anyway". A runner that treated the primary button as
 * "accept" on a batch that started raising the warning would therefore decline
 * it, silently, and every assertion downstream would describe a transfer that
 * was never accepted.
 *
 * That is also why the shared constants are named `primary`/`ghost` rather than
 * `accept`/`decline`: no shared identifier may claim a semantic role that half
 * the branches contradict. The semantics are what these tests establish, per
 * branch, in both directions.
 */
describe("the receive selectors the browser runner clicks", () => {
  const el = (selector: string) => target.querySelector(selector);

  it("ordinary branch: the primary button accepts and the ghost one declines", async () => {
    await mountActions({ canStream: true, files: flat(SMALL) });

    expect(el(RECEIVE.warning), "a small flat batch must not raise the warning").toBeNull();
    expect(el(RECEIVE.saveHint), "the save hint is what RECEIVE.saveHint names").not.toBeNull();

    const primary = el(RECEIVE.primary) as HTMLButtonElement | null;
    const ghost = el(RECEIVE.ghost) as HTMLButtonElement | null;
    expect(primary?.textContent?.trim()).toBe(t().accept);
    expect(ghost?.textContent?.trim()).toBe(t().decline);

    primary!.click();
    flushSync();
    expect(onAccept, "on the ordinary row RECEIVE.primary must accept").toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("ordinary branch: RECEIVE.ghost rejects rather than accepting", async () => {
    await mountActions({ canStream: true, files: flat(SMALL) });

    (el(RECEIVE.ghost) as HTMLButtonElement).click();
    flushSync();
    expect(onReject, "on the ordinary row RECEIVE.ghost must decline").toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("warning branch: the two invert, so RECEIVE.primary is the DECLINE button", async () => {
    await mountActions({ canStream: false, files: folder(BIG) });

    expect(el(RECEIVE.warning), "this batch is what RECEIVE.warning is for").not.toBeNull();
    // The property the inversion exists to protect: there is no plain accept.
    expect(byText(t().accept), "no direct accept may exist under the warning").toBeUndefined();

    (el(RECEIVE.primary) as HTMLButtonElement).click();
    flushSync();
    expect(onReject, "under the warning, RECEIVE.primary is decline").toHaveBeenCalledTimes(1);
    expect(
      onAccept,
      "if this ever starts accepting, mixed-link.mjs's warning guard is the only thing left",
    ).not.toHaveBeenCalled();
  });

  it("warning branch: RECEIVE.ghost is the explicit 'receive anyway'", async () => {
    await mountActions({ canStream: false, files: folder(BIG) });

    const ghost = el(RECEIVE.ghost) as HTMLButtonElement;
    expect(ghost.textContent?.trim()).toBe(t().recvMemWarnAccept);
    ghost.click();
    flushSync();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  // The exact state `mixed-link.mjs`'s mobile act reads immediately before its
  // accept click, asserted here against real rendered markup on every push.
  //
  // The browser act cannot check the strings themselves — it runs in whichever
  // of the two maintained languages the run booted in, so it matches a
  // Downloads-promising pattern and refuses the picker sentence. That pairing is
  // only meaningful while the two sentences are genuinely different and the
  // download one genuinely says Downloads, which is a copy fact and belongs
  // here, in the lane that runs without a Go server and a headless Chrome.
  it("phone branch: one non-retry save hint promising Downloads, and no warning", async () => {
    restoreUA = stubUA(ANDROID_UA);
    await mountActions({ canStream: true, files: flat(SMALL) }); // both picker properties present

    expect(el(RECEIVE.warning), "a 1 MiB flat batch must not raise the memory warning").toBeNull();
    expect(target.querySelectorAll(RECEIVE.saveHint), "exactly one save hint").toHaveLength(1);
    expect(el(RECEIVE.retryHint), "nothing was cancelled, so this is not the retry variant").toBeNull();
    expect(el(RECEIVE.saveHint)!.textContent!.trim()).toBe(t().recvSaveHintDownload);

    // The two directions the runner's regex pair asserts, on the actual copy.
    expect(t().recvSaveHintDownload).toMatch(/downloads/i);
    expect(t().recvSaveHintPicker).not.toMatch(/downloads/i);
    expect(t().recvSaveHintDownload, "the phone hint became the picker sentence")
      .not.toBe(t().recvSaveHintPicker);

    // And the button it then clicks still accepts on this branch.
    (el(RECEIVE.primary) as HTMLButtonElement).click();
    flushSync();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("phone branch: the same hint in Simplified Chinese, the other maintained language", async () => {
    restoreUA = stubUA(ANDROID_UA);
    // Armed BEFORE the switch, not after: `setLang` mutates module state and
    // `document.documentElement` before its promise settles, so a registration
    // that waits for it to resolve leaves the whole rest of the file running in
    // zh if it rejects. Restoring a language that was never switched is free.
    restoreLang = () => setLang("en");
    // Mounted under zh from the start: `lang()` is read when the component
    // renders, so switching afterwards proves nothing about what a zh user sees.
    await setLang("zh");
    restorePickers = stubPickers(true);
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(ReceiveActions, {
      target,
      props: { files: flat(SMALL), total: SMALL, retry: false, onAccept, onReject },
    });
    flushSync();

    const hint = el(RECEIVE.saveHint)!.textContent!.trim();
    expect(hint).toBe(messages.zh.recvSaveHintDownload);
    // The runner's pattern is `/downloads|下载/i` against `/where to save|选择保存位置/i`.
    // Both halves have to hold in both languages or the browser assertion is
    // language-dependent in a way nothing would report.
    expect(hint).toMatch(/下载/);
    expect(hint).not.toMatch(/选择保存位置/);
    expect(messages.zh.recvSaveHintPicker).toMatch(/选择保存位置/);
  });

  it("names the card the runner scopes all of these to", async () => {
    // The component renders the actions; `App.svelte` renders the card around
    // them. The runner queries `RECEIVE.card RECEIVE.primary`, so a change to
    // either half breaks a real click — and this pins the half that is a plain
    // string here, so the other half is the only place left to look.
    expect(RECEIVE.card).toBe(".request");
    expect(RECEIVE.primary).toBe(".btn-primary");
    expect(RECEIVE.ghost).toBe(".btn-ghost");
    expect(RECEIVE.retryHint).toBe(".savehint.retry");
    // The retired names must not come back: their meaning is false in the
    // warning branch, which is exactly the branch a careless reader skips.
    expect(RECEIVE).not.toHaveProperty("accept");
    expect(RECEIVE).not.toHaveProperty("decline");
  });
});
