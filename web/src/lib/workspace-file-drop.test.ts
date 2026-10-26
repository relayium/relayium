import { describe, expect, it, vi } from "vitest";
import { dropWorkspaceFiles, type FileDropWorkspace } from "./workspace-file-drop";

const context = (): FileDropWorkspace => ({ peerId: "linked-b", generation: 4, epoch: 2 });
const file = () => new File(["LAN only"], "hello.txt");
const flat = (files = [file()]) => ({ files } as unknown as DataTransfer);
function delayedFolder() {
  let finish!: (file: File) => void;
  const capture = vi.fn(() => ({
    isFile: true, isDirectory: false, fullPath: "/folder/hello.txt",
    file: (ok: (f: File) => void) => { finish = ok; },
  }));
  const transfer = { items: [{ webkitGetAsEntry: capture }] } as unknown as DataTransfer;
  return { transfer, capture, finish: () => finish(file()) };
}

describe("LAN workspace drops retain their exact linked target", () => {
  it("sends one batch to the linked peer without a roster-first-peer input", async () => {
    const send = vi.fn(), refused = vi.fn(), f = file();
    await dropWorkspaceFiles(flat([f]), context, send, refused);
    expect(send).toHaveBeenCalledExactlyOnceWith("linked-b", [{ file: f }]);
    expect(refused).not.toHaveBeenCalled();
  });
  it("captures entries before yielding and preserves folder paths", async () => {
    const folder = delayedFolder(), send = vi.fn(), refused = vi.fn();
    const work = dropWorkspaceFiles(folder.transfer, context, send, refused);
    expect(folder.capture).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    folder.finish(); await work;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1][0].path).toBe("folder/hello.txt");
    expect(refused).not.toHaveBeenCalled();
  });
  it.each(["peer", "generation", "epoch", "disabled-or-left-route"])("refuses a %s change during a folder walk", async change => {
    const folder = delayedFolder(), send = vi.fn(), refused = vi.fn();
    let live: FileDropWorkspace | null = context();
    const work = dropWorkspaceFiles(folder.transfer, () => live, send, refused);
    live = change === "peer" ? { ...context(), peerId: "another-peer" }
      : change === "generation" ? { ...context(), generation: 5 }
      : change === "epoch" ? { ...context(), epoch: 3 } : null;
    folder.finish(); await work;
    expect(send).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledExactlyOnceWith("changed");
  });
  it("does not read files without an eligible workspace", async () => {
    const folder = delayedFolder(), send = vi.fn(), refused = vi.fn();
    await dropWorkspaceFiles(folder.transfer, () => null, send, refused);
    expect(folder.capture).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
  });
  it("reports empty or unreadable drops without sending a partial batch", async () => {
    const send = vi.fn(), refused = vi.fn();
    await dropWorkspaceFiles(flat([]), context, send, refused);
    const broken = { items: [{ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false,
      fullPath: "/private.txt", file: (_: unknown, fail: (e: Error) => void) => fail(new Error("permission")) }) }] } as unknown as DataTransfer;
    await dropWorkspaceFiles(broken, context, send, refused);
    expect(refused).toHaveBeenCalledTimes(2); expect(refused).toHaveBeenLastCalledWith("unreadable");
    expect(send).not.toHaveBeenCalled();
  });
});
