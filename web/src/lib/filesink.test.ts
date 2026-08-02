import { describe, it, expect, vi, afterEach } from "vitest";
import { splitExtension, nextAvailableName, canStreamToDisk, asksWhereToSave, pickSaveTarget, memoryPeakBytes, warnsAboutMemory, LARGE_DOWNLOAD_WARN_BYTES, probeStreamSupport, swStreamReady, saveFailureStatus, SaveCancelledError, SaveUnavailableError } from "./filesink";
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

/** SW 流式落盘的显式开关。只有下载页传它；实时接收路一律不传（默认关）。 */
const SW_ON = { swStream: true };

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

  it("SW 就绪 + 显式开关时单文件能流式落盘，多文件仍然不能（Firefox/Safari/手机）", async () => {
    const restore = stubPickers({});
    const s = await readySW();
    try {
      expect(canStreamToDisk(1, SW_ON)).toBe(true);
      expect(canStreamToDisk(2, SW_ON)).toBe(false);
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
            const target = await pickSaveTarget(files, SW_ON);
            const streamed = !memoryLabels.has(target.label);
            expect(streamed, `caps=${JSON.stringify(caps)} sw=${sw} count=${count} label=${target.label}`)
              .toBe(canStreamToDisk(count, SW_ON));
          } finally { s?.restore(); restore(); }
        }
      }
    }
  });

  it("不传开关时 SW 分支整条关闭 —— 实时接收路（App.svelte）的行为逐字不变", async () => {
    // 这条守的是一个刻意的产品裁定，不是实现细节：实时接收路把「已 ack」当作
    // durability 信号回给发送端，而 SW 的 ack 只代表字节进了 ReadableStream。
    // 语义对不上，且完全没验证过。第 1 步只想拿到「iOS Safari 行不行」这一个
    // 干净答案，多一个未测变量就毁了这个目的。
    const restore = stubPickers({}); // Firefox/Safari/手机：没有 File System Access API
    const s = await readySW(); // SW 完全就绪 —— 唯一挡住它的只能是那个开关
    try {
      expect(canStreamToDisk(1)).toBe(false);
      const target = await pickSaveTarget([{ name: "a.bin", size: 1 }]);
      expect(target.label, "没传开关就必须落回既有的内存分支").toBe("将逐个下载到默认下载目录");
      // 内存提示同样要照旧出现：实时路那条提示不能被 SW 分支悄悄摘掉。
      expect(warnsAboutMemory(flat([LARGE_DOWNLOAD_WARN_BYTES + 1]), LARGE_DOWNLOAD_WARN_BYTES + 1)).toBe(true);
    } finally { s.restore(); restore(); }
  });

  it("SW 分支排在目录选择器之后：单文件 + 只有目录选择器仍走既有的目录分支", async () => {
    const restore = stubPickers({ dir: true });
    const s = await readySW();
    try {
      const target = await pickSaveTarget([{ name: "a.bin", size: 1 }], SW_ON);
      expect(target.label).toBe("已选择目标文件夹");
    } finally { s.restore(); restore(); }
  });
});

// --- 手机：选择器分支整条关闭 -----------------------------------------------
//
// 线上事故（Android 真机，实时与局域网两条路都复现），两种坏法都来自真机：
//  1. 安卓自带浏览器：`showSaveFilePicker` 属性在，调用它却给不出任何可用的选择
//     界面，接收当场卡死；
//  2. 安卓版 Chrome：确实弹得出文件夹选择器，但那是个系统页面，一次误触返回键
//     就把整次接收取消掉，只有正正好点中「选择此文件夹」才算成功。
//
// 两种都不是可用的保存流程，而且同一台设备上会遇到哪一种并不可预测。所以手机上
// 一次选择器都不开：走浏览器下载，接收前就明说文件落到下载目录。这一组用例钉的
// 就是这个确定性 —— **属性齐全时选择器调用次数必须是 0**，而文件必须逐字节到手。

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** 把 navigator.userAgent 换成手机的；返回还原函数。 */
function stubUA(ua: string): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  return () => {
    if (had) Object.defineProperty(navigator, "userAgent", had);
    else delete (navigator as unknown as Record<string, unknown>).userAgent;
  };
}

