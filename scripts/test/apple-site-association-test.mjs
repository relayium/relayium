#!/usr/bin/env node
// Moved from IOSSurfaceGuardTests: Web-only changes do not select Swift CI.
// Keep native entitlement/runtime tests in their owning Swift lane.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const stringArray = value => Array.isArray(value) && value.every(x => typeof x === "string");
const dictionaries = value => Array.isArray(value) && value.every(x => x !== null && typeof x === "object" && !Array.isArray(x));

test("the site association names the native apps for exactly their routable paths", () => {
  const json = JSON.parse(readFileSync(new URL("../../web/public/.well-known/apple-app-site-association", import.meta.url), "utf8"));
  assert.ok(json && typeof json === "object" && !Array.isArray(json));
  const applinks = json.applinks;
  assert.ok(applinks && typeof applinks === "object" && !Array.isArray(applinks));
  const details = applinks.details;
  assert.ok(dictionaries(details));
  const appIDs = details.flatMap(detail => stringArray(detail.appIDs) ? detail.appIDs : []);
  assert.deepEqual(appIDs, ["7PVYUG4YQS.com.relayium.mac", "7PVYUG4YQS.com.relayium.app"],
    "the association no longer names both native app IDs");
  const paths = details.flatMap(detail => (dictionaries(detail.components) ? detail.components : [])
    .flatMap(component => typeof component["/"] === "string" ? [component["/"]] : []));
  assert.deepEqual(paths, ["/d/*", "/cross-network"],
    "the site claims a path parseAppDeepLink cannot route");
  assert.ok(!paths.includes("/share"), "a path was claimed for a hand-off iOS cannot perform");
  const credentials = json.webcredentials?.apps;
  assert.ok(stringArray(credentials));
  assert.deepEqual(credentials, ["7PVYUG4YQS.com.relayium.mac"],
    "the site's AutoFill association changed shape; the app claims no webcredentials entitlement");
});
