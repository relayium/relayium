// Who owns an incoming batch.
//
// The first two describes are the assertions root's independent probe drives
// (`root-receive-coordinator-review/probe.mjs`): a cleanup rejection must not
// resolve clean, and a cancel must join a picker that has not returned. Both
// FAILED against the previous implementation. They are anchors, not
// self-confirmation — the probe is the external one and this is the resident
// regression.

import { describe, expect, it, vi } from "vitest";
import {
  ManifestMismatchError,
  PartialPublicationError,
  ReceiveCancelledError,
  ReceiveCleanupError,
  ReceiveCoordinator,
  type ReceiveBridge,
} from "../../src/renderer/receive/receive-coordinator.js";
import type { PublishReport } from "../../src/shared/ipc-contract.js";

const MANIFEST = [
  { name: "a.txt", size: 4 },
  { name: "b.txt", size: 8 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeBridge(over: Partial<ReceiveBridge> = {}) {
  const calls: string[] = [];
  const bridge: ReceiveBridge = {
    open: async () => {
      calls.push("open");
      return { leaseId: "lease-1", files: MANIFEST.length };
    },
    begin: async ({ index }) => {
      calls.push(`begin:${index}`);
    },
    write: async ({ index }) => {
      calls.push(`write:${index}`);
    },
    finish: async ({ index }) => {
      calls.push(`finish:${index}`);
    },
    publish: async (): Promise<PublishReport> => {
      calls.push("publish");
      return { status: "complete", publishedCount: 2, total: 2 };
    },
    cancel: async () => {
      calls.push("cancel");
    },
    ...over,
  };
  return { bridge, calls };
}

const make = (bridge: ReceiveBridge) => new ReceiveCoordinator(bridge, "peer-1", 3);

describe("a cleanup failure is never reported as clean", () => {
  it("rejects with a typed error carrying the lease", async () => {
    const { bridge } = fakeBridge({
      cancel: async () => {
        throw new Error("staging directory busy");
      },
    });
    const coordinator = make(bridge);
    await coordinator.open(MANIFEST);

    // A teardown that reported success over a folder it had left files in is
    // exactly the failure the lifetime rules exist to make impossible.
    const failure = await coordinator.cancel().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ReceiveCleanupError);
    expect((failure as ReceiveCleanupError).leaseId).toBe("lease-1");
  });

  it("gives every joiner the same failure", async () => {
    const { bridge } = fakeBridge({
      cancel: async () => {
        throw new Error("nope");
      },
    });
    const coordinator = make(bridge);
    await coordinator.open(MANIFEST);
    const first = coordinator.cancel().catch((e: unknown) => e);
    const second = coordinator.cancel().catch((e: unknown) => e);
    expect(await first).toBe(await second);
  });

  it("resolves cleanly when cleanup genuinely succeeds", async () => {
    const { bridge, calls } = fakeBridge();
    const coordinator = make(bridge);
    await coordinator.open(MANIFEST);
    await expect(coordinator.cancel()).resolves.toBeUndefined();
    expect(calls).toContain("cancel");
  });
});

describe("cancel joins a picker that has not returned", () => {
  it("does not settle while the native picker is still open", async () => {
    const picker = deferred<{ leaseId: string; files: number }>();
    const { bridge, calls } = fakeBridge({ open: () => picker.promise });
    const coordinator = make(bridge);

    const opening = coordinator.open(MANIFEST).catch(() => "cancelled");
    let cancelSettled = false;
    const cancelling = coordinator.cancel().then(() => {
      cancelSettled = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    // Resolving here would let the picker return afterwards and install a live
    // lease into a room that is already gone.
    expect(cancelSettled).toBe(false);

    picker.resolve({ leaseId: "lease-1", files: 2 });
    await Promise.all([opening, cancelling]);

    expect(cancelSettled).toBe(true);
    // And the lease the picker produced was cancelled, not abandoned.
    expect(calls).toContain("cancel");
  });

  it("refuses the target the late picker produced", async () => {
    const picker = deferred<{ leaseId: string; files: number }>();
    const { bridge } = fakeBridge({ open: () => picker.promise });
    const coordinator = make(bridge);

    const opening = coordinator.open(MANIFEST);
    void coordinator.cancel();
    picker.resolve({ leaseId: "lease-1", files: 2 });

    await expect(opening).rejects.toBeInstanceOf(ReceiveCancelledError);
  });

  it("settles immediately when there is nothing open yet", async () => {
    const { bridge, calls } = fakeBridge();
    await make(bridge).cancel();
    expect(calls).not.toContain("cancel");
  });
});

describe("the manifest is checked, not assumed", () => {
  it("refuses a file the manifest does not name at that position", async () => {
    // An unchecked index writes one file's bytes into another's planned name,
    // and nothing downstream notices: the size is enforced per index, so the
    // user gets a correctly-sized file with the wrong contents.
    const { bridge } = fakeBridge();
    const target = await make(bridge).open(MANIFEST);
    await expect(target.file("wrong.txt", 4)).rejects.toBeInstanceOf(ManifestMismatchError);
  });

  it("refuses a size that disagrees with the manifest", async () => {
    const { bridge } = fakeBridge();
    const target = await make(bridge).open(MANIFEST);
    await expect(target.file("a.txt", 999)).rejects.toBeInstanceOf(ManifestMismatchError);
  });

  it("refuses more files than the manifest declared", async () => {
    const { bridge } = fakeBridge();
    const target = await make(bridge).open(MANIFEST);
    await target.file("a.txt", 4);
    await target.file("b.txt", 8);
    await expect(target.file("c.txt", 1)).rejects.toBeInstanceOf(ManifestMismatchError);
  });

  it("accepts the manifest in order and indexes it accordingly", async () => {
    const { bridge, calls } = fakeBridge();
    const target = await make(bridge).open(MANIFEST);
    const first = await target.file("a.txt", 4);
    await first.write(new Uint8Array([1]));
    await first.close();
    const second = await target.file("b.txt", 8);
    await second.close();
    expect(calls).toEqual(["open", "begin:0", "write:0", "finish:0", "begin:1", "finish:1"]);
  });
});

describe("publication is the only thing that means saved", () => {
  it("resolves only on complete", async () => {
    const { bridge } = fakeBridge();
    const coordinator = make(bridge);
    const target = await coordinator.open(MANIFEST);
    await expect(target.done!()).resolves.toBeUndefined();
    expect(coordinator.retired).toBe(true);
  });

  it("REJECTS a partial, carrying the truthful counts", async () => {
    const { bridge } = fakeBridge({
      publish: async () => ({
        status: "partial",
        publishedCount: 1,
        total: 2,
        failedIndex: 1,
        reason: "exists",
      }),
    });
    const target = await make(bridge).open(MANIFEST);
    const err = await target.done!().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialPublicationError);
    expect((err as PartialPublicationError).publishedCount).toBe(1);
    expect((err as PartialPublicationError).total).toBe(2);
  });

  it("surfaces a typed failure rather than softening it to partial", async () => {
    // The interim `unsupported` answer, delivered as a RESULT because a thrown
    // error loses every custom property crossing Electron IPC.
    const { bridge } = fakeBridge({
      publish: async () => ({ status: "failed" as const, reason: "unsupported" as const, residue: true }),
    });
    const target = await make(bridge).open(MANIFEST);
    const err = await target.done!().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialPublicationError);
    expect((err as PartialPublicationError).publishedCount).toBe(0);
    expect((err as PartialPublicationError).residue).toBe(true);
  });

  it("preserves the receipt when publication succeeded and only cleanup failed", async () => {
    // Those files exist under their final names. An error about cleanup must
    // not report them as unsaved.
    const { bridge } = fakeBridge({
      publish: async () => ({
        status: "failed" as const,
        reason: "cleanup-uncertain" as const,
        residue: true,
        published: { publishedCount: 2, total: 2 },
      }),
    });
    const target = await make(bridge).open(MANIFEST);
    const err = (await target.done!().catch((e: unknown) => e)) as PartialPublicationError;
    expect(err.publishedCount).toBe(2);
    expect(err.total).toBe(2);
    expect(err.residue).toBe(true);
  });

  it("does not cancel a lease publication already took", async () => {
    const { bridge, calls } = fakeBridge();
    const coordinator = make(bridge);
    const target = await coordinator.open(MANIFEST);
    await target.done!();
    await coordinator.cancel();
    // Main forgot the lease at publish; cancelling it would be an error on a
    // lease id that no longer exists.
    expect(calls.filter((c) => c === "cancel")).toHaveLength(0);
  });

  it("declares the batch bundled, so 'saved N of M' stays honest", async () => {
    const { bridge } = fakeBridge();
    const target = await make(bridge).open(MANIFEST);
    expect(target.bundled).toBe(true);
    // Never claims local commit while publication still refuses.
    expect(target.delivery).toBeUndefined();
  });
});

describe("cancellation is checked after every await, not only before", () => {
  it("rejects a write that resumes after a cancel", async () => {
    const gate = deferred<void>();
    const { bridge } = fakeBridge({
      write: async () => {
        await gate.promise;
      },
    });
    const coordinator = make(bridge);
    const target = await coordinator.open(MANIFEST);
    const sink = await target.file("a.txt", 4);

    const writing = sink.write(new Uint8Array([1])).catch((e: unknown) => e);
    void coordinator.cancel();
    gate.resolve();

    expect(await writing).toBeInstanceOf(ReceiveCancelledError);
  });

  it("refuses a new file after cancellation", async () => {
    const { bridge } = fakeBridge();
    const coordinator = make(bridge);
    const target = await coordinator.open(MANIFEST);
    await coordinator.cancel();
    await expect(target.file("a.txt", 4)).rejects.toBeInstanceOf(ReceiveCancelledError);
  });
});

describe("identity", () => {
  it("remembers the peer and link generation it was created for", () => {
    const { bridge } = fakeBridge();
    const coordinator = new ReceiveCoordinator(bridge, "peer-9", 7);
    // What lets an owner cancel THIS batch without touching another peer's.
    expect(coordinator.peerId).toBe("peer-9");
    expect(coordinator.linkGeneration).toBe(7);
  });

  it("reports a user-cancelled picker as terminal, not as a failure to retain", async () => {
    const { bridge } = fakeBridge({ open: async () => ({ cancelled: true as const }) });
    const coordinator = make(bridge);
    await expect(coordinator.open(MANIFEST)).rejects.toBeInstanceOf(ReceiveCancelledError);
    expect(coordinator.retired).toBe(true);
  });
});

describe("no browser fallback", () => {
  it("never reaches a Chromium download", async () => {
    // The renderer has no download UI. A `SaveTarget` that fell through to the
    // browser's own picker would hand bytes to a download the user cannot see
    // and then report it as saved.
    const showSaveFilePicker = vi.fn();
    vi.stubGlobal("showSaveFilePicker", showSaveFilePicker);
    const { bridge } = fakeBridge();
    const target = await make(bridge).open(MANIFEST);
    const sink = await target.file("a.txt", 4);
    await sink.write(new Uint8Array([1, 2, 3, 4]));
    await sink.close();
    expect(showSaveFilePicker).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
