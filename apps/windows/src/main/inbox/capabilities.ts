// What this build tells central it can do.
//
// ## Advertised means implemented, and nothing else
//
// A capability is a promise to central that this device can receive a kind of
// delivery. Advertising one that is not implemented does not produce a
// degraded experience — it produces a task queued against a device that will
// never complete it, which the sender sees as a transfer that silently never
// arrives.
//
// So the set is computed from explicit feature switches rather than written as
// a literal, and every switch is `false` until its path genuinely works end to
// end on a real host. `inbox.text.v1` in particular stays off until text is
// saved to the vault and acknowledged.
import type { InboxRuntime } from "./runtime-contract.js";

/**
 * The auto-accept capability, read from the server.
 *
 * `server/internal/inbox/inbox.go`: `CapAutoAcceptV1 = "inbox.autoaccept.v1"`.
 * Declared here rather than reached through the runtime bundle because
 * `web/src/lib/device-inbox.ts` exports the POLICY type but not this string —
 * the Web client never enrols a device.
 */
export const CAP_AUTO_ACCEPT_V1 = "inbox.autoaccept.v1";

/**
 * What a device tells central to do with an incoming delivery.
 *
 * Mirrors `AutoAcceptPolicy` in `web/src/lib/device-inbox.ts`. All three values
 * are real; which of them is HONEST for this build is the question below.
 */
export type AutoAcceptPolicy = "off" | "ask" | "auto";

/**
 * The default, and it is `ask` rather than `off`.
 *
 * Both halves of this were established by a real server refusing, not by
 * reading (`native-recovery1/inbox-interop`):
 *
 *  - `auto` requires the separate `inbox.autoaccept.v1` capability. Advertising
 *    the policy without the capability is refused at enrolment.
 *  - `off` makes central refuse EVERY send to this device with
 *    `auto_receive_disabled`. It is not "receive quietly"; it is "this device
 *    cannot be sent to", which is not what a user who enabled the Inbox asked
 *    for.
 *
 * So `ask` is the honest minimum for a receiver with no auto-accept: deliveries
 * are held until the user accepts them, and sending to the device works.
 */
export const DEFAULT_AUTO_ACCEPT: AutoAcceptPolicy = "ask";

export interface ImplementedFeatures {
  /** Files and folders saved through the native helper. */
  readonly files: boolean;
  /** Text messages saved durably to the vault. */
  readonly text: boolean;
  /**
   * Accepting a delivery with no user interaction.
   *
   * Its OWN capability, not a mode of the others: central gates it separately,
   * and a device that can receive is not thereby a device that may receive
   * without asking.
   */
  readonly autoAccept: boolean;
}

/**
 * What this build actually implements.
 *
 * Both are `false`: the receive path is not wired yet. Flipping either one is a
 * deliberate act that belongs in the same change that finishes the path, and
 * `inbox-receive.test.ts` pins that they are only advertised together with
 * their implementation: with these flags it asserts that no capability is
 * offered, that enrolment is refused, and that auto-accept degrades to `ask`.
 */
export const IMPLEMENTED: ImplementedFeatures = Object.freeze({
  files: false,
  text: false,
  autoAccept: false,
});

export function capabilitiesFor(runtime: InboxRuntime, features: ImplementedFeatures): readonly string[] {
  const out: string[] = [];
  if (features.files) out.push(runtime.constants.capReceiveV3);
  if (features.text) out.push(runtime.constants.capTextV1);
  if (features.autoAccept) out.push(CAP_AUTO_ACCEPT_V1);
  return Object.freeze(out);
}

/**
 * The policy to enrol with.
 *
 * `auto` only when the user asked for it AND the build implements it, because
 * central refuses the policy without the capability. Everything else is `ask`.
 * `off` is never chosen on the user's behalf: it stops other devices sending to
 * this one entirely, which no user asking to enable the Inbox has requested.
 */
export function autoAcceptFor(features: ImplementedFeatures, consent: InboxConsent): AutoAcceptPolicy {
  // `off` is the user's explicit choice and needs no capability: it asks
  // central to refuse sends to this device, which any build can honour. It is
  // NEVER inferred — only `policy` says it — so an absent field keeps the
  // answer this function has always given.
  if (consent.policy === "off") return "off";
  return consent.autoAccept === true && features.autoAccept ? "auto" : DEFAULT_AUTO_ACCEPT;
}

/**
 * Whether this build may enrol at all.
 *
 * Enrolment tells central a device exists and is ready to be sent to. With no
 * receive capability implemented there is nothing to be ready for, so enrolling
 * would create a target for deliveries that cannot be completed.
 */
export function mayEnrol(features: ImplementedFeatures): boolean {
  // Auto-accept is deliberately NOT here: a device that can only accept
  // automatically has nothing to accept.
  return features.files || features.text;
}

/**
 * Whether the user has asked for the Inbox.
 *
 * Separate from `mayEnrol` on purpose: capability is about what the build can
 * do, consent is about what the user asked for, and BOTH are required. Nothing
 * enrols on launch.
 */
export interface InboxConsent {
  readonly enabled: boolean;
  /**
   * The user explicitly asked for deliveries to be accepted without asking.
   *
   * Optional and separate from `enabled`: enabling the Inbox is consent to
   * receive, not consent to receive silently.
   */
  readonly autoAccept?: boolean;
  /**
   * The policy the user explicitly chose, when they chose one.
   *
   * Only `off` is read here, and only because it is otherwise unreachable:
   * `autoAcceptFor` maps everything that is not `auto` to `ask`, so a device
   * whose user asked to stop being a target had no way to say so. `ask` and
   * `auto` continue to be decided by `autoAccept` and the build's capability,
   * which is what keeps a policy from being advertised without its
   * implementation.
   *
   * Absent means "no explicit choice", and every existing caller is unchanged.
   */
  readonly policy?: AutoAcceptPolicy;
}

export function shouldEnrol(features: ImplementedFeatures, consent: InboxConsent): boolean {
  return consent.enabled && mayEnrol(features);
}
