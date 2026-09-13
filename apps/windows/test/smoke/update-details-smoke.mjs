// Build the account screen with the real Svelte CLIENT build, then drive it in a
// real Electron renderer.
//
// Exit code is the result; the JSON line names what failed. A plain script
// rather than a vitest case for the same reason `electron-smoke.mjs` is one: it
// must own the process it spawns and its own timeout, and a hung Electron is a
// failure mode this has to REPORT rather than inherit.
//
// ## Why a build, and why this build
//
// `vitest.config.ts` runs in Node with Svelte's browser condition, which is
// enough to execute a rune module but not to render one: there is no document,
// no layout and no event loop delivering a click. An SSR render would not help —
// it produces markup once and never updates, so "click Cancel and the editor
// closes" would pass without anything closing.
//
// So the entry is compiled by the ORDINARY Svelte plugin, exactly as
// `vite.config.ts` compiles the app, and loaded into a real `BrowserWindow`. The
// bundle is IIFE and the CSS is a plain stylesheet because the page is loaded
// over `file:` — Chromium refuses module scripts from that origin, and a
// harness that silently failed to load would look like a screen that renders
// nothing.
//
// ## What it touches
//
// One temporary directory, created here and removed here AFTER the child's exit
// has been observed — never by the child, whose Chromium handles are still open
// when its own cleanup would run. Nothing here reaches a network, an account, a
// keychain or the developer's Electron profile.
//
// `--build-only` performs the build and stops, for checking the harness compiles
// without taking the exclusive browser slot.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const driver = fileURLToPath(new URL("./update-details-main.mjs", import.meta.url));
const TIMEOUT_MS = 120_000;
const buildOnly = process.argv.includes("--build-only");
/** Where to write real captures of the finished screen, when asked for. */
const shotArg = process.argv.find((a) => a.startsWith("--shots="));
const shotDir = shotArg ? shotArg.slice("--shots=".length) : "";

const owned = [
  mkdtempSync(path.join(tmpdir(), "relayium-update-ui-")),
  mkdtempSync(path.join(tmpdir(), "relayium-update-ui-profile-")),
];
const [bundleDir, userDataDir] = owned;

/** Returns the paths that could NOT be removed, so nothing is claimed falsely. */
function removeOwned() {
  const stuck = [];
  for (const dir of owned) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      stuck.push(`${dir}: ${String(err)}`);
    }
  }
  return stuck;
}

function finish(code, message) {
  const stuck = removeOwned();
  if (message) process.stderr.write(message);
  if (stuck.length > 0) {
    process.stderr.write(
      `update-ui: could not remove ${stuck.length} owned directory(ies)\n${stuck.join("\n")}\n`,
    );
    process.exit(1);
  }
  process.exit(code);
}

async function buildHarness() {
  await build({
    root: appRoot,
    // The app's own `vite.config.ts` builds the app; this builds one entry into
    // a task-owned directory and must not inherit its `outDir` or its base.
    configFile: false,
    logLevel: "warn",
    plugins: [svelte()],
    resolve: { dedupe: ["svelte"] },
    build: {
      outDir: bundleDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      // Classic script, not a module: see the header. `file:` refuses modules.
      lib: {
        entry: path.join(appRoot, "src/renderer/update/harness-entry.ts"),
        formats: ["iife"],
        name: "RelayiumUpdateHarness",
        fileName: () => "harness.js",
      },
    },
  });

  const css = readdirSync(bundleDir).filter((name) => name.endsWith(".css"));
  const links = css.map((name) => `    <link rel="stylesheet" href="./${name}" />`).join("\n");
  writeFileSync(
    path.join(bundleDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Relayium update harness</title>
${links}
  </head>
  <body>
    <div id="app"></div>
    <script src="./harness.js"></script>
  </body>
</html>
`,
    "utf8",
  );
  return { css };
}

const built = await buildHarness().catch((err) => {
  finish(1, `update-ui: the harness did not build\n${String(err?.stack ?? err)}\n`);
  return null;
});
if (built === null) process.exit(1);
if (built.css.length === 0) {
  finish(1, "update-ui: the build produced no stylesheet, so nothing would be styled\n");
}
if (buildOnly) {
  process.stdout.write(`update-ui: harness built (${built.css.join(", ")})\n`);
  finish(0, null);
}

const child = spawn(String(electronPath), [driver, bundleDir, userDataDir, shotDir], {
  cwd: appRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    // Ambient engineering overrides are CLEARED, not inherited: this harness
    // supplies its own page and must not depend on the environment being clean.
    RELAYIUM_WINDOWS_ENGINEERING: undefined,
    RELAYIUM_WINDOWS_DATA_ROOT: undefined,
    RELAYIUM_WINDOWS_ORIGIN: undefined,
  },
});

let out = "";
let err = "";
let timedOut = false;
child.stdout.on("data", (d) => {
  out += d;
});
child.stderr.on("data", (d) => {
  err += d;
});

const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, TIMEOUT_MS);

child.on("exit", (code) => {
  clearTimeout(timer);
  if (timedOut) {
    finish(1, `update-ui: no result within ${TIMEOUT_MS}ms\n${out}\n${err}\n`);
    return;
  }
  const line = out.split("\n").find((l) => l.startsWith("RELAYIUM_UPDATE_UI "));
  if (!line) {
    finish(1, `update-ui: produced no result line (exit ${code})\n${out}\n${err}\n`);
    return;
  }
  const { failures, checks } = JSON.parse(line.slice("RELAYIUM_UPDATE_UI ".length));
  if (failures.length > 0) {
    finish(1, `update-ui: ${failures.length} failed\n${failures.join("\n")}\n`);
    return;
  }
  if (code !== 0) {
    finish(1, `update-ui: assertions passed but the renderer exited ${code}\n${err}\n`);
    return;
  }
  process.stdout.write(`update-ui: ${checks} renderer assertions passed\n`);
  finish(0, null);
});
