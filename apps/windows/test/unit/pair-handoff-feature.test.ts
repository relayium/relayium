// The pairing handoff in main: what it retains, what it refuses to copy, and
// what a late mint may not revive.

import { describe, expect, it } from "vitest";
import {
  PairHandoffService,
  joinLinkFor,
  type PairHandoffDeps,
} from "../../src/main/features/pair-handoff.js";
import type { PairHandoffView } from "../../src/shared/pair-handoff.js";

const ORIGIN = "https://relayium.test";
const CODE = "483920";

function harness(over: Partial<PairHandoffDeps> = {}) {
  const clipboard: string[] = [];
  const views: PairHandoffView[] = [];
  const failures: unknown[] = [];
  const state = { document: 7, epoch: 3, now: 1_000 };
  const service = new PairHandoffService({
    origin: ORIGIN,
    writeClipboard: (text) => clipboard.push(text),
    currentDocument: () => state.document,
    accountEpoch: () => state.epoch,
    now: () => state.now,
    onView: (view) => views.push(view),
    reportFailure: (err) => failures.push(err),
    ...over,
  });
  /** Mint and adopt in one step, as a host would. */
  const mint = (code = CODE, ttl = 600, document = state.document) => {
    const ticket = service.beginMint();
    return service.adopt(ticket, code, state.now + ttl, document);
  };
  return { service, clipboard, views, failures, state, mint };
}

describe("the join link", () => {
  it("carries the code in the FRAGMENT and never in a query", () => {
    const link = joinLinkFor(ORIGIN, CODE);
    expect(link).toBe(`${ORIGIN}/cross-network#c=${CODE}`);
    const url = new URL(link!);
    // A query would put the code in request logs and Referer headers, which is
    // the whole reason the web client uses a fragment.
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#c=${CODE}`);
    expect(url.pathname).toBe("/cross-network");
  });

  it("refuses a code that is not the server's shape", () => {
    for (const bad of ["", "12345", "1234567", "48392a", "48 920", "../x", "483920#c=1"]) {
      expect({ bad, link: joinLinkFor(ORIGIN, bad) }).toEqual({ bad, link: null });
    }
  });

  it("refuses an origin that is not one", () => {
    for (const bad of [
      "https://relayium.test/somewhere",
      "https://relayium.test/?a=1",
      "ftp://relayium.test",
      "https://u:p@relayium.test",
      "not a url",
      "",
    ]) {
      expect({ bad, link: joinLinkFor(bad, CODE) }).toEqual({ bad, link: null });
    }
  });
});

describe("what main retains", () => {
  it("is idle until a code is adopted", () => {
    const h = harness();
    expect(h.service.view().kind).toBe("idle");
    expect(h.service.held).toBe(false);
  });

  it("publishes the code, its expiry and the built link", () => {
    const h = harness();
    expect(h.mint()).toBe(true);
    const view = h.service.view();
    if (view.kind !== "live") throw new Error("expected live");
    expect(view.code).toBe(CODE);
    expect(view.link).toBe(`${ORIGIN}/cross-network#c=${CODE}`);
    expect(view.expiresAt).toBe(1_600);
    expect(h.service.held).toBe(true);
  });

  it("carries no bearer, token or storage handle", () => {
    const h = harness();
    h.mint();
    const serialised = JSON.stringify(h.service.view());
    expect(serialised).not.toMatch(/bearer|token|secret|authorization/i);
  });

  it("moves the generation on every mint and every invalidation", () => {
    const h = harness();
    h.mint();
    const first = h.service.view().generation;
    h.mint("111111");
    const second = h.service.view().generation;
    expect(second).toBeGreaterThan(first);
    h.service.invalidate();
    expect(h.service.view().generation).toBeGreaterThan(second);
  });
});

describe("a late mint cannot revive a finished code", () => {
  it("refuses an answer whose ticket was superseded by a regenerate", () => {
    const h = harness();
    const slow = h.service.beginMint();
    // The user pressed regenerate while the first mint was still in flight.
    const fresh = h.service.beginMint();
    expect(h.service.adopt(fresh, "222222", h.state.now + 600, h.state.document)).toBe(true);
    expect(h.service.adopt(slow, CODE, h.state.now + 600, h.state.document)).toBe(false);
    const view = h.service.view();
    if (view.kind !== "live") throw new Error("expected live");
    expect(view.code).toBe("222222");
  });

  it("refuses an answer that arrives after the user left", () => {
    const h = harness();
    const ticket = h.service.beginMint();
    // Leave. Nothing else changes: same document, same account — so the ticket
    // is the ONLY thing standing between a slow mint and a live QR for a room
    // nobody is in.
    h.service.invalidate();
    expect(h.service.adopt(ticket, CODE, h.state.now + 600, h.state.document)).toBe(false);
    expect(h.service.view().kind).toBe("idle");
  });

  it("refuses an answer that arrives after a leave even from a fresh service", () => {
    // The same case with nothing ever held, so the early return in `invalidate`
    // cannot be what refuses it.
    const h = harness();
    const ticket = h.service.beginMint();
    h.service.invalidate();
    expect(h.service.adopt(ticket, CODE, h.state.now + 600, h.state.document)).toBe(false);
  });

  it("refuses an answer that arrives after a sign-out", () => {
    const h = harness();
    const ticket = h.service.beginMint();
    h.service.onAccountChanged();
    expect(h.service.adopt(ticket, CODE, h.state.now + 600, h.state.document)).toBe(false);
    expect(h.service.view().kind).toBe("idle");
  });

  it("refuses an already-expired code", () => {
    const h = harness();
    const ticket = h.service.beginMint();
    expect(h.service.adopt(ticket, CODE, h.state.now, h.state.document)).toBe(false);
    expect(h.service.adopt(ticket, CODE, h.state.now - 1, h.state.document)).toBe(false);
  });

  it("refuses a code that is not the server's shape", () => {
    const h = harness();
    const ticket = h.service.beginMint();
    expect(h.service.adopt(ticket, "abc", h.state.now + 600, h.state.document)).toBe(false);
  });
});

