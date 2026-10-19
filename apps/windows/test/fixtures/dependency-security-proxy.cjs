// Child process for `test/unit/dependency-security.test.ts`.
//
// It loads the packager's OWN `@electron/get` — the 3.x copy nested under
// `app-builder-lib`, the only one that can bootstrap `global-agent` — and makes
// one real `downloadArtifact` call. Nothing is mocked: the proxy, the
// no-proxy decision, the TLS check and the SHA-256 verification are all the
// installed code's. A separate process because `global-agent` patches the
// `http`/`https` modules process-wide, and because `@electron/get` decides
// whether to bootstrap it once, at require time, from the environment the
// parent hands this process.
//
// argv: <@electron/get directory> <JSON request>
// stdout: one JSON line describing the outcome. Exit code is always 0 when the
// outcome was reported, so a refused download is a result, not a crash.
//
// It exits explicitly once the line is written. Measured: after a refused TLS
// handshake this process otherwise stays alive with an open handle — with and
// without `global-agent` bootstrapped, so it is the downloader's behaviour, not
// the override's — and the parent would wait on its timeout instead.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Counts every `CachePolicy` the downloader builds, by replacing the export of
 * the exact `http-cache-semantics` file that `cacheable-request` will load —
 * resolved along the real chain @electron/get → got → cacheable-request — before
 * any of them is required. `cacheable-request` constructs one per response, and
 * only exists in a request when got's `cache` option is set; zero constructions
 * on a completed download is the dynamic proof that GHSA-ch52-4w7c-c8xp's code
 * did not run. The `enableGotCache` case proves the counter can see it.
 */
function instrumentCachePolicy(getDir) {
  const from = (name, dir) => path.dirname(require.resolve(`${name}/package.json`, { paths: [dir] }));
  const cacheableDir = from("cacheable-request", from("got", getDir));
  const file = require.resolve("http-cache-semantics", { paths: [cacheableDir] });
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "package.json"), "utf8")).version;
  const Original = require(file);
  const counter = { file, version, constructions: 0, restored: 0 };
  class CountedPolicy extends Original {
    constructor(...args) {
      super(...args);
      counter.constructions += 1;
    }
    // A policy read back from an already-populated store skips the constructor.
    static fromObject(obj) {
      counter.restored += 1;
      return super.fromObject(obj);
    }
  }
  require.cache[file].exports = CountedPolicy;
  return counter;
}

async function main() {
  const [getDir, requestJson] = process.argv.slice(2);
  const request = JSON.parse(requestJson);
  const cachePolicy = instrumentCachePolicy(getDir);
  const get = require(getDir);
  const version = require(path.join(getDir, "package.json")).version;
  // Resolved from @electron/get's own directory: the copy it actually loads.
  let globalAgentVersion = null;
  try {
    const manifest = require.resolve("global-agent/package.json", { paths: [getDir] });
    globalAgentVersion = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
  } catch {
    globalAgentVersion = null;
  }
  const report = {
    electronGetVersion: version,
    globalAgentVersion,
    // Set by `global-agent`'s bootstrap. `initializeProxy` swallows a failed
    // require, so this — and the proxy actually seeing the request — is how a
    // silently missing proxy shows up.
    globalAgentBootstrapped: Boolean(globalThis.GLOBAL_AGENT),
    cachePolicy,
  };
  try {
    const file = await get.downloadArtifact({
      version: request.version,
      artifactName: "electron",
      platform: "win32",
      arch: "x64",
      mirrorOptions: { mirror: request.mirror },
      checksums: request.checksums,
      cacheRoot: request.cacheRoot,
      tempDirectory: request.tempDirectory,
      cacheMode: get.ElectronDownloadCacheMode.Bypass,
      downloadOptions: {
        timeout: { request: 10000 },
        retry: { limit: 0 },
        // Only the control case sets this; nothing in the packager does.
        ...(request.enableGotCache ? { cache: new Map() } : {}),
      },
    });
    const bytes = fs.readFileSync(file);
    report.ok = true;
    report.fileName = path.basename(file);
    report.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.message ? error.message : error);
    report.code = error && error.code ? String(error.code) : null;
  }
  return report;
}

main()
  .catch((error) => ({ crashed: String(error && error.stack ? error.stack : error) }))
  .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0)));
