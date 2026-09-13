// Stage one Windows release's update feed into the published tree.
//
// `web/public/apps/` holds `macos/` and `android/` and, until this exists,
// nothing for Windows — so `https://relayium.com/apps/windows/updates.json`,
// the URL compiled into every Windows build, has been a 404. The client could
// verify a feed that nowhere served.
//
// macOS publishes through `web/scripts/stage-macos-release.mjs`, which
// validates an appcast against the version being released and stages files
// under `web/public/apps/macos/`. This is the same job for Windows.
//
// ## It verifies what it is about to publish, with the code that will read it
//
// The macOS script validates its appcast by parsing it. This one does something
// stronger, because it can: before anything is written, the staged bytes and
// their signature go through `parseManifest` and `assertSignedByPin` — the
// verifier compiled into the app — against the pin derived from the signing
// key. A feed no client could accept cannot be staged.
//
// That is why this lives beside the app rather than in `web/scripts/`: the
// verifier is compiled to `apps/windows/dist`, and importing it from the web
// tree would be a copy of the trust rules rather than the rules.
//
// ## It will not stage an unsigned feed
//
// The generator underneath will write a manifest without a signature and say
// so, which is useful when inspecting one. Staging is different: a document in
// the published tree without its `.sig` is a feed every client refuses as
// `untrusted`, and a release that looks done. `--key` is required here.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { manifestBytes, measureArtifact, publicKeyPin, signManifest } from "./manifest-publisher.js";
import { parseManifest, type UpdateManifest } from "./manifest.js";
import { assertSignedByPin, decodeSignature, PRODUCTION_TRUST_BASE } from "./trust.js";

export type StageArgs = Record<string, string | undefined>;

function checkArgs(args: StageArgs): void {
  for (const required of ["version", "build", "installer", "artifact-url", "web-root", "key"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const host = new URL(args["artifact-url"]!).hostname;
  if (!PRODUCTION_TRUST_BASE.artifactHosts.includes(host)) {
    throw new Error(
      `--artifact-url names ${host}; this build only follows ${PRODUCTION_TRUST_BASE.artifactHosts.join(", ")}`,
    );
  }
}

/**
 * The check that makes this safe to run: the shipped verifier reads what is
 * about to be published, exactly as a client would.
 */
export function verifyStagedFeed(bytes: Uint8Array, signature: string, pin: string): UpdateManifest {
  assertSignedByPin(bytes, decodeSignature(signature), { ...PRODUCTION_TRUST_BASE, publicKeys: [pin] });
  return parseManifest(bytes, PRODUCTION_TRUST_BASE, signature);
}

export interface StagedRelease {
  readonly dir: string;
  readonly pin: string;
  readonly version: string;
  readonly build: number;
  readonly sha256: string;
}

export async function stageRelease(args: StageArgs): Promise<StagedRelease> {
  checkArgs(args);
  const key = await readFile(resolve(args["key"]!), "utf8");
  const pin = publicKeyPin(key);
  const measured = measureArtifact(resolve(args["installer"]!));
  const bytes = manifestBytes({
    version: args["version"]!,
    build: Number(args["build"]),
    artifactUrl: args["artifact-url"]!,
    publishedAt: Number(args["published-at"] ?? Math.floor(Date.now() / 1000)),
    notesUrl: args["notes-url"] ?? null,
    ...measured,
  });
  const signature = signManifest(bytes, key);

  // Before anything is written. A staged feed that fails this would be a
  // release that published a document its own clients refuse.
  const parsed = verifyStagedFeed(bytes, signature, pin);

  // Written to a temporary name and renamed, so a reader never sees a half-written
  // feed and a failure leaves the previous one intact.
  const dir = join(resolve(args["web-root"]!), "public", "apps", "windows");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of [
    ["updates.json", bytes] as const,
    ["updates.json.sig", `${signature}\n`] as const,
  ]) {
    const target = join(dir, name);
    const staging = `${target}.staging`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(staging, content);
    await rename(staging, target);
  }
  return { dir, pin, version: parsed.version, build: parsed.build, sha256: measured.artifactSha256 };
}

