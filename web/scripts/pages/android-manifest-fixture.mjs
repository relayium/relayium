// Run the REAL page generators against a chosen Android manifest, in isolation.
//
// ## Why this exists
//
// The first version of these fixtures wrote `web/android-release.json` — the
// actual checked-in file — ran a generator, and restored it. Under Vitest that
// is a race with teeth: test FILES run concurrently, every other file that
// imports a content module reads that same path at import time, and a restore
// can land after another file has already observed the fixture. It produced a
// real failure (`releases.test` seeing `android-v0.1.0` from a run that had
// asked for "nothing published") and it mutated a tracked file to do it.
//
// So nothing here touches the checkout. A disposable directory becomes a
// stand-in WEB ROOT holding just the two manifests the content modules read
// from `process.cwd()`, and the generator runs in a child process with that
// directory as its working directory. The modules themselves are imported by
// absolute path out of the real repository — these are the production
// generators, not copies — so everything they resolve module-relatively (the
// macOS record, the i18n tables, the shared helpers) still comes from the real
// tree, and only the manifest under test is substituted.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The real web root, derived from this file rather than from `cwd`. */
export const WEB_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Build a disposable web root, run `body` in a child process against it, and
 * return whatever that child printed as JSON.
 *
 * `body` is source text evaluated as an ES module. It receives the generator
 * modules through `IMPORTS`, which are absolute `file://` URLs into the real
 * repository, and must `process.stdout.write(JSON.stringify(...))`.
 */
export function generateWithAndroidManifest(manifest, body) {
  const root = mkdtempSync(join(tmpdir(), "relayium-manifest-"));
  try {
    writeFileSync(join(root, "android-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    // `content/apps.mjs` reads this one from the web root too, so the stand-in
    // needs it. Copied, never linked: a link would let a mistake here reach the
    // real file.
    copyFileSync(join(WEB_ROOT, "native-releases.json"), join(root, "native-releases.json"));

    const imports = {
      apps: pathToFileURL(join(WEB_ROOT, "scripts/pages/content/apps.mjs")).href,
      releases: pathToFileURL(join(WEB_ROOT, "scripts/pages/content/releases.mjs")).href,
      modeTemplate: pathToFileURL(join(WEB_ROOT, "scripts/pages/mode-template.mjs")).href,
      shells: pathToFileURL(join(WEB_ROOT, "scripts/pages/shells.mjs")).href,
    };

    const source = `const IMPORTS = ${JSON.stringify(imports)};\n${body}`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
