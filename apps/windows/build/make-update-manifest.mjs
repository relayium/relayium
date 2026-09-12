// The command line that publishes one release's feed document.
//
// Thin on purpose: everything with a rule in it lives in
// `src/main/update/manifest-publisher.ts`, typed and compiled with the main
// process, so the test can import it directly instead of through a declaration
// file that could only ever drift from the code it describes. This file is
// argument parsing and file writing.
//
// Run it AFTER `npm run build:main`, which is what produces the module it
// imports — the same order a release already follows.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  manifestBytes,
  measureArtifact,
  publicKeyPin,
  signManifest,
} from "../dist/main/update/manifest-publisher.js";

function argOf(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? null : (argv[at + 1] ?? null);
}

function main(argv) {
  const installer = argOf(argv, "installer");
  const version = argOf(argv, "version");
  const build = Number(argOf(argv, "build"));
  const artifactUrl = argOf(argv, "artifact-url");
  const out = argOf(argv, "out");
  const publishedAt = Number(argOf(argv, "published-at") ?? "0");
  const notesUrl = argOf(argv, "notes-url");
  const keyFile = argOf(argv, "key");

  // Answering only this needs no installer and no release: it is what a person
  // provisioning the pin runs.
  if (argv.includes("--print-pin")) {
    if (!keyFile) throw new Error("--print-pin needs --key");
    process.stdout.write(`${publicKeyPin(readFileSync(keyFile, "utf8"))}\n`);
    return;
  }
  const hosts = (argOf(argv, "hosts") ?? "").split(",").filter(Boolean);

  for (const [name, value] of [["installer", installer], ["version", version], ["artifact-url", artifactUrl], ["out", out]]) {
    if (!value) throw new Error(`--${name} is required`);
  }
  if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) {
    throw new Error("--published-at must be a unix timestamp in seconds");
  }
  // Checked HERE, against the hosts the client pins, so a manifest naming a
  // host every user's build would refuse fails at publication instead.
  if (hosts.length > 0) {
    const host = new URL(artifactUrl).hostname;
    if (!hosts.includes(host)) {
      throw new Error(`--artifact-url names ${host}, which this build does not pin: ${hosts.join(", ")}`);
    }
  }

  const measured = measureArtifact(installer);
  const bytes = manifestBytes({ version, build, artifactUrl, publishedAt, notesUrl, ...measured });
  writeFileSync(out, bytes);

  if (keyFile) {
    writeFileSync(`${out}.sig`, `${signManifest(bytes, readFileSync(keyFile, "utf8"))}\n`);
    process.stdout.write(`wrote ${path.basename(out)} and its signature\n`);
  } else {
    // Said plainly rather than exited quietly. An unsigned feed is refused by
    // every client as `untrusted`; publishing one by accident should be loud.
    process.stdout.write(`wrote ${path.basename(out)} WITHOUT a signature: no --key given, so no client will accept it\n`);
  }
  process.stdout.write(`${measured.artifactSha256}  ${path.basename(installer)}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`make-update-manifest: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
