// The update facade: what it may reduce, admit and claim.
//
// SCOPE: the core is a structural stand-in. These are composition assertions —
// did a read run after a teardown, did a failed residue read look clean, did a
// terminal state offer a retry — and the real core is separately accepted and
// proven on Windows. Nothing here re-proves the feed, the staging or the
// publisher check.

import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../src/main/update/state.js";
import {
  UpdateSummaryService,
  checkAllowed,
  terminalState,
  reasonOf,
  releaseNotesUrl,
  type UpdateCore,
  type UpdateSummaryDeps,
} from "../../src/main/features/update-summary.js";
import {
  UPDATE_STATE_KINDS,
  type UpdateSummaryView,
} from "../../src/shared/update-summary.js";
import { FEED_URL } from "../../src/main/update/trust.js";

const FEED_ORIGIN = new URL(FEED_URL).origin;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const facts = (over: Partial<{ notesUrl: string | null; sha256: string | null }> = {}) => ({
  version: "1.4.0",
  build: 1400,
  sizeBytes: 8_000_000,
  notesUrl: `${FEED_ORIGIN}/apps/windows/notes/1.4.0`,
  sha256: "a".repeat(64),
  ...over,
});

/** A core whose every call is observable and holdable. */
function fakeCore(initial: UpdateState = { kind: "idle", lastCheckedAt: null }) {
  const calls = {
    check: 0, download: 0, install: 0, reveal: 0,
    reverify: 0, residue: 0, due: 0, quiesce: 0, resume: 0,
  };
  const holds = { action: null as Promise<void> | null, residue: null as Promise<void> | null };
  const answers = {
    residue: [] as { owned: boolean }[],
    residueThrows: false,
    quiesceJoined: true,
    next: null as UpdateState | null,
  };
  let state = initial;
  const listeners = new Set<(s: UpdateState) => void>();
  const settle = async (label: keyof typeof calls): Promise<UpdateState> => {
    calls[label] += 1;
    if (holds.action) await holds.action;
    if (answers.next !== null) {
      state = answers.next;
      for (const l of [...listeners]) l(state);
    }
    return state;
  };
  const core: UpdateCore = {
    get current() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: () => settle("check"),
    download: () => settle("download"),
    install: () => settle("install"),
    reveal: () => settle("reveal"),
    reverifyStaged: () => settle("reverify"),
    async residue() {
      calls.residue += 1;
      if (holds.residue) await holds.residue;
      if (answers.residueThrows) throw new Error("journal unreadable");
      return answers.residue as never;
    },
    async automaticCheckDue() {
      calls.due += 1;
      return true;
    },
    async quiesce() {
      calls.quiesce += 1;
      return { joined: answers.quiesceJoined };
    },
    resume() {
      calls.resume += 1;
    },
  };
  return {
    core, calls, holds, answers,
    push(next: UpdateState) {
      state = next;
      for (const l of [...listeners]) l(state);
    },
    listenerCount: () => listeners.size,
  };
}

function harness(over: Partial<UpdateSummaryDeps> = {}, initial?: UpdateState) {
  const fake = fakeCore(initial);
  const views: UpdateSummaryView[] = [];
  const failures: unknown[] = [];
  const opened: string[] = [];
  const service = new UpdateSummaryService({
    core: fake.core,
    currentVersion: "1.3.9",
    onView: (view) => views.push(view),
    reportFailure: (err) => failures.push(err),
    openExternal: async (url) => {
      opened.push(url);
      return true;
    },
    ...over,
  });
  return { service, views, failures, opened, ...fake };
}

