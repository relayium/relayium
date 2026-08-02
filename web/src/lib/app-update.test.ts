import { describe, it, expect, vi, afterEach } from "vitest";
import {
  appUpdateVisible,
  appUpdatePending,
  appUpdateReloadReady,
  markAppUpdatePending,
  markAppUpdateReloadReady,
  refreshBlocked,
  applyAppUpdate,
  holdRefresh,
  refreshHeld,
  refreshHolds,
  setReloadForTest,
  resetAppUpdate,
} from "./app-update.svelte";

afterEach(() => resetAppUpdate());

describe("update lifecycle", () => {
  it("starts clean: a freshly loaded page claims no update", () => {
    expect(appUpdateVisible()).toBe(false);
    expect(appUpdatePending()).toBe(false);
    expect(appUpdateReloadReady()).toBe(false);
  });

  // The whole point of the middle stage: the user is told, but refreshing would
  // not get them the new build (the old worker is still the one answering
  // navigations) and would cancel whatever is holding activation back.
  it("an installed-but-waiting build is visible and NOT refreshable", () => {
    markAppUpdatePending();
    expect(appUpdateVisible()).toBe(true);
    expect(appUpdatePending()).toBe(true);
    expect(appUpdateReloadReady()).toBe(false);
  });

  it("only a new worker taking control makes the reload ready", () => {
    markAppUpdatePending();
    markAppUpdateReloadReady();
    expect(appUpdateVisible()).toBe(true);
    expect(appUpdatePending()).toBe(false);
    expect(appUpdateReloadReady()).toBe(true);
  });

  it("goes straight to ready when control changes without a pending notice first", () => {
    markAppUpdateReloadReady();
    expect(appUpdateVisible()).toBe(true);
    expect(appUpdateReloadReady()).toBe(true);
  });

  it("is idempotent — repeated signals for the same update stay one stage", () => {
    markAppUpdatePending();
    markAppUpdatePending();
    expect(appUpdatePending()).toBe(true);
    markAppUpdateReloadReady();
    markAppUpdateReloadReady();
    expect(appUpdateReloadReady()).toBe(true);
  });

  // The stage tracks the NEWEST deployment this page has seen, not a one-way
  // trip. A build installing behind a live one has to take the action away
  // again: it is typically held in `waiting` by a download that a reload would
  // kill, and the reload would land on the older build regardless.
  it("falls back from ready to pending when a further build installs", () => {
    markAppUpdateReloadReady();

    markAppUpdatePending();

    expect(appUpdateVisible()).toBe(true);
    expect(appUpdatePending()).toBe(true);
    expect(appUpdateReloadReady()).toBe(false);
  });

  it("walks the full two-deploy path a long-lived tab actually sees", () => {
    markAppUpdatePending(); // B installs
    markAppUpdateReloadReady(); // B takes control — refresh leads to B
    markAppUpdatePending(); // C installs behind it, held back
    expect(appUpdateReloadReady()).toBe(false);
    markAppUpdateReloadReady(); // C takes control
    expect(appUpdateReloadReady()).toBe(true);
  });
});

describe("refreshBlocked", () => {
  it("blocks while no update has taken control, even with nothing else going on", () => {
    expect(refreshBlocked(false, 0)).toBe(true);
    markAppUpdatePending();
    expect(refreshBlocked(false, 0)).toBe(true);
  });

  it("allows a refresh only once the new build is in control and nothing would be destroyed", () => {
    markAppUpdateReloadReady();
    expect(refreshBlocked(false, 0)).toBe(false);
  });

  it("blocks while the workspace warns on leave (live link / transfer / message session)", () => {
    markAppUpdateReloadReady();
    expect(refreshBlocked(true, 0)).toBe(true);
  });

  // Queued files exist only in memory: a reload drops them with no prompt, so
  // "refresh is safe now" would be a false claim.
  it("blocks while files are still queued in the outbox", () => {
    markAppUpdateReloadReady();
    expect(refreshBlocked(false, 1)).toBe(true);
    expect(refreshBlocked(false, 7)).toBe(true);
  });

  // The workspace signals see nothing of a stored download or upload: those run
  // with no peer at all, which is precisely the state the other three blockers
  // read as "safe to refresh".
  it("blocks while a local operation holds the guard, with the workspace idle", () => {
    markAppUpdateReloadReady();
    const release = holdRefresh();
    expect(refreshBlocked(false, 0)).toBe(true);
    release();
    expect(refreshBlocked(false, 0)).toBe(false);
  });
});

