// Who owns Device Inbox receiving, and what stops it.
//
// SCOPE: fakes for the network and the folder dialog, the REAL built runtime
// bundle, the REAL facade, the REAL stores and a REAL temp directory. So an
// assertion here is a side effect — an enrolment that was sent, a key that was
// written, a dialog that was or was not opened, a teardown that returned only
// after the work it aborted had stopped. An acknowledgement would prove nothing.
//
// The scheduling is driven rather than waited on: every backoff is set to an
// hour so nothing fires on its own, and `wake()` steps exactly one pass. That
// makes "the loop kept going with nobody looking at it" a fact this file can
// state, instead of a sleep that passes for the wrong reason.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPOSED_FEATURES,
  INBOX_BACKOFF,
  InboxService,
  inboxRetryDelay,
  type InboxAuthority,
  type InboxServiceDeps,
} from "../../src/main/features/inbox.js";
import { grantSlotFor } from "../../src/main/features/inbox-grant.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";
import type { InboxView } from "../../src/shared/ipc-contract.js";

async function realRuntime(): Promise<InboxRuntime> {
  resetInboxRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  return inboxRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

const roots: string[] = [];
const services: InboxService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inbox-feature-"));
  roots.push(root);
  return root;
}

/** Wait for a condition the loop produces, without a fixed sleep. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface EnrolSeen {
  readonly capabilities: readonly string[];
  readonly autoAccept: string;
  readonly receiveDirReady: boolean;
  readonly platform: string;
}

/** A stand-in for `InboxApi` that records what was actually sent. */
function fakeApi(
  over: {
    failEnrol?: () => boolean;
    failDelete?: () => boolean;
    hold?: () => Promise<void> | null;
    /** Suspends the withdrawal, so the acknowledgement can be raced. */
    holdDelete?: () => Promise<void> | null;
  } = {},
) {
  const calls = {
    enrol: 0,
    heartbeat: 0,
    pending: 0,
    claim: 0,
    deleteInbox: 0,
    registerKey: 0,
    accept: [] as { taskID: string; accept: boolean }[],
  };
  let lastEnrol: EnrolSeen | null = null;
  /** Signals handed to in-flight calls, so a test can prove an abort landed. */
  const signals: AbortSignal[] = [];

  const api = {
    async enrol(request: EnrolSeen, signal: AbortSignal) {
      signals.push(signal);
      calls.enrol += 1;
      lastEnrol = request;
      if (over.failEnrol?.()) throw Object.assign(new Error("refused"), { code: "server-refused" });
      return { protocolVersion: 3, receiveCapability: "inbox.receive.v3", keyAlgorithm: "x25519" };
    },
    async deleteInbox(signal: AbortSignal) {
      signals.push(signal);
      calls.deleteInbox += 1;
      const held = over.holdDelete?.();
      if (held) await held;
      if (over.failDelete?.()) throw Object.assign(new Error("offline"), { code: "transport" });
    },
    async registerKey() {
      calls.registerKey += 1;
      return { ID: "key-1" };
    },
    async listKeys() {
      return [];
    },
    async pending(_limit: number, signal: AbortSignal) {
      signals.push(signal);
      calls.pending += 1;
      return { tasks: [], leaseSeconds: 60, heartbeatIntervalSecs: 30 };
    },
    async accept(taskID: string, accept: boolean) {
      calls.accept.push({ taskID, accept });
      return {};
    },
    async claim(_max: number, signal: AbortSignal) {
      signals.push(signal);
      calls.claim += 1;
      return { deliveries: [], leaseSeconds: 60 };
    },
    async report() {
      return { State: "saved", Terminal: true, SavedAt: 1 };
    },
    async currentDevice() {
      return { ID: "dev-1", Name: "A PC" };
    },
    async blob() {
      throw new Error("not used");
    },
    async renameDevice(name: string) {
      return name;
    },
    async heartbeat(receiveDirReady: boolean, signal: AbortSignal) {
      signals.push(signal);
      calls.heartbeat += 1;
      const held = over.hold?.();
      if (held) await held;
      return { presence: "online", intervalSeconds: 30 };
    },
  };
  return { api, calls, signals, enrolled: () => lastEnrol };
}

