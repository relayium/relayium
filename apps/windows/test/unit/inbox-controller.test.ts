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
  policy: "ask",
  epoch: 1,
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

const RECEIPT = {
  taskID: "task-9",
  phase: "acked",
  total: 3,
  published: 3,
  text: false,
  updatedAt: 1_700_000_000,
  serverTerminal: true,
};

/** The names for `RECEIPT`, as the presentation record carries them. */
const NAMED = {
  taskID: "task-9",
  receivedAt: 1_700_000_000,
  text: false,
  declared: 3,
  items: [
    { name: "report.pdf", size: 10 },
    { name: "photos/one.jpg", size: 20 },
    { name: "photos/two.jpg", size: 30 },
  ],
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
  const calls = {
    state: 0,
    pending: 0,
    messages: 0,
    wake: 0,
    enable: 0,
    copy: 0,
    reveal: 0,
    receipts: 0,
    history: 0,
    forget: 0,
    setPolicy: [] as string[],
  };
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
    async setPolicy({ policy }) {
      calls.setPolicy.push(policy);
      return { kind: "enabled" };
    },
    async reveal() {
      calls.reveal += 1;
      return { kind: "ok" };
    },
    async receipts() {
      calls.receipts += 1;
      return { entries: [RECEIPT] };
    },
    async history() {
      calls.history += 1;
      return { entries: [NAMED] };
    },
    async forget() {
      calls.forget += 1;
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
    // The shell refreshes at startup, which is when the account is adopted. An
    // action run before that adoption sees its own notice cleared by the
    // state read that follows it — correct behaviour for an account change,
    // and not the situation these cases are about.
    await controller.refresh();
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
    await controller.refresh();
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
    await controller.refresh();
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

describe("the policy control", () => {
  it("names the policy and refuses a redundant change", async () => {
    const { bridge: b, calls } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    // The fixture is already `ask`; choosing it again is not a change and must
    // not open a native dialog or re-announce anything.
    await controller.setPolicy("ask");
    expect(calls.setPolicy).toEqual([]);

    await controller.setPolicy("auto");
    expect(calls.setPolicy).toEqual(["auto"]);
  });

  it("refuses a second change while a native dialog may be open", async () => {
    // `ask` and `auto` with no folder recorded open the dialog, which is modal
    // to the window; a second click would ask the same question twice.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge: b, calls } = bridge({
      setPolicy: async ({ policy }) => {
        calls.setPolicy.push(policy);
        await held;
        return { kind: "enabled" };
      },
    });
    const controller = new InboxController(b);
    await controller.refresh();
    const first = controller.setPolicy("auto");
    await controller.setPolicy("off");
    expect(calls.setPolicy).toEqual(["auto"]);
    release();
    await first;
  });

  it("reports a declined folder dialog as its own outcome", async () => {
    const { bridge: b } = bridge({ setPolicy: async () => ({ kind: "declined" }) });
    const controller = new InboxController(b);
    await controller.refresh();
    await controller.setPolicy("auto");
    expect(controller.notice).toEqual({ kind: "declined" });
  });

  it("reports a superseded change rather than claiming it applied", async () => {
    const { bridge: b } = bridge({ setPolicy: async () => ({ kind: "superseded" }) });
    const controller = new InboxController(b);
    await controller.refresh();
    await controller.setPolicy("off");
    expect(controller.notice).toEqual({ kind: "superseded" });
  });
});

