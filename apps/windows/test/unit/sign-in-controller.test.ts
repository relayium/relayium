// The renderer's sign-in lifecycle, driven directly.
//
// This is the class `App.svelte` constructs and calls — not a replica of it.
// The component's `<script>` holds a phase variable, a subscription and markup;
// every timer, generation fence and deadline under test here is the one that
// ships.
//
// Timers and the clock are injected, so each case drives an exact interleaving
// with barriers instead of waiting for real time. The bug these exist for: a
// `cancel` that cleared timers and assigned "signed out" while a poll was still
// in flight, whose late `ok` then signed the user in anyway.

import { describe, expect, it } from "vitest";
import {
  SignInController,
  type AppInfoView,
  type CancelResult,
  type Phase,
  type SignInBridge,
} from "../../src/renderer/sign-in-controller.js";
import type { AuthState } from "../../src/shared/ipc-contract.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

const INFO: AppInfoView = { origin: "https://relayium.com", version: "0.0.1", banner: null };
const SIGNED_OUT: AuthState = { signedIn: false, accountEmail: "", store: "ok" };
const SIGNED_IN: AuthState = { signedIn: true, accountEmail: "a@b.c", store: "ok" };

interface Scheduled {
  readonly fn: () => void;
  readonly ms: number;
  readonly kind: "timeout" | "interval";
  cancelled: boolean;
}

/**
 * A controller plus the levers a test needs: a manual clock, a manual timer
 * queue, and per-call barriers on the bridge.
 */
function drive(
  over: Partial<SignInBridge["auth"]> = {},
  options: { state?: () => Promise<AuthState> } = {},
) {
  const phases: Phase[] = [];
  const scheduled: Scheduled[] = [];
  let time = 1_000_000;
  const calls = { start: 0, poll: 0, cancel: 0, state: 0 };
  const cancelledNonces: string[] = [];
  let nonceSeq = 0;

  const base: SignInBridge["auth"] = {
    start: async () => ({
      attemptNonce: "n1",
      userCode: "WDJB-MJHT",
      interval: 5,
      expiresIn: 600,
    }),
    poll: async () => ({ status: "authorization_pending" }),
    cancel: async () => ({ state: SIGNED_OUT, cleanupFailure: null }) satisfies CancelResult,
    signOut: async () => undefined,
    state: options.state ?? (async () => SIGNED_OUT),
    ...over,
  };

  // Counting wraps the FINAL implementation, override or not. Counting inside
  // the defaults instead would silently report zero for every case that
  // substitutes a held call — which is most of them.
  const auth: SignInBridge["auth"] = {
    ...base,
    start: (payload) => {
      calls.start += 1;
      return base.start(payload);
    },
    poll: (payload) => {
      calls.poll += 1;
      return base.poll(payload);
    },
    cancel: (payload) => {
      calls.cancel += 1;
      cancelledNonces.push(payload.nonce);
      return base.cancel(payload);
    },
    state: () => {
      calls.state += 1;
      return base.state();
    },
  };

  const controller = new SignInController({
    bridge: { appInfo: async () => INFO, auth },
    onPhase: (p) => phases.push(p),
    onInfo: () => undefined,
    now: () => time,
    newNonce: () => `nonce-${++nonceSeq}`,
    setTimer: (fn, ms) => {
      scheduled.push({ fn, ms, kind: "timeout", cancelled: false });
      return scheduled.length - 1;
    },
    clearTimer: (h) => {
      const entry = scheduled[h as number];
      if (entry) entry.cancelled = true;
    },
    setInterval: (fn, ms) => {
      scheduled.push({ fn, ms, kind: "interval", cancelled: false });
      return scheduled.length - 1;
    },
    clearInterval: (h) => {
      const entry = scheduled[h as number];
      if (entry) entry.cancelled = true;
    },
  });

  return {
    controller,
    phases,
    calls,
    cancelledNonces,
    advance: (ms: number) => {
      time += ms;
    },
    live: (kind: Scheduled["kind"]) => scheduled.filter((s) => !s.cancelled && s.kind === kind),
    /** Fire the newest live timer of a kind, as the event loop would. */
    fire: (kind: Scheduled["kind"]) => {
      const entry = [...scheduled].reverse().find((s) => !s.cancelled && s.kind === kind);
      if (!entry) throw new Error(`no live ${kind} to fire`);
      if (entry.kind === "timeout") entry.cancelled = true;
      entry.fn();
    },
  };
}

