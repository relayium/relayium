// 下载端的内存防线。
//
// 只有桌面 Chrome/Edge 能把下载流式写进磁盘（File System Access API）；
// Firefox、Safari 和所有手机浏览器都得把整个文件攒在内存里，一个大文件足以
// 掀掉接收方的标签页——而接收方根本没参与决定文件多大。下载页是唯一同时知道
// 「总大小」和「本浏览器有没有流式能力」的地方，所以防线放在这里。
//
// 这里用的是 QuotaNotice.test.ts 的 mount + flushSync 手法：真挂载组件，网络
// 与加密两层 mock 掉，断言落在「downloadBlob 到底有没有被调用」上——光看
// DOM 不够，"提示显示了但下载照样开始" 在页面上几乎看不出区别。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";

const downloadBlob = vi.fn();
const fetchMeta = vi.fn();

vi.mock("./stored-file", () => ({
  fetchMeta: (...a: unknown[]) => fetchMeta(...a),
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  parseDownloadKey: () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyFromFragment: async () => ({ fake: "key" }),
  DownloadNetworkError: class DownloadNetworkError extends Error {},
}));

const manifestFiles = vi.fn();
vi.mock("./store-crypto", () => ({
  decryptManifest: async () => ({ files: manifestFiles() }),
}));

/**
 * filesink 默认走真实实现（上面那些用例靠的就是它真跑分支）。只有需要盯住
 * 「SaveTarget.done 到底有没有被调用」的用例才用 injectTarget 顶掉 pickSaveTarget ——
 * DownloadPage 今天喂给 pickSaveTarget 的 FileMetaLite 不带 path，够不到 ZIP 分支，
 * 而 ZIP 分支是全仓唯一带 done 的目标。契约必须有守卫，否则等哪天下载页支持文件夹
 * （第 2 步的流式 ZIP）时，done 漏调会表现为「显示完成但什么都没下载下来」。
 */
let injectedTarget: unknown = null;
vi.mock("./filesink", async (orig) => {
  const real = await orig<typeof import("./filesink")>();
  return {
    ...real,
    pickSaveTarget: async (...a: Parameters<typeof real.pickSaveTarget>) =>
      injectedTarget ?? real.pickSaveTarget(...a),
  };
});

import DownloadPage from "./DownloadPage.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES, SinkTransportError, probeStreamSupport, swStreamReady } from "./filesink";

let target: HTMLDivElement;
let app: unknown;
let restorePickers: () => void = () => {};

/** 装/卸 File System Access 选择器，模拟桌面 Chrome 与其它一切浏览器。 */
function stubPickers(canStream: boolean): () => void {
  const w = window as unknown as Record<string, unknown>;
  const had = { save: "showSaveFilePicker" in w, dir: "showDirectoryPicker" in w };
  const writable = { write: async () => {}, close: async () => {} };
  const fileHandle = { createWritable: async () => writable };
  if (canStream) {
    w.showSaveFilePicker = async () => fileHandle;
    w.showDirectoryPicker = async () => ({
      getFileHandle: async () => fileHandle,
      getDirectoryHandle: async () => ({}),
    });
  }
  return () => {
    if (!had.save) delete w.showSaveFilePicker;
    if (!had.dir) delete w.showDirectoryPicker;
  };
}

async function mountPage(o: { canStream: boolean; files: { name: string; size: number }[] }) {
  restorePickers = stubPickers(o.canStream);
  manifestFiles.mockReturnValue(o.files);
  fetchMeta.mockResolvedValue({ expiresAt: 0, burnAfterRead: false, encManifest: "" });
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DownloadPage, { target, props: { id: "abc" } });
  // onMount 里 fetchMeta → keyFromFragment → decryptManifest 三段 await;
  // 两个宏任务足够排空它们再加上状态写入（同 QuotaNotice.test.ts）。
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** 点下载按钮并等异步的 pickSaveTarget/downloadBlob 落定。 */
async function clickDownload(sel = ".btn-primary") {
  (target.querySelector(sel) as HTMLButtonElement).click();
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

beforeEach(() => {
  injectedTarget = null;
  downloadBlob.mockReset();
  downloadBlob.mockResolvedValue(undefined);
  fetchMeta.mockReset();
  // blobSink 关闭时会走 URL.createObjectURL，jsdom 没实现。
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  }));
  window.isSecureContext = true;
});

afterEach(() => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  restorePickers();
  vi.unstubAllGlobals();
});

const BIG = LARGE_DOWNLOAD_WARN_BYTES + 1;
const SMALL = 1024 * 1024;