interface Harness {
  readonly service: InboxService;
  readonly calls: ReturnType<typeof fakeApi>["calls"];
  readonly signals: AbortSignal[];
  readonly enrolled: () => EnrolSeen | null;
  readonly states: InboxView[];
  readonly secrets: Map<string, string>;
  authority: InboxAuthority;
  epoch: number;
  picked: string | null;
  hold: Promise<void> | null;
  holdSecret: Promise<void> | null;
  secretEntered: (() => void) | null;
  usable: boolean;
  document: number;
  device: { id: string; name: string };
  readonly dialogs: () => number;
  readonly destinations: () => number;
  /** Every string a copy actually put on the clipboard, in order. */
  readonly clipboard: readonly string[];
  /** The task-owned data root, so a test can seed the real vault under it. */
  readonly dataRoot: string;
  /** The same encrypted store the service uses, for the same reason. */
  readonly slot: {
    get(key: string): Promise<string>;
    put(key: string, value: string): Promise<void>;
    putIfAbsent(key: string, value: string): Promise<{ created: boolean; value: string }>;
  };
}

async function harness(
  over: {
    grant?: { directory: string; enabled: boolean; withdrawalPending: boolean };
    apiOptions?: Parameters<typeof fakeApi>[0];
    authority?: InboxAuthority;
    start?: boolean;
  } = {},
): Promise<Harness> {
  const root = await tempRoot();
  const runtime = await realRuntime();
  const built = fakeApi(over.apiOptions ?? {});
  const secrets = new Map<string, string>();
  const states: InboxView[] = [];
  let dialogs = 0;
  let destinations = 0;
  const clipboard: string[] = [];

  const state = {
    authority: over.authority ?? ({ kind: "ok", bearer: "bearer", epoch: 1 } as InboxAuthority),
    epoch: 1,
    picked: `${root}/chosen` as string | null,
    hold: null as Promise<void> | null,
    holdSecret: null as Promise<void> | null,
    secretEntered: null as (() => void) | null,
    usable: true,
    document: 1,
    device: { id: "dev-1", name: "A PC" },
  };

  // The account digest the service will derive: sha256(deviceID) truncated, the
  // same derivation `captureAccount` performs. Written here so a preset grant
  // lands where the service will look for it.
  const { createHash } = await import("node:crypto");
  const accountKey = createHash("sha256").update(state.device.id, "utf8").digest("hex").slice(0, 32);
  if (over.grant) secrets.set(grantSlotFor(accountKey), JSON.stringify({ v: 1, ...over.grant }));

  const slot = {
    async get(key: string) {
      const value = secrets.get(key);
      if (value === undefined) throw Object.assign(new Error("not-found"), { code: "not-found" });
      return value;
    },
    async put(key: string, value: string) {
      secrets.set(key, value);
    },
    async delete(key: string) {
      secrets.delete(key);
    },
    async putIfAbsent(key: string, value: string) {
      // Suspended on demand. The vault fetches its at-rest key through here on
      // its first read, which is the only place a test can hold a message read
      // open long enough for a document to be replaced underneath it.
      if (state.holdSecret !== null && key.startsWith("inbox-at-rest-")) {
        state.secretEntered?.();
        await state.holdSecret;
      }
      const existing = secrets.get(key);
      if (existing !== undefined) return { created: false, value: existing };
      secrets.set(key, value);
      return { created: true, value };
    },
  };

  const deps: InboxServiceDeps = {
    origin: "https://relayium.com",
    dataRoot: () => root,
    platform: "windows",
    appVersion: "0.0.1",
    authority: async () => state.authority,
    accountEpoch: () => state.epoch,
    currentDocument: () => state.document,
    grantSlot: async () => slot,
    keySlot: async () => slot,
    async pickDirectory() {
      dialogs += 1;
      // Suspended on demand, because a native folder dialog IS a suspension:
      // it parks for as long as a person leaves it open, and everything the
      // user does meanwhile happens in that window.
      if (state.hold !== null) await state.hold;
      return state.picked;
    },
    runtime: async () => runtime,
    makeApi: () => built.api as never,
    resolveDevice: async () => state.device,
    directoryUsable: async () => state.usable,
    async makeDestination() {
      destinations += 1;
      return {
        fileCount: 0,
        assertAuthority() {},
        async begin() {},
        async write() {},
        async finish() {},
        async publish() {
          return { status: "complete", publishedCount: 0, total: 0 } as const;
        },
        async cancel() {},
      };
    },
    // An hour on every arm, so nothing fires on its own and `wake()` steps
    // exactly one pass.
    backoff: { idle: 3600, afterWork: 3600, first: 3600, cap: 3600, blocked: 3600 },
    onState: (view) => states.push(view),
    reportFailure: () => undefined,
    writeClipboard: (text) => {
      clipboard.push(text);
    },
  };

  const service = new InboxService(deps);
  services.push(service);
  if (over.start !== false) service.start();
  return {
    service,
    calls: built.calls,
    signals: built.signals,
    enrolled: built.enrolled,
    states,
    secrets,
    get authority() {
      return state.authority;
    },
    set authority(next: InboxAuthority) {
      state.authority = next;
    },
    get epoch() {
      return state.epoch;
    },
    set epoch(next: number) {
      state.epoch = next;
    },
    get picked() {
      return state.picked;
    },
    set picked(next: string | null) {
      state.picked = next;
    },
    get hold() {
      return state.hold;
    },
    set hold(next: Promise<void> | null) {
      state.hold = next;
    },
    get holdSecret() {
      return state.holdSecret;
    },
    set holdSecret(next: Promise<void> | null) {
      state.holdSecret = next;
    },
    get secretEntered() {
      return state.secretEntered;
    },
    set secretEntered(next: (() => void) | null) {
      state.secretEntered = next;
    },
    get document() {
      return state.document;
    },
    set document(next: number) {
      state.document = next;
    },
    get usable() {
      return state.usable;
    },
    set usable(next: boolean) {
      state.usable = next;
    },
    get device() {
      return state.device;
    },
    set device(next: { id: string; name: string }) {
      state.device = next;
    },
    dialogs: () => dialogs,
    destinations: () => destinations,
    clipboard,
    dataRoot: root,
    slot,
  };
}


