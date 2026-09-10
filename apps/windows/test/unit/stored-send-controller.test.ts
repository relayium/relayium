// The send controller: what a delayed answer is allowed to write.
//
// Every case here is a race root reproduced independently. The bridge is
// controlled so each is a fact rather than a timing accident.

import { describe, expect, it, vi } from "vitest";
import {
  StoredSendController,
  type StoredSendBridge,
} from "../../src/renderer/send/stored-send-controller.svelte.js";
import type { StoredSendHistoryEntry, StoredSendStart } from "../../src/shared/ipc-contract.js";

/**
 * A REAL 32-byte key, base64url.
 *
 * The controller imports whatever `start` answers with, so a placeholder makes
 * every send fail inside `importStoreKey` — and the test then passes or fails
 * for a reason that has nothing to do with what it is asserting.
 */
const KEY = "J9Zy3ENcfnTtHZ02gA_kr6jr8V0DGjDkqjw1vnmEENg";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ENTRY = (jobId: string): StoredSendHistoryEntry => ({
  jobId,
  state: "published",
  fileCount: 1,
  totalBytes: 1,
  burnAfterRead: false,
  expiresAt: 0,
  createdAt: 0,
  note: null,
  linkable: true,
});

function bridge(over: Partial<StoredSendBridge> = {}) {
  const calls = { feed: 0, cancel: 0, copy: 0, start: 0 };
  let account: ((payload: unknown) => void) | null = null;
  const base: StoredSendBridge = {
    async start() {
      calls.start += 1;
      return {
        ok: true,
        jobId: "job-1",
        contentKey: KEY,
        expects: { fileIndex: 0, seq: 1, bytes: 4 },
        cipherBytes: 4,
        fileCount: 1,
      } satisfies StoredSendStart;
    },
    async feed() {
      calls.feed += 1;
      return { expects: null };
    },
    async end() {
      return { status: "published", objectId: "o", expiresAt: 0 };
    },
    async cancel() {
      calls.cancel += 1;
      return { status: "cancelled" };
    },
    async history() {
      return { entries: [] };
    },
    async link() {
      return { link: "https://relayium.com/d/o#k=SECRET" };
    },
    async remove() {
      return { result: "deleted" };
    },
    async reconcile() {
      return { status: "ambiguous", code: "no-match" };
    },
    async copyLink() {
      calls.copy += 1;
      return { result: "copied" };
    },
    onProgress: () => () => undefined,
    onOutcome: () => () => undefined,
    onAccount: (cb) => {
      account = cb;
      return () => {
        account = null;
      };
    },
    ...over,
  };
  return { bridge: base, calls, signOut: (epoch: number) => account?.({ epoch }) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("a send the user cancelled before it was acknowledged", () => {
  it("feeds nothing and cancels the job main created", async () => {
    // Root's probe: `feed` was still called once after Cancel, because the
    // cancel found no job id yet and returned while `send` carried on.
    const held = deferred<StoredSendStart>();
    const built = bridge({
      start: async () => {
        built.calls.start += 1;
        return held.promise;
      },
    });
    const controller = new StoredSendController(built.bridge);
    controller.pick([new File([new Uint8Array(4)], "a.bin")]);

    const sending = controller.send();
    await settle();
    expect(controller.busy).toBe(true);

    await controller.cancel();
    // The UI stops saying "uploading" immediately, which it did not before.
    expect(controller.busy).toBe(false);

    held.resolve({
      ok: true,
      jobId: "job-1",
      contentKey: KEY,
      expects: { fileIndex: 0, seq: 1, bytes: 4 },
      cipherBytes: 4,
      fileCount: 1,
    });
    await sending;

    expect(built.calls.feed).toBe(0);
    // The job main created is stopped rather than left running.
    expect(built.calls.cancel).toBeGreaterThan(0);
    expect(controller.outcome).toEqual({ status: "cancelled" });
  });

  it("does not let the cancelled attempt clear a newer one", async () => {
    const held = deferred<StoredSendStart>();
    // The second attempt is held at FINALIZE, so it is genuinely still running
    // when the abandoned first one comes back.
    const secondEnd = deferred<{ status: "published"; objectId: string; expiresAt: number }>();
    let first = true;
    const built = bridge({
      start: async () => {
        if (first) {
          first = false;
          return held.promise;
        }
        return {
          ok: true,
          jobId: "job-2",
          contentKey: KEY,
          expects: null,
          cipherBytes: 0,
          fileCount: 1,
        };
      },
      end: async () => secondEnd.promise,
    });
    const controller = new StoredSendController(built.bridge);
    controller.pick([new File([new Uint8Array(4)], "a.bin")]);
    const firstSend = controller.send();
    await settle();
    await controller.cancel();

    const secondSend = controller.send();
    await settle();
    expect(controller.busy).toBe(true);

    // The abandoned attempt finishes LAST and must not clear `busy` for the
    // one that is running now.
    held.resolve({
      ok: true,
      jobId: "job-1",
      contentKey: KEY,
      expects: { fileIndex: 0, seq: 1, bytes: 4 },
      cipherBytes: 4,
      fileCount: 1,
    });
    await firstSend;
    // The abandoned attempt must not have cleared `busy` for this one.
    expect(controller.busy).toBe(true);
    secondEnd.resolve({ status: "published", objectId: "o", expiresAt: 0 });
    await secondSend;
    expect(controller.busy).toBe(false);
  });
});

describe("history that lands out of order", () => {
  it("does not let an older read overwrite a newer one", async () => {
    // Root's second probe. Two reads under the SAME account, the slow one
    // issued first: its answer put back a row the newer read had dropped.
    const slow = deferred<{ entries: readonly StoredSendHistoryEntry[] }>();
    let call = 0;
    const built = bridge({
      history: async () => {
        call += 1;
        return call === 1 ? slow.promise : { entries: [ENTRY("new")] };
      },
    });
    const controller = new StoredSendController(built.bridge);

    const first = controller.refreshHistory();
    const second = controller.refreshHistory();
    await second;
    expect(controller.history.map((e) => e.jobId)).toEqual(["new"]);

    slow.resolve({ entries: [ENTRY("stale")] });
    await first;
    expect(controller.history.map((e) => e.jobId)).toEqual(["new"]);
  });
});

describe("an account that changed", () => {
  it("drops the link, the history and the outcome synchronously", async () => {
    const built = bridge({ history: async () => ({ entries: [ENTRY("old")] }) });
    const controller = new StoredSendController(built.bridge);
    await controller.refreshHistory();
    controller.link = "https://relayium.com/d/o#k=SECRET";
    controller.outcome = { status: "published", objectId: "o", expiresAt: 0 };
    expect(controller.history.length).toBe(1);

    built.signOut(2);

    // A link is a KEY. It is gone before anything is awaited.
    expect(controller.link).toBeNull();
    expect(controller.outcome).toBeNull();
    expect(controller.history).toEqual([]);
  });

  it("reads the history when the credential becomes durable, without clearing anything", async () => {
    // `AppService.adopt` notifies twice under ONE epoch: once before the bearer
    // is written and once after. Only the second means "there is an account to
    // read history for", and comparing the epoch alone discarded it — so a page
    // that had just signed in kept showing an empty history.
    //
    // It must also not behave like an account CHANGE: a send running under this
    // account is still the user's, and a sign-in must not cancel it.
    let call = 0;
    const built = bridge({
      history: async () => {
        call += 1;
        return { entries: call === 1 ? [] : [ENTRY("now-visible")] };
      },
    });
    const controller = new StoredSendController(built.bridge);
    await controller.refreshHistory();
    expect(controller.history).toEqual([]);
    controller.busy = true;
    controller.link = "https://relayium.com/d/o#k=SECRET";

    // The SAME epoch the controller already holds, now readable.
    built.signOut(0);
    await settle();

    expect(controller.history.map((e) => e.jobId)).toEqual(["now-visible"]);
    // Nothing was torn down: this is a sign-in, not a sign-out.
    expect(controller.busy).toBe(true);
    expect(controller.link).toBe("https://relayium.com/d/o#k=SECRET");
  });

  it("does not let a link that was in flight land after the sign-out", async () => {
    const slow = deferred<{ link: string | null }>();
    const built = bridge({ link: async () => slow.promise });
    const controller = new StoredSendController(built.bridge);
    const asking = controller.linkFor("job-1");
    built.signOut(2);
    slow.resolve({ link: "https://relayium.com/d/o#k=SECRET" });
    expect(await asking).toBeNull();
  });

  it("does not let a history read from before the sign-out restore old rows", async () => {
    const slow = deferred<{ entries: readonly StoredSendHistoryEntry[] }>();
    let call = 0;
    const built = bridge({
      history: async () => {
        call += 1;
        return call === 1 ? slow.promise : { entries: [] };
      },
    });
    const controller = new StoredSendController(built.bridge);
    const reading = controller.refreshHistory();
    built.signOut(2);
    slow.resolve({ entries: [ENTRY("old")] });
    await reading;
    expect(controller.history).toEqual([]);
  });
});

describe("copying a link", () => {
  it("goes through main rather than a denied browser permission", async () => {
    const copied = vi.fn(async () => ({ result: "copied" as const }));
    const built = bridge({ copyLink: copied });
    const controller = new StoredSendController(built.bridge);
    await controller.copyLink("job-1");
    // It names the JOB. There is no channel that takes the link string.
    expect(copied).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(controller.copied).toBe("copied");
  });

  it("shows a refusal rather than doing nothing", async () => {
    const built = bridge({ copyLink: async () => ({ result: "unavailable" }) });
    const controller = new StoredSendController(built.bridge);
    await controller.copyLink("job-1");
    expect(controller.copied).toBe("failed");
  });
});

describe("delete and re-check always say what they did", () => {
  it("reports a failed delete instead of appearing to succeed", async () => {
    const built = bridge({ remove: async () => ({ result: "failed" }) });
    const controller = new StoredSendController(built.bridge);
    await controller.remove("job-1");
    expect(controller.rowNotice).toEqual({ jobId: "job-1", kind: "delete-failed" });
  });

  it("reports a re-check that still could not confirm anything", async () => {
    const controller = new StoredSendController(bridge().bridge);
    await controller.reconcile("job-1");
    expect(controller.rowNotice).toEqual({ jobId: "job-1", kind: "still-unknown" });
  });
});

// ---------------------------------------------------------------------------
// Which link the Copy button copies
// ---------------------------------------------------------------------------
//
// A real Windows failure, not a flaky clipboard: the page derived the job id
// from `history[0]`, and the link is shown as soon as `end` reports published —
// while the history refresh that would fill row 0 is still in flight. The copy
// therefore named the empty string and was refused at the boundary, and once
// the history did land the same expression could name a DIFFERENT job than the
// link on screen.

describe("copying the link that is on screen", () => {
  /** Publish one send whose history refresh is held open. */
  async function publishedWithHeldHistory(historyEntries: readonly StoredSendHistoryEntry[]) {
    const held = deferred<{ entries: readonly StoredSendHistoryEntry[] | null }>();
    const copied: string[] = [];
    const built = bridge({
      history: () => held.promise,
      async copyLink(payload) {
        copied.push(payload.jobId);
        return { result: "copied" };
      },
    });
    const controller = new StoredSendController(built.bridge);
    controller.pick([new File([new Uint8Array(4)], "a.bin")]);
    const sending = controller.send();
    await settle();
    return {
      controller,
      copied,
      sending,
      landHistory: () => held.resolve({ entries: historyEntries }),
    };
  }

  it("copies the right job while the history has not landed yet", async () => {
    // The exact window the Windows run failed in.
    const h = await publishedWithHeldHistory([]);
    expect(h.controller.link).not.toBeNull();
    expect(h.controller.linkJobId).toBe("job-1");

    await h.controller.copyShownLink();
    // Named the job, not the empty string a refused boundary would see.
    expect(h.copied).toEqual(["job-1"]);
    expect(h.controller.copied).toBe("copied");

    h.landHistory();
    await h.sending;
  });

  it("does not follow the history's ordering once it does land", async () => {
    // A newer send from another window, a re-ordered page, a row that sorts
    // first for any reason: none of them changes which link is being displayed.
    const h = await publishedWithHeldHistory([ENTRY("some-other-job"), ENTRY("job-1")]);
    h.landHistory();
    await h.sending;

    expect(h.controller.link).not.toBeNull();
    expect(h.controller.linkJobId).toBe("job-1");
    await h.controller.copyShownLink();
    expect(h.copied).toEqual(["job-1"]);
    // And emphatically not the row that happens to be first.
    expect(h.copied).not.toContain("some-other-job");
  });

  it("refuses rather than copying when no link is shown", async () => {
    const built = bridge();
    const controller = new StoredSendController(built.bridge);
    // Nothing published. There is no link and no identity, so there is nothing
    // to copy — and main is not asked with an empty id.
    await controller.copyShownLink();
    expect(built.calls.copy).toBe(0);
    expect(controller.copied).toBe("failed");
  });

  it("drops the identity with the link when the account changes", async () => {
    const built = bridge();
    const controller = new StoredSendController(built.bridge);
    controller.pick([new File([new Uint8Array(4)], "a.bin")]);
    await controller.send();
    expect(controller.linkJobId).toBe("job-1");

    // A link is a KEY, and it belongs to whoever was signed in.
    built.signOut(9);
    expect(controller.link).toBeNull();
    expect(controller.linkJobId).toBeNull();
    await controller.copyShownLink();
    expect(built.calls.copy).toBe(0);
  });

  it("drops the identity when a new selection replaces the last send", async () => {
    const built = bridge();
    const controller = new StoredSendController(built.bridge);
    controller.pick([new File([new Uint8Array(4)], "a.bin")]);
    await controller.send();
    expect(controller.linkJobId).toBe("job-1");

    // A fresh pick is a fresh job. Leaving the old link's identity behind would
    // let a Copy press after it name a send the screen is no longer about.
    controller.pick([new File([new Uint8Array(8)], "b.bin")]);
    expect(controller.link).toBeNull();
    expect(controller.linkJobId).toBeNull();
    await controller.copyShownLink();
    expect(built.calls.copy).toBe(0);
  });

  it("keeps a row's own Copy working, which names its row", async () => {
    // The history rows are unaffected: each names the job it renders.
    const built = bridge();
    const controller = new StoredSendController(built.bridge);
    await controller.copyLink("a-past-job");
    expect(built.calls.copy).toBe(1);
  });
});
