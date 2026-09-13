// Consent and the at-rest key: the two values that must never be re-invented.
//
// Every assertion here is about a failure that would be SILENT if it were
// handled the tempting way. An unreadable grant read as "no consent" shows an
// off switch over a live enrolment. An unreadable at-rest key replaced with a
// fresh one orphans every message the user has already received. Both are
// recoverable only if nobody helpfully recovers from them.

import { describe, expect, it } from "vitest";
import { AT_REST_KEY_BYTES } from "../../src/main/inbox/atrest.js";
import {
  InboxGrantStore,
  atRestSlotFor,
  grantSlotFor,
  type GrantSlot,
} from "../../src/main/features/inbox-grant.js";

class FakeStore implements GrantSlot {
  readonly values = new Map<string, string>();
  /** Keys whose read should fail, with the typed code the real store uses. */
  readonly failures = new Map<string, string>();
  putCalls = 0;

  async get(key: string): Promise<string> {
    const failure = this.failures.get(key);
    if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure });
    const value = this.values.get(key);
    if (value === undefined) throw Object.assign(new Error("not-found"), { code: "not-found" });
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.putCalls += 1;
    this.values.set(key, value);
  }

  async putIfAbsent(key: string, value: string): Promise<{ created: boolean; value: string }> {
    const failure = this.failures.get(key);
    // The real store rejects rather than writing on anything except a typed
    // not-found; this stand-in has to behave the same or the test proves nothing.
    if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure });
    const existing = this.values.get(key);
    if (existing !== undefined) return { created: false, value: existing };
    this.putCalls += 1;
    this.values.set(key, value);
    return { created: true, value };
  }
}

const ACCOUNT = "abc123";

describe("the receive grant", () => {
  it("is absent for an account that has never consented", async () => {
    const store = new FakeStore();
    expect(await new InboxGrantStore(store).read(ACCOUNT)).toBeNull();
  });

  it("round-trips consent, the destination and a pending withdrawal", async () => {
    const store = new FakeStore();
    const grants = new InboxGrantStore(store);
    await grants.write(ACCOUNT, { directory: "D:\\Inbox", enabled: true, policy: "auto", withdrawalPending: false });
    expect(await grants.read(ACCOUNT)).toEqual({
      directory: "D:\\Inbox",
      enabled: true,
      policy: "auto",
      withdrawalPending: false,
    });
    await grants.write(ACCOUNT, { directory: "D:\\Inbox", enabled: false, policy: "off", withdrawalPending: true });
    expect(await grants.read(ACCOUNT)).toMatchObject({ enabled: false, withdrawalPending: true });
  });

  it("is scoped per account, so one account's consent is not another's", async () => {
    const store = new FakeStore();
    const grants = new InboxGrantStore(store);
    await grants.write("first", { directory: "D:\\A", enabled: true, policy: "ask", withdrawalPending: false });
    expect(await grants.read("second")).toBeNull();
    expect(store.values.has(grantSlotFor("first"))).toBe(true);
  });

  it("propagates an unreadable store instead of reporting no consent", async () => {
    // The failure this exists for: reading "unreadable" as "the user said no"
    // would show an off switch over an enrolment central still holds, and every
    // delivery queued against this device would go unworked with nothing on
    // screen to explain it.
    const store = new FakeStore();
    store.failures.set(grantSlotFor(ACCOUNT), "undecryptable");
    await expect(new InboxGrantStore(store).read(ACCOUNT)).rejects.toMatchObject({
      code: "undecryptable",
    });
  });

  it("refuses a record from a version it does not understand", async () => {
    const store = new FakeStore();
    store.values.set(grantSlotFor(ACCOUNT), JSON.stringify({ v: 99, directory: "D:\\X", enabled: true }));
    expect(await new InboxGrantStore(store).read(ACCOUNT)).toBeNull();
  });

  it("migrates a v1 record to ASK, and never to auto", async () => {
    // The decision that could not be taken back. A v1 record says receiving was
    // on; it says NOTHING about whether the user wanted deliveries saved
    // without being asked, because there was no such choice to make. Reading it
    // as `auto` would start writing other devices' files to their disk
    // unattended on consent they never gave.
    const store = new FakeStore();
    store.values.set(
      grantSlotFor(ACCOUNT),
      JSON.stringify({ v: 1, directory: "D:\\Inbox", enabled: true, withdrawalPending: false }),
    );
    const grant = await new InboxGrantStore(store).read(ACCOUNT);
    expect(grant).toEqual({
      directory: "D:\\Inbox",
      enabled: true,
      policy: "ask",
      withdrawalPending: false,
    });
    expect(grant?.policy).not.toBe("auto");
  });

  it("migrates a v1 record that was off to off", async () => {
    const store = new FakeStore();
    store.values.set(
      grantSlotFor(ACCOUNT),
      JSON.stringify({ v: 1, directory: "D:\\Inbox", enabled: false }),
    );
    expect((await new InboxGrantStore(store).read(ACCOUNT))?.policy).toBe("off");
  });

  it("falls back to ask rather than auto when a v2 policy is unreadable", async () => {
    const store = new FakeStore();
    store.values.set(
      grantSlotFor(ACCOUNT),
      JSON.stringify({ v: 2, directory: "D:\\Inbox", enabled: true, policy: "nonsense" }),
    );
    expect((await new InboxGrantStore(store).read(ACCOUNT))?.policy).toBe("ask");
  });

  it("keeps a record with no destination, because Off needs none", async () => {
    // Refusing it meant a user who chose Off with no folder had no durable
    // record, so the announcement could never be retried and central kept
    // whatever it was last told — possibly `auto`.
    const store = new FakeStore();
    store.values.set(
      grantSlotFor(ACCOUNT),
      JSON.stringify({ v: 2, directory: "", enabled: true, policy: "off" }),
    );
    expect(await new InboxGrantStore(store).read(ACCOUNT)).toMatchObject({
      directory: "",
      policy: "off",
    });
  });

  it("still refuses a record whose destination is not a string", async () => {
    const store = new FakeStore();
    store.values.set(grantSlotFor(ACCOUNT), JSON.stringify({ v: 2, directory: 7, enabled: true }));
    expect(await new InboxGrantStore(store).read(ACCOUNT)).toBeNull();
  });
});

