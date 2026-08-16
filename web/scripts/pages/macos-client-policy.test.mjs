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

const canonicalText = await readFile(resolve(process.cwd(), CANONICAL), "utf8");
const publishedText = await readFile(resolve(process.cwd(), PUBLISHED), "utf8");
const policy = JSON.parse(canonicalText);
const manifest = JSON.parse(
  await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
);

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
        minimumSupportedVersion: policy.macos.minimumSupportedVersion,
        minimumSupportedBuild: policy.macos.minimumSupportedBuild,
        recommendedVersion: policy.macos.recommendedVersion,
        latestVersion: policy.macos.latestVersion,
      },
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
      "recommendedVersion",
    ]);
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
