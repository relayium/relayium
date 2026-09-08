// The staging tool decides what an installed app is told to install, so every
// rule in it is a release-trust rule and every one of them is asserted here.
//
// The negatives matter more than the positive. A tool that happily writes a
// document describing bytes nobody published — or describing the PREVIOUS
// release under this release's version — is exactly how a browser-mediated
// update flow becomes a way to hand users the wrong file.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANDROID_FEED_URL,
  ANDROID_RELEASE_FILE,
  APPLICATION_ID,
  MAX_APK_BYTES,
  PUBLISHED_ANDROID_FEED_PATH,
  assertMonotonic,
  assertReadableHistory,
  assetNameFor,
  buildAndroidRelease,
  buildUnavailableRelease,
  downloadUrlFor,
  measureApk,
  publishedHeight,
  readAndroidRelease,
  tagFor,
  writeAndroidRelease,
} from "./stage-android-release.mjs";
import { EXPECTED_CERT_SHA256, MAX_VERSION_CODE } from "./verify-android-apk.mjs";

const webRoot = resolve(import.meta.dirname, "..");

const ok = {
  versionName: "0.1.2",
  versionCode: 3,
  sha256: "a".repeat(64),
  size: 40_000_000,
  notes: { en: "Fixes", zh: "修复" },
};

describe("buildAndroidRelease", () => {
  it("derives the immutable asset url from the version, not from a caller", () => {
    const doc = buildAndroidRelease(ok);
    expect(doc.android.downloadUrl).toBe(
      "https://github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
    );
    expect(doc.schema).toBe(1);
    expect(doc.android.available).toBe(true);
    expect(doc.android.applicationId).toBe(APPLICATION_ID);
  });

  it("refuses a version name that is not the strict numeric form", () => {
    for (const versionName of ["0.1", "0.1.2.3", "v0.1.2", "0.1.2-rc1", "01.1.2", "", "x", "0.1.2 "]) {
      expect(() => buildAndroidRelease({ ...ok, versionName }), versionName).toThrow(/versionName/);
    }
  });

  it("refuses a version code that is not a positive integer", () => {
    for (const versionCode of [0, -1, 1.5, "3", null, undefined, NaN]) {
      expect(() => buildAndroidRelease({ ...ok, versionCode })).toThrow(/versionCode/);
    }
  });

  it("refuses a hash that is not 64 lowercase hex", () => {
    for (const sha256 of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", null]) {
      expect(() => buildAndroidRelease({ ...ok, sha256 })).toThrow(/sha256/);
    }
  });

  it("refuses a size outside the publisher policy", () => {
    for (const size of [0, -1, 1.5, MAX_APK_BYTES + 1, "40000000", null]) {
      expect(() => buildAndroidRelease({ ...ok, size })).toThrow(/size/);
    }
    expect(buildAndroidRelease({ ...ok, size: MAX_APK_BYTES }).android.size).toBe(MAX_APK_BYTES);
  });

  // The defect this whole shape exists to prevent: metadata that advertises one
  // version while pointing at another release's artifact.
  it("refuses an apk whose file name is not the advertised release", () => {
    expect(() =>
      buildAndroidRelease({ ...ok, apkName: "Relayium-0.1.1-2.apk" }),
    ).toThrow(/must be published as Relayium-0.1.2-3\.apk/);
    expect(() => buildAndroidRelease({ ...ok, apkName: "app-release.apk" })).toThrow(/file name/);
    expect(() =>
      buildAndroidRelease({ ...ok, apkName: assetNameFor("0.1.2", 3) }).android.versionCode,
    ).not.toThrow();
  });

  it("refuses an apk whose own manifest disagrees with the metadata", () => {
    expect(() => buildAndroidRelease({ ...ok, apkPackage: "com.evil.app" })).toThrow(/package/);
    expect(() => buildAndroidRelease({ ...ok, apkVersionCode: 2 })).toThrow(/versionCode/);
    expect(() => buildAndroidRelease({ ...ok, apkVersionName: "0.1.1" })).toThrow(/versionName/);
    // Agreeing values pass.
    expect(
      buildAndroidRelease({
        ...ok,
        apkPackage: APPLICATION_ID,
        apkVersionCode: "3",
        apkVersionName: "0.1.2",
      }).android.versionCode,
    ).toBe(3);
  });

  // Android refuses to replace an installed app with a differently-signed one,
  // so publishing under a new certificate produces an update nobody can install.
  it("refuses a signing certificate that is not the established one", () => {
    expect(() =>
      buildAndroidRelease({ ...ok, certSha256: "b".repeat(64), expectedCertSha256: "c".repeat(64) }),
    ).toThrow(/certificate/);
    expect(() => buildAndroidRelease({ ...ok, expectedCertSha256: "c".repeat(64) })).toThrow(
      /certificate digest was required/,
    );
    expect(() =>
      buildAndroidRelease({ ...ok, certSha256: "C".repeat(64), expectedCertSha256: "c".repeat(64) }),
    ).not.toThrow();
  });

  it("requires both maintained languages in the release notes", () => {
    expect(() => buildAndroidRelease({ ...ok, notes: { en: "Fixes" } })).toThrow(/notes\.zh/);
    expect(() => buildAndroidRelease({ ...ok, notes: { zh: "修复" } })).toThrow(/notes\.en/);
    expect(() => buildAndroidRelease({ ...ok, notes: { en: "  ", zh: "修复" } })).toThrow(/notes\.en/);
    expect(() => buildAndroidRelease({ ...ok, notes: { en: 1, zh: "修复" } })).toThrow(/notes\.en/);
  });

  it("refuses a note that is not plain bounded text", () => {
    expect(() =>
      buildAndroidRelease({ ...ok, notes: { en: "a\u0007b", zh: "修复" } }),
    ).toThrow(/control character/);
    expect(() =>
      buildAndroidRelease({ ...ok, notes: { en: "x".repeat(2001), zh: "修复" } }),
    ).toThrow(/longer than 2000/);
    // A newline is legitimate paragraphing.
    expect(() =>
      buildAndroidRelease({ ...ok, notes: { en: "one\ntwo", zh: "修复" } }),
    ).not.toThrow();
  });
});

