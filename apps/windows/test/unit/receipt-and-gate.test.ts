// Two things a user acts on, driven through the composed objects rather than
// asserted as fields: what a finished receive actually says, and whether the
// verification gate is genuinely closed.

import { describe, expect, it } from "vitest";
import {
  PartialPublicationError,
  ReceiveCancelledError,
  ReceiveCoordinator,
  type ReceiveBridge,
} from "../../src/renderer/receive/receive-coordinator.js";
import type { PublishReport } from "../../src/shared/ipc-contract.js";

const MANIFEST = [
  { name: "a.txt", size: 1 },
  { name: "b.txt", size: 1 },
];

function receiveBridge(publish: () => Promise<PublishReport>): ReceiveBridge {
  return {
    open: async () => ({ leaseId: "lease-1", files: MANIFEST.length }),
    begin: async () => {},
    write: async () => {},
    finish: async () => {},
    publish,
    cancel: async () => {},
  };
}

describe("a finished receive reports what actually happened", () => {
  // Driven through the coordinator, which is where the typed outcome is
  // produced — the mapping into a receipt is asserted on the real errors rather
  // than on a hand-built object.
  const coordinator = (publish: () => Promise<PublishReport>) =>
    new ReceiveCoordinator(receiveBridge(publish), "peer-1", 1);

  it("a complete publication resolves, and is not a failure", async () => {
    const c = coordinator(async () => ({ status: "complete", publishedCount: 2, total: 2 }));
    const target = await c.open(MANIFEST);
    await expect(target.done!()).resolves.toBeUndefined();
    expect(c.phase).toBe("done");
  });

  it("a partial keeps the count of files that DO exist", async () => {
    const c = coordinator(async () => ({
      status: "partial",
      publishedCount: 1,
      total: 2,
      failedIndex: 1,
      reason: "exists",
    }));
    const target = await c.open(MANIFEST);
    const err = (await target.done!().catch((e: unknown) => e)) as PartialPublicationError;
    // The user has one file on disk. A receipt that said "nothing was saved"
    // would be wrong, and so would one that said "saved".
    expect(err.publishedCount).toBe(1);
    expect(err.total).toBe(2);
  });

  it("distinguishes a build limitation from a real write failure", async () => {
    const unsupported = coordinator(async () => ({
      status: "failed",
      reason: "unsupported",
      residue: true,
    }));
    const denied = coordinator(async () => ({
      status: "failed",
      reason: "io-failed",
      residue: false,
    }));

    const a = (await (await unsupported.open(MANIFEST)).done!().catch((e: unknown) => e)) as PartialPublicationError;
    const b = (await (await denied.open(MANIFEST)).done!().catch((e: unknown) => e)) as PartialPublicationError;

    // One sentence for every failure used to hide the second behind the first.
    expect(a.reason).toBe("unsupported");
    expect(b.reason).toBe("io-failed");
    expect(a.reason).not.toBe(b.reason);
  });

  it("never drops files that were published before a later failure", async () => {
    const c = coordinator(async () => ({
      status: "failed",
      reason: "cleanup-uncertain",
      residue: true,
      published: { publishedCount: 2, total: 2 },
    }));
    const err = (await (await c.open(MANIFEST)).done!().catch((e: unknown) => e)) as PartialPublicationError;
    expect(err.publishedCount).toBe(2);
    expect(err.residue).toBe(true);
  });

  it("reports a cancelled picker as a choice, not a failure", async () => {
    const c = new ReceiveCoordinator(
      { ...receiveBridge(async () => ({ status: "complete", publishedCount: 0, total: 0 })), open: async () => ({ cancelled: true as const }) },
      "peer-1",
      1,
    );
    await expect(c.open(MANIFEST)).rejects.toBeInstanceOf(ReceiveCancelledError);
  });
});

describe("the verification gate is closed before there is a code", () => {
  // The bypass, stated as the boolean the pane computes.
  const gate = (verifyPeers: boolean, sas: string, confirmed: boolean) => {
    const old = verifyPeers && sas !== "" && !confirmed;
    const now = verifyPeers && !confirmed;
    return { old, now };
  };

  it("was OPEN in the window before the code existed", () => {
    // `sas` is empty until authentication derives it. The old expression is
    // false there — the gate is open at exactly the moment there is nothing to
    // have verified.
    expect(gate(true, "", false).old).toBe(false);
    expect(gate(true, "", false).now).toBe(true);
  });

  it("stays closed until the user confirms, once a code exists", () => {
    expect(gate(true, "418324", false).now).toBe(true);
    expect(gate(true, "418324", true).now).toBe(false);
  });

  it("is absent entirely when the preference is off", () => {
    expect(gate(false, "", false).now).toBe(false);
    expect(gate(false, "418324", false).now).toBe(false);
  });
});