describe("the reduction keeps all eighteen kinds", () => {
  it("maps every kind one for one", () => {
    const candidate = facts();
    const states: UpdateState[] = [
      { kind: "disabled", reason: "no-pin" },
      { kind: "idle", lastCheckedAt: 1 },
      { kind: "checking" },
      { kind: "up-to-date", checkedAt: 2 },
      { kind: "check-failed", reason: "network", retryable: true },
      { kind: "feed-untrusted", detail: "a raw detail string" },
      { kind: "update-available", candidate },
      { kind: "downloading", candidate, receivedBytes: 10 },
      { kind: "verify-failed", candidate, reason: "integrity" },
      { kind: "ready", candidate },
      { kind: "ready-unsigned", candidate },
      { kind: "publisher-mismatch", candidate },
      { kind: "verifier-unavailable", candidate },
      { kind: "installing", candidate },
      { kind: "install-deferred", candidate, reason: "no-consent-adapter" },
      { kind: "revealed", candidate },
      { kind: "journal-unavailable", reason: "corrupt" },
      { kind: "blocked", reason: "unresolved-residue", count: 4, detail: "a raw detail string" },
    ];
    expect(states.length).toBe(18);
    expect(UPDATE_STATE_KINDS.length).toBe(18);
    const h = harness();
    const seen: string[] = [];
    for (const state of states) {
      h.push(state);
      seen.push(h.service.view().state.kind);
    }
    expect(seen).toEqual([...UPDATE_STATE_KINDS]);
  });

  it("drops every free-form detail rather than carrying it", () => {
    const h = harness();
    h.push({ kind: "feed-untrusted", detail: "SECRET-C:\\path\\leak" });
    expect(JSON.stringify(h.service.view())).not.toContain("SECRET");
    h.push({ kind: "blocked", reason: "staging-unowned", count: 1, detail: "SECRET-nonce" });
    expect(JSON.stringify(h.service.view())).not.toContain("SECRET");
  });

  it("maps an adapter's own reason string to a closed code", () => {
    // `QuiesceDecision.granted:false` carries a string the HOST chose.
    expect(reasonOf("the resident lane said no because C:\\x")).toBe("other");
    expect(reasonOf("not-resumed:lease detail with a path")).toBe("not-resumed");
    expect(reasonOf("no-consent-adapter")).toBe("no-consent-adapter");
    expect(reasonOf(undefined)).toBe("other");
    expect(reasonOf(42)).toBe("other");
  });

  it("carries the core's byte count verbatim", () => {
    const h = harness();
    h.push({ kind: "downloading", candidate: facts(), receivedBytes: 4_000_000 });
    const state = h.service.view().state;
    if (state.kind !== "downloading") throw new Error("expected downloading");
    expect(state.receivedBytes).toBe(4_000_000);
    expect(state.candidate.sizeBytes).toBe(8_000_000);
  });
});

describe("release notes", () => {
  it("accepts only https on the feed origin without credentials", () => {
    expect(releaseNotesUrl(`${FEED_ORIGIN}/notes`, FEED_URL)).toBe(`${FEED_ORIGIN}/notes`);
    expect(releaseNotesUrl(`http://${new URL(FEED_URL).host}/notes`, FEED_URL)).toBeNull();
    expect(releaseNotesUrl("https://evil.test/notes", FEED_URL)).toBeNull();
    expect(releaseNotesUrl(`https://u:p@${new URL(FEED_URL).host}/notes`, FEED_URL)).toBeNull();
    expect(releaseNotesUrl(null, FEED_URL)).toBeNull();
    expect(releaseNotesUrl("not a url", FEED_URL)).toBeNull();
  });

  it("publishes hasNotes as a boolean and never the address", () => {
    const h = harness();
    h.push({ kind: "update-available", candidate: facts() });
    const state = h.service.view().state;
    if (state.kind !== "update-available") throw new Error("expected available");
    expect(state.candidate.hasNotes).toBe(true);
    expect(JSON.stringify(h.service.view())).not.toContain("/apps/windows/notes");
  });

  it("reports no notes for an address it will not open", () => {
    const h = harness();
    h.push({ kind: "update-available", candidate: facts({ notesUrl: "https://evil.test/x" }) });
    const state = h.service.view().state;
    if (state.kind !== "update-available") throw new Error("expected available");
    expect(state.candidate.hasNotes).toBe(false);
    expect(h.service.view().actions.canOpenNotes).toBe(false);
  });

  it("opens the held address for the closed token, and nothing else", async () => {
    const h = harness();
    h.push({ kind: "update-available", candidate: facts() });
    await expect(h.service.openExternal("release-notes")).resolves.toBe(true);
    expect(h.opened).toEqual([`${FEED_ORIGIN}/apps/windows/notes/1.4.0`]);
    await expect(h.service.openExternal("https://evil.test" as never)).resolves.toBe(false);
    expect(h.opened.length).toBe(1);
  });
});

