/**
 * @vitest-environment node
 *
 * Node, not jsdom: this file is about the harness's own CDP plumbing, and the
 * one global it stubs (`WebSocket`) is the one `cdp()` will really construct.
 * Under jsdom it would be stubbing jsdom's shim instead.
 *
 * No Chrome anywhere. Every branch here is reachable through the seams the
 * harness already has — a `browser` is just `{ send, on }`, and `cdp()` takes
 * whatever `WebSocket` the environment provides — so nothing was added to the
 * production module to make it testable, and what runs here is what ships.
 *
 * What it pins down, all of it from hosted run 32619074912 (job 97144335909):
 * `history.back()`, the next poll on the /me device list, and `-32000 Inspected
 * target navigated or closed`. The same commit had passed the same job on the
 * PR, so the failure is the back navigation racing the poll — not the product.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CdpError, cdp, isNavigationTransient, newTab } from "./harness.mjs";

// ── the client, with a socket we drive ──────────────────────────────────────

/** A `WebSocket` that opens immediately and hands the test both directions. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.frames = [];
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(text) { this.frames.push(JSON.parse(text)); }
  close() { this.closed = true; }
  /** What Chrome would have written back. */
  reply(message) { this.onmessage({ data: JSON.stringify(message) }); }
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = realWebSocket; FakeSocket.last = undefined; });

/** One connected client plus the socket underneath it. */
async function connected() {
  globalThis.WebSocket = FakeSocket;
  const client = cdp("ws://127.0.0.1:0/devtools/browser/fake");
  await client.open;
  return { client, socket: FakeSocket.last };
}

/** Answer the command the client just wrote, by its real id. */
const answer = (socket, body) => socket.reply({ id: socket.frames.at(-1).id, ...body });

