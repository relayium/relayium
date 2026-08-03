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
  InvalidStoredObjectIdError: class InvalidStoredObjectIdError extends Error {},
}));

const manifestFiles = vi.fn();
vi.mock("./store-crypto", () => ({
  decryptManifest: async () => ({ files: manifestFiles() }),
}));

/**
 * filesink 默认走真实实现（上面那些用例靠的就是它真跑分支）。需要盯住
 * 「SaveTarget.done / t.file 的入参」的用例用 injectTarget 顶掉 pickSaveTarget。
 *
 * 注意：下载页现在会把带 "/" 的清单 name 拆成 {name, path} 再喂下去，所以文件夹
 * 清单是真的能走到 ZIP 分支的（见下面「文件夹清单」那一组）。done 漏调会表现为
 * 「显示完成但什么都没下载下来」，所以那条契约仍然要守。
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
// From the mock above, i.e. the same class the page will see — an `instanceof`
// against the real module here would never match and the test would pass on the
// fallback branch it is meant to rule out.
import { InvalidStoredObjectIdError } from "./stored-file";
import { loadLang, messages } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES, SinkTransportError, probeStreamSupport, swStreamReady, pickSaveTarget } from "./filesink";
import { refreshHolds, resetAppUpdate } from "./app-update.svelte";

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

async function mountPage(o: {
  canStream: boolean;
  files: { name: string; size: number }[];
  /** 让 onMount 的 fetchMeta 以这个理由失败，用来盯住加载阶段的错误归因。 */
  metaError?: unknown;
}) {
  restorePickers = stubPickers(o.canStream);
  manifestFiles.mockReturnValue(o.files);
  if (o.metaError) fetchMeta.mockRejectedValue(o.metaError);
  else fetchMeta.mockResolvedValue({ expiresAt: 0, burnAfterRead: false, encManifest: "" });
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

/** 让 downloadBlob 交付清单声明的全部字节。
 *
 *  生产里这是**不变量**而不是巧合：downloadBlob 没拿到 expectedBytes 时会从
 *  加密清单算出明文总量，并在 resolve 之前用 StoreDecryptor.end(expected) 核对，
 *  对不上就抛。所以「声明了 1 MiB 却一个字节都不交付」是替身独有的形状，下载页
 *  收尾时按「和链接描述的不一致」拒绝它是对的。需要真跑完一次下载的用例用这个，
 *  别让替身违反它自己依赖的契约。 */
function deliverDeclaredBytes(files: { name: string; size: number }[]) {
  const total = files.reduce((n, f) => n + f.size, 0);
  downloadBlob.mockImplementation(
    async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      if (total > 0) await onPt(new Uint8Array(total));
    },
  );
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
  resetAppUpdate(); // 别把一个没释放的闸门漏给别的用例
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
function stubServiceWorker(o: { refuses?: boolean } = {}) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const ports: MessagePort[] = [];
  const sw = {
    controller: {
      postMessage: (m: unknown, transfer?: Transferable[]) => {
        const msg = m as Record<string, unknown>;
        const port = transfer?.[0] as MessagePort | undefined;
        if (msg.type === "stream-probe" && port) port.postMessage({ type: "stream-probe-ok" });
        if (msg.type === "stream-open" && port && o.refuses) {
          // 已交接的 SW 当场拒收新流（sw-template 的 retireIfIdle 置闩之后）。
          ports.push(port);
          port.postMessage({ type: "stream-refused", reason: "updating" });
          return;
        }
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

  // SW 已经把 skip-waiting 交接出去、正在拒收新流（sw-template 的 retireIfIdle）。
  // 这一批的内存提示**从来没出现过**，因为 canStreamToDisk 说了这次是流式落盘——
  // 所以绝不能默默改成攒一个 256 MiB 以上的 Blob，那是一次标签页被系统回收。
  it("SW 拒收新流 + 大文件：如实报错并给重试，不静默改成内存下载", async () => {
    const s = stubServiceWorker({ refuses: true });
    probeStreamSupport();
    await until(swStreamReady);
    try {
      await mountPage({ canStream: false, files: [{ name: "big.mp4", size: BIG }] });
      await clickDownload();
      await until(() => !!target.querySelector(".error"));

      const err = target.querySelector(".error");
      expect(err, "拒收之后必须说出来").not.toBeNull();
      expect(err!.textContent!.trim()).toBe(messages.en.download.swFail);
      expect(err!.textContent!.trim()).not.toBe(messages.en.download.decryptFail);
      expect(target.querySelector(".btn-primary"), "换版是暂时的，重试有意义").not.toBeNull();
      expect(downloadBlob, "一个字节都不该取").not.toHaveBeenCalled();
    } finally { s.restore(); }
  });

  it("SW 拒收新流 + 小文件：安静回落到内存下载，照常完成", async () => {
    const s = stubServiceWorker({ refuses: true });
    probeStreamSupport();
    await until(swStreamReady);
    try {
      const files = [{ name: "small.txt", size: SMALL }];
      deliverDeclaredBytes(files);
      await mountPage({ canStream: false, files });
      await clickDownload();
      await until(() => downloadBlob.mock.calls.length > 0);

      expect(downloadBlob).toHaveBeenCalledTimes(1);
      expect(target.querySelector(".error"), "小文件回落不是故障").toBeNull();
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
    const files = [{ name: "small.txt", size: SMALL }];
    deliverDeclaredBytes(files);
    await mountPage({ canStream: false, files });
    await clickDownload();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(target.querySelector(".error"), "回落不该报错").toBeNull();
  });
});

// 存储清单是冻结的，没有 path 字段：文件夹层级写在 name 里（"trip/day1/a.txt"）。
// Go CLI 的 walkUploadPaths 一直这么发，macOS 原生端现在也这么发 —— 所以下载页
// 必须能把它还原成一棵树，而不是把整串 name 当文件名。
describe("DownloadPage 文件夹清单", () => {
  const FOLDER = [
    { name: "trip/day1/a.txt", size: 3 },
    { name: "trip/b.txt", size: 2 },
  ];

  it("把带 / 的 name 拆成 {叶子名, 相对路径} 再喂给 sink —— 否则层级只能靠运气", async () => {
    const seen: { name: string; path?: string }[] = [];
    injectedTarget = {
      label: "test",
      file: async (name: string, _size: number, path?: string) => {
        seen.push({ name, path });
        return { write: async () => {}, close: async () => {} };
      },
      done: async () => {},
    };
    downloadBlob.mockImplementation(async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      await onPt(new Uint8Array([1, 2, 3, 4, 5]));
    });
    await mountPage({ canStream: false, files: FOLDER });
    await clickDownload();
    await until(() => seen.length === 2);
    expect(seen).toEqual([
      { name: "a.txt", path: "trip/day1/a.txt" },
      { name: "b.txt", path: "trip/b.txt" },
    ]);
  });

  it("没有 File System Access 时真的选中 ZIP 分支 —— 这正是层级丢失的那一步", async () => {
    // 以前 f.path 恒为 undefined，pickSaveTarget 判不出这是文件夹，于是逐个
    // a.download="trip/day1/a.txt"，浏览器把它压成一个平铺文件名。
    //
    // 断言落在 pickSaveTarget 真实返回的目标上，而不是「页面显示完成了」：
    // 两条分支都会显示完成，只有目标本身能区分。喂给它的正是页面自己算出的
    // 那份 spec（上一条用例已经钉住了 spec 的形状）。
    const restore = stubPickers(false);
    try {
      const folderTarget = await pickSaveTarget(
        [{ name: "a.txt", size: 3, path: "trip/day1/a.txt" },
         { name: "b.txt", size: 2, path: "trip/b.txt" }],
        { swStream: false },
      );
      expect(folderTarget.done, "文件夹批次必须走 ZIP —— 它是唯一带 done 的目标").toBeTypeOf("function");

      const flatTarget = await pickSaveTarget([{ name: "a.bin", size: 1 }], { swStream: false });
      expect(flatTarget.done, "扁平批次仍然逐个下载，没有 done").toBeUndefined();
    } finally {
      restore();
    }
  });

  it("扁平清单不受影响：仍然不带 path，仍然逐个下载", async () => {
    const seen: { name: string; path?: string }[] = [];
    injectedTarget = {
      label: "test",
      file: async (name: string, _size: number, path?: string) => {
        seen.push({ name, path });
        return { write: async () => {}, close: async () => {} };
      },
      done: async () => {},
    };
    downloadBlob.mockImplementation(async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      await onPt(new Uint8Array([1]));
    });
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: 1 }] });
    await clickDownload();
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ name: "a.bin", path: undefined }]);
  });

  // 一个文件夹里只有一个文件：整条决策链上最容易丢层级的形状。清单只有一条
  // 记录，所以「单文件」的两条快路（Save As、SW 单文件流）都会抢走它，而两条都
  // 交付一个纯文件名 —— solo/ 就此消失。这条用例走的是真的 StoredManifest。
  it("一个文件的文件夹：solo/ 必须活下来，不能被当成单文件", async () => {
    const seen: { name: string; path?: string }[] = [];
    injectedTarget = {
      label: "test",
      file: async (name: string, _size: number, path?: string) => {
        seen.push({ name, path });
        return { write: async () => {}, close: async () => {} };
      },
      done: async () => {},
    };
    downloadBlob.mockImplementation(async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      await onPt(new Uint8Array([1, 2, 3]));
    });
    await mountPage({ canStream: false, files: [{ name: "solo/only.txt", size: 3 }] });
    await clickDownload();
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ name: "only.txt", path: "solo/only.txt" }]);
  });

  it("一个文件的文件夹在真实分支上也不走单文件快路", async () => {
    // 不注入目标，让 pickSaveTarget 真跑：桌面 Chrome（两个选择器都在）必须落到
    // 目录选择器，而不是 Save As —— 后者只收一个文件名，装不下 solo/。
    const restore = stubPickers(true);
    try {
      const folderTarget = await pickSaveTarget(
        [{ name: "only.txt", size: 3, path: "solo/only.txt" }], { swStream: false },
      );
      expect(folderTarget.label).toBe("已选择目标文件夹");
      expect(folderTarget.label).not.toBe("已选择保存位置");
    } finally { restore(); }
  });

  // --- 零字节文件的收尾顺序 -------------------------------------------------
  //
  // 密文流里没有零字节文件的帧，所以 downloadBlob 根本不会为它们回调。而推进
  // fileIdx 的循环条件是「手里还有字节」，于是尾部的零字节条目一个都建不出来，
  // target.done() 却照跑、页面照样显示「完成」—— 用户拿到一个少了文件的文件夹，
  // 还被告知一切正常。
  //
  // 断言落在**顺序**上而不只是数量：done 必须排在每一个 close 之后，否则 ZIP
  // 会在文件还没收尾时就被拼出来。

  /** 记录 open/close/done 的先后。sink 的 close 记成 `close:<name>`。 */
  function recordingTarget(log: string[]) {
    return {
      label: "test",
      file: async (name: string, _size: number, path?: string) => {
        log.push(`open:${path ?? name}`);
        return {
          write: async () => {},
          close: async () => { log.push(`close:${path ?? name}`); },
        };
      },
      done: async () => { log.push("done"); },
    };
  }

  it("整份清单都是零字节文件：每个都要建出来并 close，done 排在最后", async () => {
    const log: string[] = [];
    injectedTarget = recordingTarget(log);
    // 一次明文回调都不发 —— 密文流里没有它们的帧，这就是真实行为。
    downloadBlob.mockImplementation(async () => {});
    await mountPage({
      canStream: false,
      files: [
        { name: "solo/a.txt", size: 0 },
        { name: "solo/b.txt", size: 0 },
        { name: "solo/c.txt", size: 0 },
      ],
    });
    await clickDownload();
    await until(() => log.includes("done"));

    expect(log).toEqual([
      "open:solo/a.txt", "close:solo/a.txt",
      "open:solo/b.txt", "close:solo/b.txt",
      "open:solo/c.txt", "close:solo/c.txt",
      "done",
    ]);
    expect(target.querySelector(".ok"), "页面必须真的到达完成态").not.toBeNull();
  });

  it("一个非空文件后面跟着多个零字节文件：后面的也要建出来", async () => {
    const log: string[] = [];
    injectedTarget = recordingTarget(log);
    // 只有非空文件那 3 个字节会来。
    downloadBlob.mockImplementation(async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      await onPt(new Uint8Array([1, 2, 3]));
    });
    await mountPage({
      canStream: false,
      files: [
        { name: "trip/first.bin", size: 3 },
        { name: "trip/empty1.bin", size: 0 },
        { name: "trip/empty2.bin", size: 0 },
        { name: "trip/empty3.bin", size: 0 },
      ],
    });
    await clickDownload();
    await until(() => log.includes("done"));

    expect(log).toEqual([
      "open:trip/first.bin", "close:trip/first.bin",
      "open:trip/empty1.bin", "close:trip/empty1.bin",
      "open:trip/empty2.bin", "close:trip/empty2.bin",
      "open:trip/empty3.bin", "close:trip/empty3.bin",
      "done",
    ]);
    expect(target.querySelector(".ok")).not.toBeNull();
  });

  it("零字节文件夹在中间和结尾都能正确收尾，且没有文件被 close 两次", async () => {
    const log: string[] = [];
    injectedTarget = recordingTarget(log);
    downloadBlob.mockImplementation(async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      // 分两次到达，边界正好落在中间那个空文件上 —— 守住「有字节驱动」与
      // 「没字节驱动」两条路交界处的重复收尾。
      await onPt(new Uint8Array([1]));
      await onPt(new Uint8Array([2]));
    });
    await mountPage({
      canStream: false,
      files: [
        { name: "mix/a.bin", size: 1 },
        { name: "mix/gap.bin", size: 0 },
        { name: "mix/b.bin", size: 1 },
        { name: "mix/tail.bin", size: 0 },
      ],
    });
    await clickDownload();
    await until(() => log.includes("done"));

    expect(log).toEqual([
      "open:mix/a.bin", "close:mix/a.bin",
      "open:mix/gap.bin", "close:mix/gap.bin",
      "open:mix/b.bin", "close:mix/b.bin",
      "open:mix/tail.bin", "close:mix/tail.bin",
      "done",
    ]);
    const closes = log.filter((l) => l.startsWith("close:"));
    expect(new Set(closes).size, "同一个文件被 close 了两次").toBe(closes.length);
  });

  it("恶意 name 不能逃出选中的目录：../ 段在拆解时就被丢掉", async () => {
    const seen: { name: string; path?: string }[] = [];
    injectedTarget = {
      label: "test",
      file: async (name: string, _size: number, path?: string) => {
        seen.push({ name, path });
        return { write: async () => {}, close: async () => {} };
      },
      done: async () => {},
    };
    downloadBlob.mockImplementation(async (_id: unknown, _k: unknown, onPt: (p: Uint8Array) => Promise<void>) => {
      await onPt(new Uint8Array([1]));
    });
    await mountPage({ canStream: false, files: [{ name: "../../etc/passwd", size: 1 }] });
    await clickDownload();
    await until(() => seen.length === 1);
    expect(seen[0].path).toBe("etc/passwd");
    expect(seen[0].name).toBe("passwd");
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
    const files = [{ name: "a.bin", size: SMALL }];
    deliverDeclaredBytes(files);
    await mountPage({ canStream: false, files });
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

// 刷新会把这次下载整个丢掉、从零重来。这条路完全在 workspace 之外
// （warnsOnLeave 看不见它），所以全站更新提示条只能靠这个显式闸门知道现在不能刷。
describe("DownloadPage × 更新刷新闸门", () => {
  it("从选保存位置到收尾全程占住闸门，完成后释放", async () => {
    let finish!: () => void;
    downloadBlob.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    expect(refreshHolds(), "还没点下载就不该占").toBe(0);

    await clickDownload();
    expect(refreshHolds(), "取字节期间必须占住").toBe(1);

    finish();
    await until(() => refreshHolds() === 0);
    expect(refreshHolds()).toBe(0);
  });

  it("下载失败也释放闸门", async () => {
    downloadBlob.mockRejectedValue(new SinkTransportError("boom"));
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    await clickDownload();

    expect(target.querySelector(".error"), "确实是失败那条路").not.toBeNull();
    expect(refreshHolds(), "错误路径漏放会让按钮永远是灰的").toBe(0);
  });

  it("用户取消保存位置也释放闸门", async () => {
    const w = window as unknown as Record<string, unknown>;
    const had = "showSaveFilePicker" in w;
    w.showSaveFilePicker = async () => { throw Object.assign(new Error("abort"), { name: "AbortError" }); };
    try {
      await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
      await clickDownload();
      expect(downloadBlob, "取消了就没取字节").not.toHaveBeenCalled();
      expect(refreshHolds()).toBe(0);
    } finally { if (!had) delete w.showSaveFilePicker; }
  });

  // 只显示内存提示的那一次一个字节都还没取，刷新毫无代价——占住闸门是错的。
  it("只显示内存提示时不占闸门", async () => {
    await mountPage({ canStream: false, files: [{ name: "big.mp4", size: BIG }] });
    await clickDownload();

    expect(target.querySelector(".memwarn")).not.toBeNull();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(refreshHolds()).toBe(0);
  });
});

// 拿写入端也会失败（blobSink 构造、ZIP writer、目录句柄）。这一步以前在 try 之外，
// 异常直接从 runDownload 逃走：页面永远停在进度条上一句话都不说，刷新闸门也一直被
// 占着。现在归成保存故障，可重试。
describe("DownloadPage 拿写入端失败", () => {
  it("如实报成可重试的保存故障，并释放刷新闸门，不再挂在进度条上", async () => {
    injectedTarget = {
      label: "test",
      file: async () => { throw new Error("sink construction failed"); },
    };
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    await clickDownload();
    await until(() => !!target.querySelector(".error"));

    const err = target.querySelector(".error");
    expect(err, "不能只留一个不动的进度条").not.toBeNull();
    expect(err!.textContent!.trim()).toBe(messages.en.download.swFail);
    expect(err!.textContent!.trim()).not.toBe(messages.en.download.decryptFail);
    expect(target.querySelector(".btn-primary"), "保存失败可重试").not.toBeNull();
    expect(target.querySelector(".bar"), "不该停在 downloading").toBeNull();
    expect(refreshHolds(), "漏放会让刷新按钮永远是灰的").toBe(0);
    expect(downloadBlob, "根本没走到取字节").not.toHaveBeenCalled();
  });
});

// 链接里的标识符是**收件方拿到什么就是什么**：发件人、聊天软件、系统分享，谁写的
// 都可能。stored-file 在发请求之前就会拒掉 Relayium 根本不可能签发的形状——但那条
// 拒绝到了页面上必须说人话。它以前会落进 else 分支，被说成「密钥错误或文件损坏」：
// 那句话是在指控用户的密钥或这份文件，而真相是这条链接根本不指向任何东西，而且一个
// 字节都没取、密钥一次都没用上。重试更是白搭——同一个 id 会被同样地拒掉。
describe("DownloadPage 被拒的标识符", () => {
  it("加载阶段被拒：说「链接无效或已过期」，不是「密钥错误或文件损坏」，且不给重试", async () => {
    await mountPage({
      canStream: false,
      files: [{ name: "a.bin", size: SMALL }],
      metaError: new InvalidStoredObjectIdError(),
    });

    const err = target.querySelector(".error");
    expect(err, "被拒了就得说出来").not.toBeNull();
    expect(err!.textContent!.trim()).toBe(messages.en.download.notFound);
    expect(err!.textContent!.trim()).not.toBe(messages.en.download.decryptFail);
    expect(target.querySelector("button"), "同一个 id 重试还是被拒").toBeNull();
    expect(downloadBlob, "一个字节都不该取").not.toHaveBeenCalled();
  });

  it("取字节阶段被拒同样归成链接无效，不给重试", async () => {
    // downloadBlob 是自己的公开边界：即使 meta 那一步不知怎么过去了,这里的拒绝也
    // 不能变成「密钥错误或文件损坏」。这一条走的是清单已加载的那条路,所以重试按钮
    // 的闸门（netFail/swFail/cancelled + manifest）是真的被考到的。
    downloadBlob.mockRejectedValue(new InvalidStoredObjectIdError());
    await mountPage({ canStream: false, files: [{ name: "a.bin", size: SMALL }] });
    await clickDownload();

    const err = target.querySelector(".error");
    expect(err).not.toBeNull();
    expect(err!.textContent!.trim()).toBe(messages.en.download.notFound);
    expect(err!.textContent!.trim()).not.toBe(messages.en.download.decryptFail);
    expect(target.querySelector(".btn-primary"), "重试没有意义").toBeNull();
    expect(refreshHolds(), "错误路径漏放会让刷新按钮永远是灰的").toBe(0);
  });
});
