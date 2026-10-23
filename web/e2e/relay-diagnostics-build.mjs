#!/usr/bin/env node
/**
 * The PRIVATE diagnostic Web bundle for scripts/realtime-relay-diagnostics.sh.
 *
 * Why a separate build at all: the per-batch `TransferSample` (credit wait,
 * buffer+pacing wait, finalize, active time) is produced inside the App's file
 * session, and the only consumer the shipped bundle wires is App.svelte's
 * relay-history recorder. Nothing on the page can reach that session, and the
 * product must not grow a runtime switch, global or storage flag to expose it.
 *
 * So this module builds the UNCHANGED sources with ONE extra Vite plugin that
 * rewrites exactly one line of `src/App.svelte` in memory (never on disk):
 *
 *     onTransferSample: (sample) => onTransferSample(sample),
 *
 * becomes the same call followed by a fenced hand-off of a PLAIN copy of the six
 * numeric/enum fields to `globalThis.__relayiumRelayDiagnostics.sample(...)`,
 * when — and only when — a diagnostics page installed that object. The live
 * `sample.link` is never passed, the product observer runs first and unchanged,
 * and anything the hand-off throws is swallowed, so it cannot reorder, fail or
 * retry a transfer (the product's own emitSample already swallows observer
 * faults; this is a second fence, not the only one).
 *
 * Guarantees this file enforces rather than describes:
 *   - the anchor must occur EXACTLY once, or the build refuses;
 *   - the plugin must have rewritten App.svelte exactly once by the end of the
 *     build, or the build refuses (a silently untransformed bundle would report
 *     every sample as "missing" and look like a product bug);
 *   - the output directory must be absolute and outside the WHOLE owning
 *     repository, judged both lexically and after resolving the nearest
 *     existing ancestor's symbolic links (a parent link into src/ is refused),
 *     must not itself be a link, and must be absent, empty or a previous output
 *     of this module whose marker file parses and names this module and anchor
 *     (a marker's mere presence is not enough to earn an rm -rf);
 *   - `npm run build` / `vite build` are not affected in any way: this plugin is
 *     only ever passed inline here, never added to vite.config.ts.
 *
 *     node e2e/relay-diagnostics-build.mjs --out /absolute/private/dir
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANCHOR = 'onTransferSample: (sample) => onTransferSample(sample),';
export const HOOK_GLOBAL = '__relayiumRelayDiagnostics';
export const MARKER_FILE = '.relayium-relay-diagnostics-build.json';
export const SAMPLE_FIELDS = ['dir', 'bytes', 'activeMs', 'creditWaitMs', 'bufferWaitMs', 'finalizeMs'];

const REPLACEMENT = 'onTransferSample: (sample) => { onTransferSample(sample); try { '
  + `const relayDiagnostics = (globalThis as any).${HOOK_GLOBAL}; `
  + 'if (relayDiagnostics && typeof relayDiagnostics.sample === "function") relayDiagnostics.sample({ '
  + SAMPLE_FIELDS.map(field => `${field}: sample.${field}`).join(', ')
  + ' }); } catch { /* relay diagnostics are optional observation */ } },';

const count = (text, needle) => text.split(needle).length - 1;

/** Pure: the in-memory rewrite of App.svelte. Refuses unless exactly one anchor. */
export function transformAppSource(code) {
  if (typeof code !== 'string') throw new Error('App source must be a string');
  const found = count(code, ANCHOR);
  if (found !== 1) throw new Error(`relay diagnostics anchor must occur exactly once in App.svelte, found ${found}`);
  if (code.includes(HOOK_GLOBAL)) throw new Error('App.svelte already mentions the diagnostics hook; refusing to stack rewrites');
  return code.replace(ANCHOR, REPLACEMENT);
}