/**
 * Put one message in the account's REAL vault.
 *
 * Written through the shipped store with the at-rest key the shipped grant
 * store mints, so a copy or an open below reads it back through the real
 * decryption rather than through a stand-in.
 */
async function seedMessage(h: Harness, id: string, text: string): Promise<void> {
  const { captureAccount } = await import("../../src/main/inbox/account.js");
  const { InboxFiles } = await import("../../src/main/inbox/files.js");
  const { MessageVault } = await import("../../src/main/inbox/vault.js");
  const { InboxGrantStore } = await import("../../src/main/features/inbox-grant.js");
  const context = captureAccount({
    accountID: h.device.id,
    deviceID: h.device.id,
    epoch: h.epoch,
    inboxRoot: `${h.dataRoot}/inbox`,
  });
  const grants = new InboxGrantStore(h.slot);
  const vault = new MessageVault(context, new InboxFiles(context), () => grants.atRestKey(context.accountKey));
  await vault.saveText({
    id,
    taskID: `task-${id}`,
    sourceDeviceID: "another-device",
    plaintext: new TextEncoder().encode(text),
    now: 1_700_000_000,
  });
}

const status = (h: Harness): string => h.service.view().status.kind;

// ---------------------------------------------------------------------------

describe("the backoff", () => {
  it("is the Mac's, value for value", () => {
    expect(INBOX_BACKOFF).toEqual({ idle: 30, afterWork: 2, first: 5, cap: 300, blocked: 60 });
  });

  it("doubles from the first retry and holds at the ceiling", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => inboxRetryDelay(INBOX_BACKOFF, n));
    expect(delays).toEqual([30, 5, 10, 20, 40, 80, 160, 300]);
  });

  it("cannot produce a non-finite interval after a long outage", () => {
    // The failure this shape exists to prevent: `first * 2 ** failures` reaches
    // `Infinity` around 1030 failures, and a sleep of an unrepresentable length
    // is a STOPPED inbox rather than a slow one.
    for (const failures of [100, 1_000, 10_000, Number.MAX_SAFE_INTEGER]) {
      const delay = inboxRetryDelay(INBOX_BACKOFF, failures);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(300);
    }
  });
});

describe("what this build advertises", () => {
  it("promises only what the host actually composes", () => {
    // Auto-accept is false and must stay false: there is no control for it on
    // this client, so advertising it would tell central this device may take
    // deliveries without anybody being asked.
    expect(COMPOSED_FEATURES).toEqual({ files: true, text: true, autoAccept: false });
  });

  it("sends exactly the composed capabilities when it enrols", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    const sent = h.enrolled();
    expect(sent?.capabilities).toEqual(["inbox.receive.v3", "inbox.text.v1"]);
    // `ask`, never `off`: `off` makes central refuse every send to this device,
    // which is not what a person who turned receiving on asked for.
    expect(sent?.autoAccept).toBe("ask");
    expect(sent?.capabilities).not.toContain("inbox.autoaccept.v1");
    expect(sent?.platform).toBe("windows");
  });
});

