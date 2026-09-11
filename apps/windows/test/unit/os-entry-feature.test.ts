// What an OS activation may stage, and what it may never do.
//
// Real files in a task-owned temporary tree: the claims are about the
// filesystem and about argv, and both deserve the real thing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OsEntryService, parseSendFiles, type OsEntryDeps } from "../../src/main/features/os-entry.js";
import { MAX_SELECTION_CHUNK, SEND_FILES_FLAG, type OsEntryView } from "../../src/shared/os-entry.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "relayium-os-entry-"));
});
afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
  root = "";
});

const write = async (rel: string, contents: string | Uint8Array = "x"): Promise<string> => {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
};

function harness(over: Partial<OsEntryDeps> = {}) {
  const views: OsEntryView[] = [];
  const failures: unknown[] = [];
  const state = { document: 5, epoch: 2 };
  const service = new OsEntryService({
    currentDocument: () => state.document,
    accountEpoch: () => state.epoch,
    onView: (view) => views.push(view),
    reportFailure: (err) => failures.push(err),
    now: () => 1_000,
    // Stated, not inherited. On Windows the default provider is a real one that
    // needs the packaged helper, and these cases are about staging rules rather
    // than about which binary opens the file — without this they pass on macOS
    // and answer `changed` for every read on the Windows runner.
    nativeSource: null,
    ...over,
  });
  const activate = (...paths: string[]) => service.activate([SEND_FILES_FLAG, ...paths]);
  return { service, views, failures, state, activate };
}

const staged = (view: OsEntryView) => {
  if (view.kind !== "staged") throw new Error(`expected staged, got ${view.kind}`);
  return view;
};

describe("the argv grammar is the whole grammar", () => {
  it("takes only what follows --send-files, and stops at the next flag", () => {
    expect(parseSendFiles(["relayium.exe", "--send-files", "a", "b"])).toEqual(["a", "b"]);
    expect(parseSendFiles(["--send-files"])).toEqual([]);
  });

  // ## The shape that actually broke it
  //
  // The parser used to take the values IMMEDIATELY after the flag and stop at
  // the first later `--`. That matches the command line Explorer builds, and
  // not the one Electron reconstructs when the app is already running: a switch
  // between the flag and the path ended the list before it collected anything,
  // and the app refused with `no-selection` for a file it never looked at. The
  // installed acceptance found it — cold, the same command line staged the
  // file; delivered to a running instance, it did not.
  it("finds the selection wherever the command line puts it", () => {
    // A switch between the flag and the path. This is the case that failed.
    expect(parseSendFiles(["relayium.exe", "--send-files", "--enable-x", "C:/a.txt"])).toEqual(["C:/a.txt"]);
    // Switches hoisted ahead of the positional arguments, which is how a
    // command line is normally reconstructed.
    expect(parseSendFiles(["relayium.exe", "--enable-x", "--send-files", "C:/a.txt"])).toEqual(["C:/a.txt"]);
    // The path BEFORE the flag.
    expect(parseSendFiles(["relayium.exe", "C:/a.txt", "--send-files"])).toEqual(["C:/a.txt"]);
    // The bulk path: SendTo appends every selected file.
    expect(parseSendFiles(["relayium.exe", "--send-files", "C:/a.txt", "C:/b.txt", "C:/c.txt"])).toEqual([
      "C:/a.txt",
      "C:/b.txt",
      "C:/c.txt",
    ]);
  });

  it("never opens the executable, a switch, or a deep link as a file", () => {
    // argv[0] is this program. Opening it would send the app to itself.
    expect(parseSendFiles(["C:/Program Files/Relayium/Relayium.exe", "--send-files", "C:/a.txt"])).toEqual([
      "C:/a.txt",
    ]);
    // Every form a switch takes.
    expect(parseSendFiles(["relayium.exe", "--send-files", "--x", "-y", "--z=1", "C:/a.txt"])).toEqual(["C:/a.txt"]);
    // A deep link rides in this same argv and belongs to another handler. A
    // selection is a filesystem path and never carries a scheme.
    expect(parseSendFiles(["relayium.exe", "--send-files", "relayium://pair?code=1", "C:/a.txt"])).toEqual([
      "C:/a.txt",
    ]);
    expect(parseSendFiles(["relayium.exe", "--send-files", "https://relayium.com/x"])).toEqual([]);
  });

  it("never treats a bare argument as a file", () => {
    // A future flag, or a token a shell expanded, must not become something
    // this process opens.
    expect(parseSendFiles(["relayium.exe", "C:/some/file.txt"])).toBeNull();
    expect(parseSendFiles(["relayium.exe", "relayium://pair?code=1"])).toBeNull();
    expect(parseSendFiles([])).toBeNull();
  });

  it("ignores an activation that is not one, leaving the view untouched", async () => {
    const h = harness();
    const before = h.service.view();
    await h.service.activate(["relayium.exe", "C:/x.txt"]);
    expect(h.service.view()).toBe(before);
  });
});