describe("root's five: the service contract closes them itself", () => {
  it("stamps a code with the epoch its mint STARTED under, never the current one", () => {
    const h = harness();
    const ticket = h.service.beginMint();
    // The account moves while the mint is in flight, and no callback has run.
    h.state.epoch += 1;
    expect(h.service.adopt(ticket, CODE, h.state.now + 600, h.state.document)).toBe(false);
    expect(h.service.view().kind).toBe("idle");
  });

  it("refuses a mint whose document changed while it was in flight", () => {
    const h = harness();
    const ticket = h.service.beginMint();
    h.state.document += 1;
    // The caller still claims the document it started under; the service
    // refuses because that document is no longer the one on screen.
    expect(h.service.adopt(ticket, CODE, h.state.now + 600, 7)).toBe(false);
  });

  it("stops READING out a link whose account has moved, before any callback", () => {
    const h = harness();
    h.mint();
    expect(h.service.view().kind).toBe("live");
    // Sign-out has happened; `onAccountChanged` has NOT been called yet.
    h.state.epoch += 1;
    expect(h.service.view().kind).toBe("idle");
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "no-code" });
  });

  it("stops reading out a link whose document has been replaced", () => {
    const h = harness();
    h.mint();
    h.state.document += 1;
    expect(h.service.view().kind).toBe("idle");
  });

  it("supersedes the old code at beginMint, not when the new one lands", () => {
    const h = harness();
    h.mint();
    expect(h.service.view().kind).toBe("live");
    const views = h.views.length;
    // Regenerate. The old QR and link must go NOW — the user has replaced them.
    h.service.beginMint();
    expect(h.service.view().kind).toBe("idle");
    expect(h.views.length).toBeGreaterThan(views);
  });

  it("PUSHES idle when the code expires, with nobody reading", async () => {
    const pushed: string[] = [];
    const h = harness({ onView: (view) => pushed.push(view.kind) });
    // A real 30ms deadline, and a clock that actually advances past it.
    const ticket = h.service.beginMint();
    h.state.now = 1_000;
    expect(h.service.adopt(ticket, CODE, 1_001, h.state.document)).toBe(true);
    expect(pushed.at(-1)).toBe("live");
    h.state.now = 1_002;
    await new Promise((r) => setTimeout(r, 1_050));
    // Nothing read and nothing copied: the service published it itself.
    expect(pushed.at(-1)).toBe("idle");
  });

  it("a timer armed for an old code cannot clear a newer one", async () => {
    const h = harness();
    const first = h.service.beginMint();
    h.service.adopt(first, CODE, h.state.now + 1, h.state.document);
    // Replaced before the first deadline elapses.
    const second = h.service.beginMint();
    h.service.adopt(second, "222222", h.state.now + 600, h.state.document);
    h.state.now += 2;
    await new Promise((r) => setTimeout(r, 1_050));
    const view = h.service.view();
    if (view.kind !== "live") throw new Error("the stale timer cleared the new code");
    expect(view.code).toBe("222222");
  });

  it("clears the timer on invalidate and on dispose", async () => {
    const h = harness();
    const ticket = h.service.beginMint();
    h.service.adopt(ticket, CODE, h.state.now + 1, h.state.document);
    h.service.invalidate();
    const after = h.views.length;
    h.state.now += 2;
    await new Promise((r) => setTimeout(r, 1_050));
    // The timer fired into nothing: no second idle publish for one code.
    expect(h.views.length).toBe(after);

    const g = harness();
    const t2 = g.service.beginMint();
    g.service.adopt(t2, CODE, g.state.now + 1, g.state.document);
    g.service.dispose();
    const count = g.views.length;
    g.state.now += 2;
    await new Promise((r) => setTimeout(r, 1_050));
    expect(g.views.length).toBe(count);
  });
});

