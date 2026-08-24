#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function usage() {
  return "Usage: stage-macos-release.mjs --version <version> --appcast <path> --web-root <path> [--repository <owner/repo>]";
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(usage());
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function assertVersion(version) {
  if (!/^[0-9]+(?:\.[0-9]+){1,2}$/.test(version)) {
    throw new Error(`release version is not a supported app version: ${version}`);
  }
}

function enclosure(appcast) {
  const match = appcast.match(/<enclosure\s+[^>]*\/?>/);
  if (!match) throw new Error("appcast has no enclosure");
  return match[0];
}

/// The whole `<item>…</item>`, which is where Sparkle puts the version.
function releaseItem(appcast) {
  const match = appcast.match(/<item>[\s\S]*?<\/item>/);
  if (!match) throw new Error("appcast has no release item");
  return match[0];
}

function attribute(element, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = element.match(new RegExp(`(?:^|\\s)${escaped}="([^"]+)"`));
  return match?.[1] ?? null;
}

/// A child element's text.
///
/// The version lives here and NOT on the enclosure, which is what this file got
/// wrong until a real `generate_appcast` run was read instead of assumed. Sparkle
/// 2 writes:
///
///     <item>
///       <sparkle:version>1</sparkle:version>
///       <sparkle:shortVersionString>1.0</sparkle:shortVersionString>
///       <enclosure url="…" length="…" type="…" sparkle:edSignature="…"/>
///     </item>
///
/// so `url`, `length` and the signature are attributes and the two versions are
/// not. Reading them off the enclosure returned null every time, which compared
/// unequal to the requested version and failed every release with a message that
/// looked like a version mismatch rather than a parser looking in the wrong
/// element.
///
/// There is deliberately **no attribute fallback**. A future Sparkle that moved
/// these back onto the enclosure should fail loudly at release time rather than
/// be silently absorbed here — the whole value of this check is that it knows
/// what shape it is reading.
function childText(element, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = element.match(new RegExp(`<${escaped}>([^<]*)</${escaped}>`));
  return match?.[1]?.trim() || null;
}

/// **The one canonical statement of which builds Relayium still answers for.**
///
/// `web/native-client-policy.json` is edited by hand when the product decides to
/// raise a requirement, and everything else about that decision is derived from
/// it: the macOS client fetches the published copy, and the Sparkle feed's
/// critical-update threshold is written from `minimumSupportedBuild` on every
/// staging run.
///
/// Derived rather than preserved, and that distinction is the whole reason this
/// exists. `generate_appcast` writes a fresh feed from the DMG directory and
/// knows nothing about a policy, so a `<sparkle:criticalUpdate>` added to the
/// published feed by hand disappears at the next release — silently, and in the
/// direction that matters: every user below the minimum would stop being told
/// their update is not optional, and nothing would fail.
///
/// Two vocabularies, one decision. Sparkle compares `CFBundleVersion`
/// (`sparkle:version`), so the threshold here is a BUILD number; the client
/// compares the marketing version, because that is what its sentences and the
/// policy document speak in. `minimumSupportedVersion` and
/// `minimumSupportedBuild` are the same release said both ways, and
/// `SupportedVersionSurfaceTests` holds them to each other.
export const CLIENT_POLICY_FILE = "native-client-policy.json";
export const PUBLISHED_CLIENT_POLICY_PATH = "public/apps/macos/client-policy.json";

/// **The revision, and the rule a person editing this file has to follow.**
///
/// `policyRevision` is what makes the document un-replayable: a client remembers
/// the highest revision it ever accepted and refuses anything below it, so a
/// perfectly valid copy of last quarter's policy cannot be served back to a
/// client that has since been told something stricter.
///
/// **Any hand edit that changes a requirement must advance `policyRevision` in
/// the same edit.** A client that already holds revision N refuses a DIFFERENT
/// document that still calls itself N — so an un-bumped change does not merely
/// fail to apply, it fails to apply exactly on the clients that already fetched
/// the previous copy, which are the ones the change was for. This script bumps
/// the revision only for the one field a RELEASE owns (`latestVersion`); every
/// other change is the editor's to declare.
///
/// The ceiling is the client's `SupportedVersionPolicy.maxPolicyRevision`, held
/// to this literal by `SupportedVersionSurfaceTests`. It is written without
/// numeric separators so that pin can compare the two spellings directly.
export const MAX_POLICY_REVISION = 1000000000;