describe("terminal states offer no check", () => {
  it("refuses a check from every terminal trust outcome", () => {
    // All four are trust decisions. Re-offering a check after one would relax it
    // to avoid a dead-looking screen, which is the wrong trade here: recovery is
    // a restart or a reconfiguration, not a button.
    for (const state of [
      { kind: "disabled", reason: "no-pin" },
      { kind: "feed-untrusted", detail: null },
      { kind: "publisher-mismatch", candidate: facts() },
      { kind: "verifier-unavailable", candidate: facts() },
    ] as UpdateState[]) {
      expect({ kind: state.kind, check: checkAllowed(state) }).toEqual({ kind: state.kind, check: false });
      expect(terminalState(state)).toBe(true);
    }
    expect(checkAllowed({ kind: "check-failed", reason: "untrusted", retryable: false })).toBe(false);
    expect(checkAllowed({ kind: "check-failed", reason: "network", retryable: true })).toBe(true);
    expect(terminalState({ kind: "idle", lastCheckedAt: null })).toBe(false);
  });

  it("offers no affordance at all from publisher-mismatch or verifier-unavailable", async () => {
    for (const kind of ["publisher-mismatch", "verifier-unavailable"] as const) {
      const h = harness();
      h.push({ kind, candidate: facts() });
      const actions = h.service.view().actions;
      expect({ kind, ...actions }).toEqual({
        kind,
        canCheck: false,
        canDownload: false,
        canInstall: false,
        canReveal: false,
        canOpenNotes: actions.canOpenNotes,
        busy: false,
      });
      // And the gate is enforced, not merely advertised.
      await h.service.act("check");
      await h.service.act("download");
      await h.service.act("install");
      await h.service.act("reveal");
      expect({ kind, ...h.calls }).toMatchObject({ kind, check: 0, download: 0, install: 0, reveal: 0 });
    }
  });

  it("refuses the AUTOMATIC check from a terminal state too", async () => {
    for (const kind of ["publisher-mismatch", "verifier-unavailable"] as const) {
      const h = harness();
      h.push({ kind, candidate: facts() });
      // A daily timer that re-checked would relax the same decision, quietly.
      expect(await h.service.automaticCheckDue()).toBe(false);
      expect(h.calls.due).toBe(0);
      await h.service.act("check", "automatic");
      expect(h.calls.check).toBe(0);
    }
    const ok = harness();
    ok.push({ kind: "idle", lastCheckedAt: null });
    expect(await ok.service.automaticCheckDue()).toBe(true);
  });

  it("neither offers nor performs a check from feed-untrusted", async () => {
    const h = harness();
    h.push({ kind: "feed-untrusted", detail: null });
    expect(h.service.view().actions.canCheck).toBe(false);
    await h.service.act("check");
    expect(h.calls.check).toBe(0);
  });

  it("neither offers nor performs a check from a non-retryable failure", async () => {
    const h = harness();
    h.push({ kind: "check-failed", reason: "untrusted", retryable: false });
    expect(h.service.view().actions.canCheck).toBe(false);
    await h.service.act("check");
    expect(h.calls.check).toBe(0);
  });
});

describe("action gates come from the core's predicates", () => {
  it("installs only from ready and reveals only from ready-unsigned", async () => {
    const h = harness();
    for (const kind of ["update-available", "ready-unsigned", "verifier-unavailable", "installing"] as const) {
      h.push({ kind, candidate: facts() } as UpdateState);
      expect(h.service.view().actions.canInstall).toBe(false);
      await h.service.act("install");
    }
    expect(h.calls.install).toBe(0);

    h.push({ kind: "ready", candidate: facts() });
    expect(h.service.view().actions.canInstall).toBe(true);
    await h.service.act("install");
    expect(h.calls.install).toBe(1);

    for (const kind of ["ready", "publisher-mismatch", "verifier-unavailable"] as const) {
      h.push({ kind, candidate: facts() } as UpdateState);
      expect(h.service.view().actions.canReveal).toBe(false);
      await h.service.act("reveal");
    }
    expect(h.calls.reveal).toBe(0);
    h.push({ kind: "ready-unsigned", candidate: facts() });
    await h.service.act("reveal");
    expect(h.calls.reveal).toBe(1);
  });

  it("downloads only from update-available", async () => {
    const h = harness();
    h.push({ kind: "ready", candidate: facts() });
    await h.service.act("download");
    expect(h.calls.download).toBe(0);
    h.push({ kind: "update-available", candidate: facts() });
    await h.service.act("download");
    expect(h.calls.download).toBe(1);
  });

  it("is single-flight: a second action while one runs is refused", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.action = hold.promise;
    const first = h.service.act("check");
    await Promise.resolve();
    expect(h.service.view().actions.busy).toBe(true);
    await h.service.act("check");
    hold.resolve();
    await first;
    expect(h.calls.check).toBe(1);
  });
});

