// **May this binary run at all?**
//
// Not a gate on who the user is or what they have paid for — that question is
// decided before there is a product surface to gate. The product needs one
// operational lever it does not have on Windows today: if a build ships with a
// defect that must be stopped in the field, there is currently no way to stop
// it. macOS has had that lever since `SupportedVersion.swift`; this is its
// Windows half, ported rather than invented.
//
// ## It ships INERT, deliberately
//
// `EMBEDDED_FLOOR` blocks nothing, and no server serves
// `/api/client-policy/windows` yet. Both are on purpose. A version gate cannot
// be added to a build that is already installed — whatever ships first is
// exactly the population it can never reach retroactively — so the mechanism
// has to be in the first release even though the decision that gives it teeth
// (OA-033) is the owner's and is blocked behind a verified release catalogue
// (OA-029, OA-030). Shipping the mechanism costs nothing and risks nothing;
// shipping without it forecloses the lever permanently.
//
// ## Invariants, recorded BEFORE the implementation
//
// Each has at least one adversarial case in `client-policy.test.ts`.
//
//  1. **Fail open.** With no valid served or cached document the embedded floor
//     is the policy in force, and the build carrying that floor is never
//     blocked by it. A policy outage must not brick a client.
//  2. **Stricter only.** A served document may raise the requirement above the
//     embedded floor and never lower it, so a rolled-back copy of an older
//     policy cannot unblock a client this build already knows must stop.
//  3. **Replay barrier.** The device remembers the highest revision it ever
//     accepted and refuses anything below it. Without this, a perfectly valid,
//     correctly served, older document unblocks a client that was already told
//     to stop.
//  4. **Bounded revision.** A revision above `MAX_POLICY_REVISION` is refused.
//     An unbounded one, once REMEMBERED, would sit above every revision the
//     product can ever publish, and the device would refuse every genuine
//     policy for the life of the install — including the emergency one.
//  5. **Schema is exact.** A document announcing a schema this build does not
//     know is refused whole. A forward-compatible read is a read that can be
//     told to ignore the field that mattered.
//  6. **No URL, ever.** The decoded policy has no URL of any kind and unknown
//     fields are dropped. This document is fetched over the network; a policy
//     that could name where an update comes from would be a remote redirect for
//     the one action that installs code on the user's PC. Where an update comes
//     from is the shipped updater's pinned feed, and this can only decide
//     WHETHER the app asks.
//  7. **A placeholder build number cannot block.** `BUILD_NUMBER` is 0 and
//     `BUILD_NUMBER_PROVISIONED` is false until a release sets them. Comparing a
//     placeholder against a real `minimumSupportedBuild` would have every
//     unreleased build block itself. `build-info.ts` left that flag for "a check
//     to be added the moment updates are enabled"; this is that check.
//  8. **Whole or nothing.** One unreadable field refuses the document. A
//     partially honoured policy is a policy whose refused half was the half that
//     mattered.
//  9. **Either vocabulary can block.** Version and build are one policy said
//     twice. A build below EITHER floor is blocked, so a release that got one of
//     the two wrong still stops.
// 10. **A coherent document, or none.** `minimumSupported <= recommended <=
//     latest`, or the document is refused. An incoherent one would have the
//     screen tell somebody to update to a version that is still blocked.
import { BUILD_NUMBER, BUILD_NUMBER_PROVISIONED } from "../build-info.js";
import { compareTriples, readVersion } from "../version.js";

/** The schema this build understands. A different one is refused. */
export const POLICY_SCHEMA = 1;

/** The largest document this build will read. The real one is a few hundred
 *  bytes; the bound is so a misconfigured origin cannot hand us a body to
 *  buffer. */
export const MAX_POLICY_BYTES = 8 * 1024;

/** See invariant 4. Ordinary staging can still reach this. */
export const MAX_POLICY_REVISION = 1_000_000_000;

/**
 * The highest build floor this build will read.
 *
 * Unlike the revision this is NOT remembered, so a later document corrects a
 * silly one — but until that document arrives an absurd floor blocks every
 * provisioned client, and "bounded rather than merely positive" is this file's
 * rule everywhere else.
 */
export const MAX_POLICY_BUILD = 1_000_000_000;

export interface ClientPolicy {
  readonly revision: number;
  /** Below this, the product surfaces must not run. */
  readonly minimumSupported: readonly [number, number, number];
  /** Below this, say so and carry on. */
  readonly recommended: readonly [number, number, number];
  /** The newest published version, for the sentence a person reads. */
  readonly latest: readonly [number, number, number];
  /** `minimumSupported` in the update feed's vocabulary. */
  readonly minimumSupportedBuild: number;
}

/**
 * The floor compiled into this build.
 *
 * Three jobs, exactly as macOS's: it is the policy in force when there is no
 * valid remote one; it is the level below which a served document may not take
 * the policy; and its revision is the replay barrier a fresh install starts
 * from, since a device with no memory of its own uses the binary's.
 *
 * `0.0.0` and build `0` block nothing, which is what makes this build's own
 * shipping safe: the floor cannot block the binary that carries it. Lowering a
 * requirement for real is a thing a future release does by shipping a lower
 * floor — never something an old binary can be talked into over the network.
 */