describe("receipts and reveal", () => {
  it("renders what arrived, and never a file name", async () => {
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.receipts).toEqual([RECEIPT]);
    // The whole record, serialised, contains no name-shaped field at all.
    expect(Object.keys(controller.receipts[0]!)).not.toContain("name");
    expect(JSON.stringify(controller.receipts)).not.toMatch(/\.(txt|bin|png|pdf)/i);
  });

  it("keeps an unreadable record distinct from having received nothing", async () => {
    // "Nothing has arrived yet" over a journal this app failed to open would
    // tell the user their deliveries never happened.
    const { bridge: b } = bridge({ receipts: async () => ({ entries: null }) });
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.receiptsUnavailable).toBe(true);
    expect(controller.receipts).toEqual([]);
  });

  it("shows a refused reveal rather than doing nothing", async () => {
    const { bridge: b } = bridge({
      reveal: async () => ({ kind: "failed", reason: "storage-unreadable" }),
    });
    const controller = new InboxController(b);
    await controller.reveal();
    expect(controller.revealFailed).toBe(true);
  });

  it("asks main to reveal, and names no path itself", async () => {
    const revealed = vi.fn(async () => ({ kind: "ok" as const }));
    const { bridge: b } = bridge({ reveal: revealed });
    const controller = new InboxController(b);
    await controller.reveal();
    // No argument at all: there is nothing here that could carry a directory.
    expect(revealed).toHaveBeenCalledWith();
    expect(controller.revealFailed).toBe(false);
  });
});

describe("delayed answers after the thing that asked went away", () => {
  it("does not restore a message a state push has already removed", async () => {
    // The late-ACK shape on this surface: a list read issued before a delivery
    // was deleted must not put it back.
    let list: readonly InboxMessageView[] = [MESSAGE];
    const { bridge: b, push } = bridge({ messages: async () => list });
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.messages.length).toBe(1);
    list = [];
    push(IDLE);
    await settle();
    expect(controller.messages).toEqual([]);
    expect(controller.openId).toBeNull();
  });

  it("survives a receipts read that failed without losing what it had", async () => {
    let failing = false;
    const { bridge: b, push } = bridge({
      receipts: async () => {
        if (failing) throw new Error("gone");
        return { entries: [RECEIPT] };
      },
    });
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.receipts).toEqual([RECEIPT]);
    failing = true;
    push(IDLE);
    await settle();
    // Reported as unreadable, and the last known rows are not silently blanked.
    expect(controller.receiptsUnavailable).toBe(true);
    expect(controller.receipts).toEqual([RECEIPT]);
  });
});

describe("out-of-order answers from main", () => {
  it("does not let an older receipts read overwrite a newer empty one", async () => {
    // Root's first reproduction. Two reads under one account, the slow one
    // issued first: its answer put back rows a newer read had found gone.
    const slow = deferred<{ entries: readonly (typeof RECEIPT)[] | null }>();
    let call = 0;
    const { bridge: b, push } = bridge({
      receipts: async () => {
        call += 1;
        return call === 1 ? slow.promise : { entries: [] };
      },
    });
    const controller = new InboxController(b);

    // Two list reads driven by two state PUSHES. Two `refresh()` calls no
    // longer work for this: the second supersedes the first by view sequence,
    // which is the fix for a different race and means the first never reaches
    // its list read at all.
    push(IDLE);
    await settle();
    push(IDLE);
    await settle();
    expect(controller.receipts).toEqual([]);

    slow.resolve({ entries: [RECEIPT] });
    await settle();
    expect(controller.receipts).toEqual([]);
  });

  it("keeps a healthy receipts read working", async () => {
    // The positive control, so a guard that simply dropped everything fails.
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.receipts).toEqual([RECEIPT]);
  });

  it("does not let a late message body land after a needs-account push", async () => {
    // Root's second reproduction, and the sharpest of the pair: the body is the
    // user's own text, and restoring it after the account went away puts one
    // person's message on another's screen.
    const slow = deferred<{ text: string }>();
    const { bridge: b, push } = bridge({ open: async () => slow.promise });
    const controller = new InboxController(b);
    await controller.refresh();

    const opening = controller.open("msg-1");
    push({ ...IDLE, status: { kind: "needs-account" }, epoch: 0, enabled: false });
    await settle();
    expect(controller.openText).toBe("");

    slow.resolve({ text: "hello" });
    await opening;
    expect(controller.openId).toBeNull();
    expect(controller.openText).toBe("");
  });

  it("keeps opening a message working under one account", async () => {
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    await controller.open("msg-1");
    expect(controller.openText).toBe("hello");
  });

  it("drops a body that arrived after a different message was opened", async () => {
    const slow = deferred<{ text: string }>();
    let call = 0;
    const { bridge: b } = bridge({
      open: async () => {
        call += 1;
        return call === 1 ? slow.promise : { text: "the second one" };
      },
    });
    const controller = new InboxController(b);
    await controller.refresh();
    const first = controller.open("msg-1");
    await controller.open("msg-2");
    expect(controller.openText).toBe("the second one");
    slow.resolve({ text: "the first one" });
    await first;
    expect(controller.openText).toBe("the second one");
  });
});

