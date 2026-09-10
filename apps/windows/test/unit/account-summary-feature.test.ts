// Who owns an account read, and what a mutation is allowed to land on.
//
// SCOPE: the account CLIENT underneath is a controlled stand-in, deliberately.
// These are host-discipline assertions — did a read issued before a sign-out
// install anything afterwards, did a self-revoke that finished under a
// different account sign the new one out, did a lost reply get reported as a
// failure — and a real socket would make each of them a race rather than a
// fact. `src/main/account/summary.ts` is separately accepted against a real Go
// server, so nothing here re-proves the wire.
//
// Every case below is either an invariant recorded before implementation or a
// concrete RED case root's independent probe produced.

import { describe, expect, it, vi } from "vitest";
import {
  AccountApiError,
  type AccountDevice,
  type AccountProfile,
  type AccountUsage,
} from "../../src/main/account/summary.js";
import {
  AccountSummaryService,
  normalizeDeviceNameDefault,
  type AccountReadClient,
  type AccountSummaryDeps,
} from "../../src/main/features/account-summary.js";
import type { AccountSummaryView } from "../../src/shared/account-summary.js";
// The web module is the single authority for the whitespace rule. Imported
// directly rather than vendored, exactly as the Inbox protocol modules are.
import { normalizeDeviceName as webNormalizeDeviceName } from "../../../../web/src/lib/device-identity.js";

const ORIGIN = "https://relayium.test";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const renewalOff = { available: false } as const;

function makeProfile(over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id: "user-1",
    email: "someone@relayium.test",
    displayName: "Someone",
    hasPassword: true,
    emailVerified: true,
    linkedMethods: ["password"],
    onlyOwnNodes: false,
    planId: "pro",
    subscriptionStatus: "active",
    subscriptionEnd: 1_800_000_000,
    hasBilling: true,
    scheduledPlanId: "",
    scheduledCycle: "",
    billingCycle: "monthly",
    entitlementProvider: "stripe",
    appleRenewal: renewalOff,
    ...over,
  };
}

function makeUsage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    period: "202609",
    resetsAt: 1_790_000_000,
    traffic: { used: 500, cap: 1000 },
    storage: { used: 10, cap: 0 },
    plan: {
      id: "pro",
      name: "Pro",
      storageBytes: 0,
      trafficBytes: 4000,
      retentionSecs: 7 * 86_400,
      priceMonthly: 890,
      priceYearly: 7900,
      isTop: false,
      subscriptionStatus: "active",
      subscriptionEnd: 1_800_000_000,
      billingCycle: "monthly",
      scheduledPlanId: "",
      scheduledPlanName: "",
      scheduledCycle: "",
      entitlementProvider: "stripe",
      appleRenewal: renewalOff,
    },
    ...over,
  };
}

const device = (over: Partial<AccountDevice> = {}): AccountDevice => ({
  id: "dev-a",
  name: "Office PC",
  kind: "windows",
  createdAt: 1_700_000_000,
  lastSeenAt: 1_780_000_000,
  current: false,
  enrolled: false,
  ...over,
});

const DEVICES: readonly AccountDevice[] = [
  device({ id: "dev-a", name: "Office PC", current: true }),
  device({ id: "dev-b", name: "Laptop" }),
];

/** A client whose every call is observable, holdable and individually failable. */
function fakeClient(epoch: number) {
  const calls = { profile: 0, usage: 0, devices: 0, rename: [] as string[], revoke: [] as string[] };
  const holds = {
    profile: null as Promise<void> | null,
    usage: null as Promise<void> | null,
    devices: null as Promise<void> | null,
    rename: null as Promise<void> | null,
    revoke: null as Promise<void> | null,
  };
  const fails = {
    profile: null as unknown,
    usage: null as unknown,
    devices: null as unknown,
    rename: null as unknown,
    revoke: null as unknown,
  };
  const answers = {
    profile: makeProfile(),
    usage: makeUsage(),
    devices: DEVICES as readonly AccountDevice[],
  };
  /** Server-side effects the stand-in actually performed, for the lost-reply cases. */
  const committed = { renamed: [] as string[], revoked: [] as string[] };

  const client: AccountReadClient = {
    epoch,
    async profile() {
      calls.profile += 1;
      if (holds.profile) await holds.profile;
      if (fails.profile) throw fails.profile;
      return answers.profile;
    },
    async usage() {
      calls.usage += 1;
      if (holds.usage) await holds.usage;
      if (fails.usage) throw fails.usage;
      return answers.usage;
    },
    async devices() {
      calls.devices += 1;
      if (holds.devices) await holds.devices;
      if (fails.devices) throw fails.devices;
      return answers.devices;
    },
    async renameDevice(id, name, normalize) {
      calls.rename.push(`${id}:${name}`);
      if (holds.rename) await holds.rename;
      // The effect is committed BEFORE the failure, which is the whole point of
      // the lost-reply cases: the server acted and the answer never arrived.
      committed.renamed.push(`${id}:${normalize(name)}`);
      if (fails.rename) throw fails.rename;
      return normalize(name);
    },
    async revokeDevice(id) {
      calls.revoke.push(id);
      if (holds.revoke) await holds.revoke;
      committed.revoked.push(id);
      if (fails.revoke) throw fails.revoke;
    },
  };
  return { client, calls, holds, fails, answers, committed };
}

