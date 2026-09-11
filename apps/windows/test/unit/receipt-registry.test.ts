// The receipt registry: what it hands out, what it refuses, and what it forgets.
//
// ## What these tests cannot establish
//
// **Nothing here shows that a receipt is only issued after a real publication.**
// The registry is handed a directory and told a receive finished; it has no way
// to check that and does not claim to. "Register only after publish succeeded"
// is the WIRING's contract, and it has to be proven where the mint happens. A
// green file here would be equally green against a caller that minted at the
// wrong moment.
//
// What it does establish is everything the registry itself decides: the shape
// of what crosses, which receipts stop being valid and when, that a path is
// re-checked against the real filesystem at the moment of use, and that a
// failure to open is reported as a failure rather than as success.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import {
  RECEIPT_CAPACITY,
  ReceiptRegistry,
  type ReceiptOwner,
  type ReceiptRegistryDeps,
} from "../../src/main/io/receipt-registry.js";
import { isReceiptToken } from "../../src/shared/receive-receipt.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-receipt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const OWNER: ReceiptOwner = { authority: "account", epoch: 1, document: 7 };
const DIRECT: ReceiptOwner = { authority: "direct", epoch: 0, document: 7 };

/** A real `stat`, so the filesystem cases are answered by the filesystem. */
const realDirectoryUsable = async (path: string) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

function makeRegistry(overrides: Partial<ReceiptRegistryDeps> = {}) {
  const opened: string[] = [];
  const state = { document: 7, epoch: 1, fenced: false };
  const deps: ReceiptRegistryDeps = {
    currentDocument: () => state.document,
    currentEpoch: () => state.epoch,
    admissionClosed: () => state.fenced,
    directoryUsable: realDirectoryUsable,
    openDirectory: async (path) => {
      opened.push(path);
    },
    ...overrides,
  };
  return { registry: new ReceiptRegistry(deps), opened, state };
}

describe("what crosses to the page", () => {
  it("is a token and a count, and never a path or a name", () => {
    const { registry } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 3);
    expect(receipt).not.toBeNull();
    expect(receipt!.fileCount).toBe(3);
    // The whole object, serialised: the directory must not be reachable from it
    // by any key, including one added later without thinking about this.
    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain(dir);
    expect(Object.keys(receipt!).sort()).toEqual(["fileCount", "token"]);
  });

  it("issues an opaque token of the declared shape", () => {
    const { registry } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    expect(isReceiptToken(receipt.token)).toBe(true);
  });

  it("never issues the same token twice", () => {
    const { registry } = makeRegistry();
    const tokens = new Set(
      Array.from({ length: 200 }, () => registry.register(dir, OWNER, 1)!.token),
    );
    expect(tokens.size).toBe(200);
  });

  it("hands out nothing for an empty directory", () => {
    const { registry } = makeRegistry();
    // A caller bug rather than a state worth encoding: there is no folder to
    // show, so there must be no button offering to show one.
    expect(registry.register("", OWNER, 1)).toBeNull();
  });
});

describe("revealing", () => {
  it("opens the directory the receipt was registered with", async () => {
    const { registry, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    await expect(registry.reveal(receipt.token)).resolves.toEqual({ kind: "revealed" });
    expect(opened).toEqual([dir]);
  });

  it("can be revealed more than once while it is still valid", async () => {
    const { registry, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    await registry.reveal(receipt.token);
    await registry.reveal(receipt.token);
    // A user who clicks the button twice gets the folder twice.
    expect(opened).toHaveLength(2);
  });

  it("refuses a token it never issued, without touching the disk", async () => {
    const usable = vi.fn(realDirectoryUsable);
    const { registry } = makeRegistry({ directoryUsable: usable });
    await expect(registry.reveal("f".repeat(64))).resolves.toEqual({
      kind: "refused", reason: "unknown",
    });
    expect(usable).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a token at all", async () => {
    const { registry } = makeRegistry();
    for (const bad of [undefined, null, 42, {}, [], "", "../../etc", dir, "g".repeat(64)]) {
      await expect(registry.reveal(bad)).resolves.toEqual({ kind: "refused", reason: "unknown" });
    }
  });
});

describe("a receipt stops being valid", () => {
  it("when the document that authorised it has been replaced", async () => {
    const { registry, state, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    state.document = 8;
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "stale",
    });
    expect(opened).toEqual([]);
  });

  it("when the account epoch has moved", async () => {
    const { registry, state } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    state.epoch = 2;
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "stale",
    });
  });

  it("but an account change does NOT retire a direct receive", async () => {
    const { registry, state } = makeRegistry();
    const receipt = registry.register(dir, DIRECT, 1)!;
    state.epoch = 99;
    // Nobody's account authorised it, so no account change invalidates it —
    // the same rule the receive leases follow.
    await expect(registry.reveal(receipt.token)).resolves.toEqual({ kind: "revealed" });
  });

  it("permanently: a stale receipt is dropped, not merely refused", async () => {
    const { registry, state } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    state.document = 8;
    await registry.reveal(receipt.token);
    expect(registry.size).toBe(0);
    // Even if the document somehow came back, the receipt does not.
    state.document = 7;
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "unknown",
    });
  });

  it("and invalidateStale drops it without waiting to be asked", async () => {
    const { registry, state } = makeRegistry();
    registry.register(dir, OWNER, 1);
    registry.register(dir, DIRECT, 1);
    state.epoch = 2;
    registry.invalidateStale();
    // The account one goes; the direct one stays.
    expect(registry.size).toBe(1);
  });
});