describe("the withdrawn document", () => {
  it("is coherent and offers nothing", () => {
    expect(buildUnavailableRelease()).toEqual({ schema: 1, android: { available: false } });
  });
});

describe("assertMonotonic", () => {
  it("refuses a version code that does not increase", () => {
    const published = buildAndroidRelease(ok);
    for (const versionCode of [3, 2, 1]) {
      const next = buildAndroidRelease({ ...ok, versionName: "0.1.3", versionCode });
      expect(() => assertMonotonic(published, next)).toThrow(/must increase/);
    }
    expect(() =>
      assertMonotonic(published, buildAndroidRelease({ ...ok, versionName: "0.1.3", versionCode: 4 })),
    ).not.toThrow();
  });

  it("has nothing to enforce against a first release", () => {
    expect(() => assertMonotonic(null, buildAndroidRelease(ok))).not.toThrow();
  });

  // REGRESSION. Withdrawing used to write a bare `{available:false}`, which
  // erased how high the channel had been. The next stage then saw no history,
  // the monotonicity check had nothing to compare against, and a LOWER
  // versionCode published cleanly — telling every installed build at the higher
  // code that it was up to date, permanently.
  it("still refuses a downgrade after a withdrawal", () => {
    const published = buildAndroidRelease(ok); // code 3
    const withdrawn = buildUnavailableRelease(published);
    expect(withdrawn.android.available).toBe(false);
    expect(withdrawn.android.lastPublishedVersionCode).toBe(3);
    expect(publishedHeight(withdrawn)).toBe(3);
    for (const versionCode of [1, 2, 3]) {
      expect(() =>
        assertMonotonic(withdrawn, buildAndroidRelease({ ...ok, versionName: "0.1.1", versionCode })),
      ).toThrow(/must increase/);
    }
    expect(() =>
      assertMonotonic(withdrawn, buildAndroidRelease({ ...ok, versionName: "0.1.4", versionCode: 4 })),
    ).not.toThrow();
  });

  it("reads the height a hand-written withdrawal left in versionCode", () => {
    // The shape an older or hand-edited withdrawal produces. Honouring it is
    // strictly safer than ignoring it: ignoring loses the height.
    const legacy = { schema: 1, android: { available: false, versionCode: 3 } };
    expect(publishedHeight(legacy)).toBe(3);
    expect(() =>
      assertMonotonic(legacy, buildAndroidRelease({ ...ok, versionName: "0.1.1", versionCode: 2 })),
    ).toThrow(/must increase/);
  });

  it("never lowers a remembered height", () => {
    const both = { schema: 1, android: { available: false, lastPublishedVersionCode: 2, versionCode: 7 } };
    expect(publishedHeight(both)).toBe(7);
  });

  it("carries the height through repeated withdrawals", () => {
    let doc = buildAndroidRelease(ok);
    for (let i = 0; i < 3; i += 1) doc = buildUnavailableRelease(doc);
    expect(publishedHeight(doc)).toBe(3);
  });
});

