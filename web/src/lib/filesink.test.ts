import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitExtension, nextAvailableName, canStreamToDisk, pickSaveTarget, memoryPeakBytes, warnsAboutMemory, LARGE_DOWNLOAD_WARN_BYTES, probeStreamSupport, swStreamReady } from "./filesink";
import { STREAM_ROUTE, contentDisposition } from "./sw-stream";

describe("splitExtension", () => {
  it("splits a normal name", () => {
    expect(splitExtension("photo.jpg")).toEqual({ base: "photo", ext: ".jpg" });
  });
  it("keeps only the final extension", () => {
    expect(splitExtension("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
  });
  it("treats a name with no dot as all-base", () => {
    expect(splitExtension("README")).toEqual({ base: "README", ext: "" });
  });
  it("treats a leading-dot dotfile as all-base", () => {
    expect(splitExtension(".gitignore")).toEqual({ base: ".gitignore", ext: "" });
  });
});

describe("nextAvailableName", () => {
  it("returns the name unchanged when free", () => {
    expect(nextAvailableName("a.txt", () => false)).toBe("a.txt");
  });
  it("appends ' (1)' before the extension on first collision", () => {
    const taken = new Set(["a.txt"]);
    expect(nextAvailableName("a.txt", (n) => taken.has(n))).toBe("a (1).txt");
  });
  it("increments past a run of collisions", () => {
    const taken = new Set(["a.txt", "a (1).txt", "a (2).txt"]);
    expect(nextAvailableName("a.txt", (n) => taken.has(n))).toBe("a (3).txt");
  });
  it("dedupes extension-less names", () => {
    const taken = new Set(["README"]);
    expect(nextAvailableName("README", (n) => taken.has(n))).toBe("README (1)");
  });
  it("simulates batch dedupe of repeated arrivals", () => {
    const claimed = new Set<string>();
    const names = ["dup.bin", "dup.bin", "dup.bin"];
    const out = names.map((n) => {
      const u = nextAvailableName(n, (x) => claimed.has(x));
      claimed.add(u);
      return u;
    });
    expect(out).toEqual(["dup.bin", "dup (1).bin", "dup (2).bin"]);
  });
});

// --- 内存落盘防线：能力探测 -------------------------------------------------
// canStreamToDisk 必须与 pickSaveTarget 的分支选择严格一致，否则下载页会在
// 一条其实能流式落盘的路径上误报（或更糟：在内存路径上不报）。

/** 装一对假的 File System Access 选择器；返回还原函数。 */
function stubPickers(o: { save?: boolean; dir?: boolean }): () => void {
  const w = window as unknown as Record<string, unknown>;
  const had = { save: "showSaveFilePicker" in w, dir: "showDirectoryPicker" in w };
  const writable = { write: async () => {}, close: async () => {} };
  const fileHandle = { createWritable: async () => writable };
  const dirHandle = {
    getFileHandle: async () => fileHandle,
    getDirectoryHandle: async () => dirHandle,
  };
  if (o.save) w.showSaveFilePicker = async () => fileHandle;
  if (o.dir) w.showDirectoryPicker = async () => dirHandle;
  return () => {
    if (!had.save) delete w.showSaveFilePicker;
    if (!had.dir) delete w.showDirectoryPicker;
  };
}

/** jsdom 没有 service worker，只能整个假造。照 share-target.test.ts 的 stubCaches
 *  路子：一个能被测试当作「SW 那一侧」驱动的最小替身。 */
function stubServiceWorker(o: { controller?: boolean; supports?: boolean } = {}) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  type Opened = { port: MessagePort; msg: Record<string, unknown> };
  const opened: Opened[] = [];
  const sw = {
    controller: null as { postMessage: (m: unknown, t?: Transferable[]) => void } | null,
    ready: Promise.resolve({}),
    register: async () => ({}),
    addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ||= []).push(f),
    removeEventListener: (t: string, f: (e: unknown) => void) => {
      listeners[t] = (listeners[t] || []).filter((x) => x !== f);
    },
  };
  if (o.controller !== false) {
    sw.controller = {
      postMessage: (m: unknown, transfer?: Transferable[]) => {
        const msg = m as Record<string, unknown>;
        const port = transfer?.[0] as MessagePort | undefined;
        if (msg.type === "stream-probe" && o.supports !== false && port) {
          port.postMessage({ type: "stream-probe-ok" });
        }
        if (msg.type === "stream-open" && port) {
          opened.push({ port, msg });
          port.postMessage({ type: "stream-ready" }); // 真 SW 在 openStream 末尾发的
        }
      },
    };
  }
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
  return {
    opened,
    /** 触发 navigator.serviceWorker 上的事件（controllerchange 等）。 */
    fire: (t: string) => (listeners[t] || []).forEach((f) => f({})),
    restore: () => {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
      probeStreamSupport(); // 把模块级就绪缓存清回 false，别漏给下一条用例
    },
  };
}

