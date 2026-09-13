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
    //
    // ## What this case can and cannot establish, per platform
    //
    // `chmod(0o500)` restricts a directory on POSIX and is a NO-OP for one on
    // Windows — which CI proved by failing here on the very platform the
    // product ships on. So on Windows this cannot construct the state, and it
    // says so instead of asserting something it did not arrange.
    //
    // What covers Windows is the mechanism rather than this case: the probe
    // CREATES a file, so an ACL that denies writes fails the create. That is
    // exactly why `access(W_OK)` alone was not enough — it does not consult the
    // ACL there.
    const dir = await root();
    const locked = path.join(dir, "read-only");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const probe = await probeFolder(locked);

    if (process.platform === "win32") {
      // Not a silent skip: the state was not created, so the only honest claim
      // is that the probe did not crash and answered something well-formed.
      expect(probe.ok === true || probe.ok === false).toBe(true);
      return;
    }
    // Root ignores the permission bits, so a run as root cannot make this
    // claim either. Saying so beats a green assertion that proved nothing.
    if (process.getuid?.() === 0) {
      expect(probe).toEqual({ ok: true });
      return;
    }
    expect(probe).toEqual({ ok: false, problem: "not-writable" });
  });

  it("fails a folder that only the CREATE refuses — the Windows ACL shape", async () => {
    // The branch this whole change exists for, and the one no arrangement of
    // real state can reach: on POSIX `access(W_OK)` catches an unwritable
    // directory first, and on Windows an ACL-denied folder needs `icacls` and
    // an administrator. Deleting the create branch failed NOTHING before this
    // case existed — proved by injection.
    //
    // So the filesystem is injected, and this is the exact shape: `stat` says
    // directory, `access` is satisfied — as it is on Windows, where it consults
    // the read-only attribute and not the ACL — and only the create refuses.
    // The folder is built with `path.join`, not written as a literal: the
    // probe joins too, and a hard-coded "/anywhere/..." expectation is a POSIX
    // separator assumption that fails on Windows. Which it did — the second
    // platform assumption of my own in this batch, after `chmod`.
    const folder = path.join(path.sep, "anywhere");
    const created: string[] = [];
    const probe = await probeFolder(folder, {
      stat: () => Promise.resolve({ isDirectory: () => true }),
      access: () => Promise.resolve(),
      create: (target) => {
        created.push(target);
        return Promise.reject(new Error("EACCES"));
      },
      remove: () => Promise.resolve(),
    });
    expect(probe).toEqual({ ok: false, problem: "not-writable" });
    // And it tried, in the folder it was asked about.
    expect(created).toHaveLength(1);
    expect(created[0]).toBe(path.join(folder, ".relayium-write-probe"));
  });

  it("removes its probe file when the create succeeds", async () => {
    const removed: string[] = [];
    const probe = await probeFolder(path.join(path.sep, "anywhere"), {
      stat: () => Promise.resolve({ isDirectory: () => true }),
      access: () => Promise.resolve(),
      create: () => Promise.resolve(),
      remove: (target) => {
        removed.push(target);
        return Promise.resolve();
      },
    });
    expect(probe).toEqual({ ok: true });
    expect(removed).toHaveLength(1);
  });

  it("passes a folder whose probe file cannot be removed", async () => {
    // Untidy, not unusable. The write plainly succeeded, and failing the folder
    // over the cleanup would be false in the direction that stops deliveries
    // which would have worked.
    const probe = await probeFolder(path.join(path.sep, "anywhere"), {
      stat: () => Promise.resolve({ isDirectory: () => true }),
      access: () => Promise.resolve(),
      create: () => Promise.resolve(),
      remove: () => Promise.reject(new Error("EBUSY")),
    });
    expect(probe).toEqual({ ok: true });
  });

  it("refuses a path a create cannot reach, against the real filesystem", async () => {
    // The mechanism the Windows case rests on, exercised directly and without
    // needing to arrange an ACL: a path that is not a directory cannot take a
    // create, and the probe must not report it usable.
    //
    // Kept separate from the not-a-directory case above because that one tests
    // the `stat` branch. This one would still fail the probe if `stat` were
    // removed entirely, which is what makes it evidence about the CREATE.
    const dir = await root();
    const wall = path.join(dir, "wall");
    await writeFile(wall, "");
    const probe = await probeFolder(path.join(wall, "inside"));
    expect(probe.ok).toBe(false);
  });

  it("leaves nothing behind in the folder it probes", async () => {
    // `access(W_OK)` ASKS the operating system. A probe file would be a side
    // effect nobody asked for, and one that survives a crash between create
    // and unlink.
    //
    // ## This case changed meaning, and the name changed with it
    //
    // It began as "writes nothing", asserted by listing the directory
    // afterwards — which a create-then-unlink probe passes trivially, so it was
    // really asserting that the probe tidies up. That was found by injecting
    // exactly such a probe and re-asserted by mtime instead.
    //
    // Then Windows forced the probe to become a create-then-unlink, because
    // `access(W_OK)` does not consult the ACL there. So "writes nothing" is no
    // longer true and the honest claim is the weaker one the name now makes:
    // whatever it writes, it does not LEAVE anything.
    //
    // Renaming rather than deleting: tidiness is still worth asserting, and a
    // probe that leaked a file per pass would litter a user's folder.
    const dir = await root();
    const { readdir } = await import("node:fs/promises");
    await probeFolder(dir);
    expect(await readdir(dir)).toEqual([]);
    // Twice, because a probe that reused one name and failed to remove it would
    // pass a single run and accumulate on the second.
    await probeFolder(dir);
    expect(await readdir(dir)).toEqual([]);
  });
});