/**
 * A promise that rejects when the caller withdraws — including when the signal
 * was ALREADY aborted before the call.
 *
 * The second half is the part that matters: `addEventListener("abort", …)` on a
 * spent signal never fires, so a fixture written only for the first half hangs
 * instead of failing, and reads as work that could not be joined.
 */
function abortsAs<T>(signal: AbortSignal, error: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (signal.aborted) {
      reject(error);
      return;
    }
    signal.addEventListener("abort", () => reject(error), { once: true });
  });
}

/** A client that fails the named reads from the very first call. */
function failingClient(fails: { profile?: unknown; usage?: unknown; devices?: unknown }): AccountReadClient {
  return {
    epoch: 1,
    profile: () => (fails.profile ? Promise.reject(fails.profile) : Promise.resolve(makeProfile())),
    usage: () => (fails.usage ? Promise.reject(fails.usage) : Promise.resolve(makeUsage())),
    devices: () => (fails.devices ? Promise.reject(fails.devices) : Promise.resolve(DEVICES)),
    renameDevice: (_id, name) => Promise.resolve(name),
    revokeDevice: () => Promise.resolve(),
  };
}

interface Harness {
  readonly service: AccountSummaryService;
  readonly views: AccountSummaryView[];
  readonly clients: ReturnType<typeof fakeClient>[];
  readonly failures: unknown[];
  client(): ReturnType<typeof fakeClient>;
  epoch: number;
  document: number;
  authority: "ok" | "signed-out" | "unavailable";
  authorityHold: Promise<void> | null;
  authorityThrows: boolean;
  signOuts: number;
  signOutFails: boolean;
  /** Move the account on, exactly as `AppService` does. */
  changeAccount(): void;
}

function harness(over: Partial<AccountSummaryDeps> = {}): Harness {
  const views: AccountSummaryView[] = [];
  const clients: ReturnType<typeof fakeClient>[] = [];
  const failures: unknown[] = [];
  const watchers = new Set<() => void>();
  const state = {
    epoch: 1,
    document: 7,
    authority: "ok" as "ok" | "signed-out" | "unavailable",
    authorityHold: null as Promise<void> | null,
    authorityThrows: false,
    signOuts: 0,
    signOutFails: false,
  };

  const account = {
    get accountEpoch() {
      return state.epoch;
    },
    async captureAccountAuthority() {
      const captured = state.epoch;
      if (state.authorityHold) await state.authorityHold;
      if (state.authorityThrows) throw new Error("the store exploded");
      if (state.authority === "signed-out") return { kind: "signed-out" as const };
      if (state.authority === "unavailable") return { kind: "unavailable" as const };
      return { kind: "ok" as const, bearer: `bearer-${captured}`, epoch: captured };
    },
    onAccountChanged(listener: () => void) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    async signOut() {
      state.signOuts += 1;
      if (state.signOutFails) throw new Error("store unwritable");
      state.epoch += 1;
      for (const watcher of [...watchers]) watcher();
      return { signedIn: false as const };
    },
  };

  const service = new AccountSummaryService({
    origin: ORIGIN,
    account,
    currentDocument: () => state.document,
    onView: (view) => views.push(view),
    reportFailure: (err) => failures.push(err),
    makeClient: (context) => {
      const made = fakeClient(context.epoch);
      clients.push(made);
      return made.client;
    },
    quiesceTimeoutMs: 50,
    ...over,
  });

  return {
    service,
    views,
    clients,
    failures,
    client: () => clients[clients.length - 1],
    get epoch() {
      return state.epoch;
    },
    set epoch(value: number) {
      state.epoch = value;
    },
    get document() {
      return state.document;
    },
    set document(value: number) {
      state.document = value;
    },
    get authority() {
      return state.authority;
    },
    set authority(value) {
      state.authority = value;
    },
    get authorityHold() {
      return state.authorityHold;
    },
    set authorityHold(value) {
      state.authorityHold = value;
    },
    get authorityThrows() {
      return state.authorityThrows;
    },
    set authorityThrows(value: boolean) {
      state.authorityThrows = value;
    },
    get signOuts() {
      return state.signOuts;
    },
    get signOutFails() {
      return state.signOutFails;
    },
    set signOutFails(value: boolean) {
      state.signOutFails = value;
    },
    changeAccount() {
      state.epoch += 1;
      for (const watcher of [...watchers]) watcher();
    },
  };
}

