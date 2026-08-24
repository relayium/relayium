// The browser half of the root Device Inbox admission contract.
//
// `contracts/device-inbox-admission-v1.json` is runtime-neutral and is not
// generated from this module, nor this module from it. This file reads that one
// document INDEPENDENTLY — it shares no loader, no schema type and no helper
// with the Go or Swift consumer tests — and compares it to the constants
// `device-inbox.ts` already ships. Three separate readings of one file is the
// point: a shared parser that misread the document would make all three agree
// with each other about the wrong thing.
//
// What this file is deliberately NOT compared against:
//
//   * `SEND_ERROR_CODES`. That union is this client's own presentation set — it
//     folds central's create refusals together with locally-decided failures
//     like `network`, `cancelled` and `upload_too_large`, because the card shows
//     one sentence either way. It is a UI decision, it is not a fact the other
//     two implementations hold, and freezing it would put copy-shaped choices
//     into a wire contract.
//   * `deviceReportableStates`. This build is a SENDER; it has no report path,
//     so it declares no such subset and has nothing honest to compare. The
//     contract's own well-formedness rules cover that list here, and the Go and
//     Swift consumers — both of which do implement it — compare it exactly.
//
// What it IS compared against includes one fact this module does not itself
// possess: the transition graph. The browser has no transition table, but it
// does have `isTerminalTaskState`, and "terminal" and "has no outgoing edge"
// are the same fact written twice. Checking one against the other is how a
// sender's polling-stop rule gets verified against the server's state machine
// without the browser ever having to carry that machine.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAP_RECEIVE_V3,
  CAP_TEXT_V1,
  INBOX_KEY_ALGORITHM,
  INBOX_PROTOCOL_VERSION,
  SERVER_TASK_STATES,
  TASK_ERROR_CODES,
  isServerTaskState,
  isTaskErrorCode,
  isTerminalTaskState,
} from "./device-inbox";

// ── finding the document ────────────────────────────────────────────────────

/** Files that exist at the repository root and nowhere below it. */
const REPOSITORY_MARKERS = [
  "apps/RelayiumKit/Package.swift",
  "server/go.mod",
  "web/package.json",
  ".github/workflows/ios.yml",
];

/**
 * The repository root, DISCOVERED by marker rather than counted.
 *
 * The other repository-reading tests here resolve `process.cwd(), ".."`, which
 * is a hard-coded fact about where vitest was invoked from and about how deep
 * this file sits. When such a walk is wrong it does not throw: it names a path
 * that does not exist, and the test that reads it fails in a way that looks
 * like a contract breach rather than like a moved directory. The walk below
 * starts at this file, climbs until one directory carries every marker, and
 * throws with what it searched when none does.
 */
