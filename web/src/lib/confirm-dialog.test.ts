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
  });
  it("resolves false on cancel", async () => {
    const p = confirmDialog("Sure?");
    resolveConfirm(false);
    await expect(p).resolves.toBe(false);
    expect(confirmState.open).toBe(false);
  });
});