describe("a cancelled sign-in cannot be completed by a late response", () => {
  // The exact defect, reproduced against the shipping lifecycle: the poll is
  // held, the user cancels, and the poll then returns success.
  //
  // The backing state deliberately FLIPS to signed-in when that late success
  // lands, modelling a main process that adopted anyway. Without it the test
  // would pass on a stub that never changed, which proves nothing — the whole
  // failure mode is a late `ok` reaching `refresh()` and reading a signed-in
  // account back.
  it("refuses a poll success that lands after cancel", async () => {
    const held = deferred<{ status: string }>();
    let backendSignedIn = false;
    const d = drive(
      { poll: () => held.promise },
      { state: async () => (backendSignedIn ? SIGNED_IN : SIGNED_OUT) },
    );

    await d.controller.signIn();
    d.fire("timeout"); // the scheduled poll runs and blocks on the barrier
    await settle();

    await d.controller.cancel();
    expect(d.controller.phase).toEqual({ kind: "signedOut" });
    const stateReadsAtCancel = d.calls.state;

    backendSignedIn = true;
    held.resolve({ status: "ok" });
    await settle();

    expect(d.controller.phase).toEqual({ kind: "signedOut" });
    // It did not reach for authoritative state on behalf of a dead attempt.
    expect(d.calls.state).toBe(stateReadsAtCancel);
    expect(d.calls.cancel).toBe(1);
  });

  // The second half of the same defect: a late `pending` re-armed the loop, so
  // a cancelled attempt kept polling a code nobody was watching.
  it("does not reschedule a poll whose pending result lands after cancel", async () => {
    const held = deferred<{ status: string }>();
    const d = drive({ poll: () => held.promise });

    await d.controller.signIn();
    d.fire("timeout");
    await settle();
    await d.controller.cancel();

    held.resolve({ status: "authorization_pending" });
    await settle();

    expect(d.live("timeout")).toHaveLength(0);
    expect(d.live("interval")).toHaveLength(0);
  });

  it("does not show a failure from a poll that rejects after cancel", async () => {
    const held = deferred<{ status: string }>();
    const d = drive({ poll: () => held.promise });

    await d.controller.signIn();
    d.fire("timeout");
    await settle();
    await d.controller.cancel();

    held.reject(new Error("network went away"));
    await settle();

    expect(d.controller.phase).toEqual({ kind: "signedOut" });
  });

  // Cancel has to work here, which is why the nonce is minted before the call.
  it("cancels an attempt whose start has not returned yet", async () => {
    const held = deferred<{
      attemptNonce: string;
      userCode: string;
      interval: number;
      expiresIn: number;
    }>();
    const d = drive({ start: () => held.promise });

    const signingIn = d.controller.signIn();
    await settle();
    expect(d.controller.phase).toEqual({ kind: "starting" });

    await d.controller.cancel();
    expect(d.controller.phase).toEqual({ kind: "signedOut" });

    held.resolve({ attemptNonce: "nonce-1", userCode: "AAAA", interval: 5, expiresIn: 600 });
    await signingIn;
    await settle();

    // No waiting screen for an attempt the user abandoned, and no timers armed.
    expect(d.controller.phase).toEqual({ kind: "signedOut" });
    expect(d.live("timeout")).toHaveLength(0);
    expect(d.live("interval")).toHaveLength(0);
    // Named twice: once by the cancel itself, once by the late start in case
    // the cancel overtook the start on the way to main.
    expect(d.cancelledNonces).toEqual(["nonce-1", "nonce-1"]);
  });

  it("does not show a failure from a start that rejects after cancel", async () => {
    const held = deferred<never>();
    const d = drive({ start: () => held.promise });

    const signingIn = d.controller.signIn();
    await settle();
    await d.controller.cancel();

    held.reject(new Error("start failed"));
    await signingIn;
    await settle();

    expect(d.controller.phase).toEqual({ kind: "signedOut" });
  });

  it("renders the truth when the adoption legitimately beat the click", async () => {
    const d = drive({
      cancel: async () => ({ state: SIGNED_IN, cleanupFailure: null }),
    });
    await d.controller.signIn();
    await d.controller.cancel();
    // Not a fabricated "signed out": main says a credential is held, and
    // claiming otherwise would be corrected by the next refresh anyway.
    expect(d.controller.phase).toEqual({ kind: "signedIn", accountEmail: "a@b.c" });
  });

  it("reports a cancellation whose cleanup failed as a failure", async () => {
    const d = drive({
      cancel: async () => ({
        state: SIGNED_IN,
        cleanupFailure: "cancelled sign-in could not remove the credential it wrote: disk went away",
      }),
    });
    await d.controller.signIn();
    await d.controller.cancel();
    expect(d.controller.phase).toMatchObject({
      kind: "failed",
      message: /could not remove the credential/ as unknown as string,
    });
  });

  it("shows a failure rather than success when main's cancellation errors", async () => {
    const d = drive({
      cancel: async () => {
        throw new Error("ipc gone");
      },
    });
    await d.controller.signIn();
    await d.controller.cancel();
    expect(d.controller.phase.kind).toBe("failed");
  });
});

describe("one starting action at a time", () => {
  it("does not open a second device code while a start is in flight", async () => {
    const held = deferred<{
      attemptNonce: string;
      userCode: string;
      interval: number;
      expiresIn: number;
    }>();
    const d = drive({ start: () => held.promise });

    const first = d.controller.signIn();
    await settle();
    await d.controller.signIn(); // returns immediately, does nothing
    expect(d.calls.start).toBe(1);

    held.resolve({ attemptNonce: "nonce-1", userCode: "AAAA", interval: 5, expiresIn: 600 });
    await first;
    await settle();
    // And a click on the waiting screen is refused too.
    await d.controller.signIn();
    expect(d.calls.start).toBe(1);
  });
});