describe("the guards, in the order the Mac has them", () => {
  it("starts disabled and enrols nothing", async () => {
    const h = await harness();
    await waitFor("the first pass", () => status(h) === "disabled");
    expect(h.calls.enrol).toBe(0);
    expect(h.calls.heartbeat).toBe(0);
    expect(h.calls.pending).toBe(0);
    expect(h.service.view().enabled).toBe(false);
  });

  it("says needs-account rather than disabled when nobody is signed in", async () => {
    const h = await harness({ authority: { kind: "signed-out" } });
    await waitFor("the account guard", () => status(h) === "needs-account");
    expect(h.calls.enrol).toBe(0);
  });

  it("keeps an unreadable store distinct from a sign-out", async () => {
    // The enrolment may still be live on the server, so this must not read as
    // "signed out" — which is an invitation to switch a feature on that is
    // already on.
    const h = await harness({ authority: { kind: "unavailable" } });
    await waitFor("the store guard", () => status(h) === "account-unreadable");
    expect(h.service.view().enabled).toBe(false);
  });

  it("says folder-missing, never disabled and never idle, when the folder is gone", async () => {
    const h = await harness({ grant: { directory: "/gone", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0 || status(h) === "folder-missing");
    h.usable = false;
    h.service.wake();
    await waitFor("the folder guard", () => status(h) === "folder-missing");
    // The user's answer is still their answer.
    expect(h.service.view().enabled).toBe(true);
    const before = h.calls.heartbeat;
    h.service.wake();
    await waitFor("another pass", () => h.calls.pending === h.calls.pending);
    // And nothing is claimed while there is nowhere to put it.
    expect(h.calls.heartbeat).toBe(before);
  });
});

describe("consent", () => {
  it("asks for a folder, records it, and only then enrols", async () => {
    const h = await harness();
    await waitFor("the disabled guard", () => status(h) === "disabled");
    expect(h.dialogs()).toBe(0);

    const outcome = await h.service.enable();
    expect(outcome).toEqual({ kind: "enabled" });
    expect(h.dialogs()).toBe(1);
    expect(h.calls.enrol).toBe(1);
    expect(h.service.view().enabled).toBe(true);
    expect(h.service.view().hasDestination).toBe(true);
  });

  it("enrols nothing when the dialog is closed", async () => {
    const h = await harness();
    await waitFor("the disabled guard", () => status(h) === "disabled");
    h.picked = null;

    expect(await h.service.enable()).toEqual({ kind: "declined" });
    expect(h.calls.enrol).toBe(0);
    expect(h.service.view().enabled).toBe(false);
    // Nothing was written, so a restart does not resume a consent nobody gave.
    expect([...h.secrets.keys()].some((key) => key.startsWith("inbox-grant-"))).toBe(false);
  });

  it("enrols nothing when the chosen folder cannot be prepared", async () => {
    // "A failure preparing the directory must not enrol a fictitious receiver."
    const h = await harness();
    await waitFor("the disabled guard", () => status(h) === "disabled");
    h.usable = false;

    expect(await h.service.enable()).toEqual({ kind: "declined" });
    expect(h.calls.enrol).toBe(0);
    expect([...h.secrets.keys()].some((key) => key.startsWith("inbox-grant-"))).toBe(false);
  });

  it("never lets the renderer name a destination", async () => {
    // There is no argument on any of these that could carry one: the dialog is
    // the only source, and the page is told a boolean.
    const h = await harness();
    await waitFor("the disabled guard", () => status(h) === "disabled");
    await h.service.enable();
    expect(h.service.view()).not.toHaveProperty("directory");
    expect(JSON.stringify(h.service.view())).not.toContain("chosen");
  });
});

describe("turning it off", () => {
  it("stops locally and durably before central is told", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);

    expect(await h.service.disable()).toEqual({ kind: "disabled" });
    expect(h.calls.deleteInbox).toBe(1);
    const stored = JSON.parse([...h.secrets.entries()].find(([k]) => k.startsWith("inbox-grant-"))![1]) as {
      enabled: boolean;
      withdrawalPending: boolean;
    };
    expect(stored.enabled).toBe(false);
    expect(stored.withdrawalPending).toBe(false);
  });

  it("keeps the withdrawal pending and says so when central cannot be reached", async () => {
    let failing = true;
    const h = await harness({
      grant: { directory: "/chosen", enabled: true, withdrawalPending: false },
      apiOptions: { failDelete: () => failing },
    });
    await waitFor("the enrolment", () => h.calls.enrol > 0);

    const outcome = await h.service.disable();
    expect(outcome.kind).toBe("still-enrolled");
    expect(h.service.view().withdrawalPending).toBe(true);

    // Off is ANNOUNCED, not gone quiet: the next tick retries, and success
    // clears the marker rather than leaving it pending forever.
    failing = false;
    const before = h.calls.deleteInbox;
    h.service.wake();
    await waitFor("the retried withdrawal", () => h.calls.deleteInbox > before);
    await waitFor("the cleared marker", () => !h.service.view().withdrawalPending);
  });

  it("erases nothing local", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    const keysBefore = [...h.secrets.keys()].filter((key) => key.startsWith("inbox-keys-"));
    // Enrolling generated and stored this device's key pair.
    expect(keysBefore.length).toBe(1);
    const before = new Map([...h.secrets.entries()].filter(([key]) => key.startsWith("inbox-keys-")));

    await h.service.disable();
    // The private key history is still there, byte for byte: a queued delivery
    // names the key it was sealed to, and destroying it makes every one of them
    // permanently unopenable. An unread message is the user's for the same
    // reason, and neither is deleted by turning a switch off.
    expect(new Map([...h.secrets.entries()].filter(([key]) => key.startsWith("inbox-keys-")))).toEqual(before);
    // Nothing was removed at all — only the grant was rewritten.
    expect([...h.secrets.keys()].filter((key) => key.startsWith("inbox-keys-"))).toEqual(keysBefore);
  });
});

