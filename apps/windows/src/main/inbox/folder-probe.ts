// Whether the receive folder can actually take a delivery, and if not, why.
//
// ## What this replaces
//
// A boolean from `(await stat(path)).isDirectory()`, whose own comment listed
// what it merged: "Missing, unreadable, or not a directory. All three mean the
// grant cannot be honoured, and none of them is something polling harder will
// fix."
//
// That reasoning is right about BACKOFF and wrong about what to say. The screen
// rendered one sentence — "The receiving folder is not there" — which is false
// when the folder is right there and unreadable, and false again when a file
// now sits at the path.
//
// ## And it never asked whether the folder could be WRITTEN
//
// `stat` succeeds on a read-only directory. So a receive folder whose
// permissions changed, or one on a disk with no space, reported READY: the
// service claimed deliveries, downloaded them, and failed at write time, once
// per delivery, with nothing naming the common cause. macOS checks up front
// (`inbox.folderNotWritable`).
//
// Failing before claiming is the whole point. A delivery that is claimed and
// then fails has consumed a claim, a download and a server round trip.
//
// ## Writability has to be DEMONSTRATED on Windows, and that was a correction
//
// The first version asked `fs.access(path, W_OK)` and argued that writing a
// probe file into somebody's folder is a side effect nobody asked for. The
// argument is good and the mechanism does not work here: on Windows `access`
// consults the read-only ATTRIBUTE, which Windows itself largely ignores for
// directories, and not the ACL. A folder denied by ACL passes it.
//
// CI said so before this shipped, from the other end: the test made a
// directory unwritable with `chmod(0o500)`, which is a no-op for a directory on
// Windows, and the probe answered `ok`. That is the same platform the product
// runs on, so an `access`-only probe would have detected close to nothing where
// it matters.
//
// So the probe attempts the operation it is asking about: create a uniquely
// named file, then remove it. `access` stays as a cheap first gate — it catches
// the read-only attribute without touching the disk — and the create is what
// answers the ACL.
//
// The cost is real and is accepted deliberately: if this process dies between
// the create and the unlink, a zero-byte dot-file is left in the user's folder.
// Weighed against the alternative — every delivery claimed, downloaded and then
// failed at write time, with nothing naming the cause — a stray empty file that
// the next probe overwrites is the smaller harm. The name is fixed rather than
// random so repeated probes reuse one path instead of littering.
//
// It is still not a promise about the NEXT write, which is why the copy says
// "right now": a disk can fill between this check and the delivery.

import { access, open, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

/**
 * Why a receive folder cannot take a delivery.
 *
 * Kept apart because the FIX differs: reconnect the drive or choose again;
 * change permissions or free space; move whatever is sitting at that path.
 */
export type FolderProblem =
  /** Nothing is at that path — deleted, renamed, or the disk is not connected. */
  | "missing"
  /** Something is there and it is not a directory. */
  | "not-a-directory"
  /** A directory this account cannot write into right now. */
  | "not-writable";

export type FolderProbe = { readonly ok: true } | { readonly ok: false; readonly problem: FolderProblem };

const USABLE: FolderProbe = { ok: true };

/**
 * The filesystem, injected — for one reason worth stating.
 *
 * The CREATE is the branch that exists for Windows, and it is the branch no
 * suite can reach by arranging real state: on POSIX `access(W_OK)` already
 * catches an unwritable directory, so removing the create leaves every case
 * green, and on Windows an ACL-denied folder needs `icacls` and an
 * administrator. Proved by injection — deleting the create branch failed
 * nothing at all.
 *
 * A branch that only runs on a platform where its condition cannot be
 * constructed is a branch nobody has executed. This seam is how it gets
 * executed: a test makes `create` refuse while `stat` and `access` succeed,
 * which is exactly the shape of the case it was added for.
 */
export interface FolderProbeFs {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  access(path: string, mode: number): Promise<void>;
  create(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const REAL: FolderProbeFs = {
  stat,
  access,
  async create(target) {
    const handle = await open(target, "w");
    await handle.close();
  },
  async remove(target) {
    await rm(target, { force: true });
  },
};

export async function probeFolder(path: string, fs: FolderProbeFs = REAL): Promise<FolderProbe> {
  let isDirectory: boolean;
  try {
    isDirectory = (await fs.stat(path)).isDirectory();
  } catch {
    // Missing, or a path this process cannot even stat. Both read to a person
    // as "it is not there", and both are fixed the same way.
    return { ok: false, problem: "missing" };
  }
  if (!isDirectory) return { ok: false, problem: "not-a-directory" };
  try {
    // Cheap, and touches nothing. Catches the read-only attribute on Windows
    // and the permission bits on POSIX.
    await fs.access(path, constants.W_OK);
  } catch {
    return { ok: false, problem: "not-writable" };
  }
  // And the ACL, which `access` does not consult on Windows. One fixed name, so
  // a probe interrupted by a crash leaves at most one empty file that the next
  // probe reuses.
  const probe = join(path, ".relayium-write-probe");
  try {
    await fs.create(probe);
  } catch {
    return { ok: false, problem: "not-writable" };
  }
  // Best effort. A probe file that outlives its probe is untidy; failing the
  // folder over it would be false, because the write plainly succeeded.
  await fs.remove(probe).catch(() => undefined);
  return USABLE;
}
