#!/usr/bin/env node
// Cross-file half of the Inbox physical-acceptance environment contract,
// formerly in DeviceInboxAcceptanceSeamTests. Script-only changes must run it.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsText } from './lib/swift-source-text.mjs';
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the Inbox launcher exports the environment the acceptance suite reads', () => {
  const launcher = read('scripts/ios-device-inbox-acceptance.sh');
  const suite = read('apps/ios/RelayiumUITests/DeviceInboxAcceptanceUITests.swift');
  assert.ok(containsText(suite, String.raw`environment["RELAYIUM_DEVICE_INBOX_\(name)"]`),
    'the suite no longer reads the RELAYIUM_DEVICE_INBOX_ environment');
  for (const name of ['TAG', 'ROLE', 'MESSAGE', 'PEER_ID',
    'PEER_BUDGET_SECONDS', 'DELIVERY_BUDGET_SECONDS']) {
    assert.ok(containsText(launcher, `TEST_RUNNER_RELAYIUM_DEVICE_INBOX_${name}=`),
      `the launcher no longer exports ${name}`);
  }
  for (const token of ['value("TAG")', 'value("ROLE")', 'value("MESSAGE")',
    'value("PEER_ID")', '"PEER_BUDGET_SECONDS"', '"DELIVERY_BUDGET_SECONDS"']) {
    assert.ok(containsText(suite, token),
      `the suite no longer reads ${token}, so that export is inert`);
  }
});
