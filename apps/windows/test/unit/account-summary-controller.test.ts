// What the account screen's state object may still write, and when it may not.
//
// These run the REAL rune module — `vitest.config.ts` loads the ordinary Svelte
// plugin and resolves Svelte's browser condition, so `$state` here is the same
// `$state` the packaged renderer runs. A harness that stripped runes would test
// a copy of this object rather than this object.
//
// What they are NOT is a substitute for driving the component. Reactivity that
// compiles is not reactivity that renders, which is what
// `test/smoke/account-details-smoke.mjs` exists for.

import { describe, expect, it, vi } from "vitest";
import {
  AccountSummaryController,
  type AccountRowState,
} from "../../src/renderer/account/account-controller.svelte.js";
import type { AccountSummaryBridge } from "../../src/renderer/account/bridge.js";
import type {
  AccountDeviceView,
  AccountMutationOutcome,
  AccountResendOutcome,
  AccountSummaryView,
} from "../../src/shared/account-summary.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const DEVICE_A: AccountDeviceView = {
  id: "dev-a",
  name: "Office PC",
  kind: "windows",
  createdAt: 1_700_000_000,
  lastSeenAt: 1_780_000_000,
  current: true,
  enrolled: true,
};
const DEVICE_B: AccountDeviceView = { ...DEVICE_A, id: "dev-b", name: "Laptop", current: false };

function makeView(over: Partial<AccountSummaryView> = {}): AccountSummaryView {
  return {
    epoch: 1,
    signedIn: true,
    profile: {
      kind: "ready",
      value: {
        email: "someone@relayium.test",
        displayName: "Someone",
        emailVerified: true,
        hasPassword: true,
        linkedMethods: ["password"],
        planId: "pro",
        subscriptionStatus: "active",
        subscriptionEnd: 1_800_000_000,
        hasBilling: true,
        billingCycle: "monthly",
        scheduledPlanId: "",
        scheduledCycle: "",
        entitlementProvider: "stripe",
        appleRenewal: { available: false },
      },
    },
    usage: { kind: "loading" },
    devices: { kind: "ready", value: [DEVICE_A, DEVICE_B] },
    ...over,
  };
}

interface Harness {
  readonly controller: AccountSummaryController;
  readonly calls: {
    state: number;
    refresh: (string | undefined)[];
    rename: { id: string; name: string }[];
    revoke: string[];
    manage: string[];
    /** A count: the channel carries no argument at all. */
    resend: number;
  };
  readonly holds: {
    state: Promise<void> | null;
    refresh: Promise<void> | null;
    mutate: Promise<void> | null;
  };
  answers: {
    state: AccountSummaryView;
    refresh: AccountSummaryView;
    rename: AccountMutationOutcome;
    revoke: AccountMutationOutcome;
    manage: boolean;
    resend: AccountResendOutcome;
  };
  /** Main pushed a snapshot. */
  push(payload: unknown): void;
  readonly subscriptions: () => number;
}

