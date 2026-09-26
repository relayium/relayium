#!/usr/bin/env node
// Pure script wiring formerly in LocalNearbyModuleBoundaryTests. Script-only
// changes do not select Swift CI, so repository-policy owns these assertions.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsText } from './lib/swift-source-text.mjs';
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the iOS built-App harness drives the link and the Mac one still drives the room', () => {
  const ios = read('scripts/ios-ui-session-acceptance.sh');
  assert.ok(containsText(ios, 'start_peer local-link-peer local-link-peer'),
    'the iOS built-App harness no longer starts a local link peer');
  assert.ok(!containsText(ios, 'start_peer nearby-receiver'),
    "the iOS harness is back on the hub's code-less room, which no shipped iOS build browses");
  const mac = read('scripts/macos-ui-session-acceptance.sh');
  assert.ok(containsText(mac, 'start_peer nearby-receiver nearby-receiver'),
    "the macOS harness left the hub's code-less room, which is still where macOS discovery joins");
  assert.ok(!containsText(mac, 'local-link-peer'), 'the macOS harness adopted the iOS-only local link');
});