describe("a CDP protocol error keeps its structure", () => {
  it("carries code, message and the command that failed", async () => {
    const { client, socket } = await connected();
    const failed = client.send("Runtime.evaluate", { expression: "1" }, "S1");
    answer(socket, { error: { code: -32000, message: "Inspected target navigated or closed" } });

    const err = await failed.catch((e) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect(err.code).toBe(-32000);
    expect(err.cdpMessage).toBe("Inspected target navigated or closed");
    expect(err.method).toBe("Runtime.evaluate");
    // Still readable on its own, so an unhandled one is no worse than before.
    expect(err.message).toContain("Runtime.evaluate");
    expect(err.message).toContain("-32000");
    expect(err.message).toContain("Inspected target navigated or closed");
    // And the classifier can reach the code WITHOUT parsing that sentence,
    // which is the entire reason the fields exist.
    expect(isNavigationTransient(err)).toBe(true);
  });

  it("keeps `data`, which is where the actionable half usually is", async () => {
    const { client, socket } = await connected();
    const failed = client.send("Runtime.evaluate", {}, "S1");
    answer(socket, { error: { code: -32602, message: "Invalid parameters", data: "expression: string value expected" } });

    const err = await failed.catch((e) => e);
    expect(err.code).toBe(-32602);
    expect(err.data).toBe("expression: string value expected");
    expect(err.message).toContain("expression: string value expected");
    expect(isNavigationTransient(err)).toBe(false);
  });

  it("refuses a code that is not a number rather than half-classifying it", async () => {
    const { client, socket } = await connected();
    const failed = client.send("Runtime.evaluate", {}, "S1");
    // A string compares unequal to every code the classifier knows, so storing
    // it verbatim would disable the retry silently instead of loudly.
    answer(socket, { error: { code: "-32000", message: "Inspected target navigated or closed" } });

    const err = await failed.catch((e) => e);
    expect(err.code).toBeUndefined();
    expect(isNavigationTransient(err)).toBe(false);
  });

  it("still resolves an ordinary result", async () => {
    const { client, socket } = await connected();
    const done = client.send("Runtime.evaluate", {}, "S1");
    answer(socket, { result: { result: { value: 7 } } });

    expect(await done).toEqual({ result: { value: 7 } });
  });
});

// ── the classifier ──────────────────────────────────────────────────────────

const protocolError = (message, code = -32000) => new CdpError("Runtime.evaluate", { code, message });

describe("what counts as a navigation transient", () => {
  for (const message of [
    "Inspected target navigated or closed",
    "Cannot find context with specified id",
    "Execution context was destroyed",
    "Execution context with given id not found",
  ]) {
    it(`accepts -32000 "${message}", with or without the full stop`, () => {
      expect(isNavigationTransient(protocolError(message))).toBe(true);
      expect(isNavigationTransient(protocolError(`${message}.`))).toBe(true);
    });
  }

  it("rejects the same wording under a different code", () => {
    expect(isNavigationTransient(protocolError("Inspected target navigated or closed", -32602))).toBe(false);
  });

  it("rejects a detached session, which is permanent", () => {
    // -32001 in the wild; pinned under -32000 too, so the exclusion is the
    // MESSAGE list rather than a code that happens not to collide.
    expect(isNavigationTransient(protocolError("Session with given id not found.", -32001))).toBe(false);
    expect(isNavigationTransient(protocolError("Session with given id not found.", -32000))).toBe(false);
  });

  it("rejects the other things -32000 means", () => {
    expect(isNavigationTransient(protocolError("No node with given id found"))).toBe(false);
    expect(isNavigationTransient(protocolError("Node with given id does not belong to the document"))).toBe(false);
    expect(isNavigationTransient(protocolError("Not attached to an active page"))).toBe(false);
  });

  it("rejects a plain Error saying the same words", () => {
    // The evaluate watchdog and a page exception are plain Errors. Matching on
    // text alone would retry a blocked main thread for the whole budget.
    expect(isNavigationTransient(new Error("Inspected target navigated or closed"))).toBe(false);
    expect(isNavigationTransient(undefined)).toBe(false);
  });
});

// ── the tab, with a browser we script ───────────────────────────────────────

const TARGET = "T-1";
const SESSION = "S-1";

/**
 * A `browser` for `newTab`: the four setup commands answered, and
 * `Runtime.evaluate` delegated to the test, which may return or throw.
 */
function scriptedBrowser(onEvaluate) {
  const handlers = [];
  let evaluations = 0;
  const browser = {
    send: async (method, params = {}) => {
      if (method === "Target.createTarget") return { targetId: TARGET };
      if (method === "Target.attachToTarget") return { sessionId: SESSION };
      if (method === "Runtime.evaluate") return onEvaluate(++evaluations, params.expression, browser);
      return {};
    },
    on: (h) => handlers.push(h),
    emit: (message) => { for (const h of handlers) h(message); },
    evaluations: () => evaluations,
  };
  return browser;
}

const truthy = { result: { value: true } };
const falsy = { result: { value: false } };
const NAVIGATED = "Inspected target navigated or closed";

describe("waitFor and a page that navigates under it", () => {
  it("retries the transient and then observes the condition", async () => {
    const browser = scriptedBrowser((n) => {
      if (n <= 2) throw protocolError(NAVIGATED);
      return truthy;
    });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    await tab.waitFor("document.querySelectorAll('.devicelist li').length === 2", "back on /me", 5_000);
    // Not "it didn't throw": it has to have gone THROUGH the transients.
    expect(browser.evaluations()).toBe(3);
  });

  it("fails at once on a CDP error that is not a navigation transient", async () => {
    const browser = scriptedBrowser(() => { throw protocolError("No node with given id found"); });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    await expect(tab.waitFor("x", "the row", 5_000)).rejects.toThrow(/No node with given id found/);
    expect(browser.evaluations()).toBe(1);
  });

  it("fails at once on a page exception", async () => {
    const browser = scriptedBrowser(() => ({
      exceptionDetails: { exception: { description: "TypeError: x is not a function" } },
    }));
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    await expect(tab.waitFor("x()", "the row", 5_000)).rejects.toThrow(/TypeError: x is not a function/);
    expect(browser.evaluations()).toBe(1);
  });
});

describe("waitFor and a tab that is really gone", () => {
  /** Chrome's detach/destroy/crash notifications, each addressed to this tab. */
  const endings = [
    ["a flat session detached on the browser session", { method: "Target.detachedFromTarget", params: { sessionId: SESSION, reason: "target_closed" } }, /was detached from the debugger \(target_closed\)/],
    ["a detach addressed by target id", { method: "Target.detachedFromTarget", params: { targetId: TARGET } }, /was detached from the debugger \(no reason given\)/],
    ["the target being destroyed", { method: "Target.targetDestroyed", params: { targetId: TARGET } }, /was closed/],
    ["the renderer crashing", { method: "Target.targetCrashed", params: { targetId: TARGET } }, /crashed/],
  ];

  for (const [what, event, expected] of endings) {
    it(`fails immediately after ${what}, despite the transient wording`, async () => {
      // The message is deliberately the transient one: a closed target and a
      // navigating one say the same thing, so only the event can tell them
      // apart. Reading the text first would burn the whole budget here.
      const browser = scriptedBrowser((n, expression, b) => {
        if (n === 1) b.emit(event);
        throw protocolError(NAVIGATED);
      });
      const tab = await newTab(browser, "http://127.0.0.1:0/me");

      const err = await tab.waitFor("x", "back on /me", 5_000).catch((e) => e);
      expect(err.message).toMatch(expected);
      expect(err.message).toContain("back on /me");
      // The protocol error is kept, not replaced by a summary of it.
      expect(err.cause).toBeInstanceOf(CdpError);
      expect(err.cause.cdpMessage).toBe(NAVIGATED);
      expect(browser.evaluations()).toBe(1);
    });
  }

  // The same four endings again, this time with a poll that does NOT throw.
  //
  // Chrome does not owe the next `Runtime.evaluate` an error just because the
  // target is gone: the scripted page can answer an ordinary `false`, and the
  // real one does whenever the event lands between polls. If the wait only read
  // its lifecycle state from a catch, these runs would keep polling a dead tab
  // until some later call happened to throw or the budget expired — reporting
  // the assertion as the failure, which is precisely the misdiagnosis the
  // tracking exists to prevent.

  for (const [what, event, expected] of endings) {
    it(`fails immediately after ${what}, even when the next poll answers falsy`, async () => {
      const browser = scriptedBrowser((n, expression, b) => {
        if (n === 1) b.emit(event);
        return falsy;
      });
      const tab = await newTab(browser, "http://127.0.0.1:0/me");

      const err = await tab.waitFor("x", "back on /me", 5_000).catch((e) => e);
      expect(err.message).toMatch(expected);
      expect(err.message).toContain("back on /me");
      // Nothing threw, so there is no protocol error to keep — and none is
      // invented to fill the slot.
      expect(err.cause).toBeUndefined();
      expect(err.message).not.toContain("timed out");
      // The whole point: it did not poll a second time.
      expect(browser.evaluations()).toBe(1);
    });
  }

  it("reports the ending, not the budget, when the tab ends on the last poll", async () => {
    // Why the check after a falsy poll is not made redundant by the check
    // before the next one: the deadline test sits BETWEEN them. A tab that ends
    // on the poll that exhausts the budget would be reported as `timed out
    // waiting for …` — an assertion failure, with the close nowhere in it —
    // because the loop never gets back to the top to notice. The ending wins
    // over the budget, not the other way round.
    const browser = scriptedBrowser(async (n, expression, b) => {
      await new Promise((r) => setTimeout(r, 120)); // deliberately outlives the 50ms budget below
      b.emit({ method: "Target.detachedFromTarget", params: { sessionId: SESSION, reason: "target_closed" } });
      return falsy;
    });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    const err = await tab.waitFor("x", "back on /me", 50).catch((e) => e);
    expect(err.message).toMatch(/was detached from the debugger \(target_closed\)/);
    expect(err.message).not.toContain("timed out");
    expect(err.cause).toBeUndefined();
    expect(browser.evaluations()).toBe(1);
  });

  for (const [what, event, expected] of endings) {
    it(`fails without polling at all when ${what} arrived first`, async () => {
      // The event beat the wait — between two waits, or during the sleep of the
      // previous one. Asking the question at all is already wrong here.
      const browser = scriptedBrowser(() => falsy);
      const tab = await newTab(browser, "http://127.0.0.1:0/me");
      browser.emit(event);

      const err = await tab.waitFor("x", "back on /me", 5_000).catch((e) => e);
      expect(err.message).toMatch(expected);
      expect(err.message).toContain("back on /me");
      expect(err.cause).toBeUndefined();
      expect(browser.evaluations()).toBe(0);
    });
  }

  it("does not launder an earlier transient into the cause of the ending", async () => {
    // A real transient happened, was retried, and then the tab ended with a
    // normal falsy answer. The transient is genuine but it did not cause this
    // failure, and attaching it would point a reader at a navigation race that
    // is not what went wrong.
    const browser = scriptedBrowser((n, expression, b) => {
      if (n === 1) throw protocolError(NAVIGATED);
      if (n === 2) b.emit({ method: "Target.targetDestroyed", params: { targetId: TARGET } });
      return falsy;
    });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    const err = await tab.waitFor("x", "back on /me", 5_000).catch((e) => e);
    expect(err.message).toMatch(/was closed/);
    expect(err.cause).toBeUndefined();
    expect(err.message).not.toContain(NAVIGATED);
    expect(browser.evaluations()).toBe(2);
  });

  it("still returns when the poll observed the condition before the ending", async () => {
    // The mirror image, and the reason the lifecycle check sits AFTER the
    // truthy return: a tab that closes the instant the condition became true
    // did not stop the wait from getting its answer.
    const browser = scriptedBrowser((n, expression, b) => {
      b.emit({ method: "Target.targetDestroyed", params: { targetId: TARGET } });
      return truthy;
    });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    await tab.waitFor("x", "back on /me", 5_000);
    expect(browser.evaluations()).toBe(1);
  });

  it("ignores an ending that belongs to another tab", async () => {
    const browser = scriptedBrowser((n, expression, b) => {
      if (n === 1) {
        b.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-OTHER", targetId: "T-OTHER" } });
        b.emit({ method: "Target.targetDestroyed", params: { targetId: "T-OTHER" } });
        throw protocolError(NAVIGATED);
      }
      return truthy;
    });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    await tab.waitFor("x", "back on /me", 5_000);
    expect(browser.evaluations()).toBe(2);
  });
});

describe("evaluate is not a wait and never retries", () => {
  it("propagates the transient to its caller on the first try", async () => {
    const browser = scriptedBrowser(() => { throw protocolError(NAVIGATED); });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    const err = await tab.evaluate("history.back()").catch((e) => e);
    // Structured all the way out: the caller can still see the code.
    expect(err).toBeInstanceOf(CdpError);
    expect(err.code).toBe(-32000);
    expect(browser.evaluations()).toBe(1);
  });
});

describe("the deadline is the one from the start", () => {
  it("ends a run of transients at the original budget, with the reason", async () => {
    const browser = scriptedBrowser(() => { throw protocolError(NAVIGATED); });
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    const startedAt = Date.now();
    const err = await tab.waitFor("x", "back on /me", 300).catch((e) => e);
    const elapsed = Date.now() - startedAt;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^timed out waiting for back on \/me after 300ms/);
    expect(err.message).toContain("transient CDP error");
    expect(err.message).toContain(NAVIGATED);
    // It retried at all…
    expect(browser.evaluations()).toBeGreaterThan(1);
    // …and still stopped on the budget it was given. A deadline recomputed per
    // transient would never reach this line at all.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("keeps the plain wording when nothing was transient", async () => {
    const browser = scriptedBrowser(() => falsy);
    const tab = await newTab(browser, "http://127.0.0.1:0/me");

    const err = await tab.waitFor("x", "two device rows", 300).catch((e) => e);
    expect(err.message).toBe("timed out waiting for two device rows");
    expect(err.message).not.toContain("transient");
  });
});
