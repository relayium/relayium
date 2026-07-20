// 上传端的一句提醒。发送方是唯一决定文件多大的人，但吃下后果的是接收方：
// 手机浏览器和 Firefox/Safari 必须把整份文件读进内存才能交付。这里只提示，
// 不阻止上传 —— 1 GiB 的上限本身是合理的（CLI 在这个尺寸上真能跑）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";

const uploadFileResumable = vi.fn();
vi.mock("./stored-file", () => ({
  uploadFileResumable: (...a: unknown[]) => uploadFileResumable(...a),
  buildDownloadLink: () => "https://relayium.com/d/abc#k=zzz",
  UploadError: class UploadError extends Error { status = 0; },
}));
vi.mock("./upload-keys", () => ({ rememberUploadKey: () => {} }));

import StoredUpload from "./StoredUpload.svelte";
import { loadLang } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES } from "./filesink";

let target: HTMLDivElement;
let app: unknown;

async function mountUpload() {
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(StoredUpload, { target });
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** 走真实的 <input type=file> onchange 路径，而不是直接调内部函数。 */
async function pick(sizes: number[]) {
  const input = target.querySelector('input[type="file"]') as HTMLInputElement;
  const files = sizes.map((size, i) => ({ name: `f${i}.bin`, size }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  // Svelte 5 把 change 做事件委托，挂在挂载根上 —— 不冒泡的事件到不了处理器。
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

beforeEach(() => {
  uploadFileResumable.mockReset();
  uploadFileResumable.mockResolvedValue({ id: "abc", key: "zzz", expiresAt: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ maxFileSize: 0 }) })) as unknown as typeof fetch);
});

afterEach(() => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  vi.unstubAllGlobals();
});

describe("StoredUpload 大文件提醒", () => {
  it("总量越过阈值时提醒发送方，且上传照常进行", async () => {
    await mountUpload();
    await pick([LARGE_DOWNLOAD_WARN_BYTES + 1]);

    const note = target.querySelector(".bignote");
    expect(note, "应提醒发送方接收方可能下载不了").not.toBeNull();
    expect(note!.textContent!.trim().length).toBeGreaterThan(0);
    // 只是提示：上传不受影响。
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
  });

  it("小文件不提醒", async () => {
    await mountUpload();
    await pick([1024 * 1024]);

    expect(target.querySelector(".bignote")).toBeNull();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
  });

  it("按总量算：多个各自不大的文件加起来越线也提醒", async () => {
    await mountUpload();
    await pick([70 * 1024 * 1024, 70 * 1024 * 1024, 70 * 1024 * 1024, 70 * 1024 * 1024]);

    expect(target.querySelector(".bignote")).not.toBeNull();
  });

  it("换成一批小文件后提醒消失，不残留上一次的状态", async () => {
    await mountUpload();
    await pick([LARGE_DOWNLOAD_WARN_BYTES + 1]);
    expect(target.querySelector(".bignote")).not.toBeNull();

    await pick([1024]);
    expect(target.querySelector(".bignote")).toBeNull();
  });
});