const abortError = (msg = "The user aborted a request.") => {
  const e = new Error(msg);
  e.name = "AbortError";
  return e;
};

/**
 * 装一对**能用**的选择器，并数调用次数。
 *
 * 手机那一组要的正是这个组合：属性齐全、而且真调用就真能拿到句柄 —— 于是
 * 「calls 为 0」只可能来自我们主动不调用，不可能是失败后回落的副作用。
 */
function stubCountedPickers(o: { save?: boolean; dir?: boolean } = { save: true, dir: true }) {
  const w = window as unknown as Record<string, unknown>;
  const had = { save: "showSaveFilePicker" in w, dir: "showDirectoryPicker" in w };
  const calls = { save: 0, dir: 0 };
  const writable = { write: async () => {}, close: async () => {} };
  const fileHandle = { createWritable: async () => writable };
  const dirHandle = {
    getFileHandle: async () => fileHandle,
    getDirectoryHandle: async () => dirHandle,
  };
  if (o.save) w.showSaveFilePicker = async () => { calls.save++; return fileHandle; };
  if (o.dir) w.showDirectoryPicker = async () => { calls.dir++; return dirHandle; };
  return {
    calls,
    restore: () => {
      if (!had.save) delete w.showSaveFilePicker;
      if (!had.dir) delete w.showDirectoryPicker;
    },
  };
}

/** 装一对**存在但会失败**的选择器（桌面那一组用）。 */
function stubBrokenPickers(o: { save?: boolean; dir?: boolean; err: Error }) {
  const w = window as unknown as Record<string, unknown>;
  const had = { save: "showSaveFilePicker" in w, dir: "showDirectoryPicker" in w };
  const calls = { save: 0, dir: 0 };
  if (o.save !== false) w.showSaveFilePicker = async () => { calls.save++; throw o.err; };
  if (o.dir !== false) w.showDirectoryPicker = async () => { calls.dir++; throw o.err; };
  return {
    calls,
    restore: () => {
      if (!had.save) delete w.showSaveFilePicker;
      if (!had.dir) delete w.showDirectoryPicker;
    },
  };
}

/**
 * 把 Blob 下载那条回落路截下来，取回真正交给用户的字节。
 *
 * 下载分支是 `URL.createObjectURL(blob)` + 一次 <a download> 点击，jsdom 两样都不
 * 实现下载语义，但 Blob 本体是真的 —— 所以字节比对是真的。
 */
function captureDownloads() {
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const realClick = HTMLAnchorElement.prototype.click;
  const files: { name: string; blob: Blob }[] = [];
  let pending: Blob | null = null;
  (URL as unknown as Record<string, unknown>).createObjectURL = (obj: Blob) => {
    pending = obj;
    return "blob:relayium-test";
  };
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download && pending) files.push({ name: this.download, blob: pending });
    pending = null;
  };
  return {
    files,
    restore: () => {
      (URL as unknown as Record<string, unknown>).createObjectURL = realCreate;
      (URL as unknown as Record<string, unknown>).revokeObjectURL = realRevoke;
      HTMLAnchorElement.prototype.click = realClick;
    },
  };
}

const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