describe("the shipped configuration tells the truth", () => {
  it("disabled/no-pin offers no check and says why", () => {
    const h = harness({}, { kind: "disabled", reason: "no-pin" });
    const view = h.service.view();
    expect(view.state).toEqual({ kind: "disabled", reason: "no-pin" });
    expect(view.actions.canCheck).toBe(false);
    expect(view.actions.canDownload).toBe(false);
    expect(view.actions.canInstall).toBe(false);
    expect(view.actions.canReveal).toBe(false);
  });

  it("keeps the two disabled reasons apart", () => {
    const a = harness({}, { kind: "disabled", reason: "no-pin" }).service.view().state;
    const b = harness({}, { kind: "disabled", reason: "engineering-build" }).service.view().state;
    expect(a).not.toEqual(b);
  });
});

describe("residue never claims a clean installation it did not read", () => {
  it("starts unread rather than zero", () => {
    expect(harness().service.view().residue).toEqual({ kind: "unread" });
  });

  it("reports a failed read as failed, not as nothing outstanding", async () => {
    const h = harness();
    h.answers.residueThrows = true;
    await h.service.refreshResidue();
    // The failure that matters: `{total: 0}` here would hide a blocked
    // installation behind a clean-looking pane.
    expect(h.service.view().residue).toEqual({ kind: "failed" });
    expect(h.failures.length).toBe(1);
  });

  it("counts owned and ambiguous entries when the read succeeds", async () => {
    const h = harness();
    h.answers.residue = [{ owned: true }, { owned: false }, { owned: false }];
    await h.service.refreshResidue();
    expect(h.service.view().residue).toEqual({ kind: "read", total: 3, ambiguous: 2 });
  });
});

describe("admission covers every entry point", () => {
  it("a fence refuses actions and reads without touching the core", async () => {
    const h = harness();
    h.service.fence();
    await h.service.act("check");
    await h.service.refreshResidue();
    await h.service.reverifyStaged();
    expect(await h.service.automaticCheckDue()).toBe(false);
    expect(await h.service.openExternal("release-notes")).toBe(false);
    expect(h.calls).toMatchObject({ check: 0, residue: 0, reverify: 0, due: 0, quiesce: 0 });
    // Nothing was aborted: the fence is the state to be in while a quit prompt
    // is on screen.
    expect(h.calls.quiesce).toBe(0);
  });

  it("nothing calls the core after a quiesce", async () => {
    const h = harness();
    const inventory = await h.service.quiesce();
    expect(inventory.joined).toBe(true);
    await h.service.refreshResidue();
    await h.service.reverifyStaged();
    await h.service.act("check");
    expect(h.calls).toMatchObject({ residue: 0, reverify: 0, check: 0 });
  });

  it("nothing calls the core after a dispose", async () => {
    const h = harness();
    await h.service.dispose();
    await h.service.reverifyStaged();
    await h.service.refreshResidue();
    await h.service.act("download");
    expect(h.calls).toMatchObject({ reverify: 0, residue: 0, download: 0 });
    expect(h.listenerCount()).toBe(0);
  });

  it("resume re-opens admissions", async () => {
    const h = harness();
    h.service.fence();
    await h.service.act("check");
    expect(h.calls.check).toBe(0);
    h.service.resume();
    await h.service.act("check");
    expect(h.calls.check).toBe(1);
    expect(h.calls.resume).toBe(1);
  });
});