function harness(): Harness {
  const calls: Harness["calls"] = { state: 0, refresh: [], rename: [], revoke: [], manage: [], resend: 0 };
  const holds: Harness["holds"] = { state: null, refresh: null, mutate: null };
  const answers: Harness["answers"] = {
    state: makeView(),
    refresh: makeView(),
    rename: { kind: "renamed", name: "Renamed" },
    revoke: { kind: "revoked", self: false, signedOut: false },
    manage: true,
    resend: { kind: "requested" },
  };
  const listeners = new Set<(payload: unknown) => void>();

  const bridge: AccountSummaryBridge = {
    async state() {
      calls.state += 1;
      if (holds.state) await holds.state;
      return answers.state;
    },
    async refresh(payload) {
      calls.refresh.push(payload.section);
      if (holds.refresh) await holds.refresh;
      return answers.refresh;
    },
    async rename(payload) {
      calls.rename.push(payload);
      if (holds.mutate) await holds.mutate;
      return answers.rename;
    },
    async revoke(payload) {
      calls.revoke.push(payload.id);
      if (holds.mutate) await holds.mutate;
      return answers.revoke;
    },
    async resendVerification() {
      calls.resend += 1;
      if (holds.mutate) await holds.mutate;
      return answers.resend;
    },
    async manage(payload) {
      calls.manage.push(payload.target);
      return { ok: answers.manage };
    },
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  return {
    controller: new AccountSummaryController(bridge),
    calls,
    holds,
    answers,
    push: (payload) => {
      for (const listener of [...listeners]) listener(payload);
    },
    subscriptions: () => listeners.size,
  };
}

const rowOf = (state: AccountRowState) => `${state.busy ? "busy" : "idle"}:${state.outcome?.kind ?? "-"}`;

describe("ordering", () => {
  it("a push supersedes a read that was already in flight", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.state = hold.promise;
    h.answers.state = makeView({ signedIn: true });
    const loading = h.controller.load();

    // Main speaks while the read is still out — an account change, say.
    h.push(makeView({ epoch: 2, signedIn: false, devices: { kind: "loading" } }));
    expect(h.controller.view.epoch).toBe(2);

    hold.resolve();
    await loading;

    // The older read must not roll the screen back to the previous account.
    expect(h.controller.view.epoch).toBe(2);
    expect(h.controller.view.devices.kind).toBe("loading");
  });

  it("a refresh answer from a previous account is discarded", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.refresh = hold.promise;
    h.answers.refresh = makeView({ epoch: 1 });
    const running = h.controller.refresh("devices");

    h.push(makeView({ epoch: 2, devices: { kind: "loading" } }));
    hold.resolve();
    await running;

    expect(h.controller.view.epoch).toBe(2);
    expect(h.controller.view.devices.kind).toBe("loading");
  });

  it("ignores a malformed push rather than blanking a known view", () => {
    const h = harness();
    h.push(makeView());
    const before = h.controller.view;
    h.push(null);
    h.push("not a view");
    h.push({ epoch: "one" });
    h.push({ epoch: 3 });
    expect(h.controller.view).toBe(before);
  });

  it("takes exactly one subscription and releases it on destroy", () => {
    const h = harness();
    expect(h.subscriptions()).toBe(1);
    h.controller.destroy();
    expect(h.subscriptions()).toBe(0);
  });
});

describe("an account change clears what belonged to the account that left", () => {
  it("drops the draft, the confirmation, the row state and the failure notice", async () => {
    const h = harness();
    h.push(makeView());
    h.controller.beginRename(DEVICE_B);
    h.controller.renameDraft = "Half typed";
    expect(h.controller.prompt).toEqual({ kind: "rename", id: "dev-b" });

    h.answers.rename = { kind: "failed", failure: { kind: "network" } };
    await h.controller.submitRename();
    expect(rowOf(h.controller.rowState("dev-b"))).toBe("idle:failed");

    h.push(makeView({ epoch: 2 }));

    expect(h.controller.prompt).toBeNull();
    expect(h.controller.renameDraft).toBe("");
    expect(h.controller.rows).toEqual({});
    expect(h.controller.manageFailed).toBe(false);
  });

  it("a mutation answering after the change writes nothing", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.mutate = hold.promise;
    h.controller.askRevoke(DEVICE_B);
    const running = h.controller.confirmRevoke();
    expect(h.controller.rowState("dev-b").busy).toBe(true);

    h.push(makeView({ epoch: 2 }));
    hold.resolve();
    await running;

    // Not "finished", not "failed": the row belongs to an account that is gone.
    expect(h.controller.rows).toEqual({});
  });

  it("an open self-revoke confirmation does not survive into another account", () => {
    const h = harness();
    h.push(makeView());
    h.controller.askRevoke(DEVICE_A);
    expect(h.controller.prompt).toEqual({ kind: "revoke", id: "dev-a" });
    h.push(makeView({ epoch: 2 }));
    // A question asked about one account must not be answered against another.
    expect(h.controller.prompt).toBeNull();
  });
});