/** 让 MessageChannel 的消息真的送到（jsdom 的投递是异步的）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 等一个条件成立，最多 20 个宏任务。固定 tick 次数在这里是会飘的：jsdom 投递
 *  MessagePort 消息用几个任务并没有保证，写死 await tick() 会偶发红。 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !cond(); i++) await tick();
}

/** 装好 SW 替身并跑完探测握手。 */
async function readySW(o: { controller?: boolean; supports?: boolean } = {}) {
  const s = stubServiceWorker(o);
  probeStreamSupport();
  await until(swStreamReady);
  return s;
}

describe("swStreamReady", () => {
  it("探测握手成功后就绪", async () => {
    const s = await readySW();
    try { expect(swStreamReady()).toBe(true); } finally { s.restore(); }
  });

  it("controller 为 null 时不就绪 —— 首次访问 SW 还没 claim，此时下载会漏到 nginx 拿到 index.html", async () => {
    const s = await readySW({ controller: false });
    try { expect(swStreamReady()).toBe(false); } finally { s.restore(); }
  });

  it("SW 不认识流式路由（换版期间的旧 SW）时不就绪", async () => {
    const s = await readySW({ supports: false });
    try { expect(swStreamReady()).toBe(false); } finally { s.restore(); }
  });

  it("探测成功后 controller 又变回 null，就绪立刻收回（不缓存 controller）", async () => {
    const s = await readySW();
    try {
      expect(swStreamReady()).toBe(true);
      (navigator.serviceWorker as unknown as { controller: unknown }).controller = null;
      expect(swStreamReady()).toBe(false);
    } finally { s.restore(); }
  });

  it("没有 service worker 时不就绪", () => {
    probeStreamSupport();
    expect(swStreamReady()).toBe(false);
  });
});

describe("canStreamToDisk", () => {
  it("returns false with no File System Access API at all (Firefox/Safari/手机)", () => {
    const restore = stubPickers({});
    try {
      expect(canStreamToDisk(1)).toBe(false);
      expect(canStreamToDisk(5)).toBe(false);
    } finally { restore(); }
  });

  it("returns true for both single and multi file when both pickers exist (桌面 Chrome/Edge)", () => {
    const restore = stubPickers({ save: true, dir: true });
    try {
      expect(canStreamToDisk(1)).toBe(true);
      expect(canStreamToDisk(5)).toBe(true);
    } finally { restore(); }
  });

  it("with only showSaveFilePicker, streams a single file but not a batch", () => {
    const restore = stubPickers({ save: true });
    try {
      expect(canStreamToDisk(1)).toBe(true);
      expect(canStreamToDisk(2)).toBe(false);
    } finally { restore(); }
  });

  it("with only showDirectoryPicker, streams both — pickSaveTarget falls through to the folder branch", () => {
    const restore = stubPickers({ dir: true });
    try {
      expect(canStreamToDisk(1)).toBe(true);
      expect(canStreamToDisk(3)).toBe(true);
    } finally { restore(); }
  });

  it("SW 就绪时单文件能流式落盘，多文件仍然不能（Firefox/Safari/手机）", async () => {
    const restore = stubPickers({});
    const s = await readySW();
    try {
      expect(canStreamToDisk(1)).toBe(true);
      expect(canStreamToDisk(2)).toBe(false);
    } finally { s.restore(); restore(); }
  });

  it("agrees with pickSaveTarget's actual branch for every capability/count combination", async () => {
    // 唯一能确认探测没跑偏的办法：真跑一遍 pickSaveTarget，看它落到的是流式
    // 分支还是内存分支。内存分支的两个 label 是「ZIP」和「逐个下载」。
    const memoryLabels = new Set(["将打包为 ZIP 下载", "将逐个下载到默认下载目录"]);
    for (const caps of [{}, { save: true }, { dir: true }, { save: true, dir: true }]) {
      for (const sw of [false, true]) {
        for (const count of [1, 3]) {
          const restore = stubPickers(caps);
          const s = sw ? await readySW() : null;
          try {
            const files = Array.from({ length: count }, (_, i) => ({ name: `f${i}.bin`, size: 1 }));
            const target = await pickSaveTarget(files);
            const streamed = !memoryLabels.has(target.label);
            expect(streamed, `caps=${JSON.stringify(caps)} sw=${sw} count=${count} label=${target.label}`)
              .toBe(canStreamToDisk(count));
          } finally { s?.restore(); restore(); }
        }
      }
    }
  });

  it("SW 分支排在目录选择器之后：单文件 + 只有目录选择器仍走既有的目录分支", async () => {
    const restore = stubPickers({ dir: true });
    const s = await readySW();
    try {
      const target = await pickSaveTarget([{ name: "a.bin", size: 1 }]);
      expect(target.label).toBe("已选择目标文件夹");
    } finally { s.restore(); restore(); }
  });
});