describe("the filesystem is asked at the moment of use", () => {
  it("refuses when the folder has been removed since", async () => {
    const { registry, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    await rm(dir, { recursive: true, force: true });
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "missing",
    });
    // Nothing was opened at the stale path.
    expect(opened).toEqual([]);
  });

  it("refuses when the path is now a FILE rather than a folder", async () => {
    const { registry, opened } = makeRegistry();
    const target = join(dir, "was-a-folder");
    const receipt = registry.register(target, OWNER, 1)!;
    await writeFile(target, "not a directory", "utf8");
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "missing",
    });
    expect(opened).toEqual([]);
  });

  it("treats a stat that threw as a no", async () => {
    const { registry } = makeRegistry({
      directoryUsable: async () => {
        throw new Error("the volume went away");
      },
    });
    const receipt = registry.register(dir, OWNER, 1)!;
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "missing",
    });
  });

  it("reports a refused open as FAILED, carrying nothing the system said", async () => {
    const secret = `cannot open ${dir} for user hunter2`;
    const { registry } = makeRegistry({
      openDirectory: async () => {
        // The production adapter turns `shell.openPath`'s non-empty result into
        // exactly this. A registry that awaited and ignored it would answer
        // `revealed` for a folder that never opened.
        throw new Error(secret);
      },
    });
    const receipt = registry.register(dir, OWNER, 1)!;
    const outcome = await registry.reveal(receipt.token);
    expect(outcome).toEqual({ kind: "refused", reason: "failed" });
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
    expect(JSON.stringify(outcome)).not.toContain(dir);
  });
});

/**
 * An `openDirectory` that parks, and a way to know it has actually STARTED.
 *
 * `reveal` awaits the real `stat` before it opens anything, so a single
 * microtask is not enough to be sure the open is in flight — a test that
 * assumed it was raced the filesystem and released a promise that did not exist
 * yet. The entry signal removes the guess.
 */
/** A `directoryUsable` that parks, with a signal for when it has been entered.
 *  The window between the stat and the OS boundary is where four of root's five
 *  defects lived, so the tests have to be able to stand inside it. */
function heldStat() {
  let release: ((usable: boolean) => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return {
    started,
    release: (usable: boolean) => release?.(usable),
    directoryUsable: () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
        entered?.();
      }),
  };
}

function heldOpen() {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return {
    started,
    release: () => release?.(),
    openDirectory: () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered?.();
      }),
  };
}

describe("quitting", () => {
  it("refuses new reveals once fenced, and keeps the receipt", async () => {
    const { registry, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    registry.fence();
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "fenced",
    });
    expect(opened).toEqual([]);
    expect(registry.size).toBe(1);
  });

  it("still records a receive that completed during the prompt", async () => {
    const { registry } = makeRegistry();
    registry.fence();
    // It really did finish. If the user stays, the button belongs there.
    const receipt = registry.register(dir, OWNER, 2);
    expect(receipt).not.toBeNull();
    registry.resume();
    await expect(registry.reveal(receipt!.token)).resolves.toEqual({ kind: "revealed" });
  });

  it("does NOT cancel a reveal already running", async () => {
    const held = heldOpen();
    const { registry } = makeRegistry({ openDirectory: held.openDirectory });
    const receipt = registry.register(dir, OWNER, 1)!;
    const running = registry.reveal(receipt.token);
    await held.started;
    registry.fence();
    held.release();
    // A window the user is about to see; killing it would be a flicker with no
    // benefit, and it holds nothing that needs releasing.
    await expect(running).resolves.toEqual({ kind: "revealed" });
  });

  it("joins what it admitted, and says so", async () => {
    const held = heldOpen();
    const { registry } = makeRegistry({ openDirectory: held.openDirectory });
    const receipt = registry.register(dir, OWNER, 1)!;
    const running = registry.reveal(receipt.token);
    await held.started;
    const quiesced = registry.quiesce(5_000);
    held.release();
    await running;
    expect(await quiesced).toEqual({ joined: 1, unjoined: 0 });
  });

  it("reports an unjoined reveal honestly rather than waiting for it", async () => {
    const held = heldOpen();
    const { registry } = makeRegistry({ openDirectory: held.openDirectory });
    const receipt = registry.register(dir, OWNER, 1)!;
    const running = registry.reveal(receipt.token);
    await held.started;
    // Saying "everything finished" when something did not is the habit that
    // hides real leaks, even where — as here — there is nothing to leak.
    expect(await registry.quiesce(20)).toEqual({ joined: 0, unjoined: 1 });
    held.release();
    await running;
  });

  it("resumes without resurrecting anything that was invalidated meanwhile", async () => {
    const { registry, state } = makeRegistry();
    const stale = registry.register(dir, OWNER, 1)!;
    const kept = registry.register(dir, DIRECT, 1)!;
    registry.fence();
    state.epoch = 2;
    registry.invalidateStale();
    registry.resume();
    await expect(registry.reveal(stale.token)).resolves.toEqual({
      kind: "refused", reason: "unknown",
    });
    await expect(registry.reveal(kept.token)).resolves.toEqual({ kind: "revealed" });
  });

  it("forgets everything on dispose", async () => {
    const { registry } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    registry.dispose();
    expect(registry.size).toBe(0);
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "unknown",
    });
    // And it issues nothing further.
    expect(registry.register(dir, OWNER, 1)).toBeNull();
  });
});

