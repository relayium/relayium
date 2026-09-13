// What the page is allowed to believe about a received file.
//
// Written during the Claude single-agent review pass, for code this pass added.
// The service's own 16 cases cover main's half — authority, membership, the
// re-check after the stat. None of them covers the renderer half, which is the
// one place a PATH could reach a page: main announces items, and if that
// announcement were ever malformed the page would render it and hand it back.

import { describe, expect, it } from "vitest";
import {
  ReceivedController,
  type ReceivedBridge,
} from "../../src/renderer/receive/received-controller.svelte.js";

const ITEM = (over: Record<string, unknown> = {}) => ({
  token: "rcv-1",
  name: "a.txt",
  relativePath: "box/a.txt",
  size: 4,
  ...over,
});

function harness(act: ReceivedBridge["act"] = async () => ({ kind: "revealed" })) {
  let push: ((payload: unknown) => void) | null = null;
  const calls: Array<{ action: string; token: string }> = [];
  const bridge: ReceivedBridge = {
    act: async (payload) => {
      calls.push({ action: payload.action, token: payload.token });
      return act(payload);
    },
    onItems: (cb) => {
      push = cb;
      return () => {
        push = null;
      };
    },
  };
  const controller = new ReceivedController(bridge);
  const stop = controller.start();
  return { controller, calls, stop, announce: (payload: unknown) => push?.(payload) };
}

describe("what an announcement may contain", () => {
  it("takes a well-formed item", () => {
    const h = harness();
    h.announce([ITEM()]);
    expect(h.controller.items).toHaveLength(1);
    expect(h.controller.items[0]?.relativePath).toBe("box/a.txt");
    h.stop();
  });

  it("DROPS an item carrying an absolute path", () => {
    const h = harness();
    // The contract says relative. If an absolute path ever arrived it would be
    // a path reaching the renderer, which is the whole thing this design keeps
    // out — so it is dropped rather than rendered.
    h.announce([ITEM({ relativePath: "C:\\Users\\lily\\secret\\a.txt" })]);
    expect(h.controller.items).toHaveLength(0);
    h.announce([ITEM({ relativePath: "/Users/lily/secret/a.txt" })]);
    expect(h.controller.items).toHaveLength(0);
    h.stop();
  });

  it("drops a malformed item without dropping its well-formed neighbours", () => {
    const h = harness();
    h.announce([ITEM(), { token: "", name: "b", relativePath: "b", size: 0 }, ITEM({ token: "rcv-2" })]);
    expect(h.controller.items.map((i) => i.token)).toEqual(["rcv-1", "rcv-2"]);
    h.stop();
  });

  it("ignores anything that is not a list", () => {
    const h = harness();
    h.announce([ITEM()]);
    h.announce({ token: "rcv-9" });
    h.announce(null);
    // The earlier list is untouched: a malformed push must not clear rows the
    // user can still act on.
    expect(h.controller.items.map((i) => i.token)).toEqual(["rcv-1"]);
    h.stop();
  });

  it("REPLACES the list rather than appending to it", () => {
    const h = harness();
    h.announce([ITEM()]);
    h.announce([ITEM({ token: "rcv-2", relativePath: "box/b.txt" })]);
    // Appending would leave rows from an earlier transfer beside the one the
    // screen is reporting, holding tokens that may already be retired.
    expect(h.controller.items.map((i) => i.token)).toEqual(["rcv-2"]);
    h.stop();
  });

  it("subscribes once, however many times it is started", () => {
    const h = harness();
    h.controller.start();
    h.announce([ITEM()]);
    expect(h.controller.items).toHaveLength(1);
    h.stop();
  });
});

describe("acting on one file", () => {
  it("sends the token it was given and nothing else", async () => {
    const h = harness();
    h.announce([ITEM()]);
    await h.controller.act("reveal", "rcv-1");
    expect(h.calls).toEqual([{ action: "reveal", token: "rcv-1" }]);
    expect(h.controller.refusal).toBeNull();
    h.stop();
  });

  it("withdraws a row whose token can never work again", async () => {
    const h = harness(async () => ({ kind: "unknown-token" }));
    h.announce([ITEM(), ITEM({ token: "rcv-2" })]);
    await h.controller.act("drag", "rcv-1");
    expect(h.controller.refusal).toBe("unknown-token");
    // Only that row. The other token belongs to the same receive and still works.
    expect(h.controller.items.map((i) => i.token)).toEqual(["rcv-2"]);
    h.stop();
  });

  it("keeps the row for a refusal that may not be permanent", async () => {
    const h = harness(async () => ({ kind: "missing" }));
    h.announce([ITEM()]);
    await h.controller.act("reveal", "rcv-1");
    expect(h.controller.refusal).toBe("missing");
    expect(h.controller.items).toHaveLength(1);
    h.stop();
  });

  it("treats an unrecognised answer as a failure, never as success", async () => {
    const h = harness(async () => ({ kind: "went-fine" }) as never);
    h.announce([ITEM()]);
    await h.controller.act("reveal", "rcv-1");
    expect(h.controller.refusal).toBe("failed");
    h.stop();
  });

  it("survives a bridge that rejects", async () => {
    const h = harness(async () => {
      throw new Error("gone");
    });
    h.announce([ITEM()]);
    await expect(h.controller.act("reveal", "rcv-1")).resolves.toBeUndefined();
    expect(h.controller.refusal).toBe("failed");
    h.stop();
  });

  it("does not stack presses", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const h = harness(async () => {
      await held;
      return { kind: "revealed" };
    });
    h.announce([ITEM()]);
    const first = h.controller.act("reveal", "rcv-1");
    await h.controller.act("reveal", "rcv-1");
    expect(h.calls).toHaveLength(1);
    release();
    await first;
    h.stop();
  });
});
