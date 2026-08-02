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
import { refreshHolds, resetAppUpdate } from "./app-update.svelte";

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
  resetAppUpdate(); // 别把一个没释放的闸门漏给别的用例
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

// 刷新会把这次上传整个丢掉，连带那把只存在于本机内存里的零知识密钥（要等上传成功
// 才 rememberUploadKey）。这条路完全在 workspace 之外，warnsOnLeave 看不见它，所以
// 全站更新提示条只能靠这个显式闸门知道「现在不能刷」。
describe("StoredUpload × 更新刷新闸门", () => {
  it("上传全程占住闸门，成功后释放", async () => {
    let finish!: (v: unknown) => void;
    uploadFileResumable.mockImplementation(() => new Promise((r) => (finish = r)));
    await mountUpload();
    expect(refreshHolds(), "还没开始上传就不该占").toBe(0);

    await pick([1024]);
    expect(refreshHolds(), "上传在途必须占住").toBe(1);

    finish({ id: "abc", key: "zzz", expiresAt: 0 });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(refreshHolds()).toBe(0);
  });

  it("上传失败也释放闸门", async () => {
    uploadFileResumable.mockRejectedValue(new Error("network"));
    await mountUpload();
    await pick([1024]);

    expect(target.querySelector(".err, .error"), "确实是失败那条路").not.toBeNull();
    expect(refreshHolds(), "错误路径漏放会让按钮永远是灰的").toBe(0);
  });

  it("用户取消也释放闸门", async () => {
    let reject!: (e: unknown) => void;
    uploadFileResumable.mockImplementation(() => new Promise((_, rj) => (reject = rj)));
    await mountUpload();
    await pick([1024]);
    expect(refreshHolds()).toBe(1);

    (target.querySelector(".cancel, .btn-ghost") as HTMLButtonElement | null)?.click();
    reject(new Error("aborted"));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(refreshHolds()).toBe(0);
  });

  it("空选择直接早退，不占闸门", async () => {
    await mountUpload();
    await pick([]);
    expect(refreshHolds()).toBe(0);
  });
});
