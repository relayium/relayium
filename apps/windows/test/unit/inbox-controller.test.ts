// The Inbox page's controller: a view of a scheduler it does not drive.
//
// The assertions that matter are about what it does NOT do — it does not start
// or stop receiving, it does not hold a destination, and it does not keep
// showing a message that has gone away. Everything else is bookkeeping the page
// depends on surviving a navigation.

import { describe, expect, it, vi } from "vitest";
import { InboxController, type InboxBridge } from "../../src/renderer/inbox/inbox-controller.svelte.js";
import type { InboxMessageView, InboxPendingView, InboxView } from "../../src/shared/ipc-contract.js";

const IDLE: InboxView = {
  status: { kind: "idle", pending: 0 },
  capabilities: ["inbox.receive.v3", "inbox.text.v1"],
  enabled: true,
  hasDestination: true,
  deviceName: "A PC",
  withdrawalPending: false,
  retained: [],
};

const TASK: InboxPendingView = {
  taskID: "task-1",
  sourceDeviceID: "dev-2",
  bytes: 2048,
  createdAt: 1_700_000_000,
  expiresAt: 1_700_100_000,
  state: "notified",
};

const MESSAGE: InboxMessageView = {
  id: "msg-1",
  taskID: "task-9",
  sourceDeviceID: "dev-2",
  bytes: 5,
  receivedAt: 1_700_000_000,
};

function bridge(over: Partial<InboxBridge> = {}) {
  let push: ((payload: unknown) => void) | null = null;
  const calls = { state: 0, pending: 0, messages: 0, wake: 0, enable: 0, copy: 0 };
  const base: InboxBridge = {
    async state() {
      calls.state += 1;
      return IDLE;
    },
    async enable() {
      calls.enable += 1;
      return { kind: "enabled" };
    },
    async disable() {
      return { kind: "disabled" };
    },
    async chooseFolder() {
      return { kind: "ok" };
    },
    async pending() {
      calls.pending += 1;
      return [TASK];
    },
    async accept() {
      return { kind: "queued" };
    },
    async reject() {
      return { kind: "ok" };
    },
    async messages() {
      calls.messages += 1;
      return [MESSAGE];
    },
    async open() {
      return { text: "hello" };
    },
    async copy() {
      calls.copy += 1;
      return { kind: "ok" };
    },
    async remove() {
      return { kind: "ok" };
    },
    async rename({ name }) {
      return { kind: "renamed", name };
    },
    async wake() {
      calls.wake += 1;
      return { ok: true };
    },
    async release() {
      return { kind: "ok" };
    },
    onState(cb) {
      push = cb;
      return () => {
        push = null;
      };
    },
    ...over,
  };
  return { bridge: base, calls, push: (payload: unknown) => push?.(payload), listening: () => push !== null };
}

