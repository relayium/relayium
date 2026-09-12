#!/usr/bin/env node
// The command line that stages one Windows release.
//
// Thin on purpose, for the reason `make-update-manifest.mjs` states: everything
// with a rule in it is typed and compiled with the main process, so the test
// imports the rules rather than a declaration file that could drift from them.
// Run after `npm run build:main`.

import process from "node:process";
import { stageRelease } from "../dist/main/update/release-staging.js";

const USAGE =
  "Usage: stage-windows-release.mjs --version <v> --build <n> --installer <path> " +
  "--artifact-url <url> --web-root <path> --key <pem> [--published-at <unix>] [--notes-url <url>]";

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(USAGE);
    values[key.slice(2)] = value;
  }
  return values;
}

async function main(argv) {
  const staged = await stageRelease(parseArgs(argv));
  process.stdout.write(
    `staged ${staged.version} build ${staged.build} into ${staged.dir}\n` +
      `artifact sha256 ${staged.sha256}\n` +
      `pin ${staged.pin}\n` +
      "the build must be compiled with that pin, or every client refuses this feed\n",
  );
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`stage-windows-release: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