describe("assertReadableHistory", () => {
  // A SUBTLY wrong history is more dangerous than an obviously absent one: if
  // it merely produced "no height", a downgrade would publish cleanly against a
  // document that plainly has a history.
  it("refuses a history it cannot interpret rather than ignoring it", () => {
    const bad = [
      [{ schema: 2, android: { available: false } }, /schema/],
      [{ android: { available: false } }, /schema/],
      [{ schema: 1 }, /android object/],
      [{ schema: 1, android: { available: "yes" } }, /boolean android\.available/],
      [{ schema: 1, android: {} }, /boolean android\.available/],
      [{ schema: 1, android: { available: true } }, /no usable versionCode/],
      [{ schema: 1, android: { available: true, versionCode: "3" } }, /positive int32/],
      [{ schema: 1, android: { available: true, versionCode: 0 } }, /positive int32/],
      [{ schema: 1, android: { available: true, versionCode: 3.5 } }, /positive int32/],
      [{ schema: 1, android: { available: false, lastPublishedVersionCode: "3" } }, /positive int32/],
      [{ schema: 1, android: { available: false, versionCode: -1 } }, /positive int32/],
    ];
    for (const [doc, pattern] of bad) {
      expect(() => publishedHeight(doc), JSON.stringify(doc)).toThrow(pattern);
      expect(() => assertReadableHistory(doc), JSON.stringify(doc)).toThrow(pattern);
    }
  });

  // REGRESSION: 2147483648 is one past Android's int32 versionCode.
  it("refuses a version code outside Android's int range, in both directions", () => {
    expect(MAX_VERSION_CODE).toBe(2147483647);
    expect(() =>
      buildAndroidRelease({ ...ok, versionCode: MAX_VERSION_CODE + 1 }),
    ).toThrow(/int32/);
    expect(() =>
      publishedHeight({ schema: 1, android: { available: true, versionCode: MAX_VERSION_CODE + 1 } }),
    ).toThrow(/positive int32/);
    expect(buildAndroidRelease({ ...ok, versionCode: MAX_VERSION_CODE }).android.versionCode)
      .toBe(MAX_VERSION_CODE);
  });

  it("accepts the placeholder and a well formed withdrawal", () => {
    expect(publishedHeight({ schema: 1, android: { available: false } })).toBe(null);
    expect(publishedHeight({ schema: 1, android: { available: false, lastPublishedVersionCode: 9 } })).toBe(9);
  });
});

describe("measureApk", () => {
  it("reports the real bytes on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relayium-apk-"));
    const path = join(dir, assetNameFor("0.1.2", 3));
    await writeFile(path, "not really an apk");
    const measured = await measureApk(path);
    expect(measured.apkName).toBe("Relayium-0.1.2-3.apk");
    expect(measured.size).toBe(17);
    // sha256("not really an apk")
    expect(measured.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The staged document carries exactly what was measured, never a guess.
    const doc = buildAndroidRelease({ ...ok, ...measured });
    expect(doc.android.sha256).toBe(measured.sha256);
    expect(doc.android.size).toBe(17);
  });
});

