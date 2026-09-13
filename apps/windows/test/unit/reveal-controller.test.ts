// The renderer half of "open the folder": what it holds, what it shows, and
// what it refuses to keep.
//
// The controller is the REAL rune module the renderer runs — `vitest.config.ts`
// compiles it with the ordinary Svelte plugin under the browser condition, so
// `$state` here behaves as it does in the packaged app rather than as a server
// no-op.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RevealController } from "../../src/renderer/receive/reveal-controller.svelte.js";
import type { RevealOutcome } from "../../src/shared/receive-receipt.js";

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);

function harness(answer: (token: string) => RevealOutcome | Promise<RevealOutcome> = () => ({ kind: "revealed" })) {
  const asked: string[] = [];
  let push: ((payload: unknown) => void) | null = null;
  let released = 0;
  const controller = new RevealController({
    async reveal({ token }) {
      asked.push(token);
      return answer(token);
    },
    onReceipt(cb) {
      push = cb;
      return () => {
        released += 1;
        push = null;
      };
    },
  });
  return {
    controller,
    asked,
    send: (payload: unknown) => push?.(payload),
    get released() {
      return released;
    },
    get listening() {
      return push !== null;
    },
  };
}

describe("what the controller holds", () => {
  it("has nothing to offer before main has pushed anything", () => {
    const h = harness();
    h.controller.start();
    expect(h.controller.receiptFor(3)).toBeNull();
  });

  it("offers the receipt only for a card reporting the same file count", () => {
    // Only one receipt is kept, matching the room's own single last-outcome. So
    // a card reporting three saved files must not be handed the token from an
    // earlier two-file transfer — pressing it would open a different folder.
    const h = harness();
    h.controller.start();
    h.send({ token: TOKEN, fileCount: 2 });
    expect(h.controller.receiptFor(2)?.token).toBe(TOKEN);
    expect(h.controller.receiptFor(3)).toBeNull();
  });

  it("replaces the held receipt when a newer transfer finishes", async () => {
    const h = harness();
    h.controller.start();
    h.send({ token: TOKEN, fileCount: 1 });
    h.send({ token: OTHER_TOKEN, fileCount: 1 });
    await h.controller.reveal();
    expect(h.asked).toEqual([OTHER_TOKEN]);
  });

  it("drops a pushed value that is not a receipt this app mints", () => {
    const h = harness();
    h.controller.start();
    for (const junk of [
      null,
      "string",
      { token: TOKEN },
      { token: "short", fileCount: 1 },
      { token: TOKEN.toUpperCase(), fileCount: 1 },
      { token: TOKEN, fileCount: -1 },
      { token: TOKEN, fileCount: 1.5 },
      { token: TOKEN, fileCount: "1" },
    ]) {
      h.send(junk);
      expect(h.controller.receiptFor(1)).toBeNull();
    }
  });

  it("subscribes once, however many times it is started", () => {
    // The same emitter would otherwise deliver every receipt twice.
    const h = harness();
    const first = h.controller.start();
    h.controller.start();
    first();
    expect(h.released).toBe(1);
    expect(h.listening).toBe(false);
  });
});