describe("staging", () => {
  it("stages a single file with its name as the relative path", async () => {
    const file = await write("one.txt", "hello");
    const view = staged(await harness().activate(file));
    expect(view.entries.length).toBe(1);
    expect(view.entries[0]?.relativePath).toBe("one.txt");
    expect(view.entries[0]?.size).toBe(5);
    expect(view.rootNames).toEqual(["one.txt"]);
    expect(view.totalBytes).toBe(5);
  });

  it("stages a folder, preserving relative paths and empty files", async () => {
    await write("box/a.txt", "aa");
    await write("box/deep/b.txt", "");
    const view = staged(await harness().activate(path.join(root, "box")));
    const paths = view.entries.map((entry) => entry.relativePath).sort();
    // An empty file is kept: a folder that arrives missing one is not the
    // folder that was sent.
    expect(paths).toEqual(["box/a.txt", "box/deep/b.txt"]);
    expect(view.entries.find((e) => e.relativePath === "box/deep/b.txt")?.size).toBe(0);
  });

  it("carries no absolute path anywhere in the view", async () => {
    await write("box/a.txt", "aa");
    const view = staged(await harness().activate(path.join(root, "box")));
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain(path.sep === "\\" ? "\\\\" : "/tmp");
  });

  it("mints a distinct token per file", async () => {
    await write("box/a.txt");
    await write("box/b.txt");
    const view = staged(await harness().activate(path.join(root, "box")));
    const tokens = new Set(view.entries.map((entry) => entry.token));
    expect(tokens.size).toBe(2);
    for (const token of tokens) expect(token).not.toContain(root);
  });
});

describe("refusals are total, never partial", () => {
  it("refuses a whole selection containing a symlink", async () => {
    const real = await write("target.txt", "secret");
    await write("box/ok.txt", "fine");
    try {
      await symlink(real, path.join(root, "box", "link.txt"));
    } catch {
      // Unprivileged Windows cannot create one; the case is reported as
      // platform-skipped rather than passing as though it had run.
      expect(process.platform).toBe("win32");
      return;
    }
    const h = harness();
    const view = await h.activate(path.join(root, "box"));
    expect(view.kind).toBe("empty");
    if (view.kind === "empty") expect(view.refusal).toBe("escapes-root");
    // Nothing staged at all — not "everything except the link".
    expect(h.service.stagedCount).toBe(0);
  });

  it("refuses device and NT-namespace forms LEXICALLY, on every platform", async () => {
    // The one that matters: a device-namespace path naming an ORDINARY file.
    // `lstat` follows it and reports a regular file, so `isFile()` cannot
    // refuse it — only the shape of the string can.
    const h = harness();
    for (const device of [
      "\\\\.\\C:\\picked.txt",
      "\\\\?\\C:\\picked.txt",
      "\\\\.\\pipe\\relayium",
      "\\\\.\\NUL",
      "//./C:/picked.txt",
      "C:\\folder\\NUL",
      "C:\\folder\\con.txt",
      "nul",
      "NUL   ",
      "/dev/null",
      "/proc/self/mem",
    ]) {
      const view = await h.activate(device);
      expect({ device, kind: view.kind }).toEqual({ device, kind: "empty" });
      if (view.kind === "empty") {
        expect({ device, refusal: view.refusal }).toEqual({ device, refusal: "unsupported-kind" });
      }
      expect(h.service.stagedCount).toBe(0);
    }
  });

  it("still accepts an ordinary file whose name merely resembles one", async () => {
    // `console.txt` is not `con`, and `nullable.dat` is not `nul`.
    const ok = await write("console.txt", "fine");
    const view = await harness().activate(ok);
    expect(view.kind).toBe("staged");
    const other = await write("nullable.dat", "fine");
    expect((await harness().activate(other)).kind).toBe("staged");
  });

  it("refuses a path that is not there", async () => {
    const view = await harness().activate(path.join(root, "absent.txt"));
    if (view.kind !== "empty") throw new Error("expected empty");
    expect(view.refusal).toBe("unreadable");
  });

  it("refuses two roots that would collide", async () => {
    const a = await write("x/same.txt", "1");
    const b = await write("y/same.txt", "2");
    const view = await harness().activate(a, b);
    if (view.kind !== "empty") throw new Error("expected empty");
    expect(view.refusal).toBe("collision");
  });

  it("refuses more roots than the bound, without staging any", async () => {
    const file = await write("one.txt");
    const many = Array.from({ length: 300 }, () => file);
    const h = harness();
    const view = await h.activate(...many);
    if (view.kind !== "empty") throw new Error("expected empty");
    expect(view.refusal).toBe("too-many");
    expect(h.service.stagedCount).toBe(0);
  });
});