/// The document, validated. A release must not proceed on a policy this script
/// cannot read: the alternative is publishing a feed whose critical threshold
/// was guessed.
async function readClientPolicy(root) {
  const path = resolve(root, CLIENT_POLICY_FILE);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`client policy is missing or not JSON: ${path} (${error.message})`);
  }
  if (parsed?.schema !== 1) {
    throw new Error(`client policy schema must be 1, found ${JSON.stringify(parsed?.schema)}`);
  }
  const mac = parsed.macos;
  if (!mac || typeof mac !== "object") throw new Error("client policy has no macos section");
  for (const key of ["minimumSupportedVersion", "recommendedVersion", "latestVersion"]) {
    if (typeof mac[key] !== "string" || !/^[0-9]+(?:\.[0-9]+){0,3}$/.test(mac[key])) {
      throw new Error(`client policy ${key} is not an app version: ${JSON.stringify(mac[key])}`);
    }
  }
  if (!Number.isInteger(mac.minimumSupportedBuild) || mac.minimumSupportedBuild < 1) {
    throw new Error("client policy minimumSupportedBuild must be a positive integer");
  }
  // Bounded on both sides, and refused here rather than clamped. The client
  // refuses the same range, so a document outside it is one no client would act
  // on — publishing it would take the whole fleet back to the embedded floor
  // silently, which is the failure this validation exists to make loud.
  if (!Number.isInteger(mac.policyRevision)
      || mac.policyRevision < 1
      || mac.policyRevision > MAX_POLICY_REVISION) {
    throw new Error(
      `client policy policyRevision must be an integer in 1…${MAX_POLICY_REVISION}, `
      + `found ${JSON.stringify(mac.policyRevision)}`);
  }
  if (compareVersions(mac.minimumSupportedVersion, mac.recommendedVersion) > 0) {
    throw new Error("client policy minimum is above its own recommended version");
  }
  const next = parsed.nextRelease;
  if (next !== undefined) {
    const keys = Object.keys(next ?? {}).sort();
    const expected = ["minimumSupportedBuild", "minimumSupportedVersion",
      "recommendedVersion", "version"];
    if (!next || typeof next !== "object" || JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new Error("client policy nextRelease has an unsupported shape");
    }
    for (const key of ["version", "minimumSupportedVersion", "recommendedVersion"]) {
      if (typeof next[key] !== "string" || !/^[0-9]+(?:\.[0-9]+){0,3}$/.test(next[key])) {
        throw new Error(`client policy nextRelease ${key} is not an app version`);
      }
    }
    if (!Number.isInteger(next.minimumSupportedBuild) || next.minimumSupportedBuild < 1) {
      throw new Error("client policy nextRelease minimumSupportedBuild must be positive");
    }
    if (compareVersions(next.minimumSupportedVersion, next.recommendedVersion) > 0
        || compareVersions(next.recommendedVersion, next.version) > 0) {
      throw new Error("client policy nextRelease versions are inconsistent");
    }
  }
  return { path, policy: parsed, nextRelease: next };
}

/// Numeric, component by component. `1.2.10` is above `1.2.9`, which is the one
/// thing a string comparison gets wrong and the only comparison that matters here.
function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/// The exact bytes both copies of the policy carry.
///
/// Key order is written here rather than inherited from the parsed object, so
/// the file staging produces and the file a person edits converge on one
/// spelling — which is what lets a test assert the published copy is
/// byte-for-byte the canonical one.
function serializeClientPolicy(policy) {
  return `${JSON.stringify({
    schema: 1,
    macos: {
      policyRevision: policy.macos.policyRevision,
      minimumSupportedVersion: policy.macos.minimumSupportedVersion,
      minimumSupportedBuild: policy.macos.minimumSupportedBuild,
      recommendedVersion: policy.macos.recommendedVersion,
      latestVersion: policy.macos.latestVersion,
    },
  }, null, 2)}\n`;
}

/// Write the threshold into every `<item>`, replacing whatever was there.
///
/// Replacing rather than appending: `generate_appcast` may be run against a
/// directory that already holds a staged feed, and two `<sparkle:criticalUpdate>`
/// elements in one item is a document whose meaning depends on which one Sparkle
/// reads first.
///
/// The element goes immediately before the enclosure, at the enclosure's own
/// indentation, so the staged feed is a document a person can read and diff
/// rather than one line of XML.
function applyCriticalUpdate(appcast, build) {
  const marker =
    `<sparkle:criticalUpdate sparkle:version="${build}"></sparkle:criticalUpdate>`;
  return appcast.replace(/<item>[\s\S]*?<\/item>/g, (item) => {
    const cleaned = item
      .replace(/[ \t]*<sparkle:criticalUpdate\b[^>]*?\/>\n?/g, "")
      .replace(/[ \t]*<sparkle:criticalUpdate\b[^>]*?>[\s\S]*?<\/sparkle:criticalUpdate>\n?/g, "");
    const at = cleaned.indexOf("<enclosure");
    if (at < 0) throw new Error("appcast item has no enclosure");
    const lineStart = cleaned.lastIndexOf("\n", at) + 1;
    const indent = cleaned.slice(lineStart, at);
    return `${cleaned.slice(0, lineStart)}${indent}${marker}\n${cleaned.slice(lineStart)}`;
  });
}