describe("pressing the button", () => {
  it("asks main with the token it was given, and says nothing went wrong", async () => {
    const h = harness();
    h.controller.start();
    h.send({ token: TOKEN, fileCount: 4 });
    await h.controller.reveal();
    expect(h.asked).toEqual([TOKEN]);
    expect(h.controller.refusal).toBeNull();
  });

  it("does nothing at all when there is no receipt", async () => {
    const h = harness();
    h.controller.start();
    await h.controller.reveal();
    expect(h.asked).toHaveLength(0);
  });

  it("does not stack presses", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const h = harness(async () => {
      await gate;
      return { kind: "revealed" };
    });
    h.controller.start();
    h.send({ token: TOKEN, fileCount: 1 });
    const first = h.controller.reveal();
    expect(h.controller.busy).toBe(true);
    await h.controller.reveal();
    release();
    await first;
    expect(h.asked).toEqual([TOKEN]);
    expect(h.controller.busy).toBe(false);
  });

  it("shows each refusal as itself", async () => {
    for (const reason of ["missing", "fenced", "failed"] as const) {
      const h = harness(() => ({ kind: "refused", reason }));
      h.controller.start();
      h.send({ token: TOKEN, fileCount: 1 });
      await h.controller.reveal();
      expect(h.controller.refusal).toBe(reason);
      // Still offered: the folder may come back, and the quit may be declined.
      expect(h.controller.receiptFor(1)).not.toBeNull();
    }
  });

  it("withdraws the button when the receipt can never work again", async () => {
    for (const reason of ["stale", "unknown"] as const) {
      const h = harness(() => ({ kind: "refused", reason }));
      h.controller.start();
      h.send({ token: TOKEN, fileCount: 1 });
      await h.controller.reveal();
      expect(h.controller.refusal).toBe(reason);
      expect(h.controller.receiptFor(1)).toBeNull();
    }
  });

  it("treats an unrecognised answer as a failure, never as success", async () => {
    // The one thing that must never be said is "revealed" when nothing opened.
    for (const answer of [null, undefined, {}, { kind: "ok" }, { kind: "refused", reason: "nope" }]) {
      const h = harness(() => answer as unknown as RevealOutcome);
      h.controller.start();
      h.send({ token: TOKEN, fileCount: 1 });
      await h.controller.reveal();
      expect(h.controller.refusal).toBe("failed");
    }
  });

  it("survives a bridge that rejects", async () => {
    const h = harness(() => {
      throw new Error("channel closed");
    });
    h.controller.start();
    h.send({ token: TOKEN, fileCount: 1 });
    await expect(h.controller.reveal()).resolves.toBeUndefined();
    expect(h.controller.refusal).toBe("failed");
    expect(h.controller.busy).toBe(false);
  });

  it("clears an old refusal when a new transfer finishes", async () => {
    // The reason belonged to the last press. Leaving it up beside a transfer
    // that has just completed reports a failure that has not happened.
    const h = harness(() => ({ kind: "refused", reason: "missing" }));
    h.controller.start();
    h.send({ token: TOKEN, fileCount: 1 });
    await h.controller.reveal();
    expect(h.controller.refusal).toBe("missing");
    h.send({ token: OTHER_TOKEN, fileCount: 1 });
    expect(h.controller.refusal).toBeNull();
  });
});

// ## Why the markup is checked as SOURCE
//
// This harness renders no components — `vitest.config.ts` runs in `node` and
// nothing here mounts a `.svelte` file — and the real button lives inside a
// finished receive card on a verified `link/1`, which needs a second device.
// The resident smoke drives the whole IPC path but composes no peer, so it
// cannot click it either.
//
// So these are source assertions, and they are worth exactly what source
// assertions are worth: they catch the button being ungated or the refusal
// being dropped, and they would not catch it rendering wrongly. Driving the
// real click needs a peer in the smoke, which is owed.
describe("the pane offers the button only where the receipt applies", () => {
  const pane = readFileSync(
    fileURLToPath(new URL("../../src/renderer/pages/LinkPane.svelte", import.meta.url)),
    "utf8",
  );

  it("gates the button on a receipt for THIS card's file count", () => {
    expect(pane).toContain("reveal.receiptFor(receipt.total) !== null");
  });

  it("offers it only beside a saved outcome", () => {
    const saved = pane.indexOf('receipt?.kind === "saved"');
    const partial = pane.indexOf('receipt?.kind === "partial"');
    const button = pane.indexOf('data-test="recv-reveal"');
    expect(saved).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(saved);
    expect(button).toBeLessThan(partial);
  });

  it("renders the refusal rather than failing silently", () => {
    expect(pane).toContain('data-test="recv-reveal-refused"');
    expect(pane).toContain("revealText(reveal.refusal)");
  });

  it("says something different for each closed reason", () => {
    // One blanket "could not open the folder" would cover a deleted folder, a
    // quit in progress and a receipt that expired with the account — three
    // situations with three different next actions.
    for (const key of ["recvRevealMissing", "recvRevealExpired", "recvRevealClosing", "recvRevealFailed"]) {
      expect(pane).toContain(key);
    }
  });
});

describe("what never crosses", () => {
  it("sends main the token and nothing else", async () => {
    const reveal = vi.fn(async () => ({ kind: "revealed" }) as RevealOutcome);
    const controller = new RevealController({
      reveal,
      onReceipt: (cb) => {
        cb({ token: TOKEN, fileCount: 1 });
        return () => undefined;
      },
    });
    controller.start();
    await controller.reveal();
    expect(reveal).toHaveBeenCalledWith({ token: TOKEN });
  });
});
