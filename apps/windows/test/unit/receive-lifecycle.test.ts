// Who owns a receive lease, and when it stops being owned.
//
// Three authorities meet here and none of them substitutes for another:
//
//   * the ACCOUNT epoch, which fences a sign-in or sign-out;
//   * the DOCUMENT generation, which fences a reload or a renderer crash —
//     neither of which destroys the `WebContents`, so neither ever reaches
//     `dispose()`;
//   * the PUBLICATION barrier, which keeps a lease joinable while it is moving
//     files under the user's chosen names.
//
// The accepted auth lifecycle is not touched by any of this; `app-service.test.ts`
// still drives it unchanged, and the default authority is still `account`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppService,
  MAX_OWNED_RECEIVES,
  ServiceRefusal,
  type AppServiceDeps,
} from "../../src/main/app-service.js";
import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";

const ORIGIN = "https://relayium.com";
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.concat([MAGIC, Buffer.from(p, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (c) => {
    if (!c.subarray(0, 4).equals(MAGIC)) throw new Error("foreign");
    return Buffer.from(c.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MANIFEST = [{ name: "report.txt", size: 4 }];

let dir = "";
let root = "";
let leaseSeq = 0;
/** Every service a test built, so `afterEach` can tear it down. A test that
 *  leaves a lease open leaves a real file handle open, and Node now treats a
 *  handle collected by GC as an error rather than a warning. */
let built: AppService[] = [];

interface Harness {
  service: AppService;
  /** The document the service currently believes is live. */
  document: { value: number };
  /** Bump it the way `IpcRouter.revoke` does: increment, THEN notify. */
  revoke(): Promise<void>;
}

function harness(over: Partial<AppServiceDeps> = {}): Harness {
  const store = new SecretStore(join(dir, "secrets"), cipher);
  const document = { value: 0 };
  const deps: AppServiceDeps = {
    origin: ORIGIN,
    makeStore: async () => store,
    makeAuthClient: () =>
      ({
        start: async () => ({
          userCode: "WDJB-MJHT",
          deviceCode: "dc",
          verificationURL: `${ORIGIN}/device`,
          interval: 5,
          expiresIn: 600,
        }),
        poll: async () => ({ status: "ok" as const, accessToken: "tok", accountEmail: "a@b.c" }),
      }) as never,
    pickDirectory: async () => root,
    openApproval: async () => true,
    newId: () => `lease-${++leaseSeq}`,
    documentGeneration: () => document.value,
    ...over,
  };
  const service = new AppService(deps);
  built.push(service);
  return {
    service,
    document,
    revoke: async () => {
      const retiring = document.value;
      document.value += 1;
      await service.revokeDocument(retiring);
    },
  };
}

/** Whatever the destination folder holds right now, including staging. */
const contents = () => readdir(root);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-life-"));
  root = await mkdtemp(join(tmpdir(), "relayium-life-dest-"));
  leaseSeq = 0;
  built = [];
});
afterEach(async () => {
  // Before the directories go, so nothing is holding a descriptor into them.
  for (const service of built) await service.dispose().catch(() => undefined);
  built = [];
  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("a lease belongs to the document that asked for it", () => {
  it("refuses to register a lease whose picker was still open across a revoke", async () => {
    const picker = deferred<string | null>();
    const h = harness({ pickDirectory: () => picker.promise });

    const opening = h.service.openReceive(MANIFEST, "direct");
    // The user is looking at the dialog; the page reloads underneath them.
    await h.revoke();
    picker.resolve(root);

    await expect(opening).rejects.toThrow(ServiceRefusal);
    expect(h.service.openLeaseCount).toBe(0);
    // And nothing was left behind in the folder they had chosen.
    expect(await contents()).toEqual([]);
  });

  it("applies the same rule to an account lease", async () => {
    const picker = deferred<string | null>();
    const h = harness({ pickDirectory: () => picker.promise });

    const opening = h.service.openReceive(MANIFEST);
    await h.revoke();
    picker.resolve(root);

    await expect(opening).rejects.toThrow(ServiceRefusal);
    expect(h.service.openLeaseCount).toBe(0);
  });

  it("cleans up a DIRECT transfer that was mid-write when the document went away", async () => {
    const h = harness();
    const opened = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in opened) throw new Error("picker cancelled");

    await h.service.beginFile(opened.leaseId, 0);
    await h.service.writeChunk(opened.leaseId, 0, new Uint8Array([1, 2]));
    // Staged bytes exist on disk right now.
    expect((await contents()).length).toBeGreaterThan(0);

    await h.revoke();

    // A `direct` lease survives an ACCOUNT change. It does not survive the page
    // that owns it ceasing to exist: nothing is left to finish or cancel it,
    // and `dispose()` never runs for a reload.
    expect(h.service.openLeaseCount).toBe(0);
    expect(await contents()).toEqual([]);
    await expect(h.service.writeChunk(opened.leaseId, 0, new Uint8Array([3]))).rejects.toThrow(
      ServiceRefusal,
    );
  });

  it("cleans up an ACCOUNT transfer the same way", async () => {
    const h = harness();
    const opened = await h.service.openReceive(MANIFEST);
    if ("cancelled" in opened) throw new Error("picker cancelled");
    await h.service.beginFile(opened.leaseId, 0);

    await h.revoke();

    expect(h.service.openLeaseCount).toBe(0);
    expect(await contents()).toEqual([]);
  });

  it("leaves a LATER document's lease alone", async () => {
    const h = harness();
    const stale = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in stale) throw new Error("picker cancelled");

    // A reload: generation moves, then the new page opens its own transfer.
    const retiring = h.document.value;
    h.document.value += 1;
    const fresh = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in fresh) throw new Error("picker cancelled");

    await h.service.revokeDocument(retiring);

    expect(h.service.openLeaseCount).toBe(1);
    await expect(h.service.beginFile(fresh.leaseId, 0)).resolves.toBeUndefined();
  });

  it("does not revoke merely because nothing happened — a hidden window keeps its lease", async () => {
    // Hiding a window navigates nothing and kills nothing, so the generation
    // never moves. Stated as a test because R-RESIDENT depends on it.
    const h = harness();
    const opened = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in opened) throw new Error("picker cancelled");

    await new Promise((r) => setTimeout(r, 5));

    expect(h.service.openLeaseCount).toBe(1);
    await expect(h.service.beginFile(opened.leaseId, 0)).resolves.toBeUndefined();
  });
});

describe("an open in flight is owned before it exists", () => {
  it("quit does NOT hang waiting for a human-held folder dialog", async () => {
    const picker = deferred<string | null>();
    const h = harness({ pickDirectory: () => picker.promise });
    void h.service.openReceive(MANIFEST, "direct").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));

    // A picker on screen has created nothing — no helper, no staging, no
    // handle. Waiting for it would mean quit blocks until a person clicks.
    let disposed = false;
    const disposal = h.service.dispose().then(() => {
      disposed = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(disposed).toBe(true);

    // And the fence holds: the dialog resolving afterwards creates nothing.
    picker.resolve(root);
    await disposal;
    await new Promise((r) => setTimeout(r, 10));
    expect(h.service.openLeaseCount).toBe(0);
    expect(await contents()).toEqual([]);
  });

  it("a document revocation fences a picker without waiting for it", async () => {
    const picker = deferred<string | null>();
    const h = harness({ pickDirectory: () => picker.promise });
    const opening = h.service.openReceive(MANIFEST, "direct").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));

    let revoked = false;
    await h.revoke().then(() => {
      revoked = true;
    });
    expect(revoked).toBe(true);

    picker.resolve(root);
    expect(await opening).toBeInstanceOf(ServiceRefusal);
    expect(h.service.openLeaseCount).toBe(0);
    expect(await contents()).toEqual([]);
  });

  it("leaves nothing behind when the destination is created into a teardown", async () => {
    // The bounded window the teardown DOES wait for: the picker has returned
    // and a real destination is being built.
    const h = harness();
    const opening = h.service.openReceive(MANIFEST, "direct").catch((e: unknown) => e);
    await opening;
    await h.service.dispose();
    expect(await contents()).toEqual([]);
  });
});