describe("the committed manifest", () => {
  // VALIDITY, not a fixed state.
  //
  // This used to assert `available === false`, which made "no release has been
  // published" a permanent requirement: the suite passed only while the channel
  // was empty and would have failed the moment a real release was staged — a
  // test that has to be edited during publication is a test that blocks it.
  //
  // What is actually required is that whatever the manifest says, it says it
  // coherently: a published entry must carry a version and the official asset
  // for exactly that version, and an unpublished one must be a well-formed
  // history rather than a half-written record.
  it("is a coherent document in whichever state it is in", async () => {
    const doc = await readAndroidRelease(webRoot);
    expect(doc.schema).toBe(1);
    expect(typeof doc.android.available, "android.available must be a boolean").toBe("boolean");

    if (doc.android.available) {
      const { versionName, versionCode, downloadUrl, sha256, size, notes, applicationId } = doc.android;
      expect(applicationId).toBe(APPLICATION_ID);
      expect(versionName, "a published entry must name its version").toMatch(/^\d+\.\d+\.\d+$/);
      expect(Number.isInteger(versionCode) && versionCode >= 1).toBe(true);
      expect(versionCode).toBeLessThanOrEqual(MAX_VERSION_CODE);
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(size) && size >= 1 && size <= MAX_APK_BYTES).toBe(true);
      // The URL must be the official immutable asset for THIS version — the
      // whole point of deriving it rather than writing it down.
      expect(downloadUrl).toBe(downloadUrlFor(versionName, versionCode));
      // Both maintained languages, because the app renders one of them.
      expect(typeof notes?.en === "string" && notes.en.trim() !== "").toBe(true);
      expect(typeof notes?.zh === "string" && notes.zh.trim() !== "").toBe(true);
      // And the document must survive the same validation staging applies.
      expect(() =>
        buildAndroidRelease({
          versionName, versionCode, sha256, size, notes,
          apkName: assetNameFor(versionName, versionCode),
          apkPackage: APPLICATION_ID,
          apkVersionCode: versionCode,
          apkVersionName: versionName,
        }),
      ).not.toThrow();
    } else {
      // Unpublished: no download may be advertised, and any remembered channel
      // height must be a usable integer rather than a half-written field.
      expect(doc.android.downloadUrl).toBeUndefined();
      expect(doc.android.sha256).toBeUndefined();
      const height = doc.android.lastPublishedVersionCode;
      if (height !== undefined) {
        expect(Number.isInteger(height) && height >= 1).toBe(true);
      }
    }
    // Either way it must be a history the staging tool can publish against.
    expect(() => assertReadableHistory(doc)).not.toThrow();
  });

  // The two states, exercised through isolated fixtures rather than by reading
  // whichever one the checkout happens to hold.
  it("accepts a published document and refuses an incoherent one", () => {
    const published = buildAndroidRelease(ok);
    expect(published.android.downloadUrl).toBe(downloadUrlFor(ok.versionName, ok.versionCode));
    expect(() => assertReadableHistory(published)).not.toThrow();
    expect(publishedHeight(published)).toBe(ok.versionCode);

    // A published entry whose URL names a different release — the exact defect
    // the derivation exists to prevent — must not be constructible.
    expect(() =>
      buildAndroidRelease({ ...ok, apkName: assetNameFor("0.1.1", 2) }),
    ).toThrow(/must be published as/);
  });

  it("accepts an unpublished document that still remembers its height", () => {
    const withdrawn = buildUnavailableRelease(buildAndroidRelease(ok));
    expect(withdrawn.android.available).toBe(false);
    expect(withdrawn.android.downloadUrl).toBeUndefined();
    expect(() => assertReadableHistory(withdrawn)).not.toThrow();
    expect(publishedHeight(withdrawn)).toBe(ok.versionCode);
  });

  it("round-trips through the writer without changing shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relayium-web-"));
    await writeAndroidRelease(dir, buildUnavailableRelease());
    const text = await readFile(join(dir, ANDROID_RELEASE_FILE), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ schema: 1, android: { available: false } });
  });
});