describe("a completing call cleans up only what it still owns", () => {
  // Both cases are root's, reproduced exactly: an account-A call whose cleanup
  // or whose answer runs AFTER account B has already started its own.
  it("account A's refresh cleanup does not clear account B's reading indicator", async () => {
    const h = harness();
    h.push(makeView({ epoch: 1 }));
    const holdA = deferred();
    h.holds.refresh = holdA.promise;
    const runningA = h.controller.refresh("devices");
    expect(h.controller.refreshing).toEqual(["devices"]);

    // Somebody signs in as somebody else, and the new account starts its own
    // read of the same section.
    h.push(makeView({ epoch: 2 }));
    expect(h.controller.refreshing).toEqual([]);
    const holdB = deferred();
    h.holds.refresh = holdB.promise;
    const runningB = h.controller.refresh("devices");
    expect(h.controller.refreshing).toEqual(["devices"]);

    // A finishes. Its `finally` must not touch B's indicator.
    holdA.resolve();
    await runningA;
    expect(h.controller.refreshing).toEqual(["devices"]);
    // And B must still be the only read: the guard that stops a duplicate is
    // the same list A would have emptied.
    await h.controller.refresh("devices");
    expect(h.calls.refresh).toEqual(["devices", "devices"]);

    holdB.resolve();
    await runningB;
    expect(h.controller.refreshing).toEqual([]);
  });

  it("account A's failed manage does not put its error on account B", async () => {
    const h = harness();
    h.push(makeView({ epoch: 1 }));
    let releaseA = () => {};
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bridge = (h.controller as unknown as { bridge: AccountSummaryBridge }).bridge;
    const original = bridge.manage.bind(bridge);
    bridge.manage = async (payload) => {
      await holdA;
      return original(payload);
    };
    h.answers.manage = false;
    const runningA = h.controller.manage();

    h.push(makeView({ epoch: 2 }));
    releaseA();
    await runningA;

    // The browser that would not open belonged to the account that left.
    expect(h.controller.manageFailed).toBe(false);
  });

  it("an older manage answer does not overwrite a newer one", async () => {
    const h = harness();
    h.push(makeView({ epoch: 1 }));
    const bridge = (h.controller as unknown as { bridge: AccountSummaryBridge }).bridge;
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    bridge.manage = async () => {
      call += 1;
      if (call === 1) {
        await first;
        return { ok: false };
      }
      return { ok: true };
    };
    const older = h.controller.manage();
    await h.controller.manage();
    expect(h.controller.manageFailed).toBe(false);
    releaseFirst();
    await older;
    expect(h.controller.manageFailed).toBe(false);
  });
});

describe("per-row state", () => {
  it("holds one row busy without disturbing the others", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.mutate = hold.promise;
    h.controller.askRevoke(DEVICE_B);
    const running = h.controller.confirmRevoke();

    expect(h.controller.rowState("dev-b").busy).toBe(true);
    expect(h.controller.rowState("dev-a").busy).toBe(false);

    hold.resolve();
    await running;
    expect(h.controller.rowState("dev-b").busy).toBe(false);
  });

  it("refuses a second action on a row that is already working", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.mutate = hold.promise;
    h.controller.askRevoke(DEVICE_B);
    const running = h.controller.confirmRevoke();

    h.controller.askRevoke(DEVICE_B);
    await h.controller.confirmRevoke();
    expect(h.calls.revoke).toEqual(["dev-b"]);

    hold.resolve();
    await running;
  });

  it("keeps one row's failure from blanking the list", async () => {
    const h = harness();
    h.push(makeView());
    h.answers.revoke = { kind: "failed", failure: { kind: "refused", status: 500 } };
    h.controller.askRevoke(DEVICE_B);
    await h.controller.confirmRevoke();
    expect(rowOf(h.controller.rowState("dev-b"))).toBe("idle:failed");
    // The list itself is untouched — it is main's to publish.
    expect(h.controller.view.devices.kind).toBe("ready");
  });

  it("clearing a notice does not make a running operation look finished", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.mutate = hold.promise;
    h.controller.askRevoke(DEVICE_B);
    const running = h.controller.confirmRevoke();
    h.controller.dismissRow("dev-b");
    expect(h.controller.rowState("dev-b").busy).toBe(true);
    hold.resolve();
    await running;
  });
});