describe("手机：一次选择器都不开", () => {
  let restoreUA: () => void = () => {};
  afterEach(() => restoreUA());

  for (const [name, ua] of [["Android", ANDROID_UA], ["iOS", IPHONE_UA]] as const) {
    it(`${name}：选择器属性齐全也一次都不调用，文件逐字节走浏览器下载`, async () => {
      restoreUA = stubUA(ua);
      const p = stubCountedPickers();
      const dl = captureDownloads();
      try {
        const bytes = payload(4096);
        const target = await pickSaveTarget([{ name: "a.bin", size: bytes.length }]);
        expect(target.label).toBe("将逐个下载到默认下载目录");
        expect(p.calls, "手机上任何选择器都不许被调用").toEqual({ save: 0, dir: 0 });

        const sink = await target.file("a.bin", bytes.length);
        await sink.write(bytes);
        await sink.close();

        expect(dl.files.map((f) => f.name)).toEqual(["a.bin"]);
        const got = new Uint8Array(await dl.files[0].blob.arrayBuffer());
        expect(got.length).toBe(bytes.length);
        expect([...got]).toEqual([...bytes]);
      } finally { dl.restore(); p.restore(); }
    });
  }

  it("多文件批次同样不开目录选择器", async () => {
    restoreUA = stubUA(ANDROID_UA);
    const p = stubCountedPickers();
    try {
      const target = await pickSaveTarget(flat([1, 2, 3]));
      expect(target.label).toBe("将逐个下载到默认下载目录");
      expect(p.calls).toEqual({ save: 0, dir: 0 });
    } finally { p.restore(); }
  });

  it("文件夹批次走 ZIP，也不开目录选择器", async () => {
    restoreUA = stubUA(ANDROID_UA);
    const p = stubCountedPickers();
    try {
      const target = await pickSaveTarget(folder([1, 2]));
      expect(target.label).toBe("将打包为 ZIP 下载");
      expect(p.calls).toEqual({ save: 0, dir: 0 });
    } finally { p.restore(); }
  });

  it("接收前的文案说的就是实际会发生的事：不问位置，落到下载目录", () => {
    restoreUA = stubUA(ANDROID_UA);
    const restore = stubPickers({ save: true, dir: true }); // 属性都在 —— 手机上不算数
    try {
      expect(asksWhereToSave(1)).toBe(false);
      expect(asksWhereToSave(4)).toBe(false);
      expect(canStreamToDisk(1)).toBe(false);
      // 内存提示是这条路上唯一的保护，绝不能被「属性存在」悄悄摘掉。
      expect(warnsAboutMemory(flat([LARGE_DOWNLOAD_WARN_BYTES + 1]), LARGE_DOWNLOAD_WARN_BYTES + 1)).toBe(true);
    } finally { restore(); }
  });

  it("手机上永远走不到「用户取消」这条路 —— 那条状态只属于桌面", async () => {
    restoreUA = stubUA(ANDROID_UA);
    const p = stubBrokenPickers({ err: abortError() }); // 调用就会抛，但没人会调用它
    try {
      const target = await pickSaveTarget([{ name: "a.bin", size: 1 }]);
      expect(target.label).toBe("将逐个下载到默认下载目录");
      expect(p.calls).toEqual({ save: 0, dir: 0 });
    } finally { p.restore(); }
  });
});

