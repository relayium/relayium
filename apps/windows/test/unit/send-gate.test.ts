// The outgoing half of the quit fence, at the points where sending starts.
//
// Main can refuse a new RECEIVE by itself. Everything outgoing begins in the
// page — a picker, a drop, a Send press, and an auto-delivery that has no button
// at all — and every one of those has an await in the middle. So the failure
// this file pins is specifically the LATE one: the user opened a picker, a quit
// began and was answered "nothing at stake", and then the picker resolved.
//
// Driven through the real command payloads and the real gate, not through a
// stubbed acknowledgement: what is asserted is whether a send HAPPENED.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendGate } from "../../src/renderer/send/send-gate.svelte.js";
import { attachResident } from "../../src/renderer/shell/resident.js";
import type { ResidentSnapshot } from "../../src/shared/ipc-contract.js";

const SNAPSHOT: ResidentSnapshot = {
  sending: false,
  receiving: false,
  drafts: 0,
  locale: "en",
  nearby: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The page, wired the way `App.svelte` wires it: real command narrowing, real
 * gate. Only the transport and the workspace are stand-ins.
 */
function page() {
  const sent: string[] = [];
  const acks: Array<{ requestId: string; ok: boolean; snapshot?: ResidentSnapshot }> = [];
  let listener: ((payload: unknown) => void) | null = null;
  let stopped = 0;

  const detach = attachResident(
    {
      onCommand(cb) {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      async ack(payload) {
        acks.push(payload);
        return { accepted: true };
      },
      async snapshot() {
        return { accepted: true };
      },
      async notify() {
        return { accepted: true };
      },
    },
    {
      snapshot: () => SNAPSHOT,
      navigate: () => undefined,
      setLan: () => undefined,
      setAdmission: (action) => (action === "fence" ? sendGate.fence() : sendGate.admit()),
      // A quiesce DOES stop things; a fence must not.
      quiesce: () => {
        stopped += 1;
      },
      resume: () => undefined,
      pairCode: () => true,
      storedLink: () => true,
    },
  );

  let id = 0;
  const command = (body: unknown) => {
    id += 1;
    listener?.({ requestId: `rq-${id}`, generation: 0, command: body });
  };

  /** The workspace's outgoing entry point, as `LinkPane` reaches it. */
  const sendFiles = (name: string) => sendGate.start(() => sent.push(name));

  return { sent, acks, command, sendFiles, detach, stopped: () => stopped };
}

beforeEach(() => {
  sendGate.admit();
});

describe("a fence stops outgoing work from STARTING", () => {
  it("refuses a picker that resolves after the fence went up", async () => {
    // The exact sequence a quit produces: the user opens a file dialog, the quit
    // is requested and answered while they are inside it, and the dialog then
    // returns. Checking the gate when the dialog OPENED would let this through.
    const app = page();
    const picker = deferred<string>();
    const send = vi.fn((picked: string) => app.sent.push(picked));

    const picking = sendGate.pickThenStart(() => picker.promise, send);
    app.command({ kind: "admission", action: "fence" });
    picker.resolve("holiday-photos");

    expect(await picking).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(app.sent).toEqual([]);
    app.detach();
  });

  it("refuses a drop still being read when the fence went up", async () => {
    const app = page();
    const reading = deferred<string[]>();
    const started = sendGate.pickThenStart(
      () => reading.promise,
      (files) => app.sent.push(...files),
    );

    app.command({ kind: "admission", action: "fence" });
    reading.resolve(["a.txt", "b.txt"]);

    expect(await started).toBe(false);
    expect(app.sent).toEqual([]);
    app.detach();
  });

  it("refuses an auto-delivery that fires because the PEER acted", async () => {
    // No button, no user gesture: a held message is released when the lane
    // opens. Disabling controls cannot reach this one.
    const app = page();
    app.command({ kind: "admission", action: "fence" });

    const delivered = sendGate.start(() => app.sent.push("held message"));

    expect(delivered).toBe(false);
    expect(app.sent).toEqual([]);
    app.detach();
  });

  it("acknowledges the fence, so main knows the page agreed", () => {
    const app = page();
    app.command({ kind: "admission", action: "fence" });
    expect(app.acks.at(-1)).toMatchObject({ ok: true });
    // A page that could not agree must not be able to look like one that did.
    expect(sendGate.fenced).toBe(true);
    app.detach();
  });
});

describe("a ticket does not survive a fence", () => {
  it("refuses a pick that began before a fence even after Stay", async () => {
    // The hole a boolean left: the flag reads "open" again, but the intent was
    // formed before a question the user has since answered.
    const app = page();
    const ticket = sendGate.ticket();

    app.command({ kind: "admission", action: "fence" });
    app.command({ kind: "admission", action: "admit" });

    expect(sendGate.fenced).toBe(false);
    expect(sendGate.valid(ticket)).toBe(false);
    expect(sendGate.startWith(ticket, () => app.sent.push("stale"))).toBe(false);
    expect(app.sent).toEqual([]);
    app.detach();
  });

  it("invalidates tickets taken between two fences", async () => {
    const app = page();
    app.command({ kind: "admission", action: "fence" });
    app.command({ kind: "admission", action: "admit" });
    const between = sendGate.ticket();
    app.command({ kind: "admission", action: "fence" });
    app.command({ kind: "admission", action: "admit" });

    expect(sendGate.valid(between)).toBe(false);
    // And a fresh one works, so the user is never locked out.
    expect(sendGate.valid(sendGate.ticket())).toBe(true);
    app.detach();
  });

  it("hands out no ticket at all while fenced", () => {
    const app = page();
    app.command({ kind: "admission", action: "fence" });
    expect(sendGate.ticket()).toBeNull();
    expect(sendGate.valid(null)).toBe(false);
    app.detach();
  });
});

describe("a fence is not a stop, and Stay lifts it", () => {
  it("cancels nothing that is already running", () => {
    const app = page();
    app.command({ kind: "admission", action: "fence" });
    // A fence tells the page to start nothing. Stopping is a quiesce, and that
    // only happens after the user has agreed to quit.
    expect(app.stopped()).toBe(0);
    app.detach();
  });

  it("lets the next user action through after Stay", async () => {
    const app = page();
    app.command({ kind: "admission", action: "fence" });
    expect(app.sendFiles("during")).toBe(false);

    app.command({ kind: "admission", action: "admit" });

    expect(app.sendFiles("after")).toBe(true);
    const picker = deferred<string>();
    const picking = sendGate.pickThenStart(
      () => picker.promise,
      (picked) => app.sent.push(picked),
    );
    picker.resolve("chosen later");
    expect(await picking).toBe(true);
    expect(app.sent).toEqual(["after", "chosen later"]);
    app.detach();
  });

  it("refuses a pick that STARTED while fenced even if Stay lands first", async () => {
    // Deliberate: the gate is checked at both ends, so an action begun under a
    // fence does not become live merely because the fence was lifted while it
    // was in flight. The user can pick again, which is one click and no
    // surprise send.
    const app = page();
    app.command({ kind: "admission", action: "fence" });

    const picker = deferred<string>();
    const picking = sendGate.pickThenStart(
      () => picker.promise,
      (picked) => app.sent.push(picked),
    );
    app.command({ kind: "admission", action: "admit" });
    picker.resolve("begun while fenced");

    expect(await picking).toBe(false);
    expect(app.sent).toEqual([]);
    app.detach();
  });
});