describe("a direct transfer has no account in it", () => {
  it("opens with no session at all, so an unusable store cannot stop it", async () => {
    let storeBuilt = false;
    const h = harness({
      makeStore: async () => {
        storeBuilt = true;
        throw new Error("data root unavailable");
      },
    });

    const opened = await h.service.openReceive(MANIFEST, "direct");

    expect("leaseId" in opened).toBe(true);
    // Not merely "it worked anyway" — the session was never reached.
    expect(storeBuilt).toBe(false);
  });

  it("still requires a session for the DEFAULT account authority", async () => {
    const h = harness({ makeStore: async () => Promise.reject(new Error("data root unavailable")) });
    await expect(h.service.openReceive(MANIFEST)).rejects.toThrow(/data root unavailable/);
  });

  it("survives a sign-in that cancels every account lease", async () => {
    const h = harness();
    const direct = await h.service.openReceive(MANIFEST, "direct");
    const account = await h.service.openReceive(MANIFEST);
    if ("cancelled" in direct || "cancelled" in account) throw new Error("picker cancelled");

    const nonce = "nonce-signin";
    await h.service.startSignIn(nonce);
    await h.service.pollSignIn(nonce);

    // The account lease is gone, exactly as the accepted behaviour requires.
    await expect(h.service.beginFile(account.leaseId, 0)).rejects.toThrow(ServiceRefusal);
    // The direct one is not: two machines transferring between themselves are
    // unaffected by one of them signing in.
    await expect(h.service.beginFile(direct.leaseId, 0)).resolves.toBeUndefined();
  });

  it("survives a sign-out too", async () => {
    const h = harness();
    const direct = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in direct) throw new Error("picker cancelled");

    await h.service.signOut();

    await expect(h.service.beginFile(direct.leaseId, 0)).resolves.toBeUndefined();
  });

  it("is still cancelled by quit", async () => {
    const h = harness();
    const direct = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in direct) throw new Error("picker cancelled");
    await h.service.beginFile(direct.leaseId, 0);

    await h.service.dispose();

    expect(await contents()).toEqual([]);
  });
});

