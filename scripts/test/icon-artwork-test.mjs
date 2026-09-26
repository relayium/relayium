#!/usr/bin/env node
// Former AppIconArtworkTests: Web artwork changes must run these too.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsText, splitText } from './lib/swift-source-text.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const macSVG = 'apps/mac/Brand/AppIcon.svg';
const sources = [macSVG, 'web/public/favicon.svg', 'web/src/lib/Logo.svelte'];
const glyph = 'M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5';

test('the glyph is identical in all three artwork sources', () => {
  assert.equal([...glyph].filter(x => x === 'M').length, 4, 'four subpaths');
  for (const file of sources) assert.ok(containsText(read(file), glyph), `${file} no longer carries the glyph`);
});
test('gradient stops and stroke are identical in all three sources', () => {
  for (const file of sources) {
    const text = read(file);
    for (const needle of ['#a94bff', '#635bff', 'stop-opacity=".22"', 'offset=".55"',
      'stroke-width="5.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"']) {
      assert.ok(containsText(text, needle), `${file} missing ${needle}`);
    }
  }
});
test('the Mac canvas follows the Apple grid and bakes no shadow', () => {
  const text = read(macSVG);
  for (const needle of ['viewBox="0 0 1024 1024"', 'x="100"', 'y="100"',
    'width="824"', 'height="824"', 'rx="185.4"', 'scale(12.875)']) {
    assert.ok(containsText(text, needle), `the Mac canvas lost ${needle}`);
  }
  assert.ok(!containsText(text, 'rx="15"'), 'the Web corner radius must not survive');
  for (const banned of ['feDropShadow', 'filter=', 'feGaussianBlur']) {
    assert.ok(!containsText(text, banned), 'no shadow may be baked into the alpha channel');
  }
});
test('the shared package has no icon targets', () => {
  const manifest = read('apps/RelayiumKit/Package.swift');
  for (const banned of ['AppIconArtwork', 'AppIconGen']) {
    assert.ok(!containsText(manifest, banned), `Package.swift gained ${banned}`);
  }
  const executables = splitText(manifest, '.executableTarget').slice(1).flatMap(chunk => {
    const pieces = splitText(chunk, 'name: "');
    if (pieces.length < 2) return [];
    return [splitText(pieces.slice(1).join('name: "'), '"')[0]];
  });
  assert.deepEqual(executables.sort(), ['LocalTransferPeer', 'NearbyReceiveE2E', 'RealtimeE2E'],
    'the executable targets are exactly the three recorded harnesses');
});
