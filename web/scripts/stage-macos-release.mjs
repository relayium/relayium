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
  const generatedAppcast = await readFile(source, "utf8");
  const appcast = canonicalizeChannel(generatedAppcast);
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

  const manifestPath = resolve(root, "native-releases.json");
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
  await mkdir(dirname(destination), { recursive: true });

  const manifestTemp = `${manifestPath}.tmp`;
  const appcastTemp = `${destination}.tmp`;
  await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(appcastTemp, appcast, "utf8");
  await rename(manifestTemp, manifestPath);
  await rename(appcastTemp, destination);

  return { version, build, downloadUrl: expectedUrl, manifestPath, appcastPath: destination };
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
