import { describe, expect, it, vi } from "vitest";
import { FirstCloseCoordinator, firstCloseDialog, type FirstCloseDeps } from "../../src/main/first-run.js";
import { translator } from "../../src/main/l10n.js";

const t = translator("en");
const deps = (over: Partial<FirstCloseDeps> = {}): FirstCloseDeps => ({
  store: { read: () => false, write: vi.fn() },
  ask: async () => 0,
  reportFailure: vi.fn(),
  t,
  ...over,
});
const onFirstClose = (d: FirstCloseDeps) => new FirstCloseCoordinator(d).onClose();

describe("the notice", () => {
  it("offers Hide, Quit and Cancel, index-aligned", () => {
    const dialog = firstCloseDialog(t);
    expect(dialog.choices).toEqual(["hide", "quit", "cancel"]);
    expect(dialog.buttons).toHaveLength(dialog.choices.length);
  });

  it("says the app keeps running, never that it is receiving", () => {
    // With LAN discovery off or the Inbox disabled, "still receiving" is false,
    // and a resident notice that overstates reachability is worse than none.
    for (const locale of ["en", "zh-Hans"] as const) {
      const body = firstCloseDialog(translator(locale)).body;
      expect(body.toLowerCase()).not.toContain("receiv");
      expect(body).not.toContain("接收");
    }
  });
});

describe("shown once, and only on an explicit answer", () => {
  it("does not show once acknowledged", async () => {
    const ask = vi.fn();
    const outcome = await onFirstClose(deps({ store: { read: () => true, write: vi.fn() }, ask }));
    expect(outcome).toEqual({ kind: "already-acknowledged", action: "hide" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("records the acknowledgement on Hide and on Quit", async () => {
    for (const [index, action] of [[0, "hide"], [1, "quit"]] as const) {
      const write = vi.fn();
      const outcome = await onFirstClose(deps({ store: { read: () => false, write }, ask: async () => index }));
      expect(outcome).toEqual({ kind: "answered", action, persisted: true });
      expect(write).toHaveBeenCalledOnce();
    }
  });

  it("does NOT record on Cancel", async () => {
    const write = vi.fn();
    const outcome = await onFirstClose(deps({ store: { read: () => false, write }, ask: async () => 2 }));
    expect(outcome).toEqual({ kind: "answered", action: "cancel", persisted: false });
    expect(write).not.toHaveBeenCalled();
  });

  it("does NOT record a dismissed dialog", async () => {
    // Dismissal is not an answer, so the notice returns. Showing it twice is a
    // small annoyance; suppressing the only explanation is not.
    const write = vi.fn();
    const outcome = await onFirstClose(deps({ store: { read: () => false, write }, ask: async () => null }));
    expect(outcome).toEqual({ kind: "answered", action: "cancel", persisted: false });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("rapid closes are serialized", () => {
  it("shows one dialog and writes the acknowledgement once", async () => {
    let asks = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const write = vi.fn();
    const coordinator = new FirstCloseCoordinator(
      deps({ store: { read: () => false, write }, ask: async () => { asks += 1; return gate; } }),
    );
    const a = coordinator.onClose();
    const b = coordinator.onClose();
    release(0);
    await Promise.all([a, b]);
    expect(asks).toBe(1);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe("failures are reported as closed codes", () => {
  it("does NOT hide when the dialog cannot be shown", async () => {
    // The whole point of the notice is that a user who closes the window
    // understands the app is still running. Hiding it when the explanation
    // failed to appear delivers exactly the confusion it exists to prevent.
    const reportFailure = vi.fn();
    const outcome = await onFirstClose(
      deps({ ask: async () => { throw new Error("no window"); }, reportFailure }),
    );
    expect(outcome).toEqual({ kind: "dialog-failed", action: "cancel", failure: "dialog-failed" });
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("does NOT hide on an out-of-range index rather than trusting it", async () => {
    const outcome = await onFirstClose(deps({ ask: async () => 99 }));
    expect(outcome).toEqual({ kind: "dialog-failed", action: "cancel", failure: "dialog-out-of-range" });
  });

  it("shows the notice again when the flag cannot be read, and says so", async () => {
    const ask = vi.fn(async () => 0);
    const outcome = await onFirstClose(
      deps({ store: { read: () => { throw new Error("EACCES"); }, write: vi.fn() }, ask }),
    );
    expect(ask).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("answered");
    expect("failure" in outcome && outcome.failure).toBe("flag-unreadable");
  });

  it("reports a failed write rather than claiming it persisted", async () => {
    const outcome = await onFirstClose(
      deps({ store: { read: () => false, write: () => { throw new Error("disk full"); } }, ask: async () => 0 }),
    );
    expect(outcome).toMatchObject({ kind: "answered", action: "hide", persisted: false, failure: "flag-write-failed" });
    // Closed code only: no filesystem text reaches this value.
    expect(JSON.stringify(outcome)).not.toContain("disk full");
  });
});