describe("DownloadPage 大文件内存提示", () => {
  it("无流式落盘能力 + 大文件：显示提示，且一个字节都不开始下载", async () => {
    await mountPage({ canStream: false, files: [{ name: "big.mp4", size: BIG }] });
    await clickDownload();

    const warn = target.querySelector(".memwarn");
    expect(warn, "应显示内存提示").not.toBeNull();
    expect(warn!.textContent!.trim().length).toBeGreaterThan(0);
    // 核心断言：提示不是装饰，下载必须真的没启动。
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(target.querySelector(".bar"), "不应进入 downloading 状态").toBeNull();
  });

  it("有流式落盘能力 + 大文件：照常下载，不提示", async () => {
    await mountPage({ canStream: true, files: [{ name: "big.mp4", size: BIG }] });
    await clickDownload();

    expect(target.querySelector(".memwarn"), "桌面 Chrome 那条路多大都行").toBeNull();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("无流式落盘能力 + 小文件：照常下载，不提示", async () => {
    await mountPage({ canStream: false, files: [{ name: "small.txt", size: SMALL }] });
    await clickDownload();

    expect(target.querySelector(".memwarn")).toBeNull();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("恰好等于阈值不提示，超过一个字节才提示（守 > 与 >= 的手滑）", async () => {
    // 尺寸写死 256 MiB 而不是引用常量：引用常量时这条会随阈值一起漂（阈值改成 0
    // 它退化成 0 > 0，照样不提示）。写死之后它同时守两件事：> 与 >= 的手滑，
    // 以及阈值的取值本身。
    await mountPage({ canStream: false, files: [{ name: "edge.bin", size: 256 * 1024 * 1024 }] });
    await clickDownload();
    expect(target.querySelector(".memwarn")).toBeNull();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("提示后点「仍要下载」，下载真的开始", async () => {
    await mountPage({ canStream: false, files: [{ name: "big.mp4", size: BIG }] });
    await clickDownload();
    expect(downloadBlob).not.toHaveBeenCalled();

    await clickDownload(".memwarn button");
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it("按总大小判断：多个各自不大的文件加起来越线也提示", async () => {
    const files = Array.from({ length: 4 }, (_, i) => ({ name: `p${i}.bin`, size: 70 * 1024 * 1024 }));
    await mountPage({ canStream: false, files });
    await clickDownload();
    expect(target.querySelector(".memwarn")).not.toBeNull();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

// --- service worker 流式落盘的接线 -------------------------------------------
//
// 这一段守的是第 1 步的用户可见效果：没有 File System Access API 的浏览器
// （Firefox / Safari / 所有手机）在 SW 就绪时应当**不再看到内存提示**，并且真的
// 走 SW 流式分支；SW 不可用时必须干净回落到既有的 blobSink + 既有提示。

/** jsdom 没有 service worker。这是 filesink.test.ts 那套替身的下载页版本：
 *  除了握手，还替 SW 自动回 ack / closed，好让整条下载真的跑完。 */
function stubServiceWorker() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const ports: MessagePort[] = [];
  const sw = {
    controller: {
      postMessage: (m: unknown, transfer?: Transferable[]) => {
        const msg = m as Record<string, unknown>;
        const port = transfer?.[0] as MessagePort | undefined;
        if (msg.type === "stream-probe" && port) port.postMessage({ type: "stream-probe-ok" });
        if (msg.type === "stream-open" && port) {
          ports.push(port);
          port.onmessage = (e) => {
            const t = (e.data as { type: string }).type;
            if (t === "chunk") port.postMessage({ type: "ack" });
            else if (t === "close") port.postMessage({ type: "closed" });
          };
          port.postMessage({ type: "stream-ready" });
          port.postMessage({ type: "stream-serving" }); // 导航到了，清掉 serve 超时
        }
      },
    },
    ready: Promise.resolve({}),
    addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ||= []).push(f),
    removeEventListener: (t: string, f: (e: unknown) => void) => {
      listeners[t] = (listeners[t] || []).filter((x) => x !== f);
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
  return {
    opened: ports,
    restore: () => {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
      probeStreamSupport(); // 把模块级就绪缓存清回 false，别漏给下一条用例
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !cond(); i++) { await tick(); flushSync(); }
}

describe("DownloadPage × service worker 流式落盘", () => {
  it("SW 就绪时大文件不再提示内存，且真的走 SW 流式分支", async () => {
    // 变异守卫：DownloadPage 忘了把 swStream 开关传给 canStreamToDisk / pickSaveTarget
    // 时，这条会红——内存提示又回来了，或者根本没开出 SW 流。
    const s = stubServiceWorker();
    probeStreamSupport();
    await until(swStreamReady);
    try {
      await mountPage({ canStream: false, files: [{ name: "big.mp4", size: BIG }] });
      await clickDownload();
      await until(() => s.opened.length > 0);

      expect(target.querySelector(".memwarn"), "SW 能流式落盘就不该再吓唬用户").toBeNull();
      expect(s.opened.length, "必须真的向 SW 登记了一条流").toBe(1);
      expect(downloadBlob).toHaveBeenCalledTimes(1);
    } finally { s.restore(); }
  });

  it("SW 不可用（dev / 注册失败 / controller 为 null）时干净回落到既有提示", async () => {
    // navigator.serviceWorker 根本不存在 —— 就是 dev 模式和注册失败的样子。
    probeStreamSupport();
    expect(swStreamReady()).toBe(false);
    await mountPage({ canStream: false, files: [{ name: "big.mp4", size: BIG }] });
    await clickDownload();

    expect(target.querySelector(".memwarn"), "回落路径必须保留既有提示").not.toBeNull();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("SW 不可用 + 小文件：走既有 blobSink，下载照常完成", async () => {
    probeStreamSupport();
    await mountPage({ canStream: false, files: [{ name: "small.txt", size: SMALL }] });
    await clickDownload();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(target.querySelector(".error"), "回落不该报错").toBeNull();
  });
});

describe("DownloadPage 收尾与错误归因", () => {
  it("最后一个 sink 关掉后必须调用 target.done()（ZIP 之类的目标靠它才产出文件）", async () => {
    const done = vi.fn(async () => {});
    injectedTarget = {
      label: "test",
      file: async () => ({ write: async () => {}, close: async () => {} }),
      done,
    };
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    await clickDownload();
    await until(() => done.mock.calls.length > 0);
    expect(done, "不调用 done：界面显示完成，磁盘上什么都没有").toHaveBeenCalledTimes(1);
    expect(target.querySelector(".ok"), "done 之后才算完成").not.toBeNull();
  });

  it("SW 落盘故障如实归因成传输问题，并给出重试按钮 —— 不是「密钥错误或文件损坏」", async () => {
    // 这是本轮修复里用户可见的那一半：ack 停滞 / 换版 / 浏览器没来取流，以前全落进
    // decryptFail，等于告诉用户他的文件坏了，还没得重试。
    downloadBlob.mockRejectedValue(new SinkTransportError("service worker stopped responding"));
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    await clickDownload();

    const err = target.querySelector(".error")!;
    expect(err).not.toBeNull();
    expect(err.textContent!.trim()).toBe(messages.en.download.swFail);
    expect(err.textContent!.trim()).not.toBe(messages.en.download.decryptFail);
    expect(target.querySelector(".btn-primary"), "传输故障必须可重试").not.toBeNull();
  });

  it("保存位置选不出来（且这一批不能安全塞进内存）要如实报出来，不是按了下载什么都没发生", async () => {
    // 桌面上选择器坏掉的那一批：点击之前的文案基于「属性存在」说了「浏览器会问你
    // 存哪里」，于是用户没看到内存提示。这时静默退回按钮那一屏，用户只会以为
    // 自己没点中。
    const w = window as unknown as Record<string, unknown>;
    const had = "showSaveFilePicker" in w;
    w.showSaveFilePicker = async () => { throw new Error("SecurityError"); };
    try {
      await mountPage({ canStream: false, files: [{ name: "big.bin", size: LARGE_DOWNLOAD_WARN_BYTES + 1 }] });
      await clickDownload();
      const err = target.querySelector(".error");
      expect(err, "保存这一段用不了必须说出来").not.toBeNull();
      expect(err!.textContent!.trim()).toBe(messages.en.download.swFail);
      expect(target.querySelector(".btn-primary"), "换个浏览器/重试是有意义的").not.toBeNull();
      expect(downloadBlob, "一个字节都不该取").not.toHaveBeenCalled();
    } finally { if (!had) delete w.showSaveFilePicker; }
  });

  it("用户自己取消保存位置：回到按钮那一屏，不报错", async () => {
    const w = window as unknown as Record<string, unknown>;
    const had = "showSaveFilePicker" in w;
    w.showSaveFilePicker = async () => { throw Object.assign(new Error("abort"), { name: "AbortError" }); };
    try {
      await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
      await clickDownload();
      expect(target.querySelector(".error"), "取消不是故障").toBeNull();
      expect(downloadBlob).not.toHaveBeenCalled();
    } finally { if (!had) delete w.showSaveFilePicker; }
  });

  it("真正的解密失败仍然是「密钥错误或文件损坏」，且不给重试按钮", async () => {
    // 守住反面：别为了修归因把所有失败都变成「可重试的传输问题」。
    downloadBlob.mockRejectedValue(new Error("bad tag"));
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    await clickDownload();

    expect(target.querySelector(".error")!.textContent!.trim()).toBe(messages.en.download.decryptFail);
    expect(target.querySelector(".btn-primary"), "解密失败重试没有意义").toBeNull();
  });
});
