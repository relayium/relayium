// The at-rest format for local Inbox state.
//
// ## Why this is not the wire format
//
// The wire has its own framing (`store-crypto`'s AEAD frames, reached through
// the runtime contract) and it is a PROTOCOL: both ends must agree on it. What
// the vault and the journal need is different — authenticated encryption of a
// local record that no other party reads — so it uses WebCrypto AES-GCM
// directly rather than borrowing a protocol format it would then be coupled to.
//
// Keeping them separate means a wire-format change cannot silently invalidate
// everything on the user's disk, and a local-format change cannot reach the
// wire.
//
// ## Associated data is the point
//
// Every record binds its account key, its kind and the format version as AEAD
// associated data. A ciphertext therefore cannot be replayed into another
// account's directory, read as a different kind of record, or reinterpreted by a
// future format — all three fail authentication rather than decrypting into
// something plausible.
export const AT_REST_VERSION = 1;
export const AT_REST_KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The record kinds, each binding its own associated data.
 *
 * `send-plan` is additive. `associatedData` interpolates the kind, so a new
 * member gives a distinct AAD for free while the existing three keep
 * byte-identical associated data — `AT_REST_VERSION` does not move and no
 * stored record is reinterpreted. A document sealed under one purpose fails
 * authentication under another, which is what stops a journal being opened as a
 * send plan even though both live in the same account directory.
 */
export type AtRestKind = "vault-record" | "vault-index" | "journal" | "send-plan";

export class AtRestError extends Error {
  constructor(
    readonly code: "unreadable" | "unsupported-version" | "key-unavailable",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AtRestError";
  }
}

interface Envelope {
  readonly v: number;
  readonly iv: string;
  readonly ct: string;
}

/**
 * Copy into an ArrayBuffer-backed view.
 *
 * WebCrypto's `BufferSource` requires `ArrayBufferView<ArrayBuffer>`, and both
 * Node's `Buffer` and a `Uint8Array` typed from Node's lib are
 * `ArrayBufferLike`-backed. Copying at the boundary is one small allocation per
 * record and avoids casting away a real type distinction.
 */
function webcryptoBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

function associatedData(accountKey: string, kind: AtRestKind): Uint8Array<ArrayBuffer> {
  return webcryptoBytes(new TextEncoder().encode(`relayium-inbox-at-rest-v${AT_REST_VERSION}:${accountKey}:${kind}`));
}

export async function importAtRestKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== AT_REST_KEY_BYTES) {
    throw new AtRestError("key-unavailable", "at-rest key is the wrong length");
  }
  return crypto.subtle.importKey("raw", webcryptoBytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function newAtRestKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AT_REST_KEY_BYTES));
}

/** Seal one record. The envelope is JSON so a partial write is detectable. */
export async function seal(
  key: CryptoKey,
  accountKey: string,
  kind: AtRestKind,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(accountKey, kind) },
    key,
    webcryptoBytes(plaintext),
  );
  const envelope: Envelope = {
    v: AT_REST_VERSION,
    iv: Buffer.from(iv).toString("base64"),
    ct: Buffer.from(ct).toString("base64"),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/**
 * Open one record.
 *
 * Every failure is `unreadable` and NONE of them is recoverable by starting
 * fresh. A caller that treated a corrupt record as "no record" would silently
 * discard the user's history, which is the failure mode this whole store exists
 * to avoid.
 */
export async function open(
  key: CryptoKey,
  accountKey: string,
  kind: AtRestKind,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(sealed)) as Envelope;
  } catch {
    throw new AtRestError("unreadable", "record envelope is not JSON");
  }
  if (typeof envelope.v !== "number") throw new AtRestError("unreadable", "record has no version");
  if (envelope.v !== AT_REST_VERSION) {
    // Refused, not guessed at. A newer record written by a later build is not
    // something this one may reinterpret.
    throw new AtRestError("unsupported-version", `record version ${envelope.v}`);
  }
  if (typeof envelope.iv !== "string" || typeof envelope.ct !== "string") {
    throw new AtRestError("unreadable", "record envelope is malformed");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: webcryptoBytes(Buffer.from(envelope.iv, "base64")),
        additionalData: associatedData(accountKey, kind),
      },
      key,
      webcryptoBytes(Buffer.from(envelope.ct, "base64")),
    );
    return new Uint8Array(plaintext);
  } catch {
    // Authentication failure: corrupt, truncated, or a record from another
    // account or kind. Indistinguishable by design, and all equally refused.
    throw new AtRestError("unreadable", "record failed authentication");
  }
}