describe("expiry invalidates both the QR and the copy", () => {
  it("reads as idle once the deadline passes, without anything ticking", () => {
    const h = harness();
    h.mint(CODE, 600);
    expect(h.service.view().kind).toBe("live");
    h.state.now = 1_600;
    expect(h.service.view().kind).toBe("idle");
    expect(h.service.held).toBe(false);
  });

  it("refuses the copy as EXPIRED, distinctly from having no code", () => {
    const h = harness();
    h.mint(CODE, 600);
    h.state.now = 1_601;
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "expired" });
    expect(h.clipboard).toEqual([]);
    // And once it is gone, the honest answer is that there is none.
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "no-code" });
  });
});

describe("the copy takes a token, never a payload", () => {
  it("copies the link main built from the code main retained", () => {
    const h = harness();
    h.mint();
    const outcome = h.service.copy("copy-join-link", h.state.document);
    expect(outcome.kind).toBe("copied");
    expect(h.clipboard).toEqual([`${ORIGIN}/cross-network#c=${CODE}`]);
  });

  it("refuses any token that is not the closed one", () => {
    const h = harness();
    h.mint();
    for (const bad of ["copy", "", "https://evil.test", null, undefined, 1]) {
      expect(h.service.copy(bad as never, h.state.document)).toEqual({ kind: "unavailable" });
    }
    expect(h.clipboard).toEqual([]);
  });

  it("stamps the confirmation with the link's generation", () => {
    const h = harness();
    h.mint();
    const view = h.service.view();
    const outcome = h.service.copy("copy-join-link", h.state.document);
    if (outcome.kind !== "copied") throw new Error("expected copied");
    expect(outcome.generation).toBe(view.generation);
  });

  it("refuses a copy from a document that has since reloaded", () => {
    const h = harness();
    h.mint();
    const asked = h.state.document;
    h.state.document = asked + 1;
    expect(h.service.copy("copy-join-link", asked)).toEqual({ kind: "unavailable" });
    expect(h.clipboard).toEqual([]);
  });

  it("refuses a copy of a code minted under another account", () => {
    const h = harness();
    h.mint();
    h.state.epoch += 1;
    // Deliberately without calling `onAccountChanged`, so the check being
    // tested is the one at COPY time rather than the clearing before it.
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "unavailable" });
    expect(h.clipboard).toEqual([]);
  });

  it("reports a clipboard that threw, and copies nothing", () => {
    const h = harness({
      writeClipboard: () => {
        throw new Error("clipboard unavailable");
      },
    });
    h.mint();
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "unavailable" });
    expect(h.failures.length).toBe(1);
  });
});

describe("clearing", () => {
  it("clears on leave or regenerate", () => {
    const h = harness();
    h.mint();
    h.service.invalidate();
    expect(h.service.view().kind).toBe("idle");
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "no-code" });
  });

  it("clears on an account change", () => {
    const h = harness();
    h.mint();
    h.service.onAccountChanged();
    expect(h.service.view().kind).toBe("idle");
  });

  it("clears when the owning document is revoked, and only then", () => {
    const h = harness();
    h.mint();
    h.service.revokeDocument(h.state.document + 1);
    expect(h.service.view().kind).toBe("live");
    h.service.revokeDocument(h.state.document);
    expect(h.service.view().kind).toBe("idle");
  });
});

describe("lifecycle", () => {
  it("a fence refuses new mints and copies, and drops nothing", () => {
    const h = harness();
    h.mint();
    h.service.fence();
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "unavailable" });
    const ticket = h.service.beginMint();
    expect(h.service.adopt(ticket, "111111", h.state.now + 600, h.state.document)).toBe(false);
    // Nothing held was dropped: the user may still choose Stay. `beginMint`
    // under a fence must not supersede either, or the quit prompt itself would
    // cost the user the code it is asking about.
    expect(h.service.view().kind).toBe("live");
  });

  it("resume re-opens, and reports a code that died during the prompt", () => {
    const h = harness();
    h.mint(CODE, 600);
    h.service.fence();
    h.state.now = 1_700;
    h.service.resume();
    // Honest rather than silently reappearing.
    expect(h.service.view().kind).toBe("idle");
    const ticket = h.service.beginMint();
    expect(h.service.adopt(ticket, "111111", h.state.now + 600, h.state.document)).toBe(true);
  });

  it("quiesce reports whether a code was held, and drops it", () => {
    const h = harness();
    h.mint();
    expect(h.service.quiesce()).toEqual({ held: true });
    expect(h.service.view().kind).toBe("idle");
    expect(h.service.quiesce()).toEqual({ held: false });
  });

  it("dispose is terminal and publishes nothing further", () => {
    const h = harness();
    h.mint();
    h.service.dispose();
    const before = h.views.length;
    h.service.invalidate();
    const ticket = h.service.beginMint();
    expect(h.service.adopt(ticket, CODE, h.state.now + 600, h.state.document)).toBe(false);
    expect(h.service.copy("copy-join-link", h.state.document)).toEqual({ kind: "unavailable" });
    expect(h.views.length).toBe(before);
  });

  it("survives an observer that throws", () => {
    const h = harness({
      onView: () => {
        throw new Error("observer exploded");
      },
    });
    expect(h.mint()).toBe(true);
    expect(h.service.view().kind).toBe("live");
    expect(h.failures.length).toBeGreaterThan(0);
  });
});