describe("the contract shared with the Android client", () => {
  // These constants exist in two languages. If they drift, an installed build
  // reads a URL nothing publishes, and the failure is invisible until a user
  // presses Check for updates.
  it("matches UpdateFeed's official url, application id and size bound", async () => {
    const kotlin = await readFile(
      resolve(webRoot, "..", "apps/android/app/src/main/kotlin/com/relayium/android/update/UpdateFeed.kt"),
      "utf8",
    );
    expect(kotlin).toContain(`const val OFFICIAL_URL = "${ANDROID_FEED_URL}"`);
    expect(kotlin).toContain(`const val APPLICATION_ID = "${APPLICATION_ID}"`);
    expect(kotlin).toContain("const val MAX_APK_BYTES: Long = 512L * 1024 * 1024");
    expect(MAX_APK_BYTES).toBe(512 * 1024 * 1024);
  });

  it("derives the same asset path the app compares against", async () => {
    const kotlin = await readFile(
      resolve(webRoot, "..", "apps/android/app/src/main/kotlin/com/relayium/android/update/UpdateFeed.kt"),
      "utf8",
    );
    // The Kotlin builds "/relayium/relayium/releases/download/android-v$v/Relayium-$v-$c.apk";
    // this asserts the JS produces exactly that string for a concrete pair.
    expect(downloadUrlFor("0.1.2", 3)).toBe(
      "https://github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
    );
    expect(kotlin).toContain(
      '"/relayium/relayium/releases/download/android-v$versionName/Relayium-$versionName-$versionCode.apk"',
    );
    expect(tagFor("0.1.2")).toBe("android-v0.1.2");
  });

  it("publishes the feed at the path the official url resolves to", () => {
    expect(new URL(ANDROID_FEED_URL).pathname).toBe(PUBLISHED_ANDROID_FEED_PATH);
  });
});

describe("the APK observer", () => {
  // The staging CLI used to accept the package, versionCode, versionName and
  // certificate as ARGUMENTS. A 20-byte text file named Relayium-0.1.1-2.apk
  // therefore published cleanly with `available: true`. These facts have to be
  // read out of the artifact, and there must be no way to skip reading them.
  it("pins the established signing certificate", () => {
    expect(EXPECTED_CERT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    // The certificate the already-shipped 0.1.0 APK carries. Publishing under a
    // different key produces an update no existing installation can take.
    expect(EXPECTED_CERT_SHA256).toBe(
      "ac867828a511f15e9214498f234d8898bbd56033342edd7e70d8037c20380aad",
    );
  });

  it("offers no way to skip verification", async () => {
    const source = await readFile(resolve(webRoot, "scripts/stage-android-release.mjs"), "utf8");
    // "skip-verify" appears exactly once, in the list of flags that are
    // REFUSED. A word-level ban would fail on the refusal itself, so assert the
    // meaning: it is rejected, never parsed into behaviour.
    expect(source).toMatch(/"skip-verify"\]?\)?[\s\S]{0,400}?is not accepted/);
    expect(source).not.toMatch(/if \(args\["skip-verify"\]\)\s*(?!\{[\s\S]{0,40}fail)/);
    expect(source).not.toMatch(/--force\b/);
    // The observation is unconditional, and the certificate is always pinned.
    expect(source).toContain("expectedCertSha256: EXPECTED_CERT_SHA256");
    expect(source).toContain("observeApk(resolve(args.apk))");
    // And the old claim flags are actively refused rather than merely unused,
    // so an operator reaching for them gets an error instead of silence.
    for (const flag of ["apk-package", "apk-version-code", "apk-version-name", "cert-sha256"]) {
      expect(source).toContain(`"${flag}"`);
    }
  });

  it("requires real tools rather than degrading to an unchecked publish", async () => {
    const source = await readFile(resolve(webRoot, "scripts/verify-android-apk.mjs"), "utf8");
    expect(source).toContain("apksigner not found");
    expect(source).toContain("apkanalyzer not found");
    // Same bytes start to finish: a file swapped mid-verification must not be
    // published under the digest of the one that was checked.
    expect(source).toContain("changed while it was being verified");
    // The scheme line must be matched WITH its value: apksigner --verbose
    // prints "Verified using v1 scheme (JAR signing): false", so matching the
    // scheme name alone passes on an APK with no modern signature at all.
    expect(source).toMatch(/Verified using \(v\[0-9\.\]\+\) scheme\[\^:\\n\]\*:\\s\*\(true\|false\)/);
    expect(source).toContain('value === "true"');
  });
});