describe("an unknown outcome re-reads; it never re-sends", () => {
  it("refreshes the device list once and issues no second mutation", async () => {
    const h = harness();
    h.push(makeView());
    h.answers.revoke = { kind: "uncertain" };
    h.controller.askRevoke(DEVICE_B);
    await h.controller.confirmRevoke();

    expect(h.controller.rowState("dev-b").outcome).toEqual({ kind: "uncertain" });
    // A READ of the list, and exactly one. Repeating the revoke could revoke
    // something that is already gone and report it as a fresh failure.
    expect(h.calls.refresh).toEqual(["devices"]);
    expect(h.calls.revoke).toEqual(["dev-b"]);
  });

  it("treats a broken channel as unknown rather than as a failure", async () => {
    const h = harness();
    h.push(makeView());
    const bridgeError = vi.fn(() => Promise.reject(new Error("channel gone")));
    (h.controller as unknown as { bridge: AccountSummaryBridge }).bridge.rename =
      bridgeError as unknown as AccountSummaryBridge["rename"];
    h.controller.beginRename(DEVICE_B);
    h.controller.renameDraft = "Travel laptop";
    await h.controller.submitRename();
    // Main may or may not have sent it. This app cannot tell, and says so.
    expect(h.controller.rowState("dev-b").outcome).toEqual({ kind: "uncertain" });
  });
});

describe("the rename field", () => {
  it("refuses to submit an empty or over-long name", async () => {
    const h = harness();
    h.push(makeView());
    h.controller.beginRename(DEVICE_B);

    h.controller.renameDraft = "    ";
    expect(h.controller.renameValid).toBe(false);
    await h.controller.submitRename();
    expect(h.calls.rename).toEqual([]);

    // Runes, not UTF-16 units: 65 astral characters is 130 units and one rune
    // over the server's ceiling.
    h.controller.renameDraft = "😀".repeat(65);
    expect(h.controller.renameValid).toBe(false);
    expect(h.controller.renameOverBy).toBe(1);
    await h.controller.submitRename();
    expect(h.calls.rename).toEqual([]);

    h.controller.renameDraft = "😀".repeat(64);
    expect(h.controller.renameValid).toBe(true);
    await h.controller.submitRename();
    expect(h.calls.rename).toEqual([{ id: "dev-b", name: "😀".repeat(64) }]);
  });

  it("sends the normalised name and closes the editor", async () => {
    const h = harness();
    h.push(makeView());
    h.controller.beginRename(DEVICE_B);
    h.controller.renameDraft = "  Travel   laptop  ";
    await h.controller.submitRename();
    expect(h.calls.rename).toEqual([{ id: "dev-b", name: "Travel laptop" }]);
    expect(h.controller.prompt).toBeNull();
    expect(h.controller.renameDraft).toBe("");
  });

  it("seeds the editor with the row's current name and cancels cleanly", () => {
    const h = harness();
    h.push(makeView());
    h.controller.beginRename(DEVICE_B);
    expect(h.controller.renameDraft).toBe("Laptop");
    h.controller.dismissPrompt();
    expect(h.controller.prompt).toBeNull();
    expect(h.controller.renameDraft).toBe("");
  });
});

describe("refreshing", () => {
  it("refreshes one section without claiming the other two", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.refresh = hold.promise;
    const running = h.controller.refresh("usage");
    expect(h.controller.refreshing).toEqual(["usage"]);
    hold.resolve();
    await running;
    expect(h.controller.refreshing).toEqual([]);
    expect(h.calls.refresh).toEqual(["usage"]);
  });

  it("does not stack a second refresh of a section already reading", async () => {
    const h = harness();
    h.push(makeView());
    const hold = deferred();
    h.holds.refresh = hold.promise;
    const running = h.controller.refresh("usage");
    await h.controller.refresh("usage");
    expect(h.calls.refresh).toEqual(["usage"]);
    hold.resolve();
    await running;
  });
});

describe("the way out of the app", () => {
  it("names a closed destination and never a URL", async () => {
    const h = harness();
    await h.controller.manage();
    expect(h.calls.manage).toEqual(["account-management"]);
    expect(h.controller.manageFailed).toBe(false);
  });

  it("says so when the browser could not be opened", async () => {
    const h = harness();
    h.answers.manage = false;
    await h.controller.manage();
    expect(h.controller.manageFailed).toBe(true);
  });
});