/** The Vite plugin. `state.rewrites` is checked by the caller after the build. */
export function relayDiagnosticsPlugin(appPath, state = { rewrites: 0 }) {
  const target = resolve(appPath);
  return {
    name: 'relayium-relay-diagnostics-private-build',
    enforce: 'pre',
    apply: 'build',
    load(id) {
      const path = id.split('?')[0];
      if (resolve(path) !== target || id.includes('?')) return null;
      state.rewrites++;
      return transformAppSource(readFileSync(target, 'utf8'));
    },
  };
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** The path as the filesystem will resolve it: the nearest EXISTING ancestor
 * through realpath, plus the not-yet-existing remainder. */
function physical(path) {
  const rest = [];
  let probe = path;
  for (;;) {
    try { return join(realpathSync(probe), ...rest.reverse()); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(probe);
    if (parent === probe) return path;
    rest.push(probe.slice(parent.length).replace(/^[\\/]+/, ''));
    probe = parent;
  }
}

/** A previous output of THIS module, judged by its marker's content. */
export function isPreviousBuild(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8'));
    return marker?.kind === 'relayium-relay-diagnostics-private-build' && marker.anchor === ANCHOR && marker.rewrites === 1
      && typeof marker.fingerprint?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(marker.fingerprint.sha256)
      && Number.isSafeInteger(marker.fingerprint.files) && marker.fingerprint.files > 0;
  } catch { return false; }
}

/** Refuse any output location that could overwrite repository bytes, before
 * anything is removed. `repoRoot` defaults to the repository owning `webRoot`. */
export function checkedOutDir(outDir, webRoot, repoRoot = resolve(webRoot, '..')) {
  if (typeof outDir !== 'string' || !isAbsolute(outDir)) throw new Error('--out must be an absolute path');
  const out = resolve(outDir);
  const repos = [resolve(repoRoot), physical(resolve(repoRoot))];
  for (const candidate of [out, physical(out)]) {
    for (const repo of repos) {
      if (inside(candidate, repo) || inside(repo, candidate)) throw new Error('refusing diagnostic output inside or around the owning repository');
    }
  }
  let link = false;
  try { link = lstatSync(out).isSymbolicLink(); } catch { /* absent */ }
  if (link) throw new Error('--out is a symbolic link');
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error('--out exists and is not a directory');
    if (readdirSync(out).length && !isPreviousBuild(out)) throw new Error('--out exists, is not empty and is not a previous diagnostic build');
  }
  return out;
}

export function treeFingerprint(root) {
  const hash = createHash('sha256');
  let files = 0;
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path !== join(root, MARKER_FILE)) {
        hash.update(relative(root, path)); hash.update('\0');
        hash.update(createHash('sha256').update(readFileSync(path)).digest('hex')); hash.update('\n');
        files++;
      }
    }
  };
  walk(root);
  return { sha256: hash.digest('hex'), files };
}

/** Build the private bundle. Returns { outDir, rewrites, fingerprint }. */
export async function buildDiagnosticBundle({ outDir, webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), logLevel = 'warn' }) {
  const out = checkedOutDir(outDir, webRoot);
  const appPath = join(webRoot, 'src', 'App.svelte');
  transformAppSource(readFileSync(appPath, 'utf8')); // refuse before spending a build
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  const { build } = await import('vite');
  const state = { rewrites: 0 };
  await build({ root: webRoot, configFile: join(webRoot, 'vite.config.ts'), logLevel,
    plugins: [relayDiagnosticsPlugin(appPath, state)],
    build: { outDir: out, emptyOutDir: true } });
  if (state.rewrites !== 1) throw new Error(`diagnostic build rewrote App.svelte ${state.rewrites} times, want exactly 1`);
  const bundled = readdirSync(join(out, 'assets')).filter(n => n.endsWith('.js'))
    .filter(n => readFileSync(join(out, 'assets', n), 'utf8').includes(HOOK_GLOBAL));
  if (bundled.length !== 1) throw new Error(`diagnostic hook found in ${bundled.length} bundled scripts, want exactly 1`);
  const fingerprint = treeFingerprint(out);
  writeFileSync(join(out, MARKER_FILE), JSON.stringify({ kind: 'relayium-relay-diagnostics-private-build', anchor: ANCHOR,
    rewrites: state.rewrites, fingerprint }, null, 2) + '\n');
  return { outDir: out, rewrites: state.rewrites, fingerprint };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') {
    console.error('usage: node e2e/relay-diagnostics-build.mjs --out /absolute/private/dir');
    process.exit(2);
  }
  buildDiagnosticBundle({ outDir: args[1] }).then(result => {
    console.log(`relay diagnostics private build: ${result.fingerprint.files} files, tree ${result.fingerprint.sha256}`);
  }, error => { console.error(`relay diagnostics private build FAILED: ${error.message}`); process.exit(1); });
}
