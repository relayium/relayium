// Is this device a legal target, and is it still the one we sealed to?
//
// ## Why this runs before a byte moves, and again after
//
// `InboxSendCoordinator` checks eligibility twice for two different reasons.
// BEFORE the upload it is a fail-fast: a device with receiving off refuses the
// create, and discovering that after an encrypted upload costs the user the
// whole transfer. AFTER the upload it is the key read: an upload can take long
// enough for the key it started with to be stale, and re-sealing 80 bytes is
// cheaper than re-sending the file.
//
// Every refusal below is central's, read from `writeInboxTaskError`. None is
// inferred from a device row this side decided to interpret.
import { SEND_REFUSALS, type SendRefusal } from "./send-wire.js";
import type { SendKind } from "./send-manifest.js";

/** The key central will seal to, as `GET .../inbox/keys` returns it. */
export interface TargetKey {
  readonly keyID: string;
  readonly generation: number;
  readonly publicKey: string;
  readonly algorithm: string;
}

/** What central says about the target's inbox. Fields it does not send are absent. */
export interface TargetInbox {
  readonly capabilities: readonly string[];
  readonly autoAccept: string;
  readonly presence: string;
  readonly protocolVersion: number;
  readonly revoked: boolean;
}

export interface EligibleTarget {
  readonly deviceID: string;
  readonly key: TargetKey;
  readonly inbox: TargetInbox;
}

export class TargetIneligible extends Error {
  constructor(
    /** Central's own token where one applies, so a caller can act on it. */
    readonly refusal: SendRefusal | "no_active_key" | "unsupported_content_kind",
    message?: string,
  ) {
    super(message ?? refusal);
    this.name = "TargetIneligible";
  }
}

/**
 * Decide eligibility from what central actually said.
 *
 * ## Offline is NOT ineligible
 *
 * A target that is offline still accepts deliveries: the task queues and the
 * device claims it when it next runs. Refusing here because presence says
 * `offline` would make the product unusable for the case it exists for — sending
 * to a machine that is not in front of you. Only `auto_receive_disabled`,
 * revocation and a missing receive capability are refusals, and all three are
 * central's verdicts.
 */
export function assertEligible(
  deviceID: string,
  inbox: TargetInbox,
  keys: readonly TargetKey[],
  kind: SendKind,
  runtimeCaps: { readonly receiveV3: string; readonly textV1: string; readonly keyAlgorithm: string },
): EligibleTarget {
  if (inbox.revoked) {
    throw new TargetIneligible(SEND_REFUSALS.deviceInboxRevoked, "the target's inbox was revoked");
  }
  if (!inbox.capabilities.includes(runtimeCaps.receiveV3)) {
    throw new TargetIneligible(SEND_REFUSALS.deviceCannotReceive, "the target advertises no receive capability");
  }
  // `off` makes central refuse every send with `auto_receive_disabled`. Saying
  // so here costs one read instead of an entire upload.
  if (inbox.autoAccept === "off") {
    throw new TargetIneligible(SEND_REFUSALS.autoReceiveDisabled, "the target accepts no deliveries");
  }
  // A TEXT delivery needs `inbox.text.v1`. A receiver without it would be
  // handed a message it cannot present as one.
  if (kind === "text" && !inbox.capabilities.includes(runtimeCaps.textV1)) {
    throw new TargetIneligible("unsupported_content_kind", "the target cannot present text deliveries");
  }
  const active = keys
    .filter((k) => k.algorithm === runtimeCaps.keyAlgorithm)
    .sort((a, b) => b.generation - a.generation)[0];
  if (active === undefined) {
    throw new TargetIneligible("no_active_key", "the target has no usable key");
  }
  return { deviceID, key: active, inbox };
}

/** Did the target rotate between two reads? */
export function keyChanged(sealedTo: TargetKey, current: TargetKey): boolean {
  return sealedTo.keyID !== current.keyID || sealedTo.generation !== current.generation;
}