describe("桌面：选择器坏了（非取消的失败）", () => {
  it("单文件：非 Abort 的失败回落到浏览器下载，而不是把这次接收判死", async () => {
    const p = stubBrokenPickers({ err: Object.assign(new Error("nope"), { name: "NotAllowedError" }) });
    try {
      const target = await pickSaveTarget([{ name: "a.bin", size: 1 }]);
      expect(target.label).toBe("将逐个下载到默认下载目录");
      expect(p.calls.save, "桌面上要真的试一次").toBe(1);
      expect(p.calls.dir, "第一个选择器已经花掉了这次点击的手势，别再抛一次").toBe(0);
    } finally { p.restore(); }
  });

  it("选择器弹出来了，createWritable 才失败 —— 依然是回落，不是用户取消", async () => {
    const w = window as unknown as Record<string, unknown>;
    const had = "showSaveFilePicker" in w;
    w.showSaveFilePicker = async () => ({
      createWritable: async () => { throw new Error("NotAllowedError: write access denied"); },
    });
    try {
      const target = await pickSaveTarget([{ name: "a.bin", size: 1 }]);
      expect(target.label).toBe("将逐个下载到默认下载目录");
    } finally { if (!had) delete w.showSaveFilePicker; }
  });

  it("文件夹批次：目录选择器坏了时回落到 ZIP", async () => {
    const p = stubBrokenPickers({ save: false, err: new Error("SecurityError") });
    try {
      const target = await pickSaveTarget(folder([1, 2]));
      expect(target.label).toBe("将打包为 ZIP 下载");
      expect(p.calls.dir).toBe(1);
    } finally { p.restore(); }
  });

  it("坏掉之后没有留下任何会话级状态：下一批照旧完整地再试一次", async () => {
    const broken = stubBrokenPickers({ err: new Error("SecurityError") });
    try {
      await pickSaveTarget([{ name: "a.bin", size: 1 }]);
      expect(broken.calls.save).toBe(1);
    } finally { broken.restore(); }
    const good = stubCountedPickers();
    try {
      const target = await pickSaveTarget([{ name: "b.bin", size: 1 }]);
      expect(target.label, "上一批的失败不该污染这一批").toBe("已选择保存位置");
      expect(good.calls.save).toBe(1);
      expect(asksWhereToSave(1)).toBe(true);
    } finally { good.restore(); }
  });

  it("回落会撑爆内存的大批次：如实失败，不悄悄塞进内存", async () => {
    // 点击之前 asksWhereToSave 说了「浏览器会问你存哪里」，于是用户没看到内存
    // 提示。选择器随后坏掉就退到 Blob = 在一条被告知会流式落盘的路径上把整批攒进
    // 内存，用户等来的是被系统回收的标签页。宁可报错让他重试。
    const p = stubBrokenPickers({ err: new Error("SecurityError") });
    try {
      const big = flat([LARGE_DOWNLOAD_WARN_BYTES + 1]);
      await expect(pickSaveTarget(big)).rejects.toBeInstanceOf(SaveUnavailableError);
      // 归因是「保存失败」，不是「用户取消」。
      await expect(pickSaveTarget(big).catch((e) => saveFailureStatus(e))).resolves.toBe("saveFail");
    } finally { p.restore(); }
  });

  it("SW 流还能用时，大批次照旧回落 —— 那条路是真落盘，不吃内存", async () => {
    const p = stubBrokenPickers({ err: new Error("SecurityError") });
    const s = await readySW();
    try {
      const target = await pickSaveTarget(flat([LARGE_DOWNLOAD_WARN_BYTES + 1]), SW_ON);
      expect(target.label).toBe("将流式下载到默认下载目录");
    } finally { s.restore(); p.restore(); }
  });
});

describe("桌面：真正的用户取消", () => {
  it("AbortError 就是取消：抛 SaveCancelledError，这次接收必须停下来问一次", async () => {
    // 桌面上 AbortError 没有第二种含义。那些「界面没弹出来也抛 AbortError」的设备
    // 全是手机，而手机连调用都不会发生 —— 所以这里不需要任何计时启发式。
    const p = stubBrokenPickers({ err: abortError() });
    try {
      await expect(pickSaveTarget([{ name: "a.bin", size: 1 }])).rejects.toBeInstanceOf(SaveCancelledError);
      expect(p.calls.dir, "取消不是故障，别再拿目录选择器骚扰用户一次").toBe(0);
    } finally { p.restore(); }
  });

  it("多文件批次在目录选择器上取消同样是取消", async () => {
    const p = stubBrokenPickers({ save: false, err: abortError() });
    try {
      await expect(pickSaveTarget(flat([1, 2]))).rejects.toBeInstanceOf(SaveCancelledError);
    } finally { p.restore(); }
  });

  it("取消之后能力探测不变 —— 取消不是故障", async () => {
    const p = stubBrokenPickers({ err: abortError() });
    try {
      await pickSaveTarget([{ name: "a.bin", size: 1 }]).catch(() => {});
      expect(asksWhereToSave(1)).toBe(true);
      expect(canStreamToDisk(1)).toBe(true);
    } finally { p.restore(); }
  });

  it("桌面（属性存在）仍然按能流式落盘算 —— 既有行为逐字不变", () => {
    const restore = stubPickers({ save: true, dir: true });
    try {
      expect(asksWhereToSave(1)).toBe(true);
      expect(canStreamToDisk(5)).toBe(true);
    } finally { restore(); }
  });
});