describe("the three reads are independent", () => {
  it("a failing usage read leaves the profile and the devices standing", async () => {
    const h = harness();
    await h.service.refresh();
    const client = h.client();
    client.fails.usage = new AccountApiError("server-refused", undefined, 500);
    await h.service.refreshUsage();

    const view = h.service.view();
    expect(view.profile.kind).toBe("ready");
    expect(view.devices.kind).toBe("ready");
    expect(view.usage).toEqual({ kind: "failed", failure: { kind: "refused", status: 500 } });
  });

  it("a failed read is never a zero quota, an unlimited cap or a free plan", async () => {
    // Failing from the very FIRST read, so there is no earlier good answer that
    // a degradation could be mistaken for.
    const h = harness({ makeClient: () => failingClient({ usage: new AccountApiError("network") }) });
    await h.service.refreshUsage();

    const usage = h.service.view().usage;
    expect(usage.kind).toBe("failed");
    // The important half: there is no `value` at all. Not a zero, not a cap.
    expect(usage).not.toHaveProperty("value");
  });

  it("carries retention, and the effective cap distinct from the nominal one", async () => {
    const h = harness();
    await h.service.refresh();
    const usage = h.service.view().usage;
    if (usage.kind !== "ready") throw new Error("expected a usage read");
    expect(usage.value.plan.retentionSecs).toBe(7 * 86_400);
    // 1000 is what is being enforced this month; 4000 is what the tier says.
    expect(usage.value.traffic.cap).toBe(1000);
    expect(usage.value.plan.trafficBytes).toBe(4000);
    // 0 travels as 0. The screen — not this layer — says "unlimited".
    expect(usage.value.storage.cap).toBe(0);
    expect(usage.value.plan.storageBytes).toBe(0);
  });

  it("an unreadable schema is closed and unavailable, never a rendered provider", async () => {
    // What the client throws for a NEWER server's unknown entitlement provider.
    const h = harness({
      makeClient: () => failingClient({ profile: new AccountApiError("malformed") }),
    });
    await h.service.refreshProfile();
    expect(h.service.view().profile).toEqual({
      kind: "failed",
      failure: { kind: "unreadable" },
    });
  });

  it("holds one read per section and lets a second caller join it", async () => {
    const h = harness();
    await h.service.refreshProfile();
    const client = h.client();
    const hold = deferred();
    client.holds.profile = hold.promise;
    const before = client.calls.profile;
    const a = h.service.refreshProfile();
    const b = h.service.refreshProfile();
    hold.resolve();
    await Promise.all([a, b]);
    expect(client.calls.profile - before).toBe(1);
  });
});

describe("ordering", () => {
  it("a device read issued before a rename cannot put the old name back", async () => {
    const h = harness();
    await h.service.refresh();
    const client = h.client();

    // A devices read is started and HELD. It carries the pre-rename list.
    const hold = deferred();
    client.holds.devices = hold.promise;
    const stale = h.service.refreshDevices();

    // The rename lands while that read is still in the air.
    client.holds.devices = null;
    const renamed = await h.service.renameDevice(h.document, "dev-b", "Travel laptop");
    expect(renamed).toEqual({ kind: "renamed", name: "Travel laptop" });

    // Now the old read answers, with "Laptop".
    hold.resolve();
    await stale;

    const devices = h.service.view().devices;
    if (devices.kind !== "ready") throw new Error("expected a device list");
    expect(devices.value.find((row) => row.id === "dev-b")?.name).toBe("Travel laptop");
  });

  it("a read issued before an account change installs nothing afterwards", async () => {
    const h = harness();
    await h.service.refresh();
    const first = h.client();
    const hold = deferred();
    first.holds.profile = hold.promise;
    first.answers.profile = makeProfile({ email: "old@relayium.test" });
    const stale = h.service.refreshProfile();

    h.changeAccount();
    expect(h.service.view().profile.kind).toBe("loading");

    hold.resolve();
    await stale;

    // Still loading under the NEW epoch: the previous account's profile did not
    // arrive late and install itself over it.
    const view = h.service.view();
    expect(view.epoch).toBe(2);
    expect(view.profile.kind).toBe("loading");
  });

  it("an account change clears the held data and aborts the work synchronously", async () => {
    const h = harness();
    await h.service.refresh();
    expect(h.service.view().devices.kind).toBe("ready");

    const client = h.client();
    client.holds.usage = deferred().promise;
    void h.service.refreshUsage();
    expect(h.service.active).toBeGreaterThan(0);

    h.changeAccount();

    const view = h.service.view();
    expect(view.epoch).toBe(2);
    expect(view.profile.kind).toBe("loading");
    expect(view.usage.kind).toBe("loading");
    expect(view.devices.kind).toBe("loading");
    // And a mutation cannot select from a list that has been dropped.
    await expect(h.service.renameDevice(h.document, "dev-b", "Nope")).resolves.toEqual({
      kind: "unknown-device",
    });
  });

  it("a signed-out read replaces every section at once", async () => {
    const h = harness();
    await h.service.refresh();
    h.authority = "signed-out";
    await h.service.refreshProfile();
    const view = h.service.view();
    expect(view.signedIn).toBe(false);
    expect(view.profile).toEqual({ kind: "failed", failure: { kind: "signed-out" } });
    expect(view.usage).toEqual({ kind: "failed", failure: { kind: "signed-out" } });
    expect(view.devices).toEqual({ kind: "failed", failure: { kind: "signed-out" } });
  });

  it("an unreadable store is not reported as signed out", async () => {
    const h = harness();
    await h.service.refresh();
    h.authority = "unavailable";
    await h.service.refreshProfile();
    expect(h.service.view().profile).toEqual({
      kind: "failed",
      failure: { kind: "unavailable" },
    });
    // `signedIn` is deliberately untouched: nothing observed says nobody is.
    expect(h.service.view().signedIn).toBe(true);
  });
});

