#!/usr/bin/env node
// Web-only changes do not select swift-package.yml. This unfiltered Linux
// policy checks the static guides behind native help links. English-only Web
// application routes are outside this static-page contract. The owning Swift test
// binds this test-only contract to actual Mac/iOS URLs for AppLanguage.allCases;
// native URL/language behaviour remains tested in Swift, with no Node copy.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('every native static guide destination has a published page', async t => {
  const contract = JSON.parse(readFileSync(new URL(
    '../../apps/RelayiumKit/Tests/Fixtures/native-help-pages.json',
    import.meta.url), 'utf8'));
  assert.ok(contract && typeof contract === 'object' && !Array.isArray(contract),
    'native help publication contract must be an object');
  assert.deepEqual(Object.keys(contract).sort(), ['paths', 'schema']);
  assert.equal(contract.schema, 1, 'unsupported native help publication schema');
  assert.ok(Array.isArray(contract.paths) && contract.paths.length > 0,
    'native help publication paths must be a nonempty array');
  assert.equal(new Set(contract.paths).size, contract.paths.length,
    'native help publication paths must be unique');
  for (const path of contract.paths) {
    assert.ok(typeof path === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(path),
    'native help publication paths must be safe relative page paths');
  }
  assert.deepEqual(contract.paths, [...contract.paths].sort(),
    'keep native help publication paths in stable order');

  for (const path of contract.paths) {
    await t.test(path, () => {
      const page = new URL(`../../web/public/${path}/index.html`, import.meta.url);
      assert.ok(existsSync(page), `native help link has no published page: ${path}`);
      assert.ok(lstatSync(page).isFile(),
        `native help link is not a regular published HTML page: ${path}`);
    });
  }
});
