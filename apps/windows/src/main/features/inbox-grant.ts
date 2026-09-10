// What the user actually agreed to, per account, and where it may write.
//
// ## Why this is persisted at all
//
// Two things have to survive a restart or the Inbox is not a resident feature:
// the CONSENT ("yes, receive on this PC") and the DESTINATION the user chose in
// a native dialog. Neither can be re-derived. Without them a restart would
// either re-ask on every launch — which trains people to click through consent
// — or silently resume receiving into a folder nobody re-authorised.
//
// ## Why it is account-scoped, and never a preference
//
// `preferences.ts` is a fixed set of BOOLEANS in a plain JSON file, shared by
// the whole installation. A destination is neither: it is a path, and it belongs
// to one account. Storing consent app-wide would mean signing in as a second
// account silently inherited the first account's "yes", which is the one thing
// `mayEnrol`/consent separation exists to prevent — so the record is keyed by
// the same account digest every other Inbox store uses, and an account with no
// record is DISABLED.
//
// ## Why the secret store
//
// It is the only main-owned store this app has that is encrypted at rest,
// serialised per key, and already refuses to invent a value when it cannot read
// one. That last property is the reason: an unreadable record must never read
// as "no consent, generate fresh", because the fresh path would mint a new
// at-rest key and orphan the user's message history. Every failure except a
// typed `not-found` propagates.
//
// Nothing here ever crosses IPC. The renderer learns THAT a folder is chosen,
// never which one.

import { newAtRestKeyBytes, AT_REST_KEY_BYTES } from "../inbox/atrest.js";

/** The record's own version, so a later shape is refused rather than guessed. */
const GRANT_VERSION = 1;

/**
 * The longest destination this will accept back out of the store.
 *
 * Main wrote it, so this is a corruption check rather than input validation:
 * a value longer than any Windows path could be is not a path this process
 * chose, and opening a helper against it is not something to attempt.
 */
const MAX_DIRECTORY_LENGTH = 4096;

export interface InboxGrant {
  /** The folder the user chose natively. Main-only. */
  readonly directory: string;
  /** Whether the user has asked to receive. */
  readonly enabled: boolean;
  /**
   * A withdrawal central has not confirmed.
   *
   * The Mac's `stopAnnouncementPending`, and it exists for the same reason:
   * central keeps the last policy it was told, so a device that stops polling
   * without saying so is still offered to senders and collects deliveries
   * nobody will ever work. Set when a disable could not reach central, retried
   * on later ticks, and cleared only when central confirms.
   */
  readonly withdrawalPending: boolean;
}

/** The narrow slice of `SecretStore` this needs. Nothing else is reachable. */
export interface GrantSlot {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  putIfAbsent(key: string, value: string): Promise<{ created: boolean; value: string }>;
}

/** `code` off a SecretStoreError-shaped rejection, without importing the class. */
function failureCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function grantSlotFor(accountKey: string): string {
  return `inbox-grant-${accountKey}`;
}

export function atRestSlotFor(accountKey: string): string {
  return `inbox-at-rest-${accountKey}`;
}

export class InboxGrantStore {
  constructor(private readonly slot: GrantSlot) {}

  /**
   * The account's grant, or `null` when it genuinely has none.
   *
   * `null` is returned for exactly one reason — a typed `not-found` — and for a
   * malformed record, which is a record this build cannot honour and must not
   * act on. Every other failure propagates, because "the store could not be
   * read" is not "the user said no", and treating it as such would show a
   * disabled switch over an enrolment that is still live on the server.
   */
  async read(accountKey: string): Promise<InboxGrant | null> {
    let raw: string;
    try {
      raw = await this.slot.get(grantSlotFor(accountKey));
    } catch (error) {
      if (failureCode(error) === "not-found") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record["v"] !== GRANT_VERSION) return null;
    const directory = record["directory"];
    if (typeof directory !== "string" || directory.length === 0) return null;
    if (directory.length > MAX_DIRECTORY_LENGTH) return null;
    return {
      directory,
      enabled: record["enabled"] === true,
      withdrawalPending: record["withdrawalPending"] === true,
    };
  }

  /** Replace the grant. The caller owns the whole value; there is no merge. */
  async write(accountKey: string, grant: InboxGrant): Promise<void> {
    await this.slot.put(
      grantSlotFor(accountKey),
      JSON.stringify({
        v: GRANT_VERSION,
        directory: grant.directory,
        enabled: grant.enabled,
        withdrawalPending: grant.withdrawalPending,
      }),
    );
  }

  /**
   * The at-rest key for this account's journal and vault.
   *
   * `putIfAbsent` rather than get-then-generate, because the failure being
   * prevented is not a race — it is a SECOND key for records the first one
   * sealed. The store writes only on a typed `not-found`; an unreadable or
   * undecryptable record, or an unavailable cipher, rejects here rather than
   * quietly becoming a fresh key over a history that can then never be opened.
   *
   * The random bytes are generated before the call and usually discarded. That
   * is the correct direction: generating lazily would mean a code path where
   * "absent" and "unreadable" both reach the same generation site.
   */
  async atRestKey(accountKey: string): Promise<Uint8Array> {
    const minted = Buffer.from(newAtRestKeyBytes()).toString("base64");
    const { value } = await this.slot.putIfAbsent(atRestSlotFor(accountKey), minted);
    const bytes = Buffer.from(value, "base64");
    if (bytes.byteLength !== AT_REST_KEY_BYTES) {
      // A stored value of the wrong length is not something to replace: the
      // records were sealed to whatever key wrote them, and minting over it
      // would destroy the history rather than recover it.
      throw Object.assign(new Error("inbox: at-rest key is malformed"), { code: "key-unavailable" });
    }
    return new Uint8Array(bytes);
  }
}