describe("destroy", () => {
  it("invalidates every pending result", async () => {
    const h = harness();
    h.push(makeView());
    const stateHold = deferred();
    const mutateHold = deferred();
    h.holds.state = stateHold.promise;
    h.holds.mutate = mutateHold.promise;

    const loading = h.controller.load();
    h.controller.askRevoke(DEVICE_B);
    const revoking = h.controller.confirmRevoke();
    const before = h.controller.view;

    h.controller.destroy();
    stateHold.resolve();
    mutateHold.resolve();
    await Promise.all([loading, revoking]);

    expect(h.controller.view).toBe(before);
    // The busy marker set before the teardown is not resolved into a result:
    // the answer belongs to an object that no longer exists.
    expect(h.controller.rowState("dev-b").outcome).toBeNull();
  });

  it("refuses to start anything new", async () => {
    const h = harness();
    h.push(makeView());
    h.controller.destroy();
    await h.controller.refresh();
    await h.controller.manage();
    h.controller.beginRename(DEVICE_B);
    expect(h.calls.refresh).toEqual([]);
    expect(h.calls.manage).toEqual([]);
    expect(h.controller.prompt).toBeNull();
  });
});

describe("asking for the verification email again", () => {
  it("shows it running, then what it did", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.mutate = hold.promise;
    const running = h.controller.resendVerification();
    expect(h.controller.resending).toBe(true);
    expect(h.controller.resendOutcome).toBeNull();
    hold.resolve();
    await running;
    expect(h.controller.resending).toBe(false);
    expect(h.controller.resendOutcome).toEqual({ kind: "requested" });
    expect(h.calls.resend).toBe(1);
  });

  it("refuses a second click while the first is running", async () => {
    const h = harness();
    const hold = deferred();
    h.holds.mutate = hold.promise;
    const running = h.controller.resendVerification();
    await h.controller.resendVerification();
    hold.resolve();
    await running;
    // One request. The main-side flag would refuse a second anyway; refusing it
    // here is what stops the screen flickering through a second busy state for
    // a click that was never going to send anything.
    expect(h.calls.resend).toBe(1);
  });

  it("clears the last sentence when a new attempt starts", async () => {
    const h = harness();
    h.answers.resend = { kind: "failed", failure: { kind: "network" } };
    await h.controller.resendVerification();
    expect(h.controller.resendOutcome).toEqual({ kind: "failed", failure: { kind: "network" } });

    const hold = deferred();
    h.holds.mutate = hold.promise;
    h.answers.resend = { kind: "requested" };
    const running = h.controller.resendVerification();
    // The old failure is gone WHILE the retry runs, not only once it lands: a
    // stale "that did not work" under a spinner reads as the retry having
    // failed too.
    expect(h.controller.resendOutcome).toBeNull();
    hold.resolve();
    await running;
    expect(h.controller.resendOutcome).toEqual({ kind: "requested" });
  });

  it("a broken channel is a failure, not silence", async () => {
    const h = harness();
    const controller = new AccountSummaryController({
      ...(h.controller as unknown as { bridge: AccountSummaryBridge }).bridge,
      resendVerification: () => Promise.reject(new Error("channel gone")),
    });
    await controller.resendVerification();
    expect(controller.resendOutcome).toEqual({ kind: "failed", failure: { kind: "network" } });
    expect(controller.resending).toBe(false);
  });

  it("re-reads the profile when the server says it is already verified", async () => {
    // The badge this button sits under is now wrong. Re-READ, so it goes away
    // instead of contradicting the sentence beside it. Never a re-send.
    const h = harness();
    h.answers.resend = { kind: "already-verified" };
    await h.controller.resendVerification();
    expect(h.calls.refresh).toEqual(["profile"]);
    expect(h.calls.resend).toBe(1);
  });

  it("does not re-read for an ordinary requested", async () => {
    const h = harness();
    await h.controller.resendVerification();
    expect(h.calls.refresh).toEqual([]);
  });

  it("drops an answer belonging to the account that has since left", async () => {
    // The other half of the main-side rule: main reports a landed request as
    // `requested` whatever the account did afterwards, because it happened.
    // What must not happen is that sentence appearing under somebody else's
    // email, so the guard that stops it lives here.
    const h = harness();
    const hold = deferred();
    h.holds.mutate = hold.promise;
    const running = h.controller.resendVerification();
    h.push(makeView({ epoch: 2 }));
    hold.resolve();
    await running;
    expect(h.controller.resendOutcome).toBeNull();
    expect(h.controller.resending).toBe(false);
  });
});