describe("LARGE_DOWNLOAD_WARN_BYTES", () => {
  it("is 256 MiB", () => {
    expect(LARGE_DOWNLOAD_WARN_BYTES).toBe(256 * 1024 * 1024);
  });
});

const flat = (sizes: number[]) => sizes.map((size, i) => ({ name: `f${i}.bin`, size }));
const folder = (sizes: number[]) =>
  sizes.map((size, i) => ({ name: `f${i}.bin`, size, path: `trip/f${i}.bin` }));

describe("memoryPeakBytes", () => {
  it("扁平批次按总量算（blobSink 逐个下载，偏保守）", () => {
    expect(memoryPeakBytes(flat([100, 200]), 300)).toBe(300);
  });

  it("文件夹批次算 2×：ZipWriter 先攒 parts[]，concat 再复制一份进 zip", () => {
    expect(memoryPeakBytes(folder([100, 200]), 300)).toBe(600);
  });

  it("path 不含 '/' 不算文件夹 —— 必须与 pickSaveTarget 的 ZIP 分支同条件", () => {
    expect(memoryPeakBytes([{ name: "a.bin", size: 10, path: "a.bin" }], 10)).toBe(10);
  });

  it("与 pickSaveTarget 实际选中的分支一致：只有 ZIP 那条是 2×", async () => {
    const restore = stubPickers({});
    try {
      for (const files of [flat([1, 2]), folder([1, 2])]) {
        const target = await pickSaveTarget(files);
        const isZip = target.label === "将打包为 ZIP 下载";
        expect(memoryPeakBytes(files, 3), `label=${target.label}`).toBe(isZip ? 6 : 3);
      }
    } finally { restore(); }
  });
});

// --- SW 流式 sink ------------------------------------------------------------

/** 开一条 SW 流并把「SW 那一侧」的端口交出来。 */
async function openSink(name = "a.bin") {
  const restorePickers = stubPickers({});
  const s = await readySW();
  const target = await pickSaveTarget([{ name, size: 3 }]);
  const sink = await target.file(name, 3);
  return {
    sink,
    target,
    msg: s.opened[0].msg,
    swPort: s.opened[0].port,
    fire: s.fire,
    restore: () => { s.restore(); restorePickers(); },
  };
}

describe("swStreamSink", () => {
  it("登记的路径在 STREAM_ROUTE 下，头里带 Content-Disposition 和 octet-stream", async () => {
    const o = await openSink("图 片.svg");
    try {
      expect(String(o.msg.path).startsWith(STREAM_ROUTE)).toBe(true);
      const h = o.msg.headers as Record<string, string>;
      expect(h["Content-Disposition"]).toBe(contentDisposition("图 片.svg"));
      expect(h["Content-Type"]).toBe("application/octet-stream");
    } finally { o.restore(); }
  });

  it("**不**发 Content-Length —— 字节数对不上时浏览器会截断或丢弃整份已下完的文件", async () => {
    const o = await openSink();
    try {
      expect(Object.keys(o.msg.headers as object)).not.toContain("Content-Length");
    } finally { o.restore(); }
  });

  it("write 在 SW 回 ack 之前不 resolve（credit-1 背压窗口）", async () => {
    const o = await openSink();
    try {
      const got: Uint8Array[] = [];
      o.swPort.onmessage = (e) => {
        if ((e.data as { type: string }).type === "chunk") got.push((e.data as { chunk: Uint8Array }).chunk);
      };
      let done = false;
      const p = o.sink.write(new Uint8Array([1, 2, 3])).then(() => { done = true; });
      await until(() => got.length > 0);
      await tick(); // 再多给一轮：真让 write 有机会（错误地）提前 resolve
      expect(got.length).toBe(1);
      expect(Array.from(got[0])).toEqual([1, 2, 3]);
      expect(done, "ack 还没回，write 就不该 resolve —— 否则上游会无节制地灌，内存又回去了").toBe(false);
      o.swPort.postMessage({ type: "ack" });
      await p;
      expect(done).toBe(true);
    } finally { o.restore(); }
  });

  it("传给 write 的 subarray 不会被转移搞坏（拷一份再转移）", async () => {
    const o = await openSink();
    try {
      const backing = new Uint8Array([1, 2, 3, 4, 5]);
      const view = backing.subarray(1, 3);
      o.swPort.onmessage = () => o.swPort.postMessage({ type: "ack" });
      await o.sink.write(view);
      expect(Array.from(backing)).toEqual([1, 2, 3, 4, 5]); // detach 过就会全是 0 / 抛错
    } finally { o.restore(); }
  });

  it("用户在浏览器里取消下载后，write 报错而不是继续往死流里写", async () => {
    const o = await openSink();
    try {
      // 取消发生在一次 write 还挂着等 ack 的时候——真实场景就是这样，而且不用
      // 靠 tick 次数碰运气：那个 ack 永远不会来，只能被 cancel 打断。
      const inflight = o.sink.write(new Uint8Array([1]));
      o.swPort.postMessage({ type: "cancel" });
      await expect(inflight).rejects.toThrow(/cancel/i);
      // 取消之后再写也必须立刻报错，而不是继续往死流里灌。
      await expect(o.sink.write(new Uint8Array([2]))).rejects.toThrow(/cancel/i);
    } finally { o.restore(); }
  });

  it("部署换版顶掉 SW（controllerchange）后 write 报错，而不是永远卡住等 ack", async () => {
    const o = await openSink();
    try {
      o.fire("controllerchange");
      await expect(o.sink.write(new Uint8Array([1]))).rejects.toThrow(/replaced/i);
    } finally { o.restore(); }
  });

  it("SW 一直没来取流（iframe 的请求没到）时报错，而不是无声挂死在第二个 write 上", async () => {
    // shouldAdvanceTime 让假定时器仍随真实时间走，否则 jsdom 投递 MessageChannel
    // 消息用的 tick() 会被冻住，openSink 根本回不来。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const o = await openSink();
      try {
        const p = o.sink.write(new Uint8Array([1]));
        vi.advanceTimersByTime(30_000);
        await expect(p).rejects.toThrow(/never fetched/);
      } finally { o.restore(); }
    } finally { vi.useRealTimers(); }
  });

  it("单文件目标只能取一次 sink", async () => {
    const o = await openSink();
    try {
      await expect(o.target.file("a.bin", 3)).rejects.toThrow(/already consumed/);
    } finally { o.restore(); }
  });
});