describe("the scheduler belongs to the application", () => {
  it("keeps passing with nobody asking it to", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the first pass", () => h.calls.pending > 0);
    const first = h.calls.pending;
    for (let i = 0; i < 3; i += 1) {
      h.service.wake();
      await waitFor(`pass ${String(i + 2)}`, () => h.calls.pending > first + i);
    }
    expect(h.calls.pending).toBeGreaterThanOrEqual(first + 3);
    // And it enrolled once, not once per pass.
    expect(h.calls.enrol).toBe(1);
  });

  it("cannot be started twice", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the first pass", () => h.calls.pending > 0);
    // A remounting component cannot create a second loop — there is nothing on
    // the renderer's surface that starts one, and `start` is idempotent even
    // from inside main.
    h.service.start();
    h.service.start();
    const before = h.calls.pending;
    h.service.wake();
    await waitFor("one more pass", () => h.calls.pending > before);
    expect(h.calls.pending).toBe(before + 1);
  });
});

describe("the quit fence", () => {
  it("refuses new work synchronously, before any dialog opens", async () => {
    const h = await harness();
    await waitFor("the disabled guard", () => status(h) === "disabled");
    h.service.fence();

    expect(await h.service.enable()).toEqual({ kind: "refused" });
    // The point: a quit prompt is on screen and no folder dialog appeared
    // behind it, and nothing was enrolled while a human was reading a question.
    expect(h.dialogs()).toBe(0);
    expect(h.calls.enrol).toBe(0);
  });

  it("stops the loop, joins what is running, and a Stay resumes it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const h = await harness({
      grant: { directory: "/chosen", enabled: true, withdrawalPending: false },
      apiOptions: { hold: () => (holding ? held : null) },
    });
    await waitFor("a pass to be in flight", () => h.calls.heartbeat > 0);

    let joined = false;
    const stopping = h.service.quiesce().then(() => {
      joined = true;
    });
    // The abort has already landed on the in-flight call — synchronously, before
    // the join — but the join does not return while it is still running.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.signals.some((signal) => signal.aborted)).toBe(true);
    expect(joined).toBe(false);

    holding = false;
    release();
    await stopping;
    expect(joined).toBe(true);

    const after = h.calls.pending;
    h.service.wake();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Fenced: waking a stopped scheduler does not restart it.
    expect(h.calls.pending).toBe(after);

    h.service.resume();
    await waitFor("the resumed loop", () => h.calls.pending > after);
  });
});

describe("an account change", () => {
  it("invalidates before it joins, and rebinds to the new account", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the first enrolment", () => h.calls.enrol > 0);

    h.epoch = 2;
    h.device = { id: "dev-2", name: "Another PC" };
    h.authority = { kind: "ok", bearer: "second-bearer", epoch: 2 };
    h.service.onAuthorityChanged();

    // Synchronously: the old binding is already gone as far as admission is
    // concerned, so nothing can be started under an account that has left.
    expect(await h.service.accept("anything")).toEqual({ kind: "not-enabled" });

    await waitFor("the new binding", () => h.service.view().deviceName === "Another PC");
    // A second account starts DISABLED: consent is per account, and the first
    // account's yes is not the second's.
    await waitFor("the new account's own guard", () => status(h) === "disabled");
    expect(h.calls.enrol).toBe(1);
  });

  it("does not stop receiving when only the document changed", async () => {
    // A reload replaces the document and fires the same watcher. Background
    // receiving must survive it — that is the resident invariant.
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    const name = h.service.view().deviceName;

    h.service.onAuthorityChanged(); // same epoch: a document change

    const before = h.calls.pending;
    h.service.wake();
    await waitFor("the loop still running", () => h.calls.pending > before);
    expect(h.service.view().deviceName).toBe(name);
    // Not re-enrolled: the binding was never torn down.
    expect(h.calls.enrol).toBe(1);
  });

  it("aborts an in-flight operation rather than letting it finish under a new account", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const h = await harness({
      grant: { directory: "/chosen", enabled: true, withdrawalPending: false },
      apiOptions: { hold: () => (holding ? held : null) },
    });
    await waitFor("a pass to be in flight", () => h.calls.heartbeat > 0);

    h.epoch = 2;
    h.service.onAuthorityChanged();
    expect(h.signals.some((signal) => signal.aborted)).toBe(true);

    holding = false;
    release();
    // And the teardown is joinable: disposing returns only once the aborted
    // work has actually stopped.
    await h.service.dispose();
  });
});

