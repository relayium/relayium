import { describe, it, expect } from "vitest";
import { splitExtension, nextAvailableName, canStreamToDisk, pickSaveTarget, memoryPeakBytes, warnsAboutMemory, LARGE_DOWNLOAD_WARN_BYTES } from "./filesink";

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

  it("agrees with pickSaveTarget's actual branch for every capability/count combination", async () => {
    // 唯一能确认探测没跑偏的办法：真跑一遍 pickSaveTarget，看它落到的是流式
    // 分支还是内存分支。内存分支的两个 label 是「ZIP」和「逐个下载」。
    const memoryLabels = new Set(["将打包为 ZIP 下载", "将逐个下载到默认下载目录"]);
    for (const caps of [{}, { save: true }, { dir: true }, { save: true, dir: true }]) {
      for (const count of [1, 3]) {
        const restore = stubPickers(caps);
        try {
          const files = Array.from({ length: count }, (_, i) => ({ name: `f${i}.bin`, size: 1 }));
          const target = await pickSaveTarget(files);
          const streamed = !memoryLabels.has(target.label);
          expect(streamed, `caps=${JSON.stringify(caps)} count=${count} label=${target.label}`)
            .toBe(canStreamToDisk(count));
        } finally { restore(); }
      }
    }
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
