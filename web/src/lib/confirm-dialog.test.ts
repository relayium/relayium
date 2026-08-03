import { describe, it, expect } from "vitest";
import { confirmDialog, resolveConfirm, confirmState } from "./confirm-dialog.svelte";

describe("confirmDialog", () => {
  it("opens with the message and resolves true on confirm", async () => {
    const p = confirmDialog("Delete this?");
    expect(confirmState.open).toBe(true);
    expect(confirmState.message).toBe("Delete this?");
    resolveConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(confirmState.open).toBe(false);
    expect(confirmState.message).toBe("");
    expect(confirmState.confirmLabel).toBe("");
  });
  it("resolves false on cancel", async () => {
    const p = confirmDialog("Sure?");
    resolveConfirm(false);
    await expect(p).resolves.toBe(false);
    expect(confirmState.open).toBe(false);
  });

  it("carries an affirmative label when the caller names the action", async () => {
    const p = confirmDialog("Delete this account?", "Send the confirmation email");
    expect(confirmState.confirmLabel).toBe("Send the confirmation email");
    resolveConfirm(true);
    await p;
    expect(confirmState.message).toBe("");
    expect(confirmState.confirmLabel).toBe("");
  });

  // 状态是所有调用方共用的一份。上一次弹窗的按钮标签要是留了下来，下一次通用弹窗
  // 的确认键就会写着别的操作的名字——比「按钮没定制」严重得多。
  it("clears the label for the next caller that doesn't name one", async () => {
    const first = confirmDialog("Delete this account?", "Send the confirmation email");
    resolveConfirm(false);
    await first;
    const second = confirmDialog("Remove this node?");
    expect(confirmState.confirmLabel).toBe("");
    resolveConfirm(false);
    await second;
  });
});
