// Resolving an upload whose finalize answer was lost.
//
// ## Why this is the only route
//
// `POST /api/uploads/{id}/finalize` answers 409 for every attempt after the
// first and carries no object id, and `GET /api/uploads/{id}` answers 404 once
// the session is terminal. So after a lost finalize response there is no
// endpoint that will name the object — if one was created at all.
//
// What CAN be proved is identity. The sealed manifest is AES-GCM over the file
// list under a per-upload random key at a fixed nonce, so a byte-identical
// `encManifest` cannot have come from any other init body. This module lists
// the account's shares, narrows by ciphertext size, and then compares the
// SHA-256 of each candidate's sealed manifest against the digest the journal
// recorded before init. A match is proof; nothing else is treated as one.
//
// ## What a non-match does NOT prove
//
// Absence. An object may have been created and then burned, expired or deleted
// — every one of which looks exactly like "never created" from here. So a
// no-match leaves the record `ambiguous` and the key retained. Nothing is
// deleted, nothing is retired, and no record is closed on this evidence.
//
// Guessing by filename, size or timestamp is refused outright: size only
// narrows the candidate set, and the digest is the only thing that decides.

import { createHash } from "node:crypto";

import { sealedManifestBytes } from "../manifest.js";
import type { StoredObjectSource } from "../transport.js";
import type { UploadJournal, UploadRecord } from "./journal.js";
import { UploadTransport, UploadTransportError } from "./transport.js";

/** How many `/meta` reads one reconciliation will spend. Candidates are already
 *  narrowed by exact ciphertext size, so this is reached only by an account
 *  with many same-sized shares. When it is reached, the result says so — a
 *  silent cap would read as "no match" and mean "not looked". */
export const MAX_CANDIDATE_PROBES = 32;

export type ReconcileOutcome =
  /** Proven: this object carries the exact sealed manifest this upload sent. */
  | { readonly result: "resolved"; readonly record: UploadRecord }
  /** No candidate matched. NOT proof of absence — see the header. */
  | { readonly result: "no-match"; readonly probed: number; readonly truncated: boolean }
  /** The account's list or a candidate's metadata could not be read. */
  | { readonly result: "unavailable"; readonly code: string };

export const manifestDigest = (sealed: Uint8Array): string =>
  createHash("sha256").update(sealed).digest("hex");

/**
 * Try to name the object an ambiguous record produced.
 *
 * Read-only against the account: it lists and it reads metadata. It never
 * deletes, never finalizes and never touches an object it did not prove.
 */
export async function reconcileUpload(input: {
  readonly record: UploadRecord;
  readonly transport: UploadTransport;
  /** The unauthenticated metadata reader — the same one a receive uses. */
  readonly source: StoredObjectSource;
  readonly journal: UploadJournal;
  readonly signal?: AbortSignal;
}): Promise<ReconcileOutcome> {
  const { record } = input;
  if (record.state === "published" && record.objectId !== null) {
    return { result: "resolved", record };
  }
  let rows;
  try {
    rows = await input.transport.list(input.signal);
  } catch (error) {
    return {
      result: "unavailable",
      code: error instanceof UploadTransportError ? error.code : "internal",
    };
  }
  // Narrowed, never decided, by size: the server stores the ciphertext length
  // this upload declared and produced, so a row of another size cannot be it.
  const candidates = rows
    .filter((row) => row.size === record.cipherBytes)
    // Newest first: an ambiguous finalize is recent, so the match is usually
    // the first probe rather than the last.
    .sort((a, b) => b.createdAt - a.createdAt);
  const probes = candidates.slice(0, MAX_CANDIDATE_PROBES);
  let probed = 0;
  for (const row of probes) {
    let meta;
    try {
      meta = await input.source.meta(row.id, input.signal);
    } catch {
      // A candidate that cannot be read is not a candidate that failed to
      // match; it is simply unproven, so the search continues.
      probed += 1;
      continue;
    }
    probed += 1;
    const sealed = sealedManifestBytes(meta.encManifest);
    if (sealed === null) continue;
    if (manifestDigest(sealed) !== record.manifestDigest) continue;
    // Proven. The record becomes publishable, with the server's own id and
    // deadline — never a locally reconstructed one.
    const updated = await input.journal.update(record.jobId, {
      state: "published",
      objectId: row.id,
      expiresAt: meta.expiresAt,
      note: "reconciled",
    });
    return { result: "resolved", record: updated };
  }
  return { result: "no-match", probed, truncated: candidates.length > probes.length };
}