// Five holes root found by writing the adversarial cases I had not. Every one
// of them ended in `revealed` — the registry opening a folder it had no
// business opening — so each is written here as the thing that must not happen
// rather than as a state to report.
describe("nothing may cross the OS boundary once the world has moved", () => {
  it("honours the HOST's admission, not only its own fence", async () => {
    const { registry, state, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    // The app is shutting down. This module was never told — declaring the
    // dependency and then never consulting it is the same as not having it.
    state.fenced = true;
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "fenced",
    });
    expect(opened).toEqual([]);
  });

  it("does not open the old folder when the account changed during the stat", async () => {
    const held = heldStat();
    const { registry, state, opened } = makeRegistry({ directoryUsable: held.directoryUsable });
    const receipt = registry.register(dir, OWNER, 1)!;

    const running = registry.reveal(receipt.token);
    await held.started;
    // Everything can move across an await, and the identity checks happened
    // before this one.
    state.epoch = 2;
    registry.invalidateStale();
    held.release(true);

    await expect(running).resolves.toEqual({ kind: "refused", reason: "stale" });
    expect(opened).toEqual([]);
  });

  it("does not begin an open when dispose landed during the stat", async () => {
    const held = heldStat();
    const { registry, opened } = makeRegistry({ directoryUsable: held.directoryUsable });
    const receipt = registry.register(dir, OWNER, 1)!;

    const running = registry.reveal(receipt.token);
    await held.started;
    registry.dispose();
    held.release(true);

    await expect(running).resolves.toEqual({ kind: "refused", reason: "unknown" });
    // Nothing was ASKED of the operating system. Cancelling one that had
    // already been asked for is a different thing, and is not attempted.
    expect(opened).toEqual([]);
  });

  it("captures the owner instead of borrowing the caller's object", async () => {
    const { registry, state, opened } = makeRegistry();
    const mutable = { ...OWNER };
    const receipt = registry.register(dir, mutable, 1)!;

    // The caller reuses its own object. If the registry kept a reference, this
    // would retroactively change who the receipt belongs to and bring a stale
    // token back to life under a document that never authorised it.
    state.document = 8;
    mutable.document = 8;

    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "stale",
    });
    expect(opened).toEqual([]);
  });

  it("closes admission from quiesce even when there is nothing to wait for", async () => {
    const { registry, opened } = makeRegistry();
    const receipt = registry.register(dir, OWNER, 1)!;
    // "Nothing in flight" is not "nothing to do": quiescing is the caller
    // saying stop, and answering instantly while still admitting the next
    // request reports a stop that did not happen.
    expect(await registry.quiesce(10)).toEqual({ joined: 0, unjoined: 0 });
    await expect(registry.reveal(receipt.token)).resolves.toEqual({
      kind: "refused", reason: "fenced",
    });
    expect(opened).toEqual([]);
    // And only `resume` reopens it.
    registry.resume();
    await expect(registry.reveal(receipt.token)).resolves.toEqual({ kind: "revealed" });
  });
});

describe("it stays small", () => {
  it("keeps no more than its capacity", () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < RECEIPT_CAPACITY + 40; i += 1) registry.register(dir, OWNER, 1);
    expect(registry.size).toBe(RECEIPT_CAPACITY);
  });

  it("evicts the OLDEST issued receipt, deterministically", async () => {
    const { registry } = makeRegistry();
    const first = registry.register(dir, OWNER, 1)!;
    const rest = Array.from({ length: RECEIPT_CAPACITY - 1 }, () => registry.register(dir, OWNER, 1)!);
    // Still exactly full, and the first is still there.
    await expect(registry.reveal(first.token)).resolves.toEqual({ kind: "revealed" });

    const overflow = registry.register(dir, OWNER, 1)!;
    await expect(registry.reveal(first.token)).resolves.toEqual({
      kind: "refused", reason: "unknown",
    });
    // Reading a receipt does not renew it: this is a fact with an age, not a
    // most-recently-used cache, so the one after it is next to go.
    await expect(registry.reveal(rest[0]!.token)).resolves.toEqual({ kind: "revealed" });
    await expect(registry.reveal(overflow.token)).resolves.toEqual({ kind: "revealed" });
  });
});
