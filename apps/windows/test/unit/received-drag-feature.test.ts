// Dragging out and revealing a received file: who may, and when they stop.
//
// Real files again, because the claims are about a file still being there and
// still being the one that was received.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ReceivedDragService,
  type ReceivedAuthority,
  type ReceivedDragDeps,
} from "../../src/main/features/received-drag.js";
import { isSafeRelativePath } from "../../src/shared/received-drag.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "relayium-received-"));
});
afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
  root = "";
});

const write = async (rel: string, contents = "x"): Promise<string> => {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
};

/** The accepted `ReceiptOwner` shape, with the account id this module needs. */
const accountOwner = (over: Partial<ReceivedAuthority> = {}): ReceivedAuthority => ({
  authority: "account",
  epoch: 3,
  document: 9,
  accountId: "acct-1",
  ...over,
});
const directOwner = (over: Partial<ReceivedAuthority> = {}): ReceivedAuthority => ({
  authority: "direct",
  epoch: 0,
  document: 9,
  accountId: "",
  ...over,
});

function harness(over: Partial<ReceivedDragDeps> = {}) {
  const drags: string[] = [];
  const reveals: string[] = [];
  const failures: unknown[] = [];
  const state = { document: 9, epoch: 3, accountId: "acct-1" };
  const service = new ReceivedDragService({
    startDrag: (p) => {
      drags.push(p);
      return true;
    },
    showItemInFolder: (p) => reveals.push(p),
    currentDocument: () => state.document,
    accountEpoch: () => state.epoch,
    currentAccountId: () => state.accountId,
    reportFailure: (err) => failures.push(err),
    ...over,
  });
  return { service, drags, reveals, failures, state };
}

describe("relative-path validation uses segments, not substrings", () => {
  it("accepts an ordinary name containing dots", () => {
    // `photo..jpg` is a file, not a traversal. A substring test refused it.
    for (const good of ["photo..jpg", "archive..tar.gz", "a/b..c/d.txt", "..leading.txt", "trailing..", "x.y.z"]) {
      expect({ good, ok: isSafeRelativePath(good) }).toEqual({ good, ok: true });
    }
  });

  it("refuses a traversal, an absolute path and a drive", () => {
    for (const bad of ["../x", "a/../b", "..", ".", "/abs", "C:/x", "a//b", "", "a/./b"]) {
      expect({ bad, ok: isSafeRelativePath(bad) }).toEqual({ bad, ok: false });
    }
  });

  it("registers a dotted name and refuses a traversal", async () => {
    const file = await write("photo..jpg");
    const h = harness();
    expect(await h.service.register({ absolutePath: file, relativePath: "photo..jpg", authority: accountOwner() })).not.toBeNull();
    expect(await h.service.register({ absolutePath: file, relativePath: "../escape.jpg", authority: accountOwner() })).toBeNull();
  });
});

describe("the owner is copied BEFORE the filesystem check", () => {
  it("a caller that mutates its authority object cannot relabel a receipt", async () => {
    const file = await write("a.txt");
    const h = harness();
    // One object, reused across receives — the shape a caller naturally writes.
    const borrowed = { authority: "account" as const, epoch: 3, document: 9, accountId: "acct-1" };
    const pending = h.service.register({ absolutePath: file, relativePath: "a.txt", authority: borrowed });
    // Mutated while the `examine` is still in flight.
    borrowed.epoch = 4;
    borrowed.document = 10;
    const view = await pending;
    expect(view).not.toBeNull();
    // The receipt still belongs to the account that actually received it, so it
    // is still usable from the document that did.
    const outcome = await h.service.act("reveal", view?.token ?? "", 9);
    expect(outcome).toEqual({ kind: "revealed" });
  });
});

describe("a revocation during registration cancels it", () => {
  it("an item does not revive after its document was revoked mid-check", async () => {
    const file = await write("b.txt");
    const h = harness();
    const pending = h.service.register({ absolutePath: file, relativePath: "b.txt", authority: accountOwner() });
    // Lands while `examine` is still running.
    h.service.revokeDocument(9);
    const view = await pending;
    // Either refused outright, or registered and then unusable — never usable.
    if (view !== null) {
      expect((await h.service.act("drag", view.token, 9)).kind).toBe("unknown-token");
    }
    expect(h.drags).toEqual([]);
  });

  it("an account change mid-check cancels an account registration", async () => {
    const file = await write("c.txt");
    const h = harness();
    const pending = h.service.register({ absolutePath: file, relativePath: "c.txt", authority: accountOwner() });
    h.service.onAccountChanged();
    h.state.epoch = 4;
    const view = await pending;
    if (view !== null) {
      expect((await h.service.act("drag", view.token, 9)).kind).toBe("unknown-token");
    }
    expect(h.drags).toEqual([]);
  });
});