describe("what the page may ask for", () => {
  it("refuses to accept a delivery central never offered", async () => {
    // The renderer names a task; it does not supply the idempotency key or the
    // creation time, which is what the dedup horizon compares against. An id
    // this process has not seen from central cannot be accepted at all.
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    expect(await h.service.accept("invented-task")).toEqual({ kind: "already-settled" });
    expect(h.calls.accept).toEqual([]);
  });

  it("pushes state only when it actually changed", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the first pass", () => h.calls.pending > 0);
    await waitFor("a settled state", () => status(h) === "idle");
    const seen = h.states.length;

    for (let i = 0; i < 3; i += 1) {
      const before = h.calls.pending;
      h.service.wake();
      await waitFor("another pass", () => h.calls.pending > before);
    }
    // Three more identical passes are not three more pushes to the renderer.
    expect(h.states.length).toBe(seen);
  });

  it("answers a page that asks before anything has been bound", async () => {
    const h = await harness({ start: false });
    expect(h.service.view().status.kind).toBe("starting");
    expect(h.service.pending()).toEqual([]);
    expect(h.service.retained()).toEqual([]);
    expect(h.service.inventory()).toEqual({ active: 0, retained: [] });
  });
});

describe("the quit fence holds for the WHOLE pass, not just its entry", () => {
  it("admits no new claim after a fence that landed mid-pass", async () => {
    // The window this closes: a pass is already past the loop's entry check and
    // parked in a network call. A quit fences, asks the user what is at stake,
    // and gets "nothing" — and then the parked pass wakes up and claims and
    // downloads a delivery the prompt never mentioned.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const h = await harness({
      grant: { directory: "/chosen", enabled: true, withdrawalPending: false },
      apiOptions: { hold: () => (holding ? held : null) },
    });
    await waitFor("a pass parked in the heartbeat", () => h.calls.heartbeat > 0);
    expect(h.calls.claim).toBe(0);

    // The quit fences while the pass is suspended.
    h.service.fence();
    holding = false;
    release();

    // Give the resumed pass every chance to go on and claim.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.calls.claim).toBe(0);
    expect(h.calls.pending).toBe(0);

    // And the fence did not CANCEL the work that was already running: the
    // in-flight heartbeat was allowed to finish, because a fence is a refusal
    // to admit and not a teardown.
    expect(h.signals.every((signal) => !signal.aborted)).toBe(true);

    // Stay: admission comes back and the next pass does claim.
    h.service.resume();
    await waitFor("the resumed pass to claim", () => h.calls.claim > 0);
  });

  it("shows nothing new starting once the prompt is up", async () => {
    // The risk snapshot's side of the same window. Nothing is receiving, so the
    // prompt truthfully says nothing is at stake — and it must still be true
    // after the parked pass resumes.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const h = await harness({
      grant: { directory: "/chosen", enabled: true, withdrawalPending: false },
      apiOptions: { hold: () => (holding ? held : null) },
    });
    await waitFor("a pass parked in the heartbeat", () => h.calls.heartbeat > 0);

    h.service.fence();
    expect(h.service.inventory().active).toBe(0);
    holding = false;
    release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.service.inventory().active).toBe(0);
    expect(h.calls.claim).toBe(0);
  });
});

