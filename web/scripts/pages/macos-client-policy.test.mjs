import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/// **The document the macOS client decides whether it may run from.**
///
/// Two files, one decision. `native-client-policy.json` is canonical — the file
/// a person edits to raise the minimum supported version — and
/// `public/apps/macos/client-policy.json` is the copy the client actually
/// fetches, written by `gen-pages.mjs` on every build and by
/// `stage-macos-release.mjs` on every release.
///
/// Everything here is asserted about the FILES rather than about the scripts
/// that write them, because the failure this guards is a published copy that
/// stopped agreeing with the canonical one: nothing breaks, no build fails, and
/// the requirement the product believes it published is not the one being
/// served.
const CANONICAL = "native-client-policy.json";
const PUBLISHED = "public/apps/macos/client-policy.json";
const policyRoot = process.env.RELAYIUM_POLICY_TEST_ROOT ?? process.cwd();

const canonicalText = await readFile(resolve(policyRoot, CANONICAL), "utf8");
const publishedText = await readFile(resolve(policyRoot, PUBLISHED), "utf8");
const policy = JSON.parse(canonicalText);
const manifest = JSON.parse(
  await readFile(resolve(policyRoot, "native-releases.json"), "utf8"),
);
const isPreparedCutover = Object.hasOwn(policy, "nextRelease");

/** Numeric, component by component: `1.2.10` is above `1.2.9`. */
function compare(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

describe("the macOS client version policy", () => {
  it("is served byte-for-byte as it is written", () => {
    // Not "equal as JSON". The client fetches one file and a person edits the
    // other; a difference in key order or whitespace is a difference nobody
    // would look for, and re-running `gen-pages` would silently repair it in
    // whichever direction the build happened to run.
    expect(publishedText).toBe(canonicalText);
  });

  it("is the schema this client understands, in the spelling it is written in", () => {
    expect(policy.schema).toBe(1);
    // The exact serialization the release path produces. A hand edit that used
    // a different key order or four-space indentation would still parse, and
    // would then be rewritten by the next release — turning one product change
    // into a diff nobody asked for.
    expect(canonicalText).toBe(`${JSON.stringify({
      schema: 1,
      macos: {
        policyRevision: policy.macos.policyRevision,
        minimumSupportedVersion: policy.macos.minimumSupportedVersion,
        minimumSupportedBuild: policy.macos.minimumSupportedBuild,
        recommendedVersion: policy.macos.recommendedVersion,
        latestVersion: policy.macos.latestVersion,
      },
      nextRelease: policy.nextRelease,
    }, null, 2)}\n`);
  });

  it("names no URL, host or path anywhere", () => {
    // The client refuses to read one, and this refuses to publish one. An
    // update address is the single most valuable field an attacker could add to
    // a document fetched over the network, and the defence is that neither end
    // has a place to put it.
    expect(canonicalText).not.toMatch(/https?:/i);
    expect(Object.keys(policy.macos).sort()).toEqual([
      "latestVersion",
      "minimumSupportedBuild",
      "minimumSupportedVersion",
      "policyRevision",
      "recommendedVersion",
    ]);
  });

  it("is exactly the prepared source or the staged 1.2.9 cutover", () => {
    const expected = isPreparedCutover
      ? {
          manifest: { available: true, version: "1.2.7", build: 13 },
          macos: {
            policyRevision: 1,
            minimumSupportedVersion: "1.2.4",
            minimumSupportedBuild: 11,
            recommendedVersion: "1.2.5",
            latestVersion: "1.2.7",
          },
          nextRelease: {
            version: "1.2.9",
            minimumSupportedVersion: "1.2.9",
            minimumSupportedBuild: 15,
            recommendedVersion: "1.2.9",
          },
        }
      : {
          manifest: { available: true, version: "1.2.9", build: 15 },
          macos: {
            policyRevision: 2,
            minimumSupportedVersion: "1.2.9",
            minimumSupportedBuild: 15,
            recommendedVersion: "1.2.9",
            latestVersion: "1.2.9",
          },
          nextRelease: undefined,
        };
    expect({
      manifest: {
        available: manifest.macos.available,
        version: manifest.macos.version,
        build: manifest.macos.build,
      },
      macos: policy.macos,
      nextRelease: policy.nextRelease,
    }).toEqual(expected);
  });

  /// **The requirement and the revision that names it, pinned together.**
  ///
  /// This is the one assertion in the suite that a change is SUPPOSED to break.
  /// A client remembers the highest revision it has accepted and refuses a
  /// different document under a revision it already holds — so an edit that
  /// raises the minimum without advancing `policyRevision` is not merely
  /// undocumented, it is declined by exactly the clients that already fetched
  /// the previous copy, silently and with nothing failing anywhere.
  ///
  /// **So: change any line below and advance `policyRevision` in the same edit,
  /// then update this expectation to match.** Only `latestVersion` is exempt —
  /// `stage-macos-release.mjs` owns that field and advances the revision itself
  /// when a release moves it. `SupportedVersionModelTests` proves the client
  /// behaviour this rule follows from.
  it("declares its requirement and its revision in one edit", () => {
    expect({
      policyRevision: policy.macos.policyRevision,
      minimumSupportedVersion: policy.macos.minimumSupportedVersion,
      minimumSupportedBuild: policy.macos.minimumSupportedBuild,
      recommendedVersion: policy.macos.recommendedVersion,
    }).toEqual(isPreparedCutover
      ? {
          policyRevision: 1,
          minimumSupportedVersion: "1.2.4",
          minimumSupportedBuild: 11,
          recommendedVersion: "1.2.5",
        }
      : {
          policyRevision: 2,
          minimumSupportedVersion: "1.2.9",
          minimumSupportedBuild: 15,
          recommendedVersion: "1.2.9",
        });
  });

  it("carries a revision inside the range every client will read", () => {
    // The floor is what makes it a revision; the ceiling is what stops one
    // corrupt document from pinning a client's high-water mark above anything
    // the product can ever publish again. `SupportedVersionSurfaceTests` holds
    // this ceiling to the client's own `maxPolicyRevision`.
    expect(Number.isInteger(policy.macos.policyRevision)).toBe(true);
    expect(policy.macos.policyRevision).toBeGreaterThanOrEqual(1);
    expect(policy.macos.policyRevision).toBeLessThanOrEqual(1000000000);
  });

  it("orders its three versions the way the client reads them", () => {
    const { minimumSupportedVersion, recommendedVersion, latestVersion } = policy.macos;
    for (const version of [minimumSupportedVersion, recommendedVersion, latestVersion]) {
      expect(version).toMatch(/^[0-9]+(?:\.[0-9]+){0,3}$/);
    }
    // A minimum above the recommendation would block builds the product also
    // calls merely out of date; a recommendation above the latest release would
    // recommend a version nobody can install.
    expect(compare(minimumSupportedVersion, recommendedVersion)).toBeLessThanOrEqual(0);
    expect(compare(recommendedVersion, latestVersion)).toBeLessThanOrEqual(0);
  });

  it("names the release that is actually published", () => {
    if (!manifest.macos.available) return;
    expect(policy.macos.latestVersion).toBe(manifest.macos.version);
    expect(Number.isInteger(policy.macos.minimumSupportedBuild)).toBe(true);
    expect(policy.macos.minimumSupportedBuild).toBeGreaterThan(0);
    expect(policy.macos.minimumSupportedBuild).toBeLessThanOrEqual(manifest.macos.build);
  });
});
