// The ownership boundary: the ONLY place an update file path is produced.
//
// ## Why a path never comes from the journal
//
// The journal is an unsigned local file. An earlier revision stored the staged
// artifact's PATH in it and then passed that value to `rm`, so a corrupt or
// forged journal naming any file on the machine got that file deleted — root's
// probe demonstrated it on a synthetic victim outside the staging directory.
//
// The rule that replaces it: the journal stores an IDENTITY (a version and a
// build), and every path is DERIVED here from the fixed staging directory plus
// that identity. Nothing outside this module composes an update path, and no
// value read from disk is ever treated as one. So a journal cannot authorize a
// read, a reveal, a retire or an execution of anything but the one file this
// process would itself have created.
//
// ## The derived name is one inert component, checked
//
// `version` and `build` come from a re-verified manifest, but they are checked
// again here anyway: this function is the last thing between a string and a
// filesystem call, and a component that could contain a separator, a `..`, a
// drive letter or a reparse-looking prefix would defeat the whole arrangement.
//
// ## The name carries a NONCE, and the nonce is still not ownership
//
// `relayium-0.3.0-9.exe` is a name anything could have created — the user, an
// installer, a previous product. So every staged file is named with a nonce
// minted for that one attempt. That stops two attempts, or an unrelated
// program, from colliding; it does NOT establish that the object sitting at the
// nonced name is the one this installation created, because a file can be
// renamed away and another left in its place. The receipt in `custody.ts`
// carries the object's identity, and that is what authorizes a delete.
//
// ## A derived name is still not ownership
//
// Deriving `updates/relayium-X-N.exe` says where a file of ours would be, not
// that the thing answering to that name is ours — `updates` itself can be a
// symlink or a junction to somewhere else entirely. So every filesystem effect
// goes through `custody.ts`, which holds the directory and refuses a redirected
// one, and deletion is authorized by a RECEIPT — the identity of the object the
// exclusive create returned — rather than by the name alone.

import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  CustodyError,
  RECEIPT,
  defaultScopeProvider,
  type RetireOutcome,
  type StagingScopeProvider,
} from "./custody.js";

/** Identity of a staged candidate. No path, deliberately. */
export interface StagedIdentity {
  readonly version: string;
  readonly build: number;
  /** Minted before the exclusive create, so the name is not one anything else
   *  would have chosen. See the header. */
  readonly nonce: string;
}

/** The subdirectory of the app's data root that this module owns. */
export const STAGING_DIRECTORY_NAME = "updates";

/** Where the journal lives. Derived, never stored. */
export const JOURNAL_FILE_NAME = "candidate.json";

/** The nonce shape, restated wherever a nonce crosses a boundary. */
export const NONCE = /^[0-9a-f]{16}$/;

/** A fresh staging nonce. 64 bits: this is an unpredictability requirement
 *  inside one directory, not a collision-resistance one. */
export const mintNonce = (): string => randomBytes(8).toString("hex");

/** Only these characters may appear in a derived name. */
const INERT_COMPONENT = /^[A-Za-z0-9._-]{1,120}$/;
/** The version shape the manifest already enforces, restated at the boundary. */
const VERSION = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;

export class StagingError extends Error {
  constructor(readonly code: "bad-identity" | "not-owned") {
    super(`update staging: ${code}`);
    this.name = "StagingError";
  }
}

export const stagingDirectory = (dataDirectory: string): string =>
  join(dataDirectory, STAGING_DIRECTORY_NAME);

export const journalPath = (dataDirectory: string): string =>
  join(stagingDirectory(dataDirectory), JOURNAL_FILE_NAME);

/**
 * The one filename a candidate may have.
 *
 * Derived from the identity and validated as a single inert component. A
 * version or build that cannot produce one is a refusal, not a fallback name —
 * a fallback would mean two candidates sharing a file.
 */
export function stagedFileName(identity: StagedIdentity): string {
  if (typeof identity.version !== "string" || !VERSION.test(identity.version)) {
    throw new StagingError("bad-identity");
  }
  if (!Number.isSafeInteger(identity.build) || identity.build <= 0) {
    throw new StagingError("bad-identity");
  }
  if (typeof identity.nonce !== "string" || !NONCE.test(identity.nonce)) {
    throw new StagingError("bad-identity");
  }
  const name = `relayium-${identity.version}-${String(identity.build)}-${identity.nonce}.exe`;
  // Belt and braces on a string this module just composed: if the composition
  // ever admits something else, it must not reach a filesystem call.
  if (!INERT_COMPONENT.test(name) || isAbsolute(name) || name.includes("..")) {
    throw new StagingError("bad-identity");
  }
  return name;
}

/** The full path for a candidate. The ONLY way an update path is produced. */
export function stagedPath(dataDirectory: string, identity: StagedIdentity): string {
  return join(stagingDirectory(dataDirectory), stagedFileName(identity));
}

export type { RetireOutcome };

/**
 * Remove one candidate this installation durably claimed, through the scope.
 *
 * The name is derived here; the DELETE happens inside a held scope, against the
 * RECEIPT, so it removes an object rather than whatever answers to a name. The
 * absence is confirmed afterwards, so a failed delete stays `residue` for the
 * caller to keep owning instead of quietly becoming "cleaned up".
 */
export async function retireCandidate(
  dataDirectory: string,
  identity: StagedIdentity,
  /** Identity of the object this installation created. Without one there is no
   *  deletion authority, only a name. */
  receipt: string | null = null,
  provider: StagingScopeProvider = defaultScopeProvider(),
): Promise<RetireOutcome> {
  if (typeof receipt !== "string" || !RECEIPT.test(receipt)) {
    // A record with no receipt names a slot, not an object. Nothing is removed
    // and nothing is confirmed.
    return { outcome: "residue", detail: "no-receipt" };
  }
  let name: string;
  try {
    name = stagedFileName(identity);
  } catch {
    // An identity with no nonce names nothing this installation created. It is
    // not reported as `gone`, because nothing was checked and nothing removed.
    return { outcome: "residue", detail: "bad-identity" };
  }
  let scope;
  try {
    scope = await provider.open(dataDirectory, STAGING_DIRECTORY_NAME);
  } catch (error) {
    return { outcome: "residue", detail: error instanceof CustodyError ? error.code : "scope" };
  }
  try {
    return await scope.removeOwned(name, receipt);
  } finally {
    await scope.close();
  }
}
