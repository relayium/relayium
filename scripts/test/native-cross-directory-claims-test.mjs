#!/usr/bin/env node
// Source-only claims formerly in HelpPresentationTests and IOSPrivacyManifestTests.
// repository-policy runs these for Web/server-only changes as well as native edits.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const characters = text => Array.from(segmenter.segment(text), part => part.segment.normalize("NFC"));
// Swift matches whole Characters; combining marks must not turn a malformed
// delimiter into an ordinary SQL parenthesis, space, quote or comma.
function find(source, needle, start = 0) {
  const wanted = characters(needle);
  for (let i = start; i <= source.length - wanted.length; i++) {
    if (wanted.every((c, j) => source[i + j] === c)) return i;
  }
  return -1;
}
function firstWord(text) {
  let word = "";
  for (const character of characters(text)) {
    if (character === " ") { if (word) break; }
    else word += character;
  }
  return word;
}

test("the native CLI help link has a matching Web route", () => {
  assert.ok(find(characters(read("web/src/lib/router.svelte.ts")), 'CLI_PATH = "/cli"') >= 0,
    "the app links to a path the web router no longer serves");
});

test("the activation aggregate carries no identifier", () => {
  const schema = characters(read("server/account/sqlite.go"));
  const head = "CREATE TABLE IF NOT EXISTS activation_funnel_monthly (";
  const start = find(schema, head);
  assert.notEqual(start, -1, "the activation aggregate's table is no longer created here");
  let depth = 1;
  const columnList = [];
  for (let i = start + characters(head).length; i < schema.length; i++) {
    const character = schema[i];
    if (character === "(") depth++;
    if (character === ")" && --depth === 0) break;
    columnList.push(character);
  }
  assert.equal(depth, 0, "the activation table's column list is unterminated");

  // Split only top-level commas, preserving CHECK expressions and table constraints.
  let entryDepth = 0;
  const entries = [""];
  for (const character of columnList) {
    if (character === "," && entryDepth === 0) { entries.push(""); continue; }
    if (character === "(") entryDepth++;
    if (character === ")") entryDepth--;
    entries[entries.length - 1] += character;
  }
  const columns = entries
    .map(entry => entry.replace(/^[\p{White_Space}\u200B]+|[\p{White_Space}\u200B]+$/gu, ""))
    .filter(Boolean)
    .filter(entry => !["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"].includes(firstWord(entry).toUpperCase()));
  const names = columns.map(firstWord);
  assert.deepEqual(names, ["period", "stage", "count"],
    "the activation aggregate no longer has exactly three columns; an identifier here would make the unlinked Product Interaction declaration false");

  const stageColumn = columns.find(column => find(characters(column), "stage ") === 0);
  assert.notEqual(stageColumn, undefined, "the aggregate has no stage column");
  const stage = characters(stageColumn);
  const literals = [];
  let index = 0;
  while (true) {
    const open = find(stage, "'", index);
    if (open < 0) break;
    const close = find(stage, "'", open + 1);
    if (close < 0) break;
    literals.push(stage.slice(open + 1, close).join(""));
    index = close + 1;
  }
  assert.deepEqual(literals, ["code_minted", "room_opened", "room_paired"],
    "the aggregate's stage vocabulary is no longer exactly the closed three");
  assert.ok(find(columnList, "stage IN ('code_minted','room_opened','room_paired')") >= 0,
    "the three stages are no longer enforced by a CHECK");
  for (const identifier of ["user_id", "account_id", "install_id", "device_id", "ip",
    "code", "room", "session", "token", "locale", "platform"]) {
    assert.ok(!names.includes(identifier),
      `the activation aggregate gained a ${identifier} column; it is declared UNLINKED and that is now false`);
  }
});