describe("saveFailureStatus", () => {
  it("只有 SaveCancelledError 才算用户取消", () => {
    expect(saveFailureStatus(new SaveCancelledError("x"))).toBe("noSave");
  });
  it("其余一律是保存失败 —— 包括名字长得像取消的 AbortError", () => {
    expect(saveFailureStatus(abortError())).toBe("saveFail");
    expect(saveFailureStatus(new Error("boom"))).toBe("saveFail");
    expect(saveFailureStatus(undefined)).toBe("saveFail");
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
  const target = await pickSaveTarget([{ name, size: 3 }], SW_ON);
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
  it("登记的路径在 STREAM_ROUTE 下，只把 Content-Disposition 交给 SW", async () => {
    const o = await openSink("图 片.svg");
    try {
      expect(String(o.msg.path).startsWith(STREAM_ROUTE)).toBe(true);
      const h = o.msg.headers as Record<string, string>;
      expect(h["Content-Disposition"]).toBe(contentDisposition("图 片.svg"));
      // Content-Type / nosniff / no-store 由 SW 自己强制（sw-template.test.ts 守），
      // 页面**不该**参与：那条路上的字节完全由对端控制，反射消息内容就是把同源
      // 任意 Content-Type 托管权交出去。
      expect(Object.keys(h)).toEqual(["Content-Disposition"]);
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

  it("SW 被回收后 write 不会永久挂死：每一次 ack 等待都有独立的停滞超时", async () => {
    // 这是手机上最可能发生的失败方式。SW 被浏览器回收**不会**触发 controllerchange
    // （registration 没变），stream-ping 只会拉起一个 streams 为空的新实例，旧 port
    // 随 worker 一起没了——之后的 chunk 全发进虚空。握手期那个一次性超时早就被
    // stream-serving 清掉了，兜不住这里。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const o = await openSink();
      try {
        o.swPort.postMessage({ type: "stream-serving" }); // 先让 serveTimer 被清掉
        await tick();
        const p = o.sink.write(new Uint8Array([1]));
        vi.advanceTimersByTime(30_000); // 越过 serve 超时：它已经不管这条流了
        vi.advanceTimersByTime(31_000); // 越过 ack 停滞超时
        await expect(p).rejects.toThrow(/stopped responding/i);
      } finally { o.restore(); }
    } finally { vi.useRealTimers(); }
  });

  it("stream-serving 会清掉 serve 超时 —— 否则每一次下载都会在 30s 被掐断", async () => {
    // 变异守卫：删掉 SW 侧那条 clearTimeout(serveTimer)，正常下载也会在 30s 报
    // 「never fetched」，功能整个作废。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const o = await openSink();
      try {
        o.swPort.postMessage({ type: "stream-serving" });
        await tick();
        const p = o.sink.write(new Uint8Array([1]));
        vi.advanceTimersByTime(35_000); // 越过 30s serve 超时，但没到 ack 超时
        o.swPort.postMessage({ type: "ack" });
        await expect(p).resolves.toBeUndefined();
      } finally { o.restore(); }
    } finally { vi.useRealTimers(); }
  });

  it("close 必须等 SW 回 closed 才 resolve —— 否则用户被告知成功，磁盘上是半个文件", async () => {
    const o = await openSink();
    try {
      let done = false;
      const p = o.sink.close().then(() => { done = true; });
      await tick(); await tick();
      expect(done, "没有回执就无从知道 SW 是否还活着、流是否真的收尾了").toBe(false);
      o.swPort.postMessage({ type: "closed" });
      await p;
      expect(done).toBe(true);
    } finally { o.restore(); }
  });

  it("SW 已死时 close 超时 reject，绝不 resolve", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const o = await openSink();
      try {
        const p = o.sink.close();
        vi.advanceTimersByTime(16_000);
        await expect(p).rejects.toThrow(/stopped responding/i);
      } finally { o.restore(); }
    } finally { vi.useRealTimers(); }
  });

  it("close 期间 SW 被换掉也 reject，而不是被摘掉监听后永远搁浅", async () => {
    const o = await openSink();
    try {
      const p = o.sink.close();
      o.fire("controllerchange");
      await expect(p).rejects.toThrow(/replaced/i);
    } finally { o.restore(); }
  });

  it("违反串行约定（并发 write，或 close 撞上在途 write）是响亮的失败，不是挂死", async () => {
    const o = await openSink();
    try {
      const first = o.sink.write(new Uint8Array([1]));
      const second = o.sink.write(new Uint8Array([2]));
      await expect(second).rejects.toThrow(/serialised/i);
      // 并发写入的字节序本来就已经未定义，整条流一并判死比落一个内容错乱的文件好。
      await expect(first).rejects.toThrow(/serialised/i);
    } finally { o.restore(); }
  });

  it("close 撞上在途 write 同样立刻报错", async () => {
    const o = await openSink();
    try {
      const w = o.sink.write(new Uint8Array([1]));
      await expect(o.sink.close()).rejects.toThrow(/serialised/i);
      await expect(w).rejects.toThrow(/serialised/i);
    } finally { o.restore(); }
  });

  it("放弃这条流时先给 SW 发 abort，再关端口 —— 否则 SW 侧的流被遗弃", async () => {
    // 只 port.close() 的话 SW 那边什么都不知道：reader.read() 永远 pending，
    // 注册表条目一直活着，浏览器那份下载吊在一个半截临时文件上。
    // abort 到了 SW 会发生什么由 sw-template.test.ts 真跑那份脚本验证。
    const o = await openSink();
    try {
      const seen: string[] = [];
      o.swPort.onmessage = (e) => seen.push((e.data as { type: string }).type);
      o.fire("controllerchange"); // 页面侧放弃的一种：部署换版顶掉了 SW
      await until(() => seen.includes("abort"));
      expect(seen, "fail() 必须在 port.close() 之前发 abort").toContain("abort");
    } finally { o.restore(); }
  });

  it("重复放弃只发一次 abort（端口已关，再发就是抛异常）", async () => {
    const o = await openSink();
    try {
      const seen: string[] = [];
      o.swPort.onmessage = (e) => seen.push((e.data as { type: string }).type);
      o.fire("controllerchange");
      o.fire("controllerchange");
      await until(() => seen.includes("abort"));
      await tick();
      expect(seen.filter((t) => t === "abort").length).toBe(1);
    } finally { o.restore(); }
  });

  it("单文件目标只能取一次 sink", async () => {
    const o = await openSink();
    try {
      await expect(o.target.file("a.bin", 3)).rejects.toThrow(/already consumed/);
    } finally { o.restore(); }
  });
});

// sw-template.js 自己的行为（拦截顺序、pull/ack 汇合、close 回执、强制响应头）
// 由 src/sw-template.test.ts 用 new Function 真跑那份脚本来测。这里只测页面侧。

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

  it("SW 就绪 + 开关打开：单文件多大都不提示（这一步的用户可见效果）", async () => {
    const restore = stubPickers({}); // Firefox/Safari/手机
    const s = await readySW();
    try {
      const big = 10 * LARGE_DOWNLOAD_WARN_BYTES;
      expect(warnsAboutMemory(flat([big]), big, SW_ON), "SW 能流式落盘就不该再吓唬用户").toBe(false);
      // 多文件 SW 接不了，提示照旧。
      expect(warnsAboutMemory(flat([big, big]), 2 * big, SW_ON)).toBe(true);
    } finally { s.restore(); restore(); }
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