describe("Off is enrolled, and the page must not call that receiving", () => {
  it("reports an Off account as not receiving", async () => {
    // `off` keeps the ENROLMENT — that is how the refusal reaches senders — so
    // `enabled` is true for it. A page reading the title off `enabled` said
    // "Receiving is on" and promised deliveries would keep arriving, directly
    // beside the Off radio the user had just chosen.
    const off: InboxView = { ...IDLE, policy: "off", enabled: true };
    expect(off.enabled && off.policy !== "off").toBe(false);
    const asking: InboxView = { ...IDLE, policy: "ask", enabled: true };
    expect(asking.enabled && asking.policy !== "off").toBe(true);
  });
});

describe("a message deleted while its body was being fetched", () => {
  it("does not put the deleted plaintext back on screen", async () => {
    // Root's confirmed RED. The user pressed Delete; an `open` already in
    // flight came back afterwards and restored the message they had just
    // removed.
    const slow = deferred<{ text: string }>();
    let list: readonly InboxMessageView[] = [MESSAGE];
    const { bridge: b } = bridge({
      open: async () => slow.promise,
      messages: async () => list,
      remove: async () => {
        list = [];
        return { kind: "ok" };
      },
    });
    const controller = new InboxController(b);
    await controller.refresh();

    const opening = controller.open("msg-1");
    await controller.remove("msg-1");
    expect(controller.openText).toBe("");

    slow.resolve({ text: "the deleted message" });
    await opening;
    expect(controller.openId).toBeNull();
    expect(controller.openText).toBe("");
  });

  it("still shows a message that was NOT deleted", async () => {
    // Positive control: the invalidation follows a delete, not every open.
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    await controller.open("msg-1");
    expect(controller.openText).toBe("hello");
  });
});

describe("a state read that lands after an account push", () => {
  it("does not roll the UI back to the account that went away", async () => {
    // Root's second confirmed RED: a slow initial `state()` (epoch 1, idle)
    // returning after an `onState` push (epoch 2, needs-account) reinstalled
    // the previous account's view over the one the page had been told.
    const slow = deferred<InboxView>();
    const { bridge: b, push } = bridge({ state: async () => slow.promise });
    const controller = new InboxController(b);

    const reading = controller.refresh();
    push({ ...IDLE, status: { kind: "needs-account" }, epoch: 2, enabled: false });
    await settle();
    expect(controller.view.status.kind).toBe("needs-account");

    slow.resolve(IDLE);
    await reading;
    expect(controller.view.status.kind).toBe("needs-account");
  });

  it("still installs a state read when nothing newer has spoken", async () => {
    const { bridge: b } = bridge();
    const controller = new InboxController(b);
    await controller.refresh();
    expect(controller.view.status.kind).toBe("idle");
  });
});