function repositoryRoot(): string {
  let candidate = dirname(fileURLToPath(import.meta.url));
  const searched: string[] = [];
  for (;;) {
    searched.push(candidate);
    if (REPOSITORY_MARKERS.every((m) => existsSync(resolve(candidate, m)))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(
    `no repository root above ${searched[0]}: walked ${searched.length} directories up to ` +
      `${searched[searched.length - 1]} without finding one carrying all of ` +
      `${REPOSITORY_MARKERS.join(", ")}.`,
  );
}

const ROOT = repositoryRoot();
const CONTRACT_PATH = "contracts/device-inbox-admission-v1.json";

// ── the document's shape, stated here rather than imported ──────────────────

interface CapabilityToken {
  token: string;
  definedBy: string[];
}

interface AdmissionContract {
  contract: string;
  contractVersion: number;
  documentation: string;
  consumers: string[];
  protocolVersion: number;
  keyAlgorithm: string;
  requiredReceiveCapability: string;
  capabilityTokenSyntax: { pattern: string; maxLength: number };
  capabilityTokens: CapabilityToken[];
  taskStates: string[];
  terminalStates: string[];
  deviceReportableStates: string[];
  stateTransitions: Record<string, string[]>;
  noErrorValue: string;
  deviceReportableErrors: string[];
  centralOnlyErrors: string[];
}

/** The closed top-level key set. Extra and missing are both refused against it. */
const TOP_LEVEL_KEYS = [
  "capabilityTokenSyntax",
  "capabilityTokens",
  "centralOnlyErrors",
  "consumers",
  "contract",
  "contractVersion",
  "deviceReportableErrors",
  "deviceReportableStates",
  "documentation",
  "keyAlgorithm",
  "noErrorValue",
  "protocolVersion",
  "requiredReceiveCapability",
  "stateTransitions",
  "taskStates",
  "terminalStates",
];

const RAW = readFileSync(resolve(ROOT, CONTRACT_PATH), "utf8");
const CONTRACT = JSON.parse(RAW) as AdmissionContract;

/** Strictly ascending — the contract's order rule, and its duplicate check. */
function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((v, i) => i === 0 || values[i - 1] < v);
}

/** A list of states in `taskStates` order: deterministic, and duplicate-free. */
function isStateSubsequence(values: readonly string[], order: readonly string[]): boolean {
  let last = -1;
  for (const value of values) {
    const at = order.indexOf(value);
    if (at <= last) return false;
    last = at;
  }
  return true;
}

describe("the Device Inbox admission contract document", () => {
  it("is a single object carrying exactly the closed key set", () => {
    expect(typeof CONTRACT).toBe("object");
    expect(CONTRACT).not.toBeNull();
    // Sorted-key equality refuses BOTH directions at once: an unknown fact this
    // build would silently ignore, and a deleted fact every consumer would then
    // stop comparing anything against.
    expect(Object.keys(CONTRACT).sort()).toEqual(TOP_LEVEL_KEYS);
  });

  it("identifies itself and points at a document that exists", () => {
    expect(CONTRACT.contract).toBe("relayium.device-inbox.admission");
    expect(CONTRACT.contractVersion).toBe(1);
    expect(CONTRACT.documentation).toBe("docs/DEVICE-INBOX-ADMISSION-CONTRACT.md");
    expect(existsSync(resolve(ROOT, CONTRACT.documentation))).toBe(true);
    expect(CONTRACT.consumers).toEqual(["go", "swift", "web"]);
    expect(CONTRACT.consumers).toContain("web");
  });

  it("orders every unordered list strictly, which is also how it refuses a duplicate", () => {
    expect(isStrictlyAscending(CONTRACT.consumers)).toBe(true);
    expect(isStrictlyAscending(CONTRACT.deviceReportableErrors)).toBe(true);
    expect(isStrictlyAscending(CONTRACT.centralOnlyErrors)).toBe(true);
    expect(isStrictlyAscending(CONTRACT.capabilityTokens.map((c) => c.token))).toBe(true);
    for (const entry of CONTRACT.capabilityTokens) {
      expect(isStrictlyAscending(entry.definedBy)).toBe(true);
      expect(entry.definedBy.length).toBeGreaterThan(0);
      expect(Object.keys(entry).sort()).toEqual(["definedBy", "token"]);
      for (const consumer of entry.definedBy) expect(CONTRACT.consumers).toContain(consumer);
    }
  });

  it("orders every state list by taskStates, and names no state it did not declare", () => {
    expect(new Set(CONTRACT.taskStates).size).toBe(CONTRACT.taskStates.length);
    expect(isStateSubsequence(CONTRACT.terminalStates, CONTRACT.taskStates)).toBe(true);
    expect(isStateSubsequence(CONTRACT.deviceReportableStates, CONTRACT.taskStates)).toBe(true);
    expect(Object.keys(CONTRACT.stateTransitions).sort()).toEqual([...CONTRACT.taskStates].sort());
    for (const [from, targets] of Object.entries(CONTRACT.stateTransitions)) {
      expect(isStateSubsequence(targets, CONTRACT.taskStates)).toBe(true);
      expect(targets).not.toContain(from);
    }
  });

  it("states 'terminal' twice and the two readings agree", () => {
    for (const state of CONTRACT.taskStates) {
      expect(CONTRACT.terminalStates.includes(state)).toBe(
        CONTRACT.stateTransitions[state].length === 0,
      );
    }
  });

  it("keeps the no-error value out of both nonempty error sets", () => {
    expect(CONTRACT.noErrorValue).toBe("");
    expect(CONTRACT.deviceReportableErrors).not.toContain("");
    expect(CONTRACT.centralOnlyErrors).not.toContain("");
    for (const code of CONTRACT.centralOnlyErrors) {
      expect(CONTRACT.deviceReportableErrors).not.toContain(code);
    }
  });
});

describe("this build's Device Inbox constants against the contract", () => {
  it("wraps with the frozen key algorithm and speaks the frozen protocol version", () => {
    expect(INBOX_KEY_ALGORITHM).toBe(CONTRACT.keyAlgorithm);
    expect(INBOX_PROTOCOL_VERSION).toBe(CONTRACT.protocolVersion);
  });

  it("declares exactly the capability tokens the contract attributes to the browser", () => {
    const mine = [CAP_RECEIVE_V3, CAP_TEXT_V1].sort();
    const frozen = CONTRACT.capabilityTokens
      .filter((c) => c.definedBy.includes("web"))
      .map((c) => c.token)
      .sort();
    // Exact, in both directions. A token this build named and the contract did
    // not is a private extension to a shared vocabulary; a token the contract
    // attributes here and this build does not have is a claim nothing backs.
    expect(mine).toEqual(frozen);
  });

  it("spells every token it declares the way the contract's own syntax requires", () => {
    const syntax = new RegExp(CONTRACT.capabilityTokenSyntax.pattern);
    for (const token of [CAP_RECEIVE_V3, CAP_TEXT_V1]) {
      expect(syntax.test(token)).toBe(true);
      expect(token.length).toBeLessThanOrEqual(CONTRACT.capabilityTokenSyntax.maxLength);
    }
    // The pattern is load-bearing rather than permissive: these are the shapes
    // it exists to refuse.
    for (const bad of ["inbox.receive", "inbox.v0", "inbox.v01", "Inbox.receive.v1", "v1", ""]) {
      expect(syntax.test(bad)).toBe(false);
    }
  });

  it("requires the same receive capability before it will offer a device as a target", () => {
    expect(CAP_RECEIVE_V3).toBe(CONTRACT.requiredReceiveCapability);
  });

  it("holds exactly the frozen server task states, in the frozen order", () => {
    expect([...SERVER_TASK_STATES]).toEqual(CONTRACT.taskStates);
    for (const state of CONTRACT.taskStates) expect(isServerTaskState(state)).toBe(true);
    for (const other of ["encrypting", "uploading", "registering", "Saved", "done", ""]) {
      expect(isServerTaskState(other)).toBe(false);
    }
  });

  it("stops polling on exactly the states the contract's graph cannot leave", () => {
    // The browser has no transition table. It has a polling-stop rule, and this
    // is that rule checked against the server's graph, state by state.
    for (const state of CONTRACT.taskStates) {
      expect(isTerminalTaskState(state)).toBe(CONTRACT.stateTransitions[state].length === 0);
      expect(isTerminalTaskState(state)).toBe(CONTRACT.terminalStates.includes(state));
    }
  });

  it("understands exactly the union of the device-reportable and central-only codes", () => {
    // A read model legitimately sees both authors' codes: the account-scoped
    // task view carries whichever one is on the row. What it must not do is
    // grow a code no other implementation writes, or lose one that central
    // does — either way a real task would render as an unknown error.
    expect([...TASK_ERROR_CODES].sort()).toEqual(
      [...CONTRACT.deviceReportableErrors, ...CONTRACT.centralOnlyErrors].sort(),
    );
    for (const code of [...CONTRACT.deviceReportableErrors, ...CONTRACT.centralOnlyErrors]) {
      expect(isTaskErrorCode(code)).toBe(true);
    }
    // The no-error value is the ABSENCE of a code, so it is not a member here.
    // A build that accepted `""` as an error code would render "nothing has
    // gone wrong" through an error branch.
    expect(isTaskErrorCode(CONTRACT.noErrorValue)).toBe(false);
    for (const code of ["none", "unknown", "lease-expired", "Internal"]) {
      expect(isTaskErrorCode(code)).toBe(false);
    }
  });
});
