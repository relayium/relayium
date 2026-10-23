import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ANCHOR, HOOK_GLOBAL, MARKER_FILE, SAMPLE_FIELDS, transformAppSource, relayDiagnosticsPlugin, checkedOutDir, isPreviousBuild, buildDiagnosticBundle } from './relay-diagnostics-build.mjs';

const web = resolve(import.meta.dirname, '..');
const app = readFileSync(join(web, 'src/App.svelte'), 'utf8');

/** The rewritten `onTransferSample:` property value, as a callable arrow. */
function rewrittenArrow(onTransferSample) {
  const out = transformAppSource(app);
  const start = out.indexOf('onTransferSample: (sample) => {');
  const body = out.slice(start + 'onTransferSample: '.length, out.indexOf(' } },', start)) + ' } }';
  // The only TypeScript in the replacement is one erasable cast.
  const js = body.replace(' as any', '');
  return new Function('onTransferSample', `return (${js});`)(onTransferSample);
}

describe('private relay diagnostics build', () => {
  it('the shipped source carries the anchor exactly once and no hook', () => {
    expect(app.split(ANCHOR).length - 1).toBe(1);
    expect(app).not.toContain(HOOK_GLOBAL);
  });
  it('is never wired into the standard build configuration', () => {
    for (const config of ['vite.config.ts', 'vitest.config.ts', 'package.json']) {
      const text = readFileSync(join(web, config), 'utf8');
      expect(text).not.toContain('relay-diagnostics-build');
      expect(text).not.toContain(HOOK_GLOBAL);
    }
  });
  it('rewrites exactly one line and nothing else', () => {
    const out = transformAppSource(app);
    expect(out.split('\n').length).toBe(app.split('\n').length);
    const changed = out.split('\n').filter((line, i) => line !== app.split('\n')[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain(HOOK_GLOBAL);
    expect(changed[0]).not.toMatch(/sample\.link|\(sample\)\s*\)|relayDiagnostics\.sample\(sample\)/);
  });
  it('refuses a missing, duplicated or already-rewritten anchor', () => {
    expect(() => transformAppSource(app.replace(ANCHOR, 'onTransferSample: (s) => onTransferSample(s),'))).toThrow('found 0');
    expect(() => transformAppSource(`${app}\n${ANCHOR}`)).toThrow('found 2');
    expect(() => transformAppSource(transformAppSource(app))).toThrow();
    expect(() => transformAppSource(null)).toThrow();
  });
  it('the product observer runs first and unchanged; the hand-off copies six plain fields', () => {
    const calls = [];
    const sample = { link: { conn: 'LIVE-LINK' }, dir: 'send', bytes: 9, activeMs: 5, creditWaitMs: 1, bufferWaitMs: 2, finalizeMs: 1 };
    globalThis[HOOK_GLOBAL] = { sample: copy => calls.push(['hook', copy]) };
    try {
      rewrittenArrow(s => calls.push(['product', s]))(sample);
    } finally { delete globalThis[HOOK_GLOBAL]; }
    expect(calls[0]).toEqual(['product', sample]);
    expect(calls[1][0]).toBe('hook');
    expect(Object.keys(calls[1][1]).sort()).toEqual([...SAMPLE_FIELDS].sort());
    expect(calls[1][1]).not.toHaveProperty('link');
  });
  it('a throwing or absent hook never reaches the product; a product fault is not masked', () => {
    const product = [];
    globalThis[HOOK_GLOBAL] = { sample() { throw new Error('observer fault'); } };
    try {
      expect(() => rewrittenArrow(s => product.push(s))({ dir: 'recv', bytes: 1, activeMs: 1, creditWaitMs: 0, bufferWaitMs: 0, finalizeMs: 0 })).not.toThrow();
    } finally { delete globalThis[HOOK_GLOBAL]; }
    expect(product).toHaveLength(1);
    expect(() => rewrittenArrow(() => {})({ dir: 'send' })).not.toThrow(); // no hook installed
    globalThis[HOOK_GLOBAL] = { sample: 'not a function' };
    try { expect(() => rewrittenArrow(() => {})({ dir: 'send' })).not.toThrow(); } finally { delete globalThis[HOOK_GLOBAL]; }
    expect(() => rewrittenArrow(() => { throw new Error('product'); })({})).toThrow('product');
  });
  it('the plugin rewrites only the exact App.svelte module, once', () => {
    const state = { rewrites: 0 }, path = join(web, 'src/App.svelte');
    const plugin = relayDiagnosticsPlugin(path, state);
    expect(plugin.apply).toBe('build');
    expect(plugin.load(join(web, 'src/lib/ice.ts'))).toBeNull();
    expect(plugin.load(`${path}?svelte&type=style&lang.css`)).toBeNull();
    expect(plugin.load(path)).toContain(HOOK_GLOBAL);
    expect(state.rewrites).toBe(1);
  });
  it('refuses output locations that could overwrite repository bytes, lexically or through links', () => {
    for (const bad of ['relative/dir', join(web, 'dist'), join(web, 'dist/sub'), join(web, 'public'), join(web, 'src/x'), web,
      resolve(web, '..'), resolve(web, '../scripts/new-output'), resolve(web, '../..')]) {
      expect(() => checkedOutDir(bad, web)).toThrow();
    }
    const root = mkdtempSync(join(tmpdir(), 'relay-diag-build-'));
    expect(checkedOutDir(join(root, 'fresh'), web)).toBe(join(root, 'fresh'));
    expect(checkedOutDir(join(root, 'fresh', 'deeper'), web)).toBe(join(root, 'fresh', 'deeper'));
  });
  it('a parent symbolic link into a (fake) repository source tree is refused, and nothing is touched', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-diag-link-'));
    const repo = join(root, 'repo'), fakeWeb = join(repo, 'web');
    mkdirSync(join(fakeWeb, 'src'), { recursive: true });
    writeFileSync(join(fakeWeb, 'src', 'sentinel.txt'), 'keep me');
    symlinkSync(fakeWeb, join(root, 'alias'));
    for (const target of [join(root, 'alias', 'src', 'new-output'), join(root, 'alias', 'new-output'), join(root, 'alias')]) {
      expect(() => checkedOutDir(target, fakeWeb, repo)).toThrow();
    }
    // The output itself being a link is refused even when it points outside.
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'out-link'));
    expect(() => checkedOutDir(join(root, 'out-link'), fakeWeb, repo)).toThrow('symbolic link');
    expect(readFileSync(join(fakeWeb, 'src', 'sentinel.txt'), 'utf8')).toBe('keep me');
  });
  it('a marker file earns reuse only by its content; forged or foreign markers are refused before any removal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-diag-marker-'));
    const forged = join(root, 'forged'); mkdirSync(forged);
    writeFileSync(join(forged, MARKER_FILE), '{}'); writeFileSync(join(forged, 'sentinel.txt'), 'keep me');
    expect(isPreviousBuild(forged)).toBe(false);
    expect(() => checkedOutDir(forged, web)).toThrow('not a previous diagnostic build');
    await expect(buildDiagnosticBundle({ outDir: forged, webRoot: web })).rejects.toThrow('not a previous diagnostic build');
    expect(readFileSync(join(forged, 'sentinel.txt'), 'utf8')).toBe('keep me');
    const garbage = join(root, 'garbage'); mkdirSync(garbage); writeFileSync(join(garbage, MARKER_FILE), 'not json');
    expect(() => checkedOutDir(garbage, web)).toThrow();
    const foreign = join(root, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'keep.txt'), 'x');
    expect(() => checkedOutDir(foreign, web)).toThrow('not a previous diagnostic build');
    const previous = join(root, 'previous'); mkdirSync(previous);
    writeFileSync(join(previous, MARKER_FILE), JSON.stringify({ kind: 'relayium-relay-diagnostics-private-build', anchor: ANCHOR,
      rewrites: 1, fingerprint: { sha256: 'a'.repeat(64), files: 559 } }));
    expect(isPreviousBuild(previous)).toBe(true);
    expect(checkedOutDir(previous, web)).toBe(previous);
  });
});