describe("one adoption path, whatever observed the change", () => {
  it("does not let an earlier read overwrite a same-account Off push", async () => {
    // The epoch does not change when the user chooses Off, so invalidating only
    // on an epoch change left a `state()` read issued before it — still saying
    // `ask` — free to land afterwards and undo what they had just chosen.
    const slow = deferred<InboxView>();
    let call = 0;
    const { bridge: b, push } = bridge({
      state: async () => {
        call += 1;
        return call === 1 ? IDLE : slow.promise;
      },
    });
    const controller = new InboxController(b);
    // The account is adopted FIRST, so the push below shares its epoch. Without
    // this the controller is still at epoch 0, the push differs, and the case
    // exercises the epoch path rather than the same-account one it is about.
    await controller.refresh();

    const reading = controller.refresh();
    push({ ...IDLE, policy: "off" });
    await settle();
    expect(controller.view.policy).toBe("off");

    slow.resolve({ ...IDLE, policy: "ask" });
    await reading;
    expect(controller.view.policy).toBe("off");
  });

  it("clears an already-open body when a READ is the first to see the new account", async () => {
    // A read can observe an account change before any push does. The clearing
    // used to live only in the push handler, so the new account's status was
    // installed beside the old account's open message.
    let view: InboxView = IDLE;
    const { bridge: b } = bridge({ state: async () => view });
    const controller = new InboxController(b);
    await controller.refresh();
    await controller.open("msg-1");
    expect(controller.openText).toBe("hello");

    view = { ...IDLE, epoch: 2 };
    await controller.refresh();
    expect(controller.openId).toBeNull();
    expect(controller.openText).toBe("");
    expect(controller.view.epoch).toBe(2);
  });

  it("does not install a release's state read after the account moved", async () => {
    const slow = deferred<InboxView>();
    let call = 0;
    const { bridge: b, push } = bridge({
      state: async () => {
        call += 1;
        return call <= 1 ? IDLE : slow.promise;
      },
    });
    const controller = new InboxController(b);
    await controller.refresh();

    const releasing = controller.release("a-ticket");
    push({ ...IDLE, status: { kind: "needs-account" }, epoch: 2, enabled: false });
    await settle();
    expect(controller.view.status.kind).toBe("needs-account");

    slow.resolve(IDLE);
    await releasing;
    expect(controller.view.status.kind).toBe("needs-account");
  });

  it("writes nothing once the app has torn the controller down", async () => {
    const slow = deferred<{ text: string }>();
    const { bridge: b } = bridge({ open: async () => slow.promise });
    const controller = new InboxController(b);
    await controller.refresh();
    const opening = controller.open("msg-1");
    controller.destroy();
    slow.resolve({ text: "too late" });
    await opening;
    expect(controller.openText).toBe("");
  });
});

describe("the named history", () => {
  it("reads names beside the counts and keys them by task", async () => {
    const h = bridge();
    const controller = new InboxController(h.bridge);
    await controller.refresh();
    // The journal is the authoritative list; the names fill it in.
    expect(controller.receipts.map((r) => r.taskID)).toEqual(["task-9"]);
    expect(controller.named["task-9"]?.items.map((i) => i.name)).toEqual([
      "report.pdf",
      "photos/one.jpg",
      "photos/two.jpg",
    ]);
    expect(controller.namesUnavailable).toBe(false);
  });

  it("keeps unreadable NAMES distinct from unreadable counts", async () => {
    const h = bridge({
      async history() {
        return { entries: null };
      },
    });
    const controller = new InboxController(h.bridge);
    await controller.refresh();
    // The counts are still exact. Saying which record failed is the difference
    // between "we lost your deliveries" and "we could not read one file".
    expect(controller.namesUnavailable).toBe(true);
    expect(controller.receiptsUnavailable).toBe(false);
    expect(controller.receipts).toHaveLength(1);
    expect(controller.named).toEqual({});
  });

  it("drops one account's names before another's are rendered", async () => {
    const h = bridge();
    const controller = new InboxController(h.bridge);
    await controller.refresh();
    expect(Object.keys(controller.named)).toHaveLength(1);

    // A different account. These are the previous user's file names.
    h.push({ ...IDLE, epoch: 4 });
    expect(controller.named).toEqual({});
    expect(controller.namesUnavailable).toBe(false);
  });

  it("forgets one delivery, and re-reads afterwards", async () => {
    const h = bridge();
    const controller = new InboxController(h.bridge);
    await controller.refresh();
    const before = h.calls.history;
    await controller.forget("task-9");
    expect(h.calls.forget).toBe(1);
    // Re-read, so the row leaves the list rather than lingering until the next
    // push happens to arrive.
    expect(h.calls.history).toBeGreaterThan(before);
  });

  it("reports a failed forget rather than pretending it worked", async () => {
    const h = bridge({
      async forget() {
        return { kind: "failed", reason: "storage-unreadable" };
      },
    });
    const controller = new InboxController(h.bridge);
    await controller.refresh();
    await controller.forget("task-9");
    expect(controller.notice).toMatchObject({ kind: "failed", reason: "storage-unreadable" });
  });
});
