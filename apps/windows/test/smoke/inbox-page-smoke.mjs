// Build the REAL Device Inbox page with the Svelte CLIENT build, then drive it
// in a real Electron renderer.
//
// The Inbox is this app's flagship screen and had no real-renderer coverage at
// all: the account screen, the update pane, the OS-entry pane and the pairing
// handoff each had one, and the screen the product is named for did not. This
// is the same rig as `account-details-smoke.mjs`, deliberately — the reasoning
// in that file's header applies here unchanged, and duplicating the rig was
// cheaper and clearer than generalising two callers into one.
//
// What it drives is finite and stated: the retained-cleanup card and the
// receipt phase line. Both carry copy added on 2026-09-12 that is compile-
// checked and had never been DISPLAYED by anything. The send half is mounted
// but not driven; its bridge rejects, so a scenario that strayed into it would
// fail loudly rather than pass on a stub.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const driver = fileURLToPath(new URL("./inbox-page-main.mjs", import.meta.url));
const TIMEOUT_MS = 120_000;
const buildOnly = process.argv.includes("--build-only");
/** Where to write real captures of the finished screen, when asked for. */
const shotArg = process.argv.find((a) => a.startsWith("--shots="));
const shotDir = shotArg ? shotArg.slice("--shots=".length) : "";

const owned = [
  mkdtempSync(path.join(tmpdir(), "relayium-inbox-ui-")),
  mkdtempSync(path.join(tmpdir(), "relayium-inbox-ui-profile-")),
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
      `inbox-ui: could not remove ${stuck.length} owned directory(ies)\n${stuck.join("\n")}\n`,
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
        entry: path.join(appRoot, "src/renderer/inbox/harness-entry.ts"),
        formats: ["iife"],
        name: "RelayiumInboxHarness",
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
    <title>Relayium Device Inbox harness</title>
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
  finish(1, `inbox-ui: the harness did not build\n${String(err?.stack ?? err)}\n`);
  return null;
});
if (built === null) process.exit(1);
if (built.css.length === 0) {
  finish(1, "inbox-ui: the build produced no stylesheet, so nothing would be styled\n");
}
if (buildOnly) {
  process.stdout.write(`inbox-ui: harness built (${built.css.join(", ")})\n`);
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
    finish(1, `inbox-ui: no result within ${TIMEOUT_MS}ms\n${out}\n${err}\n`);
    return;
  }
  const line = out.split("\n").find((l) => l.startsWith("RELAYIUM_INBOX_UI "));
  if (!line) {
    finish(1, `inbox-ui: produced no result line (exit ${code})\n${out}\n${err}\n`);
    return;
  }
  const { failures, checks } = JSON.parse(line.slice("RELAYIUM_INBOX_UI ".length));
  if (failures.length > 0) {
    finish(1, `inbox-ui: ${failures.length} failed\n${failures.join("\n")}\n`);
    return;
  }
  if (code !== 0) {
    finish(1, `inbox-ui: assertions passed but the renderer exited ${code}\n${err}\n`);
    return;
  }
  process.stdout.write(`inbox-ui: ${checks} renderer assertions passed\n`);
  finish(0, null);
});
