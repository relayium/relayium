// Both ends of every IPC channel, held to each other.
//
// `preload.cts` names 99 channels as string LITERALS and imports nothing from
// the contract — deliberately, because it is the sandbox bridge and keeping it
// import-free is part of what makes it auditable. `handlers.ts` names none of
// them, registering everything from `IPC`/`IPC_EVENTS`.
//
// So the two ends are declared independently with nothing linking them, and
// today they agree exactly. That is the reason for this file, not a reason to
// skip it: the agreement is maintained by attention, and attention is not a
// mechanism.
//
// The failure is an ordinary refactor. Rename a constant in the contract: main
// registers the new name, the preload keeps calling the old one, every call on
// that channel fails at runtime, and nothing goes red unless a smoke happens to
// drive that exact channel. There are 99 of them and the smokes reach a subset.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");

/** Every `"relayium:…"` a file states. */
const channelsIn = (source: string): Set<string> =>
  new Set([...source.matchAll(/"(relayium:[a-z-]+)"/g)].map((m) => m[1]));

const contract = channelsIn(read("shared/ipc-contract.ts"));
const preload = channelsIn(read("preload/preload.cts"));

const missing = (from: Set<string>, of: Set<string>): string[] =>
  [...of].filter((channel) => !from.has(channel)).sort();

describe("the IPC channel names", () => {
  it("are a set these tests can actually see", () => {
    // Guards the guard. A regex that stopped matching would otherwise report
    // perfect agreement between two empty sets, which is the one result this
    // file must never produce quietly.
    expect(contract.size).toBeGreaterThanOrEqual(90);
    expect(preload.size).toBeGreaterThanOrEqual(90);
    expect(contract.has("relayium:app-info")).toBe(true);
    expect(preload.has("relayium:app-info")).toBe(true);
  });

  it("agree: nothing the preload calls is absent from the contract", () => {
    // The rename case. The preload keeps the old spelling, main registers the
    // new one, and the call goes to a channel with no handler.
    expect(missing(contract, preload)).toEqual([]);
  });

  it("agree: nothing the contract declares is unreachable from the page", () => {
    // The other direction, and it is not symmetrical in how it fails. A channel
    // main handles but the preload never exposes is a capability that was built
    // and wired and simply cannot be called — which looks like a missing
    // feature rather than a broken one, and is harder to recognise.
    expect(missing(preload, contract)).toEqual([]);
  });

  it("are stated ONCE on main's side", () => {
    // `handlers.ts` registers from the constants and holds no literal of its
    // own. A literal appearing there is the same drift one step earlier: the
    // contract would have quietly stopped being the single declaration, and
    // this file's comparison would then be checking the preload against a
    // document main no longer follows.
    expect([...channelsIn(read("main/handlers.ts"))]).toEqual([]);
  });
});