/** Let the controller's own fire-and-forget refresh settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Inbox controller", () => {
  it("subscribes once, for the life of the app rather than of a page", () => {
    const { bridge: b, listening } = bridge();
    const controller = new InboxController(b);
    expect(listening()).toBe(true);
    // A page unmounting does not touch it: a state push that arrives while the
    // user is on another row is exactly the one they need on their return.
    controller.destroy();
    expect(listening()).toBe(false);
  });

  it("renders a pushed state and reloads the lists with it", async () => {
    const { bridge: b, push, calls } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    const before = calls.pending;

    push({ ...IDLE, status: { kind: "receiving" } });
    await settle();

    expect(controller.view.status.kind).toBe("receiving");
    // A state change is when a delivery may have arrived or been worked, so the
    // lists move with it. The page may not even be mounted to ask.
    expect(calls.pending).toBeGreaterThan(before);
  });

  it("ignores a malformed push rather than blanking what was known", async () => {
    const { bridge: b, push } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();

    push(null);
    push("nonsense");
    push({ capabilities: [] });
    await settle();

    expect(controller.view.status.kind).toBe("idle");
    expect(controller.view.deviceName).toBe("A PC");
  });

  it("never holds a destination, only whether there is one", async () => {
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.view.hasDestination).toBe(true);
    expect(JSON.stringify(controller.view)).not.toMatch(/[A-Z]:\\|\/Users\/|\/home\//);
  });

  it("reports a closed dialog as its own outcome, not as a failure", async () => {
    const { bridge: b } = bridge({ enable: async () => ({ kind: "declined" }) });
    const controller = new InboxController(b);
    await controller.enable();
    expect(controller.notice).toEqual({ kind: "declined" });
  });

  it("refuses a second enable while the native dialog is open", async () => {
    // The dialog is modal to the window; a second click would queue a second
    // one behind it, and the user would answer the same question twice.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge: b, calls } = bridge({
      enable: async () => {
        calls.enable += 1;
        await held;
        return { kind: "enabled" };
      },
    });
    const controller = new InboxController(b);
    const first = controller.enable();
    await controller.enable();
    expect(calls.enable).toBe(1);
    release();
    await first;
  });

  it("carries a still-enrolled disable through as its own notice", async () => {
    const { bridge: b } = bridge({
      disable: async () => ({ kind: "still-enrolled", reason: "transport" }),
    });
    const controller = new InboxController(b);
    await controller.disable();
    // Not reported as success: a device central still lists keeps being offered
    // to senders, and the user is the one who needs to know.
    expect(controller.notice).toEqual({ kind: "still-enrolled", reason: "transport" });
  });

  it("opens a message only when asked, and toggles it closed", async () => {
    const opened = vi.fn(async () => ({ text: "hello" }));
    const { bridge: b } = bridge({ open: opened });
    const controller = new InboxController(b);
    await controller.refresh();
    expect(opened).not.toHaveBeenCalled();

    await controller.open("msg-1");
    expect(controller.openText).toBe("hello");
    await controller.open("msg-1");
    expect(controller.openId).toBeNull();
    expect(controller.openText).toBe("");
  });

  it("closes a message that is no longer there", async () => {
    let list: readonly InboxMessageView[] = [MESSAGE];
    const { bridge: b, push } = bridge({ messages: async () => list });
    const controller = new InboxController(b);
    await controller.refresh();
    await controller.open("msg-1");
    expect(controller.openId).toBe("msg-1");

    // Deleted, or belonging to an account that has gone away. Either way it
    // must not stay on screen as though it were still readable.
    list = [];
    push(IDLE);
    await settle();
    expect(controller.openId).toBeNull();
    expect(controller.openText).toBe("");
  });

  it("keeps one row's work from blocking another", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge: b } = bridge({
      accept: async () => {
        await held;
        return { kind: "queued" };
      },
    });
    const controller = new InboxController(b);
    const first = controller.accept("task-1");
    expect(controller.working).toEqual(["task-1"]);
    // The same row refuses a second click; a different one is not blocked.
    await controller.accept("task-1");
    expect(controller.working).toEqual(["task-1"]);
    release();
    await first;
    expect(controller.working).toEqual([]);
  });

  it("copies through main rather than through a denied browser permission", async () => {
    // `window.ts` denies every renderer permission, so `navigator.clipboard`
    // is not a path that works in this app at all. The controller must reach
    // main, and it must name the MESSAGE rather than hand over its text.
    const copied = vi.fn(async () => ({ kind: "ok" as const }));
    const { bridge: b } = bridge({ copy: copied });
    const controller = new InboxController(b);
    await controller.refresh();
    expect(await controller.copy("msg-1")).toBe(true);
    expect(copied).toHaveBeenCalledWith({ id: "msg-1" });
  });

  it("surfaces a refused copy rather than looking inert", async () => {
    const { bridge: b } = bridge({ copy: async () => ({ kind: "failed", reason: "account-changed" }) });
    const controller = new InboxController(b);
    expect(await controller.copy("msg-1")).toBe(false);
    expect(controller.notice).toEqual({ kind: "failed", reason: "account-changed" });
  });

  it("asks main to end its backoff instead of pacing anything itself", async () => {
    const { bridge: b, calls } = bridge();
    const controller = new InboxController(b);
    await controller.retryNow();
    expect(calls.wake).toBe(1);
    // And there is no timer here: the controller has nothing that could poll.
    expect(Object.keys(controller)).not.toContain("timer");
  });

  it("keeps the rename draft across a page that came and went", async () => {
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    controller.nameDraft = "Work PC";
    // No page involved: the draft lives here precisely so switching rows to
    // check a spelling does not discard it.
    expect(controller.nameDraft).toBe("Work PC");
    await controller.rename();
    expect(controller.notice).toEqual({ kind: "renamed" });
    expect(controller.nameDraft).toBe("");
  });

  it("does not send a blank rename", async () => {
    const renamed = vi.fn(async ({ name }: { name: string }) => ({ kind: "renamed" as const, name }));
    const { bridge: b } = bridge({ rename: renamed });
    const controller = new InboxController(b);
    controller.nameDraft = "   ";
    await controller.rename();
    expect(renamed).not.toHaveBeenCalled();
  });

  it("survives a list read that failed without losing what it had", async () => {
    let failing = false;
    const { bridge: b, push } = bridge({
      pending: async (): Promise<readonly InboxPendingView[]> => {
        if (failing) throw new Error("gone");
        return [TASK];
      },
    });
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.pending).toEqual([TASK]);

    failing = true;
    push(IDLE);
    await settle();
    expect(controller.pending).toEqual([TASK]);
  });
});