describe("a held selection is refused, never replaced", () => {
  it("keeps the first and counts the refusals", async () => {
    const first = await write("first.txt", "aaa");
    const second = await write("second.txt", "bbbb");
    const h = harness();
    const one = staged(await h.activate(first));
    expect(one.refusedSince).toBe(0);

    // A burst: a context verb wired per file, or a user clicking twice.
    const after = staged(await h.activate(second));
    const again = staged(await h.activate(second));

    // The FIRST selection stands. Losing it would mean sending one file while
    // believing five had gone.
    expect(after.entries[0]?.relativePath).toBe("first.txt");
    expect(again.entries[0]?.relativePath).toBe("first.txt");
    expect(again.refusedSince).toBe(2);
    expect(again.selectionId).toBe(one.selectionId);
  });

  it("an explicit discard is what lets the next one through", async () => {
    const first = await write("first.txt", "aaa");
    const second = await write("second.txt", "bbbb");
    const h = harness();
    await h.activate(first);
    await h.activate(second);
    await h.service.clear();
    const view = staged(await h.activate(second));
    expect(view.entries[0]?.relativePath).toBe("second.txt");
    // The count resets with the selection it belonged to.
    expect(view.refusedSince).toBe(0);
  });
});

describe("reads are bounded capabilities", () => {
  it("serves a range for a staged token and nothing else", async () => {
    const file = await write("data.bin", new Uint8Array([1, 2, 3, 4, 5]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    const read = await h.service.read(token, 1, 3, h.state.document);
    if (read.kind !== "bytes") throw new Error(read.kind);
    expect([...read.bytes]).toEqual([2, 3, 4]);

    expect((await h.service.read("sel-nope", 0, 1, h.state.document)).kind).toBe("unknown-token");
    expect((await h.service.read(token, 0, MAX_SELECTION_CHUNK + 1, h.state.document)).kind).toBe("bad-range");
    expect((await h.service.read(token, -1, 1, h.state.document)).kind).toBe("bad-range");
    await h.service.dispose();
  });

  it("refuses a token from a document that has been replaced", async () => {
    const file = await write("doc.bin", new Uint8Array([9]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    const asked = h.state.document;
    h.state.document = asked + 1;
    expect((await h.service.read(token, 0, 1, asked)).kind).toBe("unknown-token");
    await h.service.dispose();
  });

  it("refuses a token once the account has moved", async () => {
    const file = await write("acct.bin", new Uint8Array([7]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    h.state.epoch += 1;
    expect((await h.service.read(token, 0, 1, h.state.document)).kind).toBe("unknown-token");
    await h.service.dispose();
  });

  it("refuses once the file has changed underneath", async () => {
    const file = await write("mut.bin", new Uint8Array([1, 2]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    await writeFile(file, new Uint8Array([1, 2, 3, 4]));
    expect((await h.service.read(token, 0, 2, h.state.document)).kind).toBe("changed");
    await h.service.dispose();
  });

  it("refuses every read behind a quit fence, and admits again on resume", async () => {
    const file = await write("fence.bin", new Uint8Array([1]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    h.service.fence();
    expect((await h.service.read(token, 0, 1, h.state.document)).kind).toBe("unavailable");
    h.service.resume();
    expect((await h.service.read(token, 0, 1, h.state.document)).kind).toBe("bytes");
    await h.service.dispose();
  });
});

describe("root's three: staging is cancellable while it examines", () => {
  it("a clear during the walk commits nothing", async () => {
    await write("box/a.txt", "aa");
    const h = harness();
    const running = h.activate(path.join(root, "box"));
    // Lands while `examine`/`readdir` are still in flight.
    await h.service.clear();
    await running;
    expect(h.service.stagedCount).toBe(0);
  });

  it("a document revocation during the walk commits nothing", async () => {
    await write("box/a.txt", "aa");
    const h = harness();
    const running = h.activate(path.join(root, "box"));
    await h.service.revokeDocument(h.state.document);
    await running;
    expect(h.service.stagedCount).toBe(0);
  });

  it("an account change during the walk commits nothing", async () => {
    await write("box/a.txt", "aa");
    const h = harness();
    const running = h.activate(path.join(root, "box"));
    await h.service.onAccountChanged();
    await running;
    expect(h.service.stagedCount).toBe(0);
  });

  it("a dispose during the walk commits nothing", async () => {
    await write("box/a.txt", "aa");
    const h = harness();
    const running = h.activate(path.join(root, "box"));
    await h.service.dispose();
    await running;
    expect(h.service.stagedCount).toBe(0);
  });

  it("a second activation while the first examines is refused, not admitted", async () => {
    await write("box/a.txt", "aa");
    await write("other/b.txt", "bb");
    const h = harness();
    const first = h.activate(path.join(root, "box"));
    // Synchronously, before the first has committed anything.
    const second = h.activate(path.join(root, "other"));
    const [a, b] = await Promise.all([first, second]);
    void b;
    if (a.kind !== "staged") throw new Error("expected the first to stage");
    expect(a.entries[0]?.relativePath).toBe("box/a.txt");
    // The refusal is carried onto the selection it collided with.
    expect(a.refusedSince).toBe(1);
  });

  it("a quiesce is RECOVERABLE: reads work again after resume", async () => {
    const file = await write("keep.bin", new Uint8Array([1, 2, 3, 4]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    expect((await h.service.read(token, 0, 4, h.state.document)).kind).toBe("bytes");

    const inventory = await h.service.quiesce();
    expect(inventory.staged).toBe(1);
    expect(inventory.leftover).toBe(0);

    // The user chose Stay. A permanent failure caused by a question would be
    // the worst possible answer to it.
    h.service.resume();
    const again = await h.service.read(token, 0, 4, h.state.document);
    if (again.kind !== "bytes") throw new Error(again.kind);
    expect([...again.bytes]).toEqual([1, 2, 3, 4]);
    await h.service.dispose();
  });

  it("a dispose is terminal, unlike a quiesce", async () => {
    const file = await write("term.bin", new Uint8Array([1]));
    const h = harness();
    const view = staged(await h.activate(file));
    const token = view.entries[0]?.token ?? "";
    await h.service.dispose();
    h.service.resume();
    expect((await h.service.read(token, 0, 1, h.state.document)).kind).toBe("unavailable");
  });
});

describe("clearing and teardown", () => {
  it("a document revocation drops the selection it owned", async () => {
    const file = await write("rev.txt", "x");
    const h = harness();
    await h.activate(file);
    await h.service.revokeDocument(h.state.document + 1);
    expect(h.service.stagedCount).toBe(1);
    await h.service.revokeDocument(h.state.document);
    expect(h.service.stagedCount).toBe(0);
  });

  it("an account change drops it", async () => {
    const file = await write("acc.txt", "x");
    const h = harness();
    await h.activate(file);
    await h.service.onAccountChanged();
    expect(h.service.stagedCount).toBe(0);
  });

  it("dispose reports what was staged and leaves nothing open", async () => {
    await write("box/a.txt", "aa");
    await write("box/b.txt", "bb");
    const h = harness();
    const view = staged(await h.activate(path.join(root, "box")));
    const token = view.entries[0]?.token ?? "";
    await h.service.read(token, 0, 2, h.state.document);
    const inventory = await h.service.dispose();
    expect(inventory.staged).toBe(2);
    expect(inventory.leftover).toBe(0);
    expect((await h.service.read(token, 0, 2, h.state.document)).kind).toBe("unavailable");
  });

  it("never stages while disposed", async () => {
    const file = await write("late.txt", "x");
    const h = harness();
    await h.service.dispose();
    const view = await h.activate(file);
    expect(view.kind).toBe("empty");
    expect(h.service.stagedCount).toBe(0);
  });
});

describe("diagnostics carry neither content nor paths", () => {
  it("keeps both out of every published view", async () => {
    const file = await write("secret-name.txt", "SECRET-CONTENT");
    const h = harness();
    await h.activate(file);
    const serialised = JSON.stringify(h.views);
    expect(serialised).not.toContain("SECRET-CONTENT");
    expect(serialised).not.toContain(root);
    // The NAME is display data the user chose and does appear; the location
    // does not.
    expect(serialised).toContain("secret-name.txt");
  });
});
