// The send controller: what a delayed answer is allowed to write.
//
// Every case here is a race root reproduced independently. The bridge is
// controlled so each is a fact rather than a timing accident.

import { describe, expect, it, vi } from "vitest";
import {
  StoredSendController,
  TTL_CHOICES,
  allowedTtlChoices,
  capDuration,
  exceedsCap,
  retentionCapOf,
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

// ---------------------------------------------------------------------------
// How long a link may last
// ---------------------------------------------------------------------------
//
// `0` is the server's word for UNLIMITED. The trap is the third state: a plan
// that could not be READ is not a plan without a cap, and treating it as one
// offers a choice the server is about to clamp — the user is told fourteen days
// and gets one, with nothing on screen admitting it.

describe("the plan's retention cap", () => {
  const ready = (retentionSecs: number) => ({ kind: "ready", value: { plan: { retentionSecs } } });

  it("reads zero as unlimited, not as nothing", () => {
    expect(retentionCapOf(ready(0))).toEqual({ kind: "unlimited" });
    expect(allowedTtlChoices({ kind: "unlimited" })).toEqual({ days: TTL_CHOICES, clamped: false });
  });

  it("reads a real cap as a limit", () => {
    expect(retentionCapOf(ready(7 * 24 * 60 * 60))).toEqual({ kind: "limited", seconds: 604_800 });
  });

  it("treats a section that is NOT ready as unknown", () => {
    // None of these is evidence about the plan.
    expect(retentionCapOf({ kind: "loading" })).toEqual({ kind: "unknown" });
    expect(retentionCapOf({ kind: "failed" })).toEqual({ kind: "unknown" });
    expect(retentionCapOf({ kind: "signed-out" })).toEqual({ kind: "unknown" });
    // Ready but malformed is unknown too, rather than silently zero — which
    // would read as UNLIMITED, the most generous possible misreading.
    expect(retentionCapOf({ kind: "ready", value: { plan: {} } })).toEqual({ kind: "unknown" });
    expect(retentionCapOf({ kind: "ready", value: { plan: { retentionSecs: -1 } } })).toEqual({
      kind: "unknown",
    });
  });

  it("does not shorten the offered choices when the cap is unknown", () => {
    // The server clamps whatever is sent, so hiding choices on a guess invents
    // a limit. What the page owes there is a sentence, not a shorter list.
    expect(allowedTtlChoices({ kind: "unknown" })).toEqual({ days: TTL_CHOICES, clamped: false });
  });

  it("offers only what a limited plan can honour", () => {
    const week = allowedTtlChoices({ kind: "limited", seconds: 7 * 24 * 60 * 60 });
    expect(week.days).toEqual([1, 7]);
    expect(week.clamped).toBe(true);
    const day = allowedTtlChoices({ kind: "limited", seconds: 24 * 60 * 60 });
    expect(day.days).toEqual([1]);
  });

  it("never leaves the picker empty", () => {
    // A cap shorter than every choice still leaves the shortest: the server
    // clamps it, and a control with no options is one nobody can use.
    const tiny = allowedTtlChoices({ kind: "limited", seconds: 60 });
    expect(tiny.days).toEqual([1]);
    expect(tiny.clamped).toBe(true);
  });

  it("corrects a selection the plan cannot honour, without over-clamping", () => {
    const built = bridge();
    const controller = new StoredSendController(built.bridge);
    controller.ttlDays = 14;
    controller.applyRetentionCap({ kind: "limited", seconds: 7 * 24 * 60 * 60 });
    // The LONGEST the plan permits — clamping to the shortest would take away
    // something the account actually has.
    expect(controller.ttlDays).toBe(7);

    // An unknown cap changes nothing: it is not evidence.
    controller.ttlDays = 14;
    controller.applyRetentionCap({ kind: "unknown" });
    expect(controller.ttlDays).toBe(14);

    // And a legal choice is left alone.
    controller.ttlDays = 1;
    controller.applyRetentionCap({ kind: "limited", seconds: 7 * 24 * 60 * 60 });
    expect(controller.ttlDays).toBe(1);
  });

  it("does not rewrite the choice mid-upload", () => {
    const built = bridge();
    const controller = new StoredSendController(built.bridge);
    controller.ttlDays = 14;
    controller.busy = true;
    // The job was planned with the retention it was started with; changing the
    // number under it would misdescribe an upload already in flight.
    controller.applyRetentionCap({ kind: "limited", seconds: 24 * 60 * 60 });
    expect(controller.ttlDays).toBe(14);
  });
});

describe("what the page may CLAIM about the cap", () => {
  it("states a three-day plan as three days, not as the preset that fits", () => {
    // The presets are 1/7/14, so a three-day plan fits only the first. Saying
    // "up to 1 day" understates what the account actually has — root found this
    // against real server plans, which do include three days.
    const cap = { kind: "limited", seconds: 3 * 24 * 60 * 60 } as const;
    expect(allowedTtlChoices(cap).days).toEqual([1]);
    expect(capDuration(cap.seconds)).toEqual({ unit: "day", count: 3 });
    // And a one-day choice under a three-day plan is NOT a clamp.
    expect(exceedsCap(cap, 1)).toBe(false);
  });

  it("never promises longer than a sub-day plan keeps a link", () => {
    // No preset fits, so the picker falls back to one day — which is longer
    // than the plan allows. The page must say it will be shortened.
    const cap = { kind: "limited", seconds: 6 * 60 * 60 } as const;
    expect(allowedTtlChoices(cap).days).toEqual([1]);
    expect(exceedsCap(cap, 1)).toBe(true);
    expect(capDuration(cap.seconds)).toEqual({ unit: "hour", count: 6 });
  });

  it("states the cap in the largest unit that divides it EXACTLY", () => {
    expect(capDuration(14 * 24 * 60 * 60)).toEqual({ unit: "day", count: 14 });
    expect(capDuration(3 * 24 * 60 * 60)).toEqual({ unit: "day", count: 3 });
    expect(capDuration(36 * 60 * 60)).toEqual({ unit: "hour", count: 36 });
    expect(capDuration(90 * 60)).toEqual({ unit: "minute", count: 90 });
  });

  it("falls back to whole seconds rather than rounding into another number", () => {
    // Ninety seconds is ninety seconds. Flooring called it "1 minute" and a
    // ceiling would have called it "2" — both are claims about a cap the plan
    // does not have, in opposite directions.
    expect(capDuration(90)).toEqual({ unit: "second", count: 90 });
    expect(capDuration(40)).toEqual({ unit: "second", count: 40 });
    expect(capDuration(1)).toEqual({ unit: "second", count: 1 });
    // And a value that is minutes-exact but not hours-exact still reads in
    // minutes, so seconds are the LAST resort rather than the default.
    expect(capDuration(45 * 60)).toEqual({ unit: "minute", count: 45 });
    expect(capDuration(3 * 60 * 60 + 30 * 60)).toEqual({ unit: "minute", count: 210 });
  });

  it("claims nothing at all when the cap is unknown", () => {
    // Neither a cap nor a clamp can be asserted without knowing the plan.
    expect(exceedsCap({ kind: "unknown" }, 14)).toBe(false);
    expect(exceedsCap({ kind: "unlimited" }, 14)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A dropped folder keeps its shape
// ---------------------------------------------------------------------------
//
// Root's replay: `pickedFromDrop` produced `docs/note.txt` correctly, and the
// page then mapped it to `entry.file` and let the controller re-derive the name
// from the File. A dropped file has NO `webkitRelativePath` — the structure
// lived in the entry tree the drop walked — so the manifest said `note.txt`,
// the folder arrived flat, and two siblings with the same basename collided.
//
// These assert the MANIFEST entries the bridge actually receives, not a label.

describe("what a drop actually sends", () => {
  /** Capture the entries `start` is called with. */
  function capturing() {
    const seen: { path: string; size: number }[][] = [];
    const built = bridge({
      async start(payload) {
        seen.push(payload.entries.map((entry) => ({ path: entry.path, size: entry.size })));
        return {
          ok: true,
          jobId: "job-1",
          contentKey: KEY,
          expects: null,
          cipherBytes: 0,
          fileCount: payload.entries.length,
        };
      },
    });
    return { seen, controller: new StoredSendController(built.bridge) };
  }

  const dropped = (path: string, bytes: number) => ({
    // A dropped File has no relative path of its own — this is the whole point.
    file: new File([new Uint8Array(bytes)], path.split("/").pop() ?? path),
    path,
  });

  it("keeps a nested folder's structure in the manifest", async () => {
    const h = capturing();
    h.controller.pickEntries([dropped("docs/note.txt", 3), dropped("docs/deep/report.pdf", 5)]);
    await h.controller.send();
    expect(h.seen[0]).toEqual([
      { path: "docs/note.txt", size: 3 },
      { path: "docs/deep/report.pdf", size: 5 },
    ]);
  });

  it("does not collide two siblings that share a basename", async () => {
    const h = capturing();
    h.controller.pickEntries([dropped("a/note.txt", 1), dropped("b/note.txt", 2)]);
    await h.controller.send();
    const paths = (h.seen[0] ?? []).map((entry) => entry.path);
    expect(paths).toEqual(["a/note.txt", "b/note.txt"]);
    // The failure this replaces: both became `note.txt`.
    expect(new Set(paths).size).toBe(2);
  });

  it("carries each file's own size, in the order it was dropped", async () => {
    const h = capturing();
    h.controller.pickEntries([dropped("x/one.bin", 11), dropped("y/two.bin", 22), dropped("z/three.bin", 33)]);
    await h.controller.send();
    expect(h.seen[0]).toEqual([
      { path: "x/one.bin", size: 11 },
      { path: "y/two.bin", size: 22 },
      { path: "z/three.bin", size: 33 },
    ]);
  });

  it("shows the same paths it will send", () => {
    const h = capturing();
    h.controller.pickEntries([dropped("docs/note.txt", 3)]);
    // The preview reads the entry, not the File: reading it back off the File
    // would show a flat list that disagreed with the manifest.
    expect(h.controller.picked.map((entry) => entry.path)).toEqual(["docs/note.txt"]);
    expect(h.controller.files).toHaveLength(1);
    expect(h.controller.totalBytes).toBe(3);
  });

  it("leaves the ordinary picker behaving exactly as before", async () => {
    const h = capturing();
    // `webkitRelativePath` is empty for a plain file pick, so the leaf name is
    // the path — unchanged from before this fix.
    h.controller.pick([new File([new Uint8Array(4)], "plain.bin")]);
    await h.controller.send();
    expect(h.seen[0]).toEqual([{ path: "plain.bin", size: 4 }]);
  });
});