export const EMBEDDED_FLOOR: ClientPolicy = Object.freeze({
  revision: 1,
  minimumSupported: [0, 0, 0] as const,
  recommended: [0, 0, 0] as const,
  latest: [0, 0, 1] as const,
  minimumSupportedBuild: 0,
});

/** Why a served document was refused. One case per distinct failure. */
export type PolicyRefusal =
  | "not-an-object"
  | "wrong-schema"
  | "missing-platform"
  | "bad-revision"
  | "replayed-revision"
  | "bad-version"
  | "bad-build"
  | "weaker-than-floor"
  | "incoherent";

export class PolicyError extends Error {
  constructor(readonly code: PolicyRefusal) {
    super(`client policy: ${code}`);
    this.name = "PolicyError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-negative integer within a bound. Rejects `NaN`, floats and `-0`. */
function readCount(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > max) return null;
  return value;
}

/**
 * Decode a served document, or refuse it.
 *
 * `acceptedRevision` is the highest this device has ever accepted — the replay
 * barrier of invariant 3. Pass `EMBEDDED_FLOOR.revision` on a fresh install.
 *
 * Nothing here reads a URL, and unknown fields are dropped rather than carried:
 * what this returns is exactly the five values above (invariant 6).
 */
export function decodePolicy(
  document: unknown,
  acceptedRevision: number,
  /**
   * The floor to hold the document against.
   *
   * A parameter, not a constant read inside, so invariant 2 can be ATTACKED in
   * a test. The shipped floor is `0.0.0`/build `0` — the weakest a document can
   * be — so with the constant inlined the only way to violate the rule is a
   * negative number, which the numeric validation rejects first. A test written
   * against that would report invariant 2 as covered while exercising
   * invariant 8.
   *
   * **Production must not pass this.** Every real caller takes the default; a
   * caller that supplied its own floor could hand the decoder a weaker one and
   * invariant 2 would hold against nothing.
   */
  floor: ClientPolicy = EMBEDDED_FLOOR,
): ClientPolicy {
  if (!isRecord(document)) throw new PolicyError("not-an-object");
  if (document["schema"] !== POLICY_SCHEMA) throw new PolicyError("wrong-schema");
  const windows = document["windows"];
  if (!isRecord(windows)) throw new PolicyError("missing-platform");

  const revision = readCount(windows["policyRevision"], MAX_POLICY_REVISION);
  if (revision === null || revision < 1) throw new PolicyError("bad-revision");
  // Invariant 3. Checked BEFORE the value is ever stored, which is also what
  // makes the bound above (invariant 4) worth having.
  if (revision < acceptedRevision) throw new PolicyError("replayed-revision");

  const minimumSupported = readVersion(windows["minimumSupportedVersion"]);
  const recommended = readVersion(windows["recommendedVersion"]);
  const latest = readVersion(windows["latestVersion"]);
  // Whole or nothing: one unreadable version refuses the document. Invariant 8.
  if (minimumSupported === null || recommended === null || latest === null) {
    throw new PolicyError("bad-version");
  }

  const minimumSupportedBuild = readCount(windows["minimumSupportedBuild"], MAX_POLICY_BUILD);
  if (minimumSupportedBuild === null) throw new PolicyError("bad-build");

  // Invariant 2. A document may raise the bar, never lower it — checked on both
  // vocabularies, because a document that lowered only one of them would have
  // lowered the policy.
  if (
    compareTriples(minimumSupported, floor.minimumSupported) < 0 ||
    minimumSupportedBuild < floor.minimumSupportedBuild
  ) {
    throw new PolicyError("weaker-than-floor");
  }

  // Invariant 10. An incoherent document is refused rather than rendered: with
  // `latest` below `minimumSupported`, the screen would tell somebody to update
  // to a version that is itself blocked, which is worse than saying nothing.
  if (
    compareTriples(minimumSupported, recommended) > 0 ||
    compareTriples(recommended, latest) > 0
  ) {
    throw new PolicyError("incoherent");
  }

  return { revision, minimumSupported, recommended, latest, minimumSupportedBuild };
}

/** What the app may do. */
export type SupportState = "blocked" | "recommended" | "supported";

export interface BuildIdentity {
  readonly version: string;
  readonly build: number;
  /** False while `build` is `build-info.ts`'s placeholder. Invariant 7. */
  readonly buildProvisioned: boolean;
}

/** This build, as the policy sees it. */
export function thisBuild(version: string): BuildIdentity {
  return { version, build: BUILD_NUMBER, buildProvisioned: BUILD_NUMBER_PROVISIONED };
}

/**
 * The decision.
 *
 * An unreadable OWN version is treated as supported, not blocked: this build's
 * own version comes from its packaged metadata, and if that is unreadable the
 * fault is here rather than with the user — refusing to run would turn a
 * packaging bug into a brick. Fail open is the rule in both directions.
 */
export function supportState(build: BuildIdentity, policy: ClientPolicy): SupportState {
  const version = readVersion(build.version);
  if (version === null) return "supported";
  // Invariant 9: either vocabulary can block, but only a provisioned build
  // number may speak (invariant 7).
  const belowVersion = compareTriples(version, policy.minimumSupported) < 0;
  const belowBuild = build.buildProvisioned && build.build < policy.minimumSupportedBuild;
  if (belowVersion || belowBuild) return "blocked";
  if (compareTriples(version, policy.recommended) < 0) return "recommended";
  return "supported";
}
