#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const requireApproved = process.argv.includes("--require-approved");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const source = resolve(positional[0] ?? "apps/mac/release-readiness.json");

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

let readiness;
try {
  readiness = JSON.parse(await readFile(source, "utf8"));
} catch (error) {
  fail(`cannot read release readiness: ${error.message}`);
}

if (readiness) {
  if (typeof readiness.approved !== "boolean" || !Array.isArray(readiness.capabilities)) {
    fail("release readiness must contain boolean approved and a capabilities array");
  } else {
    const ids = new Set();
    for (const [index, item] of readiness.capabilities.entries()) {
      if (!item || typeof item.id !== "string" || item.id === "" ||
          typeof item.required !== "boolean" || typeof item.implemented !== "boolean" ||
          typeof item.evidence !== "string" || item.evidence === "") {
        fail(`capability ${index + 1} is malformed`);
        break;
      }
      if (ids.has(item.id)) {
        fail(`duplicate capability id: ${item.id}`);
        break;
      }
      ids.add(item.id);
    }

    const blockers = readiness.capabilities.filter((item) => item.required && !item.implemented);
    if (readiness.approved && blockers.length > 0) {
      fail(`approved release still has blockers: ${blockers.map((item) => item.id).join(", ")}`);
    } else if (requireApproved && !readiness.approved) {
      fail(`macOS release is not approved; blockers: ${blockers.map((item) => item.id).join(", ")}`);
    } else if (!process.exitCode) {
      process.stdout.write(
        readiness.approved
          ? "macOS release readiness approved\n"
          : `macOS release readiness valid; ${blockers.length} blocker(s) remain\n`,
      );
    }
  }
}