describe("the deadline is actual time, not a tick count", () => {
  it("computes the remaining seconds from the clock", async () => {
    const d = drive();
    await d.controller.signIn();

    // One countdown tick, but ten seconds of real time — a throttled or starved
    // interval must not report 599 here.
    d.advance(10_000);
    d.fire("interval");
    expect(d.controller.phase).toMatchObject({ kind: "waiting", secondsLeft: 590 });
  });

  it("expires on the clock even when the countdown was starved", async () => {
    const d = drive();
    await d.controller.signIn();

    d.advance(601_000);
    d.fire("interval");

    expect(d.controller.phase).toMatchObject({ kind: "failed" });
    expect(d.live("timeout")).toHaveLength(0);
    expect(d.live("interval")).toHaveLength(0);
    // Main is told, so the attempt does not sit there pollable until it lapses.
    expect(d.calls.cancel).toBe(1);
  });

  it("does not issue a poll for a code that has already expired", async () => {
    const d = drive();
    await d.controller.signIn();

    d.advance(601_000);
    d.fire("timeout"); // the poll timer wins the race against the countdown

    expect(d.calls.poll).toBe(0);
    expect(d.controller.phase).toMatchObject({ kind: "failed" });
  });
});

describe("teardown", () => {
  it("abandons the attempt in main, not merely its own timers", async () => {
    const d = drive();
    await d.controller.signIn();

    d.controller.dispose();

    expect(d.live("timeout")).toHaveLength(0);
    expect(d.live("interval")).toHaveLength(0);
    expect(d.cancelledNonces).toEqual(["nonce-1"]);
  });

  it("publishes nothing after disposal", async () => {
    const held = deferred<{ status: string }>();
    const d = drive({ poll: () => held.promise });

    await d.controller.signIn();
    d.fire("timeout");
    await settle();
    const before = d.phases.length;

    d.controller.dispose();
    held.resolve({ status: "ok" });
    await settle();

    expect(d.phases).toHaveLength(before);
    expect(d.controller.phase.kind).toBe("waiting");
  });
});

describe("ordinary outcomes still work", () => {
  it("polls on the server's interval until it succeeds, then reflects state", async () => {
    let calls = 0;
    const d = drive(
      {
        poll: async () => {
          calls += 1;
          return calls === 1 ? { status: "authorization_pending" } : { status: "ok" };
        },
        state: async () => SIGNED_IN,
      },
    );

    await d.controller.signIn();
    expect(d.live("timeout")[0]?.ms).toBe(5000);

    d.fire("timeout");
    await settle();
    expect(d.controller.phase.kind).toBe("waiting");

    d.fire("timeout");
    await settle();
    expect(d.controller.phase).toEqual({ kind: "signedIn", accountEmail: "a@b.c" });
    expect(d.live("timeout")).toHaveLength(0);
    expect(d.live("interval")).toHaveLength(0);
  });

  it("reports a declined sign-in and stops", async () => {
    const d = drive({ poll: async () => ({ status: "denied" }) });
    await d.controller.signIn();
    d.fire("timeout");
    await settle();
    expect(d.controller.phase).toMatchObject({ kind: "failed" });
    expect(d.live("timeout")).toHaveLength(0);
  });

  it("shows a store problem instead of an unusable Sign in button", async () => {
    const d = drive({}, { state: async () => ({ signedIn: false, accountEmail: "", store: "unavailable" }) });
    await d.controller.refresh();
    expect(d.controller.phase).toEqual({ kind: "storeProblem", health: "unavailable" });
  });
});

describe("a disposed controller does nothing at all", () => {
  it("does not mint a nonce or call main after disposal", async () => {
    const d = drive();
    d.controller.dispose();

    await d.controller.signIn();
    await d.controller.cancel();
    await d.controller.signOut();
    await d.controller.refresh();

    expect(d.calls.start).toBe(0);
    expect(d.calls.poll).toBe(0);
    expect(d.calls.state).toBe(0);
    // Only the one dispose fired, and only when there was an attempt to abandon.
    expect(d.calls.cancel).toBe(0);
  });

  it("abandons an attempt exactly once", async () => {
    const d = drive();
    await d.controller.signIn();
    d.controller.dispose();
    d.controller.dispose();
    expect(d.cancelledNonces).toEqual(["nonce-1"]);
  });
});

describe("the countdown reflects main's remaining deadline", () => {
  // `authStart` returns what is LEFT after the browser open, so the shell cannot
  // show minutes remaining on a code main has already stopped accepting.
  it("counts down from the remaining seconds main reported", async () => {
    const d = drive({
      start: async () => ({
        attemptNonce: "n",
        userCode: "AAAA",
        interval: 5,
        expiresIn: 30,
      }),
    });
    await d.controller.signIn();
    expect(d.controller.phase).toMatchObject({ kind: "waiting", secondsLeft: 30 });

    d.advance(31_000);
    d.fire("interval");
    expect(d.controller.phase).toMatchObject({ kind: "failed" });
  });
});
