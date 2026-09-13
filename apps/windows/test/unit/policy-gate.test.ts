// The gate: what a build does with the verdict.
//
// The property under attack is the same one as everywhere else in this
// mechanism - a build must not stop itself - plus its opposite, which only
// matters once: when the product HAS withdrawn support, the block must be
// real. A gate that fails open in both directions is not a gate.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDED_FLOOR, type ClientPolicy } from "../../src/main/policy/client-policy.js";
import { PolicyStore, policyPath } from "../../src/main/policy/policy-store.js";
import { PolicyGate, report, FLOOR_REPORT } from "../../src/main/policy/policy-gate.js";

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-gate-"));
  roots.push(dir);
  return dir;
}

/** A document that withdraws support for everything below 5.0.0. */
const STRICT = {
  schema: 1,
  windows: {
    policyRevision: 11,
    minimumSupportedVersion: "5.0.0",
    recommendedVersion: "5.1.0",
    latestVersion: "5.2.0",
    minimumSupportedBuild: 0,
  },
};

describe("a build with nothing remembered", () => {
  it("is not blocked", async () => {
    const gate = await PolicyGate.open({
      version: "0.0.1",
      store: new PolicyStore(policyPath(await root())),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.current().state).toBe("supported");
  });

  it("is not blocked when the cache file is unreadable", async () => {
    const dir = await root();
    await writeFile(policyPath(dir), " not json at all", "utf8");
    const gate = await PolicyGate.open({
      version: "0.0.1",
      store: new PolicyStore(policyPath(dir)),
    });
    expect(gate.blocked).toBe(false);
  });

  it("is not blocked when the store itself throws", async () => {
    // The one thing this must never do is prevent a start.
    const angry = { read: () => Promise.reject(new Error("disk gone")) } as unknown as PolicyStore;
    const gate = await PolicyGate.open({ version: "0.0.1", store: angry });
    expect(gate.blocked).toBe(false);
  });
});

describe("a build the product has withdrawn support for", () => {
  it("is blocked, from the remembered document", async () => {
    // The block has to be real, or the lever is theatre.
    const dir = await root();
    const store = new PolicyStore(policyPath(dir));
    await store.write({ document: STRICT, acceptedRevision: 11 });
    const gate = await PolicyGate.open({ version: "1.0.0", store });
    expect(gate.blocked).toBe(true);
    const shown = gate.current();
    expect(shown.current).toBe("1.0.0");
    expect(shown.minimum).toBe("5.0.0");
    expect(shown.latest).toBe("5.2.0");
  });

  it("is not blocked once its own version is at the floor", async () => {
    const dir = await root();
    const store = new PolicyStore(policyPath(dir));
    await store.write({ document: STRICT, acceptedRevision: 11 });
    const gate = await PolicyGate.open({ version: "5.0.0", store });
    expect(gate.blocked).toBe(false);
    expect(gate.current().state).toBe("recommended");
  });
});

describe("the report the shell is given", () => {
  it("says versions as text, so the screen needs no formatter", () => {
    const shown = report("1.2.3", EMBEDDED_FLOOR);
    expect(shown).toEqual({
      state: "supported",
      current: "1.2.3",
      minimum: "0.0.0",
      latest: "0.0.1",
    });
  });

  it("carries no URL of any kind", () => {
    // The security property, asserted structurally rather than trusted: a
    // policy fetched over the network must never be able to reach a screen
    // with somewhere to send the reader.
    const shown = report("1.2.3", EMBEDDED_FLOOR);
    expect(Object.keys(shown).sort()).toEqual(["current", "latest", "minimum", "state"]);
    expect(JSON.stringify(shown)).not.toMatch(/https?:/);
  });

  it("is supported for a build with no gate at all", () => {
    expect(FLOOR_REPORT("0.0.1").state).toBe("supported");
  });
});

describe("the refresh tells the shell when the answer moves", () => {
  /** A source that answers with one document, as `PolicySource` would. */
  const sourceFor = (policy: ClientPolicy) =>
    ({ resolve: () => Promise.resolve({ policy }) }) as never;

  it("fires once for a change, and not at all for the same answer twice", async () => {
    const gate = await PolicyGate.open({
      version: "1.0.0",
      store: new PolicyStore(policyPath(await root())),
      source: sourceFor({
        revision: 11,
        minimumSupported: [5, 0, 0],
        recommended: [5, 1, 0],
        latest: [5, 2, 0],
        minimumSupportedBuild: 0,
      }),
    });
    const seen: string[] = [];
    gate.listen((r) => seen.push(r.state));

    expect(gate.blocked).toBe(false);
    await gate.refresh();
    // This is the gap the push closes: without it, a floor published now took
    // effect on the NEXT start.
    expect(gate.blocked).toBe(true);
    expect(seen).toEqual(["blocked"]);

    // A second refresh with the same answer is not news. A shell that
    // re-rendered on every poll would flicker for nothing.
    await gate.refresh();
    expect(seen).toEqual(["blocked"]);
  });

  it("is not stopped by a listener that throws", async () => {
    // A shell that cannot take the news is not the gate's problem, and must not
    // turn a refresh into a failed refresh.
    const gate = await PolicyGate.open({
      version: "1.0.0",
      store: new PolicyStore(policyPath(await root())),
      source: sourceFor({
        revision: 11,
        minimumSupported: [5, 0, 0],
        recommended: [5, 1, 0],
        latest: [5, 2, 0],
        minimumSupportedBuild: 0,
      }),
    });
    gate.listen(() => {
      throw new Error("the page is gone");
    });
    const after: string[] = [];
    gate.listen((r) => after.push(r.state));
    await expect(gate.refresh()).resolves.toBeUndefined();
    // The one that threw did not stop the one after it.
    expect(after).toEqual(["blocked"]);
    expect(gate.blocked).toBe(true);
  });

  it("stops calling a listener that unsubscribed", async () => {
    const gate = await PolicyGate.open({
      version: "1.0.0",
      store: new PolicyStore(policyPath(await root())),
      source: sourceFor({
        revision: 11,
        minimumSupported: [5, 0, 0],
        recommended: [5, 1, 0],
        latest: [5, 2, 0],
        minimumSupportedBuild: 0,
      }),
    });
    const seen: string[] = [];
    const stop = gate.listen((r) => seen.push(r.state));
    stop();
    await gate.refresh();
    expect(seen).toEqual([]);
  });
});

describe("the background refresh", () => {
  it("does nothing, and throws nothing, when there is no source", async () => {
    const gate = await PolicyGate.open({
      version: "0.0.1",
      store: new PolicyStore(policyPath(await root())),
    });
    await expect(gate.refresh()).resolves.toBeUndefined();
    expect(gate.blocked).toBe(false);
  });

  it("swallows a source that rejects", async () => {
    // Its only job is to leave a better cache behind. It cannot make the
    // session worse, including by throwing into whatever did not await it.
    const angry = { resolve: () => Promise.reject(new Error("no")) } as never;
    const gate = await PolicyGate.open({
      version: "0.0.1",
      store: new PolicyStore(policyPath(await root())),
      source: angry,
    });
    await expect(gate.refresh()).resolves.toBeUndefined();
    expect(gate.blocked).toBe(false);
  });
});