describe("which destination production actually opens", () => {
  it("uses the injected one when a caller supplies it", async () => {
    let asked = 0;
    const h = harness({
      makeDestination: async (options) => {
        asked += 1;
        expect(options.rootPath).toBe(root);
        const { ReceiveLease } = await import("../../src/main/io/receive-lease.js");
        const { LeaseReceiveAdapter } = await import("../../src/main/net/native-receive-adapter.js");
        return new LeaseReceiveAdapter(await ReceiveLease.open(options));
      },
    });
    await h.service.openReceive(MANIFEST, "direct");
    expect(asked).toBe(1);
  });

  it("never opens a ReceiveLease alongside another destination", async () => {
    // Two destinations for one batch means a staging directory nothing writes
    // to and nothing cleans up.
    const h = harness({
      makeDestination: async () => ({
        fileCount: 1,
        assertAuthority: () => {},
        begin: async () => {},
        write: async () => {},
        finish: async () => {},
        publish: async () => ({ status: "failed" as const, reason: "unsupported" as const, residue: false }),
        cancel: async () => {},
      }),
    });
    await h.service.openReceive(MANIFEST, "direct");
    // The chosen folder is untouched: no staging directory was created.
    expect(await contents()).toEqual([]);
  });
});

describe("publication is a barrier, not a fire-and-forget", () => {
  /** A lease with every file staged, ready for its terminal step. */
  async function staged(h: Harness, authority: "account" | "direct" = "direct") {
    const opened = await h.service.openReceive(MANIFEST, authority);
    if ("cancelled" in opened) throw new Error("picker cancelled");
    await h.service.beginFile(opened.leaseId, 0);
    await h.service.writeChunk(opened.leaseId, 0, new Uint8Array([1, 2, 3, 4]));
    await h.service.finishFile(opened.leaseId, 0);
    return opened.leaseId;
  }

  it("refuses honestly rather than reporting a save this build cannot perform", async () => {
    const h = harness();
    const leaseId = await staged(h);

    // No native publisher ships yet, and the portable adapter says so as a
    // NAMED failure — never softened into a `partial`, which would claim some
    // files were written under their final names, and never thrown, because a
    // thrown error loses every field crossing Electron IPC.
    const report = await h.service.publishReceive(leaseId);
    expect(report).toEqual({ status: "failed", reason: "unsupported", residue: true });
    // And the staged bytes are this app's to remove.
    expect(await contents()).toEqual([]);
    expect(h.service.openLeaseCount).toBe(0);
  });

  it("refuses a second publication while the first is still running", async () => {
    const picker = deferred<string | null>();
    const h = harness({ pickDirectory: () => picker.promise });
    picker.resolve(root);
    const leaseId = await staged(h);

    const first = h.service.publishReceive(leaseId).catch(() => "failed");
    const second = h.service.publishReceive(leaseId).catch((err: unknown) => err);

    await first;
    expect(await second).toBeInstanceOf(ServiceRefusal);
  });

  it("refuses ordinary work on a lease whose publication has begun", async () => {
    const h = harness();
    const leaseId = await staged(h);
    const publishing = h.service.publishReceive(leaseId).catch(() => undefined);
    // Synchronously after the call, the lease is terminal.
    await expect(h.service.writeChunk(leaseId, 0, new Uint8Array([9]))).rejects.toThrow(
      ServiceRefusal,
    );
    await publishing;
  });

  it("an account transition does not return while an account publication is unjoined", async () => {
    let releaseCancel!: () => void;
    const held = new Promise<void>((r) => {
      releaseCancel = r;
    });

    const h = harness();
    const leaseId = await staged(h, "account");

    // Hold the lease's own terminal cleanup open, so the publication is
    // genuinely still in flight while the transition runs.
    const service = h.service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void>; publish(): Promise<unknown> } }>;
    };
    const entry = service.leases.get(leaseId)!;
    const realCancel = entry.adapter.cancel.bind(entry.adapter);
    entry.adapter.cancel = async () => {
      await held;
      await realCancel();
    };

    const publishing = h.service.publishReceive(leaseId).catch(() => "failed");

    let transitionDone = false;
    const signIn = (async () => {
      const nonce = "nonce-join";
      await h.service.startSignIn(nonce);
      await h.service.pollSignIn(nonce);
      transitionDone = true;
    })();

    // Give the transition every chance to finish early. It must not: it has an
    // account lease whose publication is still writing.
    await new Promise((r) => setTimeout(r, 20));
    expect(transitionDone).toBe(false);

    releaseCancel();
    await publishing;
    await signIn;
    expect(transitionDone).toBe(true);
  });

  it("quit joins a publication rather than returning around it", async () => {
    let releaseCancel!: () => void;
    const held = new Promise<void>((r) => {
      releaseCancel = r;
    });

    const h = harness();
    const leaseId = await staged(h, "direct");
    const service = h.service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void> } }>;
    };
    const entry = service.leases.get(leaseId)!;
    const realCancel = entry.adapter.cancel.bind(entry.adapter);
    entry.adapter.cancel = async () => {
      await held;
      await realCancel();
    };

    const publishing = h.service.publishReceive(leaseId).catch(() => "failed");
    let disposed = false;
    const disposal = h.service.dispose().then(() => {
      disposed = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(disposed).toBe(false);

    releaseCancel();
    await publishing;
    await disposal;
    expect(disposed).toBe(true);
  });

  /** Hold one lease's terminal cleanup open so a publication stays unsettled. */
  function holdCleanup(service: AppService, leaseId: string) {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const internal = service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void> } }>;
    };
    const entry = internal.leases.get(leaseId)!;
    const real = entry.adapter.cancel.bind(entry.adapter);
    let settled = false;
    entry.adapter.cancel = async () => {
      await held;
      await real();
      settled = true;
    };
    return { release, settled: () => settled };
  }

  // ## The failure these three close
  //
  // An explicit cancel removes the lease from the map, correctly — no further
  // work may be accepted. But the files are still this process's until that
  // cancel finishes, and a teardown that consulted only the map found nothing
  // and returned. Reproduced against the compiled service before the fix, and
  // independently by root: `dispose` returned while the cancelled publication
  // was still running.

  it("quit joins a publication an explicit cancel already took ownership of", async () => {
    const h = harness();
    const leaseId = await staged(h, "direct");
    const hold = holdCleanup(h.service, leaseId);

    const publishing = h.service.publishReceive(leaseId).catch(() => "failed");
    // The renderer cancels mid-publication. The entry leaves the map here.
    const cancelling = h.service.cancelReceive(leaseId).catch(() => "cancel-failed");

    let disposed = false;
    const disposal = h.service.dispose().then(() => {
      disposed = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(hold.settled()).toBe(false);
    expect(disposed).toBe(false);

    hold.release();
    await Promise.all([publishing, cancelling, disposal]);
    expect(disposed).toBe(true);
  });

  it("a document revocation joins one an explicit cancel already took", async () => {
    const h = harness();
    const leaseId = await staged(h, "direct");
    const hold = holdCleanup(h.service, leaseId);

    const publishing = h.service.publishReceive(leaseId).catch(() => "failed");
    const cancelling = h.service.cancelReceive(leaseId).catch(() => "cancel-failed");

    let revoked = false;
    const revoking = h.revoke().then(() => {
      revoked = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(revoked).toBe(false);

    hold.release();
    await Promise.all([publishing, cancelling, revoking]);
    expect(revoked).toBe(true);
  });

  it("an account transition joins one an explicit cancel already took", async () => {
    const h = harness();
    const leaseId = await staged(h, "account");
    const hold = holdCleanup(h.service, leaseId);

    const publishing = h.service.publishReceive(leaseId).catch(() => "failed");
    const cancelling = h.service.cancelReceive(leaseId).catch(() => "cancel-failed");

    let transitioned = false;
    const signIn = (async () => {
      const nonce = "nonce-join-cancel";
      await h.service.startSignIn(nonce);
      await h.service.pollSignIn(nonce);
      transitioned = true;
    })();

    await new Promise((r) => setTimeout(r, 20));
    expect(transitioned).toBe(false);

    hold.release();
    await Promise.all([publishing, cancelling, signIn]);
    expect(transitioned).toBe(true);
  });

  it("retires a lease exactly once however many callers ask", async () => {
    const h = harness();
    const opened = await h.service.openReceive(MANIFEST, "direct");
    if ("cancelled" in opened) throw new Error("picker cancelled");

    const internal = h.service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void> } }>;
    };
    const entry = internal.leases.get(opened.leaseId)!;
    const real = entry.adapter.cancel.bind(entry.adapter);
    let calls = 0;
    entry.adapter.cancel = async () => {
      calls += 1;
      await real();
    };

    // Two teardowns racing for the same files would each run a cancel.
    await Promise.all([
      h.service.cancelReceive(opened.leaseId).catch(() => undefined),
      h.service.dispose(),
    ]);

    expect(calls).toBe(1);
  });

  it("surfaces a cleanup failure the publication's own catch could not report", async () => {
    const h = harness();
    const leaseId = await staged(h, "direct");

    const internal = h.service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void> } }>;
    };
    const entry = internal.leases.get(leaseId)!;
    const real = entry.adapter.cancel.bind(entry.adapter);
    // The real cleanup runs and THEN reports failure — a partial removal, which
    // is the shape a failing disk actually produces. Replacing it outright
    // would model a cleanup that never ran at all.
    entry.adapter.cancel = async () => {
      await real();
      throw new Error("could not remove staged bytes");
    };

    // The caller is told about the PUBLICATION outcome, which is the accurate
    // one for them.
    expect(await h.service.publishReceive(leaseId)).toMatchObject({ status: "failed" });

    // But the cleanup failure is not lost: bytes are still in the user's folder
    // and the next teardown says so, naming the reason.
    await expect(h.service.dispose()).rejects.toThrow(/could not remove staged bytes/);
  });

  it("keeps what it RETAINS bounded, keeps the leases, and refuses to grow", async () => {
    const h = harness();
    const internal = h.service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void> } }>;
      retiring: Set<{ cleanupAttempts: number; lastCleanupReason: string | null }>;
    };

    for (let i = 0; i < MAX_OWNED_RECEIVES; i += 1) {
      const leaseId = await staged(h, "direct");
      const entry = internal.leases.get(leaseId)!;
      const real = entry.adapter.cancel.bind(entry.adapter);
      entry.adapter.cancel = async () => {
        await real();
        throw new Error(`failure number ${i}`);
      };
      await h.service.publishReceive(leaseId).catch(() => undefined);
    }

    // Every one of those failed its first cleanup. Every one is still OWNED —
    // its adapter is the only thing that could ever close its destination — and
    // what each retains is a truncated STRING, not an `Error` pinning a stack
    // and whatever its closure captured, on a path a failing disk drives
    // repeatedly, in the privileged process.
    expect(internal.retiring.size).toBe(MAX_OWNED_RECEIVES);
    for (const entry of internal.retiring) {
      expect(entry.cleanupAttempts).toBe(1);
      expect(entry.lastCleanupReason).toMatch(/^failure number \d+$/);
    }

    // Growth stops at the ADMISSION boundary rather than by evicting one of
    // them: refusing a new transfer costs a truthful error, releasing an owned
    // destination to keep a number small costs a handle nothing can close.
    await expect(h.service.openReceive(MANIFEST, "direct")).rejects.toThrow(
      /too many transfers are still open/,
    );

    // Each teardown is one more attempt each, and is honest about what is still
    // open rather than reporting a clean sweep over it.
    await expect(h.service.revokeDocument(0)).rejects.toThrow(
      new RegExp(`could not clean up ${MAX_OWNED_RECEIVES} transfer\\(s\\)`),
    );
    for (const entry of internal.retiring) expect(entry.cleanupAttempts).toBe(2);

    // And they are still owned afterwards. Dropping them because two attempts
    // is "enough" would put back exactly the failure this closes, and would do
    // it to the destinations most likely to still be open.
    expect(internal.retiring.size).toBe(MAX_OWNED_RECEIVES);
    await expect(h.service.dispose()).rejects.toThrow(/could not clean up transfers on shutdown/);
  });

  it("a revocation joins a publication rather than racing it for the same files", async () => {
    let releaseCancel!: () => void;
    const held = new Promise<void>((r) => {
      releaseCancel = r;
    });

    const h = harness();
    const leaseId = await staged(h, "direct");
    const service = h.service as unknown as {
      leases: Map<string, { adapter: { cancel(): Promise<void> } }>;
    };
    const entry = service.leases.get(leaseId)!;
    const realCancel = entry.adapter.cancel.bind(entry.adapter);
    entry.adapter.cancel = async () => {
      await held;
      await realCancel();
    };

    const publishing = h.service.publishReceive(leaseId).catch(() => "failed");
    let revoked = false;
    const revoking = h.revoke().then(() => {
      revoked = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(revoked).toBe(false);

    releaseCancel();
    await publishing;
    await revoking;
    expect(revoked).toBe(true);
    expect(await contents()).toEqual([]);
  });
});
