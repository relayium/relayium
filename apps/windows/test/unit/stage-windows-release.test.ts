// Staging a release, run for real against a temporary web root.
//
// The feed URL compiled into every Windows build points at
// `/apps/windows/updates.json`, and `web/public/apps/` held `macos/` and
// `android/` and nothing for Windows — the client could verify a feed that
// nowhere served. This is the script that puts one there, and the test runs it
// rather than describing it: a real key, a real file, a real directory.
//
// What it must never do is stage a document its own clients would refuse, so
// that is the case with the most assertions on it.

import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageRelease, verifyStagedFeed } from "../../src/main/update/release-staging.js";
import { publicKeyPin } from "../../src/main/update/manifest-publisher.js";

const owned: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "relayium-stage-"));
  owned.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function fixture() {
  const root = temp();
  const keyFile = path.join(root, "feed.pem");
  writeFileSync(keyFile, privatePem);
  const installer = path.join(root, "Relayium Setup 0.2.0.exe");
  writeFileSync(installer, Buffer.alloc(8192, 9));
  return {
    root,
    args: {
      version: "0.2.0",
      build: "9",
      installer,
      "artifact-url": "https://github.com/relayium/relayium/releases/download/win-v0.2.0/Setup.exe",
      "web-root": root,
      key: keyFile,
      "published-at": "1757600000",
    },
  };
}

describe("staging a Windows release", () => {
  it("writes a feed and a signature the shipping verifier accepts", async () => {
    const { root, args } = fixture();
    const staged = await stageRelease(args);

    const dir = path.join(root, "public", "apps", "windows");
    expect(staged.dir).toBe(dir);
    const bytes = readFileSync(path.join(dir, "updates.json"));
    const signature = readFileSync(path.join(dir, "updates.json.sig"), "utf8").trim();

    // Read back off disk, not from what the function returned: the question is
    // what a client fetching these two files would get.
    const parsed = verifyStagedFeed(bytes, signature, publicKeyPin(privatePem));
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.build).toBe(9);
    expect(Buffer.from(parsed.signedBytes).equals(bytes)).toBe(true);
  });

  it("reports the pin the build must carry", async () => {
    // The one fact a release cannot infer later. A feed signed with a key the
    // shipped build does not pin is refused by every client, and nothing about
    // the staged files says which key signed them.
    const { args } = fixture();
    const staged = await stageRelease(args);
    expect(staged.pin).toBe(publicKeyPin(privatePem));
  });

  it("leaves nothing half-written behind", async () => {
    const { root, args } = fixture();
    await stageRelease(args);
    const dir = path.join(root, "public", "apps", "windows");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).sort()).toEqual(["updates.json", "updates.json.sig"]);
  });

  it("measures the installer rather than being told its size", async () => {
    const { root, args } = fixture();
    const staged = await stageRelease(args);
    const bytes = readFileSync(path.join(root, "public", "apps", "windows", "updates.json"));
    const document = JSON.parse(bytes.toString("utf8")) as { artifact: { sizeBytes: number; sha256: string } };
    expect(document.artifact.sizeBytes).toBe(8192);
    expect(document.artifact.sha256).toBe(staged.sha256);
  });
});

describe("what staging refuses, before writing anything", () => {
  const missing = async (key: string) => {
    const { args } = fixture();
    const broken: Record<string, string> = { ...args };
    delete broken[key];
    await expect(stageRelease(broken)).rejects.toThrow(new RegExp(`--${key} is required`));
  };

  it("refuses without a version, a build, an installer, a url, a root or a key", async () => {
    for (const key of ["version", "build", "installer", "artifact-url", "web-root", "key"]) {
      await missing(key);
    }
  });

  // The generator will happily write an unsigned manifest for inspection.
  // Staging one is different: a published document with no `.sig` is a feed
  // every client refuses as `untrusted`, and a release that looks finished.
  it("has no unsigned mode at all", async () => {
    await missing("key");
  });

  it("refuses an artifact host this build does not follow", async () => {
    const { args } = fixture();
    await expect(stageRelease({ ...args, "artifact-url": "https://cdn.example.com/Setup.exe" }))
      .rejects.toThrow(/cdn\.example\.com/);
  });

  it("refuses a build number the update gate could never use", async () => {
    const { args } = fixture();
    await expect(stageRelease({ ...args, build: "0" })).rejects.toThrow(/build must be/);
  });

  it("writes nothing when it refuses", async () => {
    const { root, args } = fixture();
    await expect(stageRelease({ ...args, build: "0" })).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(root, "public", "apps", "windows", "updates.json"))).toBe(false);
  });
});

describe("the guard that makes staging safe", () => {
  // The guard runs BEFORE anything is written, so these are the two ways a
  // release could publish a document its own clients refuse.
  it("refuses a feed signed by a key the build does not pin", async () => {
    const { root, args } = fixture();
    await stageRelease(args);
    const dir = path.join(root, "public", "apps", "windows");
    const bytes = readFileSync(path.join(dir, "updates.json"));
    const signature = readFileSync(path.join(dir, "updates.json.sig"), "utf8").trim();

    const stranger = generateKeyPairSync("ed25519");
    const strangerPin = publicKeyPin(stranger.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    expect(() => verifyStagedFeed(bytes, signature, strangerPin)).toThrow();
    // And the same bytes against the right pin still pass, so the refusal above
    // is about the key and not about the document.
    expect(() => verifyStagedFeed(bytes, signature, publicKeyPin(privatePem))).not.toThrow();
  });

  it("refuses a feed whose bytes changed after it was signed", async () => {
    const { root, args } = fixture();
    await stageRelease(args);
    const dir = path.join(root, "public", "apps", "windows");
    const bytes = readFileSync(path.join(dir, "updates.json"));
    const signature = readFileSync(path.join(dir, "updates.json.sig"), "utf8").trim();

    const tampered = Buffer.from(bytes.toString("utf8").replace('"build": 9', '"build": 99'), "utf8");
    expect(tampered.equals(bytes)).toBe(false);
    expect(() => verifyStagedFeed(tampered, signature, publicKeyPin(privatePem))).toThrow();
  });
});
