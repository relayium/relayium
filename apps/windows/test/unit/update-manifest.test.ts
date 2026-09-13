// The manifest: strict schema, explicit platform, and the two version rules.
import { describe, expect, it } from "vitest";

import {
  MAX_ARTIFACT_BYTES,
  ManifestError,
  compareVersions,
  installability,
  parseManifest,
  parseVersion,
} from "../../src/main/update/manifest.js";

const EXPECTED = {
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
} as const;

const good = {
  schema: 1,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
  version: "0.2.0",
  build: 7,
  artifact: {
    url: "https://github.com/relayium/relayium/releases/download/windows-v0.2.0/Relayium-Setup.exe",
    sizeBytes: 90_000_000,
    sha256: "a".repeat(64),
  },
  publishedAt: 1_789_000_000,
  notesUrl: "https://relayium.com/apps/windows/notes/0.2.0",
};

/** The signature is carried with the parse so a restart can re-authenticate;
 *  its VALIDITY is `trust.ts`'s business, not the parser's. */
const SIGNATURE = "s".repeat(86);

const parse = (document: unknown) =>
  parseManifest(new TextEncoder().encode(JSON.stringify(document)), EXPECTED, SIGNATURE);

describe("the manifest", () => {
  it("accepts the documented document", () => {
    const manifest = parse(good);
    expect(manifest).toMatchObject({
      schema: 1,
      version: "0.2.0",
      build: 7,
      artifactBytes: 90_000_000,
      artifactSha256: "a".repeat(64),
      signature: SIGNATURE,
    });
    // The EXACT bytes travel with the parse: a restart re-authenticates them,
    // and re-serialising the parsed object would produce something the
    // signature does not cover.
    expect(new TextDecoder().decode(manifest.signedBytes)).toBe(JSON.stringify(good));
  });

  it("treats an unknown schema as a refusal, not as something to partly honour", () => {
    for (const schema of [2, 0, "1", null, undefined]) {
      expect(() => parse({ ...good, schema }), String(schema)).toThrow(/unknown-schema/);
    }
  });

  it("compares product, channel, platform and arch rather than reading them", () => {
    expect(() => parse({ ...good, product: "relayium-mac" })).toThrow(/wrong-product/);
    expect(() => parse({ ...good, channel: "beta" })).toThrow(/wrong-channel/);
    expect(() => parse({ ...good, platform: "darwin" })).toThrow(/wrong-platform/);
    expect(() => parse({ ...good, arch: "arm64" })).toThrow(/wrong-arch/);
  });

  it("refuses an artifact URL that is not plainly an https download", () => {
    for (const url of [
      "http://github.com/x/y/releases/download/z/a.exe",
      "https://user:pass@github.com/a.exe",
      "https://github.com/a.exe#k=secret",
      "https://github.com:8443/a.exe",
      "file:///c:/windows/system32/a.exe",
      "",
      `https://github.com/${"a".repeat(3000)}`,
    ]) {
      expect(() => parse({ ...good, artifact: { ...good.artifact, url } }), url.slice(0, 40)).toThrow(
        /bad-artifact-url/,
      );
    }
  });

  it("bounds the artifact size and requires an exact lowercase hash", () => {
    expect(() => parse({ ...good, artifact: { ...good.artifact, sizeBytes: 0 } })).toThrow(
      /bad-artifact-size/,
    );
    expect(() =>
      parse({ ...good, artifact: { ...good.artifact, sizeBytes: MAX_ARTIFACT_BYTES + 1 } }),
    ).toThrow(/bad-artifact-size/);
    for (const sha256 of ["A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`, 42, null]) {
      expect(() => parse({ ...good, artifact: { ...good.artifact, sha256 } })).toThrow(
        /bad-artifact-hash/,
      );
    }
  });

  it("refuses a build that is not a positive safe integer", () => {
    for (const build of [0, -1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => parse({ ...good, build }), String(build)).toThrow(/bad-build/);
    }
  });

  it("refuses anything that is not JSON, or not an object", () => {
    expect(() => parseManifest(new TextEncoder().encode("not json"), EXPECTED, SIGNATURE)).toThrow(
      /not-json/,
    );
    expect(() => parseManifest(new TextEncoder().encode("[]"), EXPECTED, SIGNATURE)).toThrow(
      /not-an-object/,
    );
    // Invalid UTF-8 is not silently replaced.
    expect(() => parseManifest(new Uint8Array([0xff, 0xfe, 0xfd]), EXPECTED, SIGNATURE)).toThrow(
      /not-json/,
    );
  });

  it("accepts a missing notesUrl but not a bad one", () => {
    expect(parse({ ...good, notesUrl: undefined }).notesUrl).toBeNull();
    expect(parse({ ...good, notesUrl: null }).notesUrl).toBeNull();
    expect(() => parse({ ...good, notesUrl: "http://relayium.com/notes" })).toThrow(/bad-notes-url/);
  });
});

describe("versions", () => {
  it("accepts only strict x.y.z", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "1.2.3+7", "1.01.0", "", "a.b.c"]) {
      expect(() => parseVersion(bad), bad).toThrow(ManifestError);
    }
  });

  it("orders totally", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });
});

describe("installability", () => {
  const current = { version: "0.2.0", build: 7 };

  it("requires the build to be STRICTLY greater", () => {
    expect(installability({ version: "0.3.0", build: 8 }, current).verdict).toBe("newer");
    // Equal is not newer.
    expect(installability({ version: "0.3.0", build: 7 }, current).verdict).toBe("not-newer");
    expect(installability({ version: "0.3.0", build: 6 }, current).verdict).toBe("not-newer");
  });

  it("admits a rebuild of the same version", () => {
    // Same user-visible version, higher build: a legitimate rebuild.
    expect(installability({ version: "0.2.0", build: 8 }, current).verdict).toBe("newer");
  });

  it("refuses a downgrade wearing a higher build number", () => {
    // The case a monotonic counter alone would admit.
    expect(installability({ version: "0.1.0", build: 99 }, current).verdict).toBe(
      "version-regression",
    );
  });
});
