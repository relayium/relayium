// The "open the folder" button, from the publication that earns it to the press
// that opens it.
//
// ## What this exercises, and what it deliberately does not restate
//
// `issueReceipt` is the REAL policy the IPC handler calls, and the registry
// underneath is the REAL `ReceiptRegistry`. Nothing here reimplements either.
// That matters more than usual: a previous review found a consent test that had
// been written as a handwritten copy of the host's logic, which would have
// stayed green through any regression in the host itself. The same mistake here
// would leave the app free to offer a reveal for a failed transfer.
//
// What is faked is the filesystem and the shell, because those are the two
// things a unit test cannot have: `directoryUsable` stands in for a `stat` and
// `openDirectory` for `shell.openPath`. The contract between them and the
// registry — that `openDirectory` THROWS when the reveal did not happen — is
// the one the host's adapter honours, and it is exercised in both directions.

import { describe, expect, it } from "vitest";
import { issueReceipt, type ReceiveTarget } from "../../src/main/features/receive-receipts.js";
import { ReceiptRegistry, type ReceiptOwner } from "../../src/main/io/receipt-registry.js";
import { isReceiptToken, type ReceiveReceipt } from "../../src/shared/receive-receipt.js";
import type { PublishReport } from "../../src/shared/ipc-contract.js";

const DEST = "C:\\Users\\sam\\Downloads\\Relayium";
const OTHER = "C:\\Users\\sam\\Desktop";

function owner(over: Partial<ReceiptOwner> = {}): ReceiptOwner {
  return { authority: "direct", epoch: 1, document: 7, ...over };
}

/** The host, as far as this feature is concerned. One registry, one emitter. */
function host(over: {
  document?: number;
  epoch?: number;
  admissionClosed?: boolean;
  usable?: (dir: string) => Promise<boolean>;
  open?: (dir: string) => Promise<void>;
} = {}) {
  const opened: string[] = [];
  const state = {
    document: over.document ?? 7,
    epoch: over.epoch ?? 1,
    admissionClosed: over.admissionClosed ?? false,
  };
  const registry = new ReceiptRegistry({
    currentDocument: () => state.document,
    currentEpoch: () => state.epoch,
    admissionClosed: () => state.admissionClosed,
    directoryUsable: over.usable ?? (async () => true),
    openDirectory:
      over.open ??
      (async (dir) => {
        opened.push(dir);
      }),
  });
  const pushed: { document: number; receipt: ReceiveReceipt }[] = [];
  const issue = (report: PublishReport, target: ReceiveTarget | null) =>
    issueReceipt(report, target, {
      register: (directory, who, fileCount) => registry.register(directory, who, fileCount),
      emit: (document, receipt) => {
        pushed.push({ document, receipt });
      },
    });
  return { registry, pushed, opened, issue, state };
}

const complete = (n: number): PublishReport => ({ status: "complete", publishedCount: n, total: n });

describe("a receipt is issued only for a publication that actually completed", () => {
  it("mints one for a complete publish, bound to the count that was saved", () => {
    const h = host();
    const receipt = h.issue(complete(3), { directory: DEST, owner: owner() });
    expect(receipt).not.toBeNull();
    expect(receipt?.fileCount).toBe(3);
    // Opaque: 64 hex characters, and nothing resembling the folder.
    expect(isReceiptToken(receipt?.token)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("Downloads");
  });

  it("issues NOTHING for a partial publish, even though files exist", () => {
    const h = host();
    const report: PublishReport = {
      status: "partial",
      publishedCount: 2,
      total: 5,
      failedIndex: 2,
      reason: "conflict",
    };
    expect(h.issue(report, { directory: DEST, owner: owner() })).toBeNull();
    expect(h.pushed).toHaveLength(0);
    expect(h.registry.size).toBe(0);
  });

  it("issues NOTHING for a failed publish", () => {
    const h = host();
    const report: PublishReport = { status: "failed", reason: "io-failed", residue: true };
    expect(h.issue(report, { directory: DEST, owner: owner() })).toBeNull();
    expect(h.registry.size).toBe(0);
  });

  it("issues NOTHING for a publication the user cancelled", () => {
    // `cancelled` is a publish FAILURE reason in this build, not a separate
    // status. Named on its own because it is the one a person causes, and the
    // one they are most likely to be looking at the screen for.
    const h = host();
    const report: PublishReport = { status: "failed", reason: "cancelled", residue: false };
    expect(h.issue(report, { directory: DEST, owner: owner() })).toBeNull();
    expect(h.pushed).toHaveLength(0);
    expect(h.registry.size).toBe(0);
  });

  it("issues NOTHING for a failed publish that nevertheless published", () => {
    // The subtle one. Publication succeeded and only the teardown after it
    // failed, so the files ARE under their final names — and the user is still
    // being shown a failure. A reveal beside that sentence would contradict it.
    const h = host();
    const report: PublishReport = {
      status: "failed",
      reason: "internal",
      residue: true,
      published: { publishedCount: 4, total: 4 },
    };
    expect(h.issue(report, { directory: DEST, owner: owner() })).toBeNull();
    expect(h.registry.size).toBe(0);
  });

  it("issues nothing when the lease could not be identified", () => {
    // A cancelled receive is retired before it publishes, so there is no target
    // to read. Nothing honest can be minted from that.
    const h = host();
    expect(h.issue(complete(2), null)).toBeNull();
    expect(h.pushed).toHaveLength(0);
  });
});

describe("the receipt reaches the document that asked, and only that one", () => {
  it("pushes on the ORIGINATING document, not the current one", () => {
    const h = host({ document: 9 });
    // The receive was started by document 7; the window has since reloaded.
    h.issue(complete(1), { directory: DEST, owner: owner({ document: 7 }) });
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.document).toBe(7);
  });
});