describe("an account change during the held stat stops the drag", () => {
  it("re-checks membership and authority after the await, not the document alone", async () => {
    const file = await write("d.txt");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "d.txt", authority: accountOwner() });
    const token = view?.token ?? "";

    // The account moves while `act` is examining the file. The map is cleared,
    // but this call already holds its own reference to the item.
    const acting = h.service.act("drag", token, 9);
    h.service.onAccountChanged();
    h.state.epoch = 4;
    h.state.accountId = "acct-2";
    const outcome = await acting;

    expect(outcome.kind).toBe("unknown-token");
    // The file the current account never received is not on anybody's desktop.
    expect(h.drags).toEqual([]);
  });
});

describe("direct receipts survive an account change; account ones do not", () => {
  it("keeps a LAN file when the user signs in", async () => {
    const lan = await write("lan.txt");
    const inbox = await write("inbox.txt");
    const h = harness();
    const direct = await h.service.register({ absolutePath: lan, relativePath: "lan.txt", authority: directOwner() });
    const account = await h.service.register({ absolutePath: inbox, relativePath: "inbox.txt", authority: accountOwner() });

    h.service.onAccountChanged();
    h.state.epoch = 4;
    h.state.accountId = "acct-2";

    // A file received over the LAN is the user's regardless of who is signed
    // in; dropping it because they signed in would be a file vanishing for no
    // reason.
    expect((await h.service.act("reveal", direct?.token ?? "", 9)).kind).toBe("revealed");
    expect((await h.service.act("reveal", account?.token ?? "", 9)).kind).toBe("unknown-token");
  });
});

describe("a fence blocks the action, not the completion", () => {
  it("registers during a quit prompt and works again after Stay", async () => {
    const file = await write("e.txt");
    const h = harness();
    h.service.fence();
    // A receive that completed during the prompt really did complete.
    const view = await h.service.register({ absolutePath: file, relativePath: "e.txt", authority: accountOwner() });
    expect(view).not.toBeNull();
    // But nothing may happen while the question is on screen.
    expect((await h.service.act("drag", view?.token ?? "", 9)).kind).toBe("unavailable");
    h.service.resume();
    expect((await h.service.act("drag", view?.token ?? "", 9)).kind).toBe("started");
  });
});

describe("the file must still be the one that was received", () => {
  it("refuses once it is deleted", async () => {
    const file = await write("f.txt");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "f.txt", authority: accountOwner() });
    await rm(file);
    expect((await h.service.act("drag", view?.token ?? "", 9)).kind).toBe("missing");
    expect(h.drags).toEqual([]);
  });

  it("refuses once it has been replaced", async () => {
    const file = await write("g.txt", "original");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "g.txt", authority: accountOwner() });
    await writeFile(file, "something else entirely");
    expect((await h.service.act("drag", view?.token ?? "", 9)).kind).toBe("missing");
  });

  it("never registers a path that is not a regular file", async () => {
    await mkdir(path.join(root, "dir"));
    const h = harness();
    expect(await h.service.register({ absolutePath: path.join(root, "dir"), relativePath: "dir", authority: accountOwner() })).toBeNull();
    expect(await h.service.register({ absolutePath: path.join(root, "absent"), relativePath: "absent", authority: accountOwner() })).toBeNull();
  });
});

describe("tokens and paths", () => {
  it("carries no absolute path in the view", async () => {
    const file = await write("deep/h.txt");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "deep/h.txt", authority: accountOwner() });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(root);
    expect(view?.name).toBe("h.txt");
    expect(view?.relativePath).toBe("deep/h.txt");
  });

  it("refuses an action token that is not one of the two", async () => {
    const file = await write("i.txt");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "i.txt", authority: accountOwner() });
    expect((await h.service.act("share" as never, view?.token ?? "", 9)).kind).toBe("unknown-token");
    expect(h.drags).toEqual([]);
  });

  it("refuses a token from a document that has been replaced", async () => {
    const file = await write("j.txt");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "j.txt", authority: accountOwner() });
    h.state.document = 10;
    expect((await h.service.act("drag", view?.token ?? "", 9)).kind).toBe("unknown-token");
  });

  it("dispose forgets everything", async () => {
    const file = await write("k.txt");
    const h = harness();
    const view = await h.service.register({ absolutePath: file, relativePath: "k.txt", authority: accountOwner() });
    h.service.dispose();
    expect(h.service.size).toBe(0);
    expect((await h.service.act("drag", view?.token ?? "", 9)).kind).toBe("unavailable");
    expect(await h.service.register({ absolutePath: file, relativePath: "k.txt", authority: accountOwner() })).toBeNull();
  });
});