describe("mutations select from the list this process holds", () => {
  it("refuses an id that is not in the current device list", async () => {
    const h = harness();
    await h.service.refresh();
    await expect(h.service.revokeDevice(h.document, "dev-from-somewhere-else")).resolves.toEqual({
      kind: "unknown-device",
    });
    expect(h.client().calls.revoke).toEqual([]);
  });

  it("refuses an id that could not be one path segment, before dispatching", async () => {
    const h = harness();
    await h.service.refresh();
    await expect(h.service.renameDevice(h.document, "../admin", "x")).resolves.toEqual({
      kind: "unknown-device",
    });
    expect(h.client().calls.rename).toEqual([]);
  });

  it("refuses a second operation on a row that is already working", async () => {
    const h = harness();
    await h.service.refresh();
    const client = h.client();
    const hold = deferred();
    client.holds.rename = hold.promise;
    const first = h.service.renameDevice(h.document, "dev-b", "One");
    await expect(h.service.renameDevice(h.document, "dev-b", "Two")).resolves.toEqual({
      kind: "busy",
    });
    hold.resolve();
    await first;
    expect(client.calls.rename).toEqual(["dev-b:One"]);
  });

  it("refuses a confirmation submitted by a document that has gone away", async () => {
    const h = harness();
    await h.service.refresh();
    const asking = h.document;
    h.document = asking + 1;
    await expect(h.service.renameDevice(asking, "dev-b", "Reloaded")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(h.client().calls.rename).toEqual([]);
  });

  it("refuses a mutation once the quit fence is up, and admits again on resume", async () => {
    const h = harness();
    await h.service.refresh();
    h.service.fence();
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(h.client().calls.revoke).toEqual([]);
    // Reads are deliberately still allowed while a quit is being decided.
    await expect(h.service.refreshProfile()).resolves.toMatchObject({ kind: "ready" });
    h.service.resume();
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toMatchObject({
      kind: "revoked",
    });
  });

  it("refuses a name that is empty or over the rune ceiling, without sending it", async () => {
    const h = harness();
    await h.service.refresh();
    await expect(h.service.renameDevice(h.document, "dev-b", "   ")).resolves.toEqual({
      kind: "invalid-name",
    });
    // 65 astral code points: 130 UTF-16 units, and one rune over the ceiling.
    const tooLong = "😀".repeat(65);
    await expect(h.service.renameDevice(h.document, "dev-b", tooLong)).resolves.toEqual({
      kind: "invalid-name",
    });
    // 64 of them is exactly the ceiling and is sent.
    await expect(h.service.renameDevice(h.document, "dev-b", "😀".repeat(64))).resolves.toMatchObject(
      { kind: "renamed" },
    );
  });

  it("reports the server's own label refusal as an invalid name", async () => {
    const h = harness();
    await h.service.refresh();
    h.client().fails.rename = new AccountApiError("server-refused", "invalid_device_name", 400);
    await expect(h.service.renameDevice(h.document, "dev-b", "Bidi‮name")).resolves.toEqual({
      kind: "invalid-name",
    });
  });

  it("normalises with the same rule as the web client", () => {
    const table = [
      "  prod   backup  ",
      "prod\nbackup",
      "   ",
      "prod‮kcab",
      "a\t\tb",
      " spaced ",
      "😀 😀",
      "single",
    ];
    for (const input of table) {
      expect(normalizeDeviceNameDefault(input)).toBe(webNormalizeDeviceName(input));
    }
  });
});

describe("a mutation whose answer never arrived is reported as unknown", () => {
  // The three cases root's independent probe produced RED. In each the
  // stand-in COMMITS the effect and only then throws, WITHOUT the caller
  // aborting: a server that acted and then failed to answer.
  for (const [label, error] of [
    ["a dropped connection", new AccountApiError("network")],
    ["a deadline", new AccountApiError("timeout")],
    ["a reply this build could not read", new AccountApiError("malformed")],
  ] as const) {
    it(`revoke: ${label} is uncertain, not failed`, async () => {
      const h = harness();
      await h.service.refresh();
      const client = h.client();
      client.fails.revoke = error;
      const outcome = await h.service.revokeDevice(h.document, "dev-b");
      // The server DID revoke it. Reporting "failed" here would invite the
      // person to press the button again.
      expect(client.committed.revoked).toEqual(["dev-b"]);
      expect(outcome).toEqual({ kind: "uncertain" });
      // The row is preserved for an explicit re-check, not silently removed.
      const devices = h.service.view().devices;
      if (devices.kind !== "ready") throw new Error("expected a device list");
      expect(devices.value.map((row) => row.id)).toEqual(["dev-a", "dev-b"]);
    });

    it(`rename: ${label} is uncertain, not failed`, async () => {
      const h = harness();
      await h.service.refresh();
      const client = h.client();
      client.fails.rename = error;
      const outcome = await h.service.renameDevice(h.document, "dev-b", "Travel laptop");
      expect(client.committed.renamed).toEqual(["dev-b:Travel laptop"]);
      expect(outcome).toEqual({ kind: "uncertain" });
    });
  }

  it("a 5xx is uncertain: the server may have committed before it failed", async () => {
    const h = harness();
    await h.service.refresh();
    h.client().fails.revoke = new AccountApiError("server-refused", undefined, 503);
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
      kind: "uncertain",
    });
  });

  it("a stated refusal is definite, because the server said it did not act", async () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      const h = harness();
      await h.service.refresh();
      h.client().fails.revoke = new AccountApiError("server-refused", undefined, status);
      await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
        kind: "failed",
        failure: { kind: "refused", status },
      });
    }
  });

  it("an abandoned request is uncertain and never a confirmed failure", async () => {
    // Abandoned INSIDE the request, which is the case that is unknowable. A
    // quit that arrives before anything is dispatched is a different and
    // knowable thing — nothing was sent — and is asserted as `unavailable` by
    // the fence case above.
    const dispatched = deferred();
    const h = harness({
      makeClient: () => ({
        epoch: 1,
        profile: () => Promise.resolve(makeProfile()),
        usage: () => Promise.resolve(makeUsage()),
        devices: () => Promise.resolve(DEVICES),
        renameDevice: (_i, n) => Promise.resolve(n),
        revokeDevice: (_id, signal) => {
          dispatched.resolve();
          return abortsAs(signal, new AccountApiError("network"));
        },
      }),
    });
    await h.service.refresh();
    const running = h.service.revokeDevice(h.document, "dev-b");
    await dispatched.promise;
    const inventory = await h.service.quiesce();
    await expect(running).resolves.toEqual({ kind: "uncertain" });
    expect(inventory).toEqual({ pending: 1, unjoined: 0 });
  });

  it("never retries a mutation by itself", async () => {
    const h = harness();
    await h.service.refresh();
    const client = h.client();
    client.fails.revoke = new AccountApiError("network");
    await h.service.revokeDevice(h.document, "dev-b");
    expect(client.calls.revoke).toEqual(["dev-b"]);
  });
});

