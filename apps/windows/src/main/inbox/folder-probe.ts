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
// ## Writability is ASKED, never demonstrated
//
// `fs.access(path, W_OK)` asks the operating system. It does not create a probe
// file: writing something into somebody's folder to find out whether we can
// write into it is a side effect nobody asked for, and one that can be left
// behind if the process dies between create and unlink.
//
// It is also honest about its limits, which is why the copy says "right now":
// on Windows `access` reflects the DACL, and a quota or a full disk can still
// refuse a write that this check allows. It removes a whole class of silent
// failure; it does not promise the next write succeeds.

import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";

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

export async function probeFolder(path: string): Promise<FolderProbe> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(path)).isDirectory();
  } catch {
    // Missing, or a path this process cannot even stat. Both read to a person
    // as "it is not there", and both are fixed the same way.
    return { ok: false, problem: "missing" };
  }
  if (!isDirectory) return { ok: false, problem: "not-a-directory" };
  try {
    await access(path, constants.W_OK);
  } catch {
    return { ok: false, problem: "not-writable" };
  }
  return USABLE;
}
