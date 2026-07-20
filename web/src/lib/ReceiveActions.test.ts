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
import { loadLang, messages } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES } from "./filesink";

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
}) {
  await loadLang("en");
  restorePickers = stubPickers(o.canStream);
  const total = o.files.reduce((n, f) => n + f.size, 0);
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ReceiveActions, {
    target,
    props: { files: o.files, total, onAccept, onReject },
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

beforeEach(() => {
  onAccept = vi.fn();
  onReject = vi.fn();
  restorePickers = () => {};
});

afterEach(() => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  restorePickers();
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

  it("提示状态下拒绝仍然可用，且不触发接收", async () => {
    await mountActions({ canStream: false, files: folder(BIG) });

    byText(t().decline)!.click();
    flushSync();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });
});
