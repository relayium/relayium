// Whether the receive folder can take a delivery, against a REAL filesystem.
//
// Not a stub: the whole finding is that `stat().isDirectory()` answers a
// different question from "can this be written into", and a stubbed `fs` would
// agree with whatever this file assumed.
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeFolder } from "../../src/main/inbox/folder-probe.js";

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) {
    // Restore write permission first, or the cleanup cannot remove what it made.
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function root(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "relayium-folder-probe-"));
  owned.push(made);
  return made;
}

describe("probing a receive folder", () => {
  it("accepts a folder that exists and can be written", async () => {
    const dir = await root();
    await expect(probeFolder(dir)).resolves.toEqual({ ok: true });
  });

  it("says MISSING for a path with nothing at it", async () => {
    const dir = await root();
    await expect(probeFolder(path.join(dir, "gone"))).resolves.toEqual({
      ok: false,
      problem: "missing",
    });
  });

  it("says NOT-A-DIRECTORY when a file sits where the folder was", async () => {
    // The old probe reported this as "the receiving folder is not there",
    // which sends somebody looking for a folder that a file has replaced.
    const dir = await root();
    const file = path.join(dir, "was-a-folder");
    await writeFile(file, "not a directory");
    await expect(probeFolder(file)).resolves.toEqual({
      ok: false,
      problem: "not-a-directory",
    });
  });

  it("says NOT-WRITABLE for a directory this account cannot write into", async () => {
    // THE defect. `stat().isDirectory()` is true here, so the old probe passed
    // it, the Inbox reported ready, and every delivery failed at write time.
    const dir = await root();
    const locked = path.join(dir, "read-only");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const probe = await probeFolder(locked);
    // Root ignores the permission bits, so a run as root cannot make this
    // claim. Saying so beats a green assertion that proved nothing.
    if (process.getuid?.() === 0) {
      expect(probe).toEqual({ ok: true });
      return;
    }
    expect(probe).toEqual({ ok: false, problem: "not-writable" });
  });

  it("writes nothing into the folder it is asked about", async () => {
    // `access(W_OK)` ASKS the operating system. A probe file would be a side
    // effect nobody asked for, and one that survives a crash between create
    // and unlink.
    //
    // Checked by the directory's mtime, not by listing it afterwards. The
    // first version of this case listed the directory after the probe
    // returned, which a create-then-unlink probe passes trivially — it was
    // asserting that the probe TIDIES UP, not that it writes nothing.
    // Verified by injection: a create/unlink probe left it green.
    const dir = await root();
    const { stat: statOf } = await import("node:fs/promises");
    const before = (await statOf(dir)).mtimeMs;
    // A directory mtime has coarse resolution on some filesystems, so put a
    // gap either side rather than trusting sub-millisecond timestamps.
    await new Promise((r) => setTimeout(r, 20));
    await probeFolder(dir);
    await new Promise((r) => setTimeout(r, 20));
    expect((await statOf(dir)).mtimeMs).toBe(before);
  });
});