describe("revoking this device", () => {
  it("signs out only when the captured account is still the current one", async () => {
    const h = harness();
    await h.service.refresh();
    const outcome = await h.service.revokeDevice(h.document, "dev-a");
    expect(outcome).toEqual({ kind: "revoked", self: true, signedOut: true });
    expect(h.signOuts).toBe(1);
  });

  it("does NOT sign out a new account when the old revoke lands late", async () => {
    // The account has to move while the REVOKE is in flight, not while the
    // credential is being read — a change during the capture is refused before
    // anything is sent, which is a different (and knowable) case.
    const dispatched = deferred();
    const hold = deferred();
    const h = harness({
      makeClient: () => ({
        epoch: 1,
        profile: () => Promise.resolve(makeProfile()),
        usage: () => Promise.resolve(makeUsage()),
        devices: () => Promise.resolve(DEVICES),
        renameDevice: (_i, n) => Promise.resolve(n),
        revokeDevice: async () => {
          dispatched.resolve();
          await hold.promise;
        },
      }),
    });
    await h.service.refresh();
    const running = h.service.revokeDevice(h.document, "dev-a");
    await dispatched.promise;

    // Somebody signs in as somebody else while the revoke is still in flight.
    h.changeAccount();
    hold.resolve();

    const outcome = await running;
    // The revoke did happen on the server, and it is reported as such — but the
    // sign-out is refused, because it would take the CURRENT account away.
    expect(outcome).toEqual({ kind: "revoked", self: true, signedOut: false });
    expect(h.signOuts).toBe(0);
  });

  it("does not sign out on an uncertain self-revoke", async () => {
    const h = harness();
    await h.service.refresh();
    h.client().fails.revoke = new AccountApiError("timeout");
    await expect(h.service.revokeDevice(h.document, "dev-a")).resolves.toEqual({
      kind: "uncertain",
    });
    expect(h.signOuts).toBe(0);
  });

  it("reports the revoke when the local sign-out itself fails", async () => {
    const h = harness();
    await h.service.refresh();
    h.signOutFails = true;
    const outcome = await h.service.revokeDevice(h.document, "dev-a");
    // The device is gone from the server either way; failing to clear a local
    // credential does not un-revoke it.
    expect(outcome).toEqual({ kind: "revoked", self: true, signedOut: false });
    expect(h.failures.length).toBe(1);
  });

  it("revoking another device does not sign anybody out", async () => {
    const h = harness();
    await h.service.refresh();
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
      kind: "revoked",
      self: false,
      signedOut: false,
    });
    expect(h.signOuts).toBe(0);
    const devices = h.service.view().devices;
    if (devices.kind !== "ready") throw new Error("expected a device list");
    expect(devices.value.map((row) => row.id)).toEqual(["dev-a"]);
  });
});