describe("redeeming a receipt", () => {
  it("opens the folder that receive actually used", async () => {
    const h = host();
    const receipt = h.issue(complete(2), { directory: DEST, owner: owner() });
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({ kind: "revealed" });
    expect(h.opened).toEqual([DEST]);
  });

  it("binds each token to its own folder", async () => {
    const h = host();
    const first = h.issue(complete(1), { directory: DEST, owner: owner() });
    const second = h.issue(complete(1), { directory: OTHER, owner: owner() });
    await h.registry.reveal(second?.token);
    await h.registry.reveal(first?.token);
    expect(h.opened).toEqual([OTHER, DEST]);
  });

  it("refuses a token this process never minted", async () => {
    const h = host();
    h.issue(complete(1), { directory: DEST, owner: owner() });
    await expect(h.registry.reveal("f".repeat(64))).resolves.toEqual({
      kind: "refused",
      reason: "unknown",
    });
    expect(h.opened).toHaveLength(0);
  });

  it("refuses a value that is not a token at all, without touching the disk", async () => {
    const h = host({
      usable: async () => {
        throw new Error("stat must not be reached");
      },
    });
    for (const junk of [undefined, null, 42, DEST, "../../etc", "F".repeat(64)]) {
      await expect(h.registry.reveal(junk)).resolves.toEqual({ kind: "refused", reason: "unknown" });
    }
  });

  it("refuses once the document that asked has been replaced", async () => {
    const h = host();
    const receipt = h.issue(complete(1), { directory: DEST, owner: owner({ document: 7 }) });
    h.state.document = 8;
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({
      kind: "refused",
      reason: "stale",
    });
    expect(h.opened).toHaveLength(0);
    // Dropped, not merely refused: it can never become valid again, so a later
    // resume must not resurrect it.
    expect(h.registry.size).toBe(0);
  });

  it("retires an ACCOUNT receipt when the account changes", async () => {
    const h = host();
    const receipt = h.issue(complete(1), {
      directory: DEST,
      owner: owner({ authority: "account", epoch: 4 }),
    });
    h.state.epoch = 5;
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({
      kind: "refused",
      reason: "stale",
    });
  });

  it("keeps a DIRECT receipt across an account change", async () => {
    // Nobody's account authorised a LAN receive, so no account change retires
    // it. Clearing these too would take away a button that still works.
    const h = host();
    const receipt = h.issue(complete(1), { directory: DEST, owner: owner({ authority: "direct" }) });
    h.state.epoch = 99;
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({ kind: "revealed" });
  });

  it("stops holding retired receipts when the wiring invalidates them", () => {
    const h = host();
    h.issue(complete(1), { directory: DEST, owner: owner({ authority: "account", epoch: 4 }) });
    h.issue(complete(1), { directory: OTHER, owner: owner({ authority: "direct", epoch: 4 }) });
    expect(h.registry.size).toBe(2);
    h.state.epoch = 5;
    h.registry.invalidateStale();
    // The direct one survives; the account-bound one is no longer held.
    expect(h.registry.size).toBe(1);
  });

  it("refuses while the app is shutting down, and does not open anything", async () => {
    const h = host();
    const receipt = h.issue(complete(1), { directory: DEST, owner: owner() });
    h.state.admissionClosed = true;
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({
      kind: "refused",
      reason: "fenced",
    });
    expect(h.opened).toHaveLength(0);
    // Recoverable. The user stayed, so the button works again.
    h.state.admissionClosed = false;
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({ kind: "revealed" });
  });

  it("says `missing` for a folder that is no longer there", async () => {
    const h = host({ usable: async () => false });
    const receipt = h.issue(complete(1), { directory: DEST, owner: owner() });
    await expect(h.registry.reveal(receipt?.token)).resolves.toEqual({
      kind: "refused",
      reason: "missing",
    });
    expect(h.opened).toHaveLength(0);
  });

  it("reports a shell refusal as `failed` and never repeats its text", async () => {
    // The adapter's contract: `shell.openPath` reports failure by RETURNING a
    // non-empty string, and that string routinely contains the path. The host
    // turns it into a throw; the registry must not look at what it says.
    const h = host({
      open: async () => {
        throw new Error(`Failed to open path C:\\Users\\sam\\Downloads\\Relayium`);
      },
    });
    const receipt = h.issue(complete(1), { directory: DEST, owner: owner() });
    const outcome = await h.registry.reveal(receipt?.token);
    expect(outcome).toEqual({ kind: "refused", reason: "failed" });
    expect(JSON.stringify(outcome)).not.toContain("Downloads");
  });
});