describe("teardown joins what it owns", () => {
  it("reports the core's joined verdict verbatim", async () => {
    const h = harness();
    h.answers.quiesceJoined = false;
    // Weaker than "stopped", and reported as such: a quit prompt told
    // "everything stopped" over running work is the failure this prevents.
    expect(await h.service.quiesce()).toEqual({ busy: false, joined: false });
  });

  it("joins an external open the core knows nothing about", async () => {
    const hold = deferred<boolean>();
    let opening = false;
    const h = harness({
      openExternal: () => {
        opening = true;
        return hold.promise;
      },
    });
    h.push({ kind: "update-available", candidate: facts() });
    const open = h.service.openExternal("release-notes");
    await Promise.resolve();
    expect(opening).toBe(true);

    let settled: { busy: boolean; joined: boolean } | null = null;
    const stopping = h.service.quiesce().then((r) => {
      settled = r;
    });
    await Promise.resolve();
    // A teardown that returned `joined` here would be describing half the
    // process: the browser open is still outstanding.
    expect(settled).toBeNull();
    hold.resolve(true);
    await open;
    await stopping;
    expect(settled).toEqual({ busy: true, joined: true });
  });

  it("settles within the caller's budget even while an external open is held", async () => {
    // Root's case. The budget used to bound the CORE only; the external join
    // that followed had no bound at all, so `quiesce(10)` never returned.
    const hold = deferred<boolean>();
    const h = harness({ openExternal: () => hold.promise });
    h.push({ kind: "update-available", candidate: facts() });
    const open = h.service.openExternal("release-notes");
    await Promise.resolve();

    const started = Date.now();
    const inventory = await h.service.quiesce(10);
    const elapsed = Date.now() - started;

    expect(inventory).toEqual({ busy: true, joined: false });
    // An answer, within roughly the budget — not never.
    expect(elapsed).toBeLessThan(2_000);

    // NOT cancelled and NOT untracked: a bounded wait is a statement about this
    // teardown's patience, never about the operation.
    hold.resolve(true);
    await expect(open).resolves.toBe(true);
  });

  it("spends ONE budget across the core and the external join", async () => {
    // Two budgets in sequence would be twice the wait the caller asked for.
    const hold = deferred<boolean>();
    const h = harness({ openExternal: () => hold.promise });
    h.push({ kind: "update-available", candidate: facts() });
    void h.service.openExternal("release-notes");
    await Promise.resolve();
    const started = Date.now();
    await h.service.quiesce(120);
    const elapsed = Date.now() - started;
    // The stand-in core returns immediately, so nearly the whole budget is left
    // for the external join — and the total must still respect it.
    expect(elapsed).toBeLessThan(600);
    hold.resolve(true);
  });

  it("reports joined when the external open settles inside the budget", async () => {
    const hold = deferred<boolean>();
    const h = harness({ openExternal: () => hold.promise });
    h.push({ kind: "update-available", candidate: facts() });
    const open = h.service.openExternal("release-notes");
    await Promise.resolve();
    const stopping = h.service.quiesce(2_000);
    hold.resolve(true);
    await open;
    expect(await stopping).toEqual({ busy: true, joined: true });
  });

  it("is quiet and immediate when nothing is outstanding", async () => {
    const h = harness();
    const started = Date.now();
    expect(await h.service.quiesce(5_000)).toEqual({ busy: false, joined: true });
    // No open, so no wait: the budget is a ceiling, not a delay.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("is single-flight, so a re-entrant teardown joins rather than recurses", async () => {
    const h = harness();
    // The property is one core teardown, not one promise object: `quiesce` is
    // `async`, so it necessarily returns a fresh wrapper each call.
    const [a, b] = await Promise.all([h.service.quiesce(), h.service.quiesce()]);
    expect(h.calls.quiesce).toBe(1);
    expect(a).toEqual(b);
  });
});

describe("observers", () => {
  it("survives one that throws", async () => {
    const failures: unknown[] = [];
    const h = harness({
      onView: () => {
        throw new Error("observer exploded");
      },
      reportFailure: (err) => failures.push(err),
    });
    h.push({ kind: "checking" });
    expect(h.service.view().state.kind).toBe("checking");
    expect(failures.length).toBeGreaterThan(0);
  });

  it("does not call the core when an observer disposes mid-action", async () => {
    let service: UpdateSummaryService | null = null;
    let disposed = false;
    const h = harness({
      onView: () => {
        // Re-entrant teardown from inside the publish that `#run` performs
        // BEFORE it calls the core.
        if (!disposed && service !== null) {
          disposed = true;
          void service.dispose();
        }
      },
    });
    service = h.service;
    await h.service.act("check");
    expect(h.calls.check).toBe(0);
  });

  it("reports a core rejection instead of inventing a state", async () => {
    const h = harness({});
    const broken = { ...h.core, check: () => Promise.reject(new Error("boom")) };
    const svc = new UpdateSummaryService({
      core: broken as UpdateCore,
      currentVersion: "1.3.9",
      reportFailure: (err) => h.failures.push(err),
    });
    const before = svc.view().state.kind;
    await svc.act("check");
    expect(svc.view().state.kind).toBe(before);
    expect(h.failures.length).toBe(1);
  });
});

describe("what a view may carry", () => {
  it("is deep-frozen", () => {
    const h = harness();
    const view = h.service.view();
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view as { currentVersion: string }).currentVersion = "9";
    }).toThrow();
  });

  it("carries no url, path, nonce or adapter string", () => {
    const h = harness();
    h.push({ kind: "install-deferred", candidate: facts(), reason: "not-resumed:C:\\Users\\x\\lease" });
    const serialised = JSON.stringify(h.service.view());
    expect(serialised).not.toContain("C:\\");
    expect(serialised).not.toContain("http");
    const state = h.service.view().state;
    if (state.kind !== "install-deferred") throw new Error("expected deferred");
    expect(state.reason).toBe("not-resumed");
  });
});