describe("lifecycle", () => {
  it("registers work before the authority is read, so a teardown finds it", async () => {
    const h = harness();
    const hold = deferred();
    h.authorityHold = hold.promise;
    const running = h.service.refreshProfile();
    // Still inside `captureAccountAuthority`, before any client exists.
    expect(h.service.active).toBe(1);
    hold.resolve();
    h.authorityHold = null;
    await running;
    expect(h.service.active).toBe(0);
  });

  it("quiesce joins the work it aborted", async () => {
    const dispatched = deferred();
    const h = harness({
      makeClient: () => ({
        epoch: 1,
        profile: (signal) => {
          dispatched.resolve();
          return abortsAs<AccountProfile>(signal, new AccountApiError("network"));
        },
        usage: () => Promise.resolve(makeUsage()),
        devices: () => Promise.resolve(DEVICES),
        renameDevice: (_i, n) => Promise.resolve(n),
        revokeDevice: () => Promise.resolve(),
      }),
    });
    void h.service.refreshProfile();
    await dispatched.promise;
    const inventory = await h.service.quiesce();
    expect(inventory).toEqual({ pending: 1, unjoined: 0 });
  });

  it("does not dispatch a request it has already abandoned", async () => {
    let dispatches = 0;
    const h = harness({
      makeClient: () => ({
        epoch: 1,
        profile: () => {
          dispatches += 1;
          return Promise.resolve(makeProfile());
        },
        usage: () => Promise.resolve(makeUsage()),
        devices: () => Promise.resolve(DEVICES),
        renameDevice: (_i, n) => Promise.resolve(n),
        revokeDevice: () => Promise.resolve(),
      }),
    });
    // Aborted while the credential is still being read: the client must never
    // be reached, rather than being reached with a signal that is already spent.
    const running = h.service.refreshProfile();
    await h.service.quiesce();
    await running;
    expect(dispatches).toBe(0);
  });

  it("reports work it could NOT join rather than assuming it stopped", async () => {
    // Dispatched, and then deaf to the abort. The bounded wait runs out and the
    // inventory says so, because a quit prompt told "nothing at stake" over a
    // request still going out is the failure this number exists to prevent.
    const dispatched = deferred();
    const h = harness({
      quiesceTimeoutMs: 20,
      makeClient: () => ({
        epoch: 1,
        profile: () => {
          dispatched.resolve();
          return new Promise<AccountProfile>(() => {});
        },
        usage: () => Promise.resolve(makeUsage()),
        devices: () => Promise.resolve(DEVICES),
        renameDevice: (_i, n) => Promise.resolve(n),
        revokeDevice: () => Promise.resolve(),
      }),
    });
    void h.service.refreshProfile();
    await dispatched.promise;
    const inventory = await h.service.quiesce();
    expect(inventory).toEqual({ pending: 1, unjoined: 1 });
  });

  it("a clean quiesce closes READS too, until resume", async () => {
    // Root's case 1. A fence deliberately leaves reads open; a quiesce does not.
    // It has already aborted, joined and REPORTED an inventory, and a read
    // admitted afterwards makes that report untrue.
    const h = harness();
    await h.service.refresh();
    const client = h.client();
    const before = client.calls.devices;

    const inventory = await h.service.quiesce();
    expect(inventory).toEqual({ pending: 0, unjoined: 0 });

    await expect(h.service.refreshDevices()).resolves.toEqual({
      kind: "failed",
      failure: { kind: "unavailable" },
    });
    expect(client.calls.devices).toBe(before);

    // Resume re-opens them.
    h.service.resume();
    await h.service.refreshDevices();
    expect(h.client().calls.devices).toBe(before + 1);
  });

  it("a read queued BEFORE a quiesce does not dispatch after it", async () => {
    // Root's case 2. The account change schedules the microtask, the quiesce
    // runs before it drains, and the callback used to check nothing but
    // `#disposed`. Deciding admissibility at schedule time alone is not enough.
    const h = harness();
    await h.service.refresh();
    const before = h.clients.length;

    h.changeAccount();          // queues the read
    const inventory = await h.service.quiesce();
    expect(inventory).toEqual({ pending: 0, unjoined: 0 });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.clients.length).toBe(before);
    expect(h.service.view().profile.kind).toBe("loading");

    // The account really did move, so resume still owes that read.
    h.service.resume();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.service.view().profile.kind).toBe("ready");
    expect(h.service.view().epoch).toBe(2);
  });

  it("a quiesce closes mutations as well, and resume re-opens them", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.quiesce();
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
      kind: "unavailable",
    });
    h.service.resume();
    // The device list was dropped with everything else, so it must be re-read
    // before a row is addressable again.
    await h.service.refreshDevices();
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toMatchObject({
      kind: "revoked",
    });
  });

  it("a fence still admits an explicit read, which is the difference", async () => {
    const h = harness();
    await h.service.refresh();
    const before = h.client().calls.usage;
    h.service.fence();
    // A person asking is allowed; the speculative post-account-change read is
    // not. Both are closed by a quiesce.
    await expect(h.service.refreshUsage()).resolves.toMatchObject({ kind: "ready" });
    expect(h.client().calls.usage).toBe(before + 1);
  });

  it("degrades rather than rejecting when the injected authority throws", async () => {
    const h = harness();
    h.authorityThrows = true;
    // `AppService` answers rather than throwing, but this dep is injected: a
    // rejection escaping here would be an outcome no caller can match on.
    await expect(h.service.refreshProfile()).resolves.toEqual({
      kind: "failed",
      failure: { kind: "unavailable" },
    });
    expect(h.failures.length).toBe(1);
  });

  it("dispose is terminal: nothing installs and no observer is called again", async () => {
    const h = harness();
    await h.service.refresh();
    const before = h.views.length;
    await h.service.dispose();
    await expect(h.service.refreshProfile()).resolves.toEqual({
      kind: "failed",
      failure: { kind: "unavailable" },
    });
    await expect(h.service.renameDevice(h.document, "dev-b", "After")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(h.views.length).toBe(before);
    // And the account watcher is released, so a later change publishes nothing.
    h.changeAccount();
    expect(h.views.length).toBe(before);
  });

  it("survives an observer that throws, and one that re-enters", async () => {
    let reentered = 0;
    const h = harness({
      onView: () => {
        reentered += 1;
        if (reentered === 1) throw new Error("observer exploded");
      },
    });
    // A throwing observer must not abandon the `finally` that unregisters work.
    await h.service.refreshProfile();
    expect(h.service.active).toBe(0);
    expect(h.failures.length).toBe(1);
    expect(h.service.view().profile.kind).toBe("ready");
  });

  it("re-entrant reads from an observer see a fully installed view", async () => {
    const seen: string[] = [];
    let service: AccountSummaryService | null = null;
    const h = harness({
      onView: (view) => {
        // Re-entering while the feature is mid-publish. The view it reads back
        // must be the one just installed, never a half-built one.
        seen.push(`${view.profile.kind}:${service?.view().profile.kind ?? "none"}`);
      },
    });
    service = h.service;
    await h.service.refreshProfile();
    expect(seen).toContain("ready:ready");
  });
});