describe("holdRefresh", () => {
  it("starts clean and reports its own count", () => {
    expect(refreshHeld()).toBe(false);
    expect(refreshHolds()).toBe(0);
  });

  // Overlapping work is normal: an upload in one panel while a stored download
  // runs. The action must only come back when the LAST one lets go.
  it("reference-counts, so nested operations do not release each other's hold", () => {
    const a = holdRefresh();
    const b = holdRefresh();
    expect(refreshHolds()).toBe(2);

    a();
    expect(refreshHeld()).toBe(true); // b is still running
    expect(refreshHolds()).toBe(1);

    b();
    expect(refreshHeld()).toBe(false);
    expect(refreshHolds()).toBe(0);
  });

  // Callers release from a `finally` and sometimes from an error path as well;
  // a second call must not steal somebody else's hold.
  it("release is idempotent — no underflow, no stealing another hold", () => {
    const a = holdRefresh();
    a();
    a();
    a();
    expect(refreshHolds()).toBe(0);

    const b = holdRefresh();
    a(); // the spent release must not touch b
    expect(refreshHeld()).toBe(true);
    expect(refreshHolds()).toBe(1);
    b();
    expect(refreshHolds()).toBe(0);
  });

  it("releases in any order", () => {
    const a = holdRefresh();
    const b = holdRefresh();
    b();
    expect(refreshHeld()).toBe(true);
    a();
    expect(refreshHeld()).toBe(false);
  });

  // A test that leaves a hold outstanding would otherwise wedge the button for
  // every test after it, including in other files.
  it("is cleared by resetAppUpdate, so no test can leak a hold", () => {
    holdRefresh();
    holdRefresh();
    resetAppUpdate();
    expect(refreshHolds()).toBe(0);
    expect(refreshHeld()).toBe(false);
  });

  // The dangerous half of a reset: it zeroes the counter but cannot reach the
  // release closures already handed out. A component torn down by a test, or an
  // operation genuinely still in flight, runs its `finally` afterwards. Without
  // a generation that stale release cancels a hold it never took — and the
  // victim is whatever real work started after the reset.
  it("ignores a release created before a reset, without touching holds taken after it", () => {
    const stale = holdRefresh();
    resetAppUpdate();

    const fresh = holdRefresh(); // a real download starts after the reset
    expect(refreshHolds()).toBe(1);

    stale(); // the old operation's finally finally runs
    expect(refreshHolds(), "the stale release must not cancel the new hold").toBe(1);
    expect(refreshHeld(), "reporting false here would unblock a live download").toBe(true);
    markAppUpdateReloadReady();
    expect(refreshBlocked(false, 0)).toBe(true);

    fresh();
    expect(refreshHolds()).toBe(0);
    expect(refreshBlocked(false, 0)).toBe(false);
  });

  it("never goes negative, even with several stale releases and nothing held", () => {
    const a = holdRefresh();
    const b = holdRefresh();
    resetAppUpdate();

    a();
    b();
    a();

    expect(refreshHolds()).toBe(0);
    expect(refreshHeld()).toBe(false);
  });

  it("keeps working normally across a reset", () => {
    holdRefresh();
    resetAppUpdate();
    const release = holdRefresh();
    expect(refreshHeld()).toBe(true);
    release();
    expect(refreshHeld()).toBe(false);
  });
});

describe("applyAppUpdate", () => {
  it("refuses to reload before any update exists", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  // The disabled button is not the only way in — this is exported. A reload
  // from the pending stage is exactly the outcome the lifecycle exists to
  // prevent: it would kill the streaming download that is holding activation
  // back, and hand the same stale build back anyway.
  it("refuses to reload while the update is installed but not in control", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    markAppUpdatePending();
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  // The same gate has to close again when a further build installs behind the
  // one that took control — otherwise a programmatic apply during C's wait
  // kills the download and lands on B.
  it("refuses again once a further build is waiting behind the live one", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    markAppUpdateReloadReady();
    markAppUpdatePending();
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once the new build is in control", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    markAppUpdateReloadReady();
    expect(applyAppUpdate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Defence in depth: the guard is global, so this must hold even for a caller
  // that knows nothing about the stored upload/download running elsewhere.
  it("refuses while a local operation holds the guard, even called bare", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    markAppUpdateReloadReady();
    const release = holdRefresh();

    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    release();
    expect(applyAppUpdate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The caller-owned halves are enforced here too, so a caller that passes them
  // gets one predicate instead of two that can drift.
  it("refuses on the caller-supplied blockers as well", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    markAppUpdateReloadReady();

    expect(applyAppUpdate(true, 0)).toBe(false);
    expect(applyAppUpdate(false, 1)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    expect(applyAppUpdate(false, 0)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Never on its own: every reload in this module is the user pressing Refresh.
  it("does not reload as a side effect of an update being announced", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    markAppUpdatePending();
    markAppUpdateReloadReady();
    expect(reload).not.toHaveBeenCalled();
  });
});
