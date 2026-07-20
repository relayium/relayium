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

import DownloadPage from "./DownloadPage.svelte";
import { loadLang } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES } from "./filesink";

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
    await mountPage({ canStream: false, files: [{ name: "edge.bin", size: LARGE_DOWNLOAD_WARN_BYTES }] });
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