describe("main drives the read when the account moves", () => {
  it("reads once for the account that has just arrived", async () => {
    const h = harness();
    await h.service.refresh();
    const before = h.clients.length;

    h.changeAccount();
    // MAIN's job, not the page's: the account can move while no window is
    // mounted, and a screen that waited to be asked would sit at "…".
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const view = h.service.view();
    expect(view.epoch).toBe(2);
    expect(view.profile.kind).toBe("ready");
    expect(view.devices.kind).toBe("ready");
    // A new client for the new account; the old one is never retargeted.
    expect(h.clients.length).toBeGreaterThan(before);
  });

  it("coalesces a burst of notifications in one tick into one read", async () => {
    const h = harness();
    await h.service.refresh();
    const before = h.clients.length;
    h.changeAccount();
    h.changeAccount();
    h.changeAccount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // ONE read for the burst, not three, and one client for the account that
    // actually ended up current — not one per notification.
    expect(h.clients.length).toBe(before + 1);
    expect(h.client().calls.profile).toBe(1);
    expect(h.service.view().epoch).toBe(4);
  });

  it("publishes a signed-out account rather than sitting at loading", async () => {
    const h = harness();
    await h.service.refresh();
    h.authority = "signed-out";
    h.changeAccount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const view = h.service.view();
    expect(view.signedIn).toBe(false);
    expect(view.profile).toEqual({ kind: "failed", failure: { kind: "signed-out" } });
  });

  it("does not start a read the quit fence has just joined away", async () => {
    const h = harness();
    await h.service.refresh();
    const inventory = await h.service.quiesce();
    expect(inventory).toEqual({ pending: 0, unjoined: 0 });
    const before = h.clients.length;

    h.changeAccount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Three fresh requests here would make the inventory just reported a lie.
    expect(h.clients.length).toBe(before);
    expect(h.service.view().profile.kind).toBe("loading");

    // The person stayed. The account really did move, so the read happens now.
    h.service.resume();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.service.view().profile.kind).toBe("ready");
    expect(h.service.view().epoch).toBe(2);
  });

  it("does not read after dispose", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.dispose();
    const before = h.clients.length;
    h.changeAccount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.clients.length).toBe(before);
  });

  it("drops the held device list when a read finds nobody signed in", async () => {
    const h = harness();
    await h.service.refresh();
    h.authority = "signed-out";
    await h.service.refreshDevices();
    h.authority = "ok";
    // The list belonged to an account nobody is signed in to. It must not still
    // be addressable, even though the capture ahead of a mutation would refuse.
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
      kind: "unknown-device",
    });
  });
});