describe("the at-rest key", () => {
  it("is created once and returned unchanged afterwards", async () => {
    const store = new FakeStore();
    const grants = new InboxGrantStore(store);
    const first = await grants.atRestKey(ACCOUNT);
    const second = await grants.atRestKey(ACCOUNT);
    expect(first.byteLength).toBe(AT_REST_KEY_BYTES);
    expect([...second]).toEqual([...first]);
    // One write, ever. A second would be a second key over records the first
    // one sealed.
    expect(store.putCalls).toBe(1);
  });

  it("is scoped per account", async () => {
    const store = new FakeStore();
    const grants = new InboxGrantStore(store);
    const a = await grants.atRestKey("first");
    const b = await grants.atRestKey("second");
    expect([...a]).not.toEqual([...b]);
    expect(store.values.has(atRestSlotFor("first"))).toBe(true);
    expect(store.values.has(atRestSlotFor("second"))).toBe(true);
  });

  it("refuses rather than minting a replacement when the store cannot be read", async () => {
    // A generated replacement here is unrecoverable data loss: the journal and
    // the vault were sealed to the key that is now unreadable, and a fresh one
    // makes every record in them fail authentication forever.
    const store = new FakeStore();
    store.failures.set(atRestSlotFor(ACCOUNT), "encryption-unavailable");
    await expect(new InboxGrantStore(store).atRestKey(ACCOUNT)).rejects.toMatchObject({
      code: "encryption-unavailable",
    });
    expect(store.putCalls).toBe(0);
  });

  it("refuses a stored key of the wrong length rather than replacing it", async () => {
    const store = new FakeStore();
    store.values.set(atRestSlotFor(ACCOUNT), Buffer.from("short").toString("base64"));
    await expect(new InboxGrantStore(store).atRestKey(ACCOUNT)).rejects.toMatchObject({
      code: "key-unavailable",
    });
    expect(store.putCalls).toBe(0);
  });
});