// --- sw-template.js 的拦截顺序 ----------------------------------------------
// sw-template.js 从不被打包也从不被 import，jsdom 里更没有 service worker，所以
// 它的运行时行为一行都测不到。唯一还能守住的是**源码顺序**：流式分支必须排在
// navigate 分支之前，否则 iframe 发出的请求（mode === "navigate"）会被「网络优先」
// 那条抢走，漏到 nginx 的 try_files，用户下载到一个 index.html。这条故障只在
// 生产复现（Go 的 spa.go 对带扩展名的未知路径返真 404），本地永远看不见——所以
// 这个笨拙的源码断言是有价值的。
describe("sw-template.js", () => {
  // vitest 的 root 是 web/；import.meta.url 在这里是 http:// 的，不能喂给 fs。
  const src = readFileSync(resolve(process.cwd(), "src/sw-template.js"), "utf8");

  it("流式分支排在 navigate 分支之前", () => {
    const stream = src.indexOf("STREAM_ROUTE)");
    const navigate = src.indexOf('req.mode === "navigate"');
    expect(stream).toBeGreaterThan(0);
    expect(navigate).toBeGreaterThan(0);
    expect(stream, "流式拦截必须在 navigate 之前，否则 iframe 的请求会被送去网络").toBeLessThan(navigate);
  });

  it("留着给 vite-plugin-pwa 替换的 __STREAM_ROUTE__ 占位符", () => {
    expect(src).toContain("__STREAM_ROUTE__");
  });

  it("未登记的 /__stream__/ 路径由 SW 自己 404，不放行到 nginx", () => {
    expect(src).toContain('status: 404');
  });
});

describe("warnsAboutMemory", () => {
  it("有流式落盘能力时永不提示，多大都行", () => {
    const restore = stubPickers({ save: true, dir: true });
    try {
      expect(warnsAboutMemory(folder([10 * LARGE_DOWNLOAD_WARN_BYTES]), 10 * LARGE_DOWNLOAD_WARN_BYTES)).toBe(false);
    } finally { restore(); }
  });

  it("无流式落盘能力 + 扁平批次：越过阈值才提示", () => {
    const restore = stubPickers({});
    try {
      expect(warnsAboutMemory(flat([256 * 1024 * 1024]), 256 * 1024 * 1024)).toBe(false);
      expect(warnsAboutMemory(flat([256 * 1024 * 1024 + 1]), 256 * 1024 * 1024 + 1)).toBe(true);
    } finally { restore(); }
  });

  it("无流式落盘能力 + 文件夹：峰值 2×，所以一半的量就越线", () => {
    const restore = stubPickers({});
    try {
      const half = 130 * 1024 * 1024; // 扁平不会提示，×2 后越过 256 MiB
      expect(warnsAboutMemory(flat([half]), half)).toBe(false);
      expect(warnsAboutMemory(folder([half]), half)).toBe(true);
    } finally { restore(); }
  });
});