describe("what a view may carry", () => {
  it("is deep-frozen, so a holder cannot edit the account state", async () => {
    const h = harness();
    await h.service.refresh();
    const view = h.service.view();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.profile)).toBe(true);
    expect(() => {
      (view as { epoch: number }).epoch = 99;
    }).toThrow();
  });

  it("carries an opaque epoch and no credential, origin, address or IP", async () => {
    const h = harness();
    await h.service.refresh();
    const serialised = JSON.stringify(h.service.view());
    expect(serialised).not.toContain("bearer");
    expect(serialised).not.toContain(ORIGIN);
    expect(serialised).not.toMatch(/lastip/i);
    expect(serialised).not.toMatch(/inbox/i);
    expect(h.service.view().epoch).toBe(1);
  });

  it("drops the device list when its read fails, so nothing stale is selectable", async () => {
    const h = harness();
    await h.service.refresh();
    const client = h.client();
    client.fails.devices = new AccountApiError("network");
    await h.service.refreshDevices();
    // The list is gone, and with it the ability to address a row from it.
    await expect(h.service.revokeDevice(h.document, "dev-b")).resolves.toEqual({
      kind: "unknown-device",
    });
    // The profile beside it is untouched.
    expect(h.service.view().profile.kind).toBe("ready");
  });
});

describe("the one journey out of the app", () => {
  it("resolves a closed token to a fixed path on the pinned origin", () => {
    const h = harness();
    expect(h.service.externalUrl("account-management")).toBe(`${ORIGIN}/me`);
  });

  it("refuses anything that is not the closed token", () => {
    const h = harness();
    expect(h.service.externalUrl("https://evil.test" as never)).toBeNull();
    expect(h.service.externalUrl("../admin" as never)).toBeNull();
  });

  it("refuses when this build's own origin is not an origin", () => {
    const h = harness({ origin: "https://relayium.test/somewhere" });
    expect(h.service.externalUrl("account-management")).toBeNull();
  });
});

describe("the default normaliser is used when the host supplies none", () => {
  it("passes the app's normaliser through to the client", async () => {
    const normalizeDeviceName = vi.fn((value: string) => value.trim().replace(/\s+/g, " "));
    const h = harness({ normalizeDeviceName });
    await h.service.refresh();
    await h.service.renameDevice(h.document, "dev-b", "  Travel   laptop ");
    expect(normalizeDeviceName).toHaveBeenCalled();
    expect(h.client().calls.rename).toEqual(["dev-b:Travel laptop"]);
  });
});