describe("two consent changes that overlap", () => {
  it("does not let a folder dialog re-enable what a later disable turned off", async () => {
    // A person opens the folder dialog, leaves it, turns receiving off from
    // somewhere else, and only then answers the dialog. Without an ordering
    // rule the answered dialog writes `enabled: true` over the disable and
    // re-enrols a device the user just withdrew.
    let answer!: () => void;
    const dialog = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const h = await harness({ grant: { directory: "/chosen", enabled: false, withdrawalPending: false } });
    await waitFor("the disabled guard", () => status(h) === "disabled");

    h.hold = dialog;
    const enabling = h.service.enable();
    await waitFor("the dialog to open", () => h.dialogs() > 0);

    // The user turns it off while the dialog is still on screen.
    const disabled = await h.service.disable();
    expect(disabled.kind).toBe("disabled");

    // And only now answers the dialog.
    h.hold = null;
    answer();
    const enabled = await enabling;

    expect(enabled).toEqual({ kind: "superseded" });
    expect(h.service.view().enabled).toBe(false);
    expect(h.calls.enrol).toBe(0);
    const stored = JSON.parse(
      [...h.secrets.entries()].find(([key]) => key.startsWith("inbox-grant-"))![1],
    ) as { enabled: boolean };
    // The DURABLE record, which is what a restart reads.
    expect(stored.enabled).toBe(false);
  });

  it("does not let a folder change re-enable what a later disable turned off", async () => {
    // The same hazard through `chooseFolder`, which merges rather than
    // replaces: merging into a snapshot taken before the dialog opened carries
    // that snapshot's `enabled: true` back over the disable.
    let answer!: () => void;
    const dialog = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const h = await harness({ grant: { directory: "/first", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);

    h.hold = dialog;
    h.picked = "/second";
    const choosing = h.service.chooseFolder();
    await waitFor("the dialog to open", () => h.dialogs() > 0);

    expect((await h.service.disable()).kind).toBe("disabled");

    h.hold = null;
    answer();
    await choosing;

    expect(h.service.view().enabled).toBe(false);
    const stored = JSON.parse(
      [...h.secrets.entries()].find(([key]) => key.startsWith("inbox-grant-"))![1],
    ) as { enabled: boolean; directory: string };
    expect(stored.enabled).toBe(false);
  });

  it("keeps a destination a concurrent change persisted", async () => {
    // The mirror of the rule above: turning receiving off must not discard the
    // folder the user chose, because turning it back on should not have to ask
    // again.
    const h = await harness({ grant: { directory: "/first", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);

    h.picked = "/second";
    expect((await h.service.chooseFolder()).kind).toBe("ok");
    expect((await h.service.disable()).kind).toBe("disabled");

    const stored = JSON.parse(
      [...h.secrets.entries()].find(([key]) => key.startsWith("inbox-grant-"))![1],
    ) as { enabled: boolean; directory: string };
    expect(stored.directory).toBe("/second");
    expect(stored.enabled).toBe(false);
  });
});

describe("a withdrawal acknowledgement that lands late", () => {
  it("does not revert a destination chosen while it was in flight", async () => {
    // `deleteInbox` takes as long as the network takes. If the acknowledgement
    // writes the record it snapshotted BEFORE that call, a folder the user
    // chose in the meantime is silently replaced by the old one — an
    // acknowledgement about enrolment quietly undoing something else.
    let finishDelete!: () => void;
    const deleting = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    let holdingDelete = true;
    const h = await harness({
      grant: { directory: "/first", enabled: true, withdrawalPending: false },
      apiOptions: { holdDelete: () => (holdingDelete ? deleting : null) },
    });
    await waitFor("the enrolment", () => h.calls.enrol > 0);

    const disabling = h.service.disable();
    await waitFor("the withdrawal to be in flight", () => h.calls.deleteInbox > 0);

    // The user picks a new folder while the withdrawal is still going.
    h.picked = "/second";
    expect((await h.service.chooseFolder()).kind).toBe("ok");

    holdingDelete = false;
    finishDelete();
    expect((await disabling).kind).toBe("disabled");

    const stored = JSON.parse(
      [...h.secrets.entries()].find(([key]) => key.startsWith("inbox-grant-"))![1],
    ) as { enabled: boolean; directory: string; withdrawalPending: boolean };
    expect(stored.directory).toBe("/second");
    expect(stored.enabled).toBe(false);
    expect(stored.withdrawalPending).toBe(false);
  });

  it("does not revert consent the user restored while it was in flight", async () => {
    // The other direction: the withdrawal finally succeeds, and by then the
    // user has turned receiving back on. The acknowledgement owns one boolean
    // and must not carry `enabled: false` back over their answer.
    let finishDelete!: () => void;
    const deleting = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    let holdingDelete = true;
    const h = await harness({
      grant: { directory: "/first", enabled: true, withdrawalPending: false },
      apiOptions: { holdDelete: () => (holdingDelete ? deleting : null) },
    });
    await waitFor("the enrolment", () => h.calls.enrol > 0);

    const disabling = h.service.disable();
    await waitFor("the withdrawal to be in flight", () => h.calls.deleteInbox > 0);

    h.picked = "/second";
    // NOT awaited before the withdrawal is released, and that is a fact about
    // the product rather than about the test: the facade serialises the remote
    // authority calls of one binding, so a fresh enrolment cannot overtake a
    // withdrawal that is still in flight. Awaiting it here would wait for the
    // very call this scenario is holding.
    const enabling = h.service.enable();
    await waitFor("the enable to persist its consent", () => h.service.view().enabled);

    holdingDelete = false;
    finishDelete();
    expect((await enabling).kind).toBe("enabled");
    await disabling;

    const stored = JSON.parse(
      [...h.secrets.entries()].find(([key]) => key.startsWith("inbox-grant-"))![1],
    ) as { enabled: boolean; directory: string };
    expect(stored.enabled).toBe(true);
    expect(stored.directory).toBe("/second");
    expect(h.service.view().enabled).toBe(true);
  });

  it("clears the pending marker from the scheduler's retry without reverting anything else", async () => {
    let failing = true;
    const h = await harness({
      grant: { directory: "/first", enabled: false, withdrawalPending: true },
      apiOptions: { failDelete: () => failing },
    });
    await waitFor("the first retry", () => h.calls.deleteInbox > 0);
    expect(h.service.view().withdrawalPending).toBe(true);

    // A folder chosen while the withdrawal is still unconfirmed.
    h.picked = "/second";
    expect((await h.service.chooseFolder()).kind).toBe("ok");

    failing = false;
    h.service.wake();
    await waitFor("the marker to clear", () => !h.service.view().withdrawalPending);

    const stored = JSON.parse(
      [...h.secrets.entries()].find(([key]) => key.startsWith("inbox-grant-"))![1],
    ) as { enabled: boolean; directory: string; withdrawalPending: boolean };
    expect(stored.directory).toBe("/second");
    expect(stored.enabled).toBe(false);
    expect(stored.withdrawalPending).toBe(false);
  });
});

describe("copying a message", () => {
  it("writes the message's actual bytes, from main", async () => {
    // The renderer names the message and never supplies its text: there is no
    // channel here that takes a string and puts it on the clipboard, and
    // `window.ts` denies the browser clipboard permission outright.
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    await seedMessage(h, "msg-1", "hello from the phone");

    expect(await h.service.copyMessage("msg-1", h.document)).toEqual({ kind: "ok" });
    expect(h.clipboard).toEqual(["hello from the phone"]);
  });

  it("refuses after the account has gone away", async () => {
    // A copy that resumed under a new account would put the previous account's
    // message on the clipboard of whoever is using the app now.
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    await seedMessage(h, "msg-1", "private");

    h.epoch = 2;
    h.service.onAuthorityChanged();

    expect(await h.service.copyMessage("msg-1", h.document)).toEqual({
      kind: "failed",
      reason: "account-changed",
    });
    expect(h.clipboard).toEqual([]);
  });

  it("refuses while a quit is being decided", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    await seedMessage(h, "msg-1", "private");

    h.service.fence();
    expect(await h.service.copyMessage("msg-1", h.document)).toEqual({ kind: "refused" });
    expect(h.clipboard).toEqual([]);
  });

  it("puts nothing on the clipboard for a message that is not there", async () => {
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    const outcome = await h.service.copyMessage("no-such-message", h.document);
    expect(outcome.kind).toBe("failed");
    expect(h.clipboard).toEqual([]);
  });

  it("does not write the clipboard for a page that has been replaced", async () => {
    // A reload is not an account change, and the scheduler deliberately ignores
    // it — that is what makes receiving survive one. A copy is different: it is
    // a side effect a specific page asked for, visible OUTSIDE the app, and the
    // page that asked is gone. Held at the vault's key read, replaced, released.
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    await seedMessage(h, "msg-1", "private");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    h.secretEntered = () => {
      entered = true;
    };
    h.holdSecret = held;

    const copying = h.service.copyMessage("msg-1", h.document);
    await waitFor("the vault read to be in flight", () => entered);

    // The page reloads while the message is being opened.
    h.document = 2;
    h.holdSecret = null;
    release();

    expect(await copying).toEqual({ kind: "failed", reason: "cancelled" });
    expect(h.clipboard).toEqual([]);
  });

  it("still copies for the document that actually asked", async () => {
    // The control case, so the guard above is not merely refusing everything.
    const h = await harness({ grant: { directory: "/chosen", enabled: true, withdrawalPending: false } });
    await waitFor("the enrolment", () => h.calls.enrol > 0);
    await seedMessage(h, "msg-1", "still mine");
    h.document = 7;
    expect(await h.service.copyMessage("msg-1", 7)).toEqual({ kind: "ok" });
    expect(h.clipboard).toEqual(["still mine"]);
  });
});
