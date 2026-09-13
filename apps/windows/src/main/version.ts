// The product's ONE version ordering.
//
// Extracted from `update/manifest.ts`, where it was born, because a second
// caller now needs it: the client-policy gate decides whether this build may
// run at all by comparing its version against a served floor. Two orderings in
// one app is the kind of divergence that is invisible until the day the two
// disagree about a single build — and here one of them would decide whether a
// person's app opens.
//
// `manifest.ts` keeps its exact contract: its `parseVersion` still throws
// `ManifestError("bad-version")`, and its own suite is unchanged, which is the
// proof that moving these did not move the update path.

/** Long enough for `65535.65535.65535`, short enough to bound a hostile input. */
export const MAX_VERSION_LENGTH = 32;

/**
 * `x.y.z`, and nothing else.
 *
 * No prerelease, no build metadata, no `v` prefix, no four-part version. Every
 * one of those is a comparison rule this product does not need and would have
 * to get right to be safe. Leading zeros are refused so `1.01.0` cannot compare
 * equal to `1.1.0` in one place and differently in another.
 */
const SEMVER = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;

/**
 * Total: a version this cannot read is `null`, never a best guess.
 *
 * Non-throwing on purpose. The policy path reads a document off the network,
 * where an unreadable version is an ordinary outcome to refuse rather than an
 * exception to catch — and a lenient parse would turn `1.2.4-beta` into a
 * number and compare it against a policy that meant something else.
 */
export function readVersion(text: unknown): readonly [number, number, number] | null {
  if (typeof text !== "string" || text.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 or 1 over two already-read versions. */
export function compareTriples(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}