function canonicalizeChannel(appcast) {
  const itemAt = appcast.indexOf("<item");
  if (itemAt < 0) throw new Error("appcast has no release item");
  let channel = appcast.slice(0, itemAt);
  const items = appcast.slice(itemAt);
  const fields = [
    ["title", "Relayium for macOS updates"],
    ["link", "https://relayium.com/apps"],
    ["description", "Signed Relayium updates for macOS."],
    ["language", "en"],
  ];
  const missing = [];
  for (const [tag, value] of fields) {
    const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
    if (pattern.test(channel)) {
      channel = channel.replace(pattern, `<${tag}>${value}</${tag}>`);
    } else {
      missing.push(`    <${tag}>${value}</${tag}>`);
    }
  }
  if (missing.length > 0) {
    channel = channel.replace(/<channel>\s*/, `<channel>\n${missing.join("\n")}\n`);
  }
  return channel + items;
}

export async function stageMacOSRelease({
  version,
  appcastPath,
  webRoot,
  repository = "relayium/relayium",
}) {
  assertVersion(version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }

  const source = resolve(appcastPath);
  const root = resolve(webRoot);
  const { path: policyPath, policy, nextRelease } = await readClientPolicy(root);
  if (nextRelease && nextRelease.version !== version) {
    throw new Error(
      `client policy is prepared for ${nextRelease.version}, not requested release ${version}`);
  }
  const releasePolicy = nextRelease ?? policy.macos;
  const generatedAppcast = await readFile(source, "utf8");
  const appcast = applyCriticalUpdate(
    canonicalizeChannel(generatedAppcast),
    releasePolicy.minimumSupportedBuild,
  );
  // Two elements, not one. The enclosure carries the asset; the item carries
  // the version. The single misnamed `item = enclosure(...)` this replaced is
  // what made every version read return null.
  const asset = enclosure(appcast);
  const item = releaseItem(appcast);
  const expectedUrl =
    `https://github.com/${repository}/releases/download/macos-v${version}/Relayium.dmg`;

  if (attribute(asset, "url") !== expectedUrl) {
    throw new Error(`appcast enclosure URL does not match the immutable release asset: ${expectedUrl}`);
  }
  if (!attribute(asset, "sparkle:edSignature")) {
    throw new Error("appcast enclosure has no Sparkle EdDSA signature");
  }
  if (childText(item, "sparkle:shortVersionString") !== version) {
    throw new Error(`appcast short version does not match ${version}`);
  }
  const build = childText(item, "sparkle:version");
  if (!build || !/^[1-9][0-9]{0,9}$/.test(build)) {
    throw new Error("appcast build version must be a positive integer");
  }
  const length = attribute(asset, "length");
  if (!length || !/^[1-9][0-9]*$/.test(length)) {
    throw new Error("appcast enclosure length must be a positive integer");
  }
  // A release that is critical against ITSELF. Sparkle marks an update critical
  // when the running build is BELOW the threshold, so a threshold ABOVE this
  // release's own build tells the people who just installed it that what they
  // are running is already unsupported — and the update it directs them to is
  // this one. Equality is fine and is the strongest coherent policy: everything
  // before this release, and nothing after it.
  if (BigInt(releasePolicy.minimumSupportedBuild) > BigInt(build)) {
    throw new Error(
      `client policy minimumSupportedBuild ${releasePolicy.minimumSupportedBuild} is above `
      + `the released build ${build}`);
  }
  if (compareVersions(releasePolicy.recommendedVersion, version) > 0) {
    throw new Error(
      `client policy recommends ${releasePolicy.recommendedVersion}, which is above the released `
      + `version ${version}`);
  }

  const manifestPath = resolve(root, "native-releases.json");
  const serverCatalogPath = resolve(root, "../server/account/macos_release_catalog.json");
  const destination = resolve(root, "public/apps/macos/appcast.xml");
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  if (current.macos?.available) {
    if (current.macos.version === version) {
      throw new Error(`release version ${version} is already published; release tags are immutable`);
    }
    // The same element mistake, and the more dangerous half: the published
    // appcast is one this script wrote, so it has the same shape. Reading the
    // build off the enclosure returned null, and a null build means "published
    // appcast has no valid build version" — a monotonicity check that could
    // never pass, on the branch that only runs for the SECOND release. The
    // first release fails at the version comparison above; without this it
    // would have failed here instead, months later.
    const previousAppcast = await readFile(destination, "utf8");
    const previousBuild = childText(releaseItem(previousAppcast), "sparkle:version");
    if (!previousBuild || !/^[1-9][0-9]{0,9}$/.test(previousBuild)) {
      throw new Error("published appcast has no valid build version");
    }
    if (BigInt(build) <= BigInt(previousBuild)) {
      throw new Error(`appcast build ${build} must be greater than published build ${previousBuild}`);
    }
  }

  const manifest = {
    macos: {
      available: true,
      version,
      build: Number(build),
      downloadUrl: expectedUrl,
    },
  };
  let serverCatalog = null;
  try {
    serverCatalog = JSON.parse(await readFile(serverCatalogPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (serverCatalog) {
    const releases = Array.isArray(serverCatalog.releases) ? serverCatalog.releases : [];
    const existing = releases.find((entry) => entry.version === version || entry.build === Number(build));
    if (existing && (existing.version !== version || existing.build !== Number(build))) {
      throw new Error(`server macOS release catalog conflicts with ${version} (${build})`);
    }
    if (!existing) {
      releases.push({ version, build: Number(build), tag: `macos-v${version}` });
    }
    serverCatalog = { releases };
  }
  // The one field of the policy a release owns. The requirement fields are a
  // product decision and are carried through untouched — staging must never
  // raise or lower what users are required to run — but `latestVersion` is a
  // statement about what has been published, and this is the moment it changes.
  //
  // **The revision advances exactly when the document does, and by exactly one.**
  // A changed policy that kept its revision would be a second document under one
  // number, which every client that already fetched the first one refuses. An
  // UNCHANGED policy that advanced anyway would break the recovery path: the
  // publish job reruns staging after a delivery that failed downstream, and it
  // requires re-deriving to reproduce `main` byte for byte — a revision that
  // climbed on every attempt would turn each retry into a diff, and there is no
  // clock or counter here to make it idempotent for us. So the test is the
  // document itself: same `latestVersion` spelling, same revision, same bytes.
  const changesTheDocument = policy.macos.latestVersion !== version || nextRelease !== undefined;
  const policyRevision = policy.macos.policyRevision + (changesTheDocument ? 1 : 0);
  if (policyRevision > MAX_POLICY_REVISION) {
    throw new Error(
      `client policy policyRevision ${policyRevision} would exceed ${MAX_POLICY_REVISION}`);
  }
  const stagedPolicy = serializeClientPolicy({
    ...policy,
    macos: {
      ...policy.macos,
      policyRevision,
      minimumSupportedVersion: releasePolicy.minimumSupportedVersion,
      minimumSupportedBuild: releasePolicy.minimumSupportedBuild,
      recommendedVersion: releasePolicy.recommendedVersion,
      latestVersion: version,
    },
  });
  const publishedPolicyPath = resolve(root, PUBLISHED_CLIENT_POLICY_PATH);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(dirname(publishedPolicyPath), { recursive: true });

  const manifestTemp = `${manifestPath}.tmp`;
  const appcastTemp = `${destination}.tmp`;
  const policyTemp = `${policyPath}.tmp`;
  const publishedPolicyTemp = `${publishedPolicyPath}.tmp`;
  const serverCatalogTemp = `${serverCatalogPath}.tmp`;
  await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(appcastTemp, appcast, "utf8");
  await writeFile(policyTemp, stagedPolicy, "utf8");
  await writeFile(publishedPolicyTemp, stagedPolicy, "utf8");
  if (serverCatalog) {
    await writeFile(serverCatalogTemp, `${JSON.stringify(serverCatalog, null, 2)}\n`, "utf8");
  }
  await rename(manifestTemp, manifestPath);
  await rename(appcastTemp, destination);
  // Both copies, from the same bytes. The canonical file is what a person edits
  // and what `gen-pages.mjs` publishes; the published one is what the macOS
  // client actually fetches, and a release that updated only one of them would
  // leave the served policy naming a release that is no longer the latest.
  await rename(policyTemp, policyPath);
  await rename(publishedPolicyTemp, publishedPolicyPath);
  if (serverCatalog) await rename(serverCatalogTemp, serverCatalogPath);

  return {
    version,
    build,
    downloadUrl: expectedUrl,
    manifestPath,
    appcastPath: destination,
    criticalUpdateBuild: releasePolicy.minimumSupportedBuild,
    policyRevision,
    clientPolicyPath: policyPath,
    publishedClientPolicyPath: publishedPolicyPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.appcast || !args["web-root"]) {
    throw new Error(usage());
  }
  const result = await stageMacOSRelease({
    version: args.version,
    appcastPath: args.appcast,
    webRoot: args["web-root"],
    repository: args.repository,
  });
  process.stdout.write(
    `Staged Relayium for macOS ${result.version} (${result.build}) from ${basename(result.appcastPath)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
