// The client-policy model, and one adversarial case per invariant.
//
// This decides whether a person's app opens, so every case here is written as
// an attack on the property rather than a demonstration of it: what does a
// hostile, rolled-back, oversized or malformed document make this build do?
//
// The invariants are numbered at the head of `client-policy.ts`. Each `it`
// names the one it defends.
import { describe, expect, it } from "vitest";
import {
  decodePolicy,
  supportState,
  thisBuild,
  EMBEDDED_FLOOR,
  MAX_POLICY_BUILD,
  MAX_POLICY_BYTES,
  MAX_POLICY_REVISION,
  POLICY_SCHEMA,
  PolicyError,
  type ClientPolicy,
} from "../../src/main/policy/client-policy.js";

/**
 * A well-formed served document, which each case then damages.
 *
 * `schema` is spread from a caller-supplied object rather than taken as a
 * defaulted parameter: a default turns `schema: undefined` — an ABSENT field,
 * and a real case — back into the valid value, and the assertion then passes
 * for the wrong reason. It did, until this comment existed.
 */
const served = (
  over: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
): unknown => ({
  schema: POLICY_SCHEMA,
  ...top,
  windows: {
    policyRevision: 5,
    minimumSupportedVersion: "1.2.0",
    recommendedVersion: "1.3.0",
    latestVersion: "1.4.0",
    minimumSupportedBuild: 20,
    ...over,
  },
});

const build = (version: string, buildNumber: number, provisioned = true) => ({
  version,
  build: buildNumber,
  buildProvisioned: provisioned,
});

describe("invariant 1 — fail open", () => {
  it("never blocks the build that carries the embedded floor", () => {
    // The floor's whole safety property. If this ever fails, shipping the
    // binary bricks it with no server involved at all.
    expect(supportState(thisBuild("0.0.1"), EMBEDDED_FLOOR)).not.toBe("blocked");
  });

  it("does not block when this build's own version is unreadable", () => {
    // A packaging fault is ours, not the user's. Refusing to run would turn it
    // into a brick, so fail open runs in both directions.
    const strict: ClientPolicy = { ...EMBEDDED_FLOOR, minimumSupported: [9, 0, 0], revision: 2 };
    expect(supportState(build("not-a-version", 1), strict)).toBe("supported");
  });
});

describe("invariant 2 — a served document may only make it stricter", () => {
  // The floor is injected so this rule can be attacked. Against the SHIPPED
  // floor (`0.0.0`, build `0`) no document can be weaker, because that is
  // already the weakest a validated document can express — which is a property
  // worth stating and a useless thing to test.
  const raised: ClientPolicy = {
    ...EMBEDDED_FLOOR,
    minimumSupported: [2, 0, 0],
    minimumSupportedBuild: 30,
  };

  it("refuses a document that lowers the version requirement", () => {
    // A rolled-back copy of an older policy, perfectly valid in itself, would
    // otherwise unblock a client this build already knows must stop.
    expect(() => decodePolicy(served({ minimumSupportedVersion: "1.9.9" }), 1, raised)).toThrow(
      new PolicyError("weaker-than-floor"),
    );
  });

  it("refuses a document that lowers only the BUILD requirement", () => {
    // Both vocabularies, because a document that lowered one of them lowered
    // the policy.
    expect(
      () =>
        decodePolicy(served({ minimumSupportedVersion: "2.0.0", minimumSupportedBuild: 29 }), 1, raised),
    ).toThrow(new PolicyError("weaker-than-floor"));
  });

  it("accepts a document that meets the raised floor exactly", () => {
    const policy = decodePolicy(
      served({ minimumSupportedVersion: "2.0.0", recommendedVersion: "2.0.0", latestVersion: "2.0.0", minimumSupportedBuild: 30 }),
      1,
      raised,
    );
    expect(policy.minimumSupportedBuild).toBe(30);
  });

  it("accepts a document that raises the bar", () => {
    const policy = decodePolicy(served(), 1);
    expect(policy.minimumSupported).toEqual([1, 2, 0]);
    expect(policy.minimumSupportedBuild).toBe(20);
  });
});

describe("invariant 3 — replay barrier", () => {
  it("refuses a valid, correctly served, OLDER document", () => {
    // The attack this exists for: a client already told 1.3.0 is handed a
    // genuine copy of the older policy and would unblock itself.
    expect(() => decodePolicy(served({ policyRevision: 4 }), 9)).toThrow(
      new PolicyError("replayed-revision"),
    );
  });

  it("accepts the same revision it already holds", () => {
    // Not below, so not a replay: a re-fetch of the current policy is ordinary.
    expect(decodePolicy(served({ policyRevision: 5 }), 5).revision).toBe(5);
  });
});

describe("invariant 4 — bounded revision", () => {
  it("refuses a revision above the ceiling", () => {
    // Accepting this once would REMEMBER it, and every genuine policy after it
    // — including the emergency one — would then read as a replay, for the life
    // of the install.
    expect(() => decodePolicy(served({ policyRevision: MAX_POLICY_REVISION + 1 }), 1)).toThrow(
      new PolicyError("bad-revision"),
    );
    expect(() => decodePolicy(served({ policyRevision: Number.MAX_SAFE_INTEGER }), 1)).toThrow(
      PolicyError,
    );
  });

  it("refuses a revision that is not a whole positive number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(() => decodePolicy(served({ policyRevision: bad }), 1), JSON.stringify(bad)).toThrow(
        PolicyError,
      );
    }
  });
});

describe("invariant 5 — the schema is exact", () => {
  it("refuses a schema this build does not know", () => {
    for (const bad of [2, 0, "1", null]) {
      expect(() => decodePolicy(served({}, { schema: bad }), 1), JSON.stringify(bad)).toThrow(
        new PolicyError("wrong-schema"),
      );
    }
    // Absent, which is not the same as wrong and must be refused too.
    expect(() => decodePolicy({ windows: { policyRevision: 5 } }, 1)).toThrow(
      new PolicyError("wrong-schema"),
    );
  });

  it("refuses a document with no windows section rather than reading macos'", () => {
    expect(() => decodePolicy({ schema: 1, macos: { policyRevision: 9 } }, 1)).toThrow(
      new PolicyError("missing-platform"),
    );
  });
});

describe("invariant 6 — nothing in the document can name a URL", () => {
  it("drops every field it was not asked for", () => {
    const hostile = served({
      updateUrl: "https://evil.example/installer.exe",
      feedUrl: "https://evil.example/updates.json",
      message: "<script>alert(1)</script>",
    });
    const policy = decodePolicy(hostile, 1);
    // Structural, not a spot check: the decoded object has exactly five keys.
    expect(Object.keys(policy).sort()).toEqual([
      "latest",
      "minimumSupported",
      "minimumSupportedBuild",
      "recommended",
      "revision",
    ]);
    expect(JSON.stringify(policy)).not.toContain("evil.example");
    expect(JSON.stringify(policy)).not.toContain("script");
  });
});

describe("invariant 7 — a placeholder build number cannot block", () => {
  it("does not block an unprovisioned build against a real build floor", () => {
    // `BUILD_NUMBER` is 0 until a release sets it. Comparing that placeholder
    // against a served floor of 20 would have every unreleased build block
    // itself, with no server error and nothing to see.
    const policy = decodePolicy(served(), 1);
    expect(supportState(build("9.9.9", 0, false), policy)).toBe("supported");
  });

  it("does block a PROVISIONED build below the floor", () => {
    // The other half: the flag must not disable the check for real releases.
    const policy = decodePolicy(served(), 1);
    expect(supportState(build("9.9.9", 19, true), policy)).toBe("blocked");
  });
});

describe("invariant 8 — whole or nothing", () => {
  it("refuses the document when any one version is unreadable", () => {
    for (const field of ["minimumSupportedVersion", "recommendedVersion", "latestVersion"]) {
      for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.02.3", "1.2.3-beta", "", 5, null]) {
        expect(() => decodePolicy(served({ [field]: bad }), 1), `${field}=${String(bad)}`).toThrow(
          PolicyError,
        );
      }
    }
  });

  it("refuses a build that is not a whole non-negative number", () => {
    for (const bad of [-1, 1.5, "20", null, Number.NaN]) {
      expect(() =>
        decodePolicy(served({ minimumSupportedBuild: bad }), 1),
        JSON.stringify(bad),
      ).toThrow(PolicyError);
    }
  });
});

describe("invariant 10 — a coherent document, or none", () => {
  it("refuses a document whose latest is below its own minimum", () => {
    // The screen would otherwise tell somebody to update to a version that is
    // itself blocked — an instruction that cannot be followed.
    expect(() => decodePolicy(served({ latestVersion: "1.0.0" }), 1)).toThrow(
      new PolicyError("incoherent"),
    );
  });

  it("refuses a recommended below the minimum", () => {
    expect(() => decodePolicy(served({ recommendedVersion: "1.1.0" }), 1)).toThrow(
      new PolicyError("incoherent"),
    );
  });

  it("accepts all three being the same version", () => {
    const flat = served({
      minimumSupportedVersion: "2.0.0",
      recommendedVersion: "2.0.0",
      latestVersion: "2.0.0",
    });
    expect(decodePolicy(flat, 1).latest).toEqual([2, 0, 0]);
  });
});

describe("the constants are the ones the design requires", () => {
  it("bounds the document, the revision and the build floor", () => {
    // On the record, and not dead: each exists because an unbounded version of
    // it is a way to hurt a client. `MAX_POLICY_BYTES` is read by the fetch
    // that comes next.
    expect(MAX_POLICY_BYTES).toBe(8 * 1024);
    expect(MAX_POLICY_REVISION).toBe(1_000_000_000);
    expect(MAX_POLICY_BUILD).toBe(1_000_000_000);
    expect(POLICY_SCHEMA).toBe(1);
  });

  it("ships a floor that blocks nothing", () => {
    // The inert-by-default property, asserted rather than assumed. If a future
    // edit raises this, that edit is a decision (OA-033) and this test is where
    // it has to be made deliberately.
    expect(EMBEDDED_FLOOR.minimumSupported).toEqual([0, 0, 0]);
    expect(EMBEDDED_FLOOR.minimumSupportedBuild).toBe(0);
  });

  it("refuses a build floor above the bound", () => {
    expect(() => decodePolicy(served({ minimumSupportedBuild: MAX_POLICY_BUILD + 1 }), 1)).toThrow(
      new PolicyError("bad-build"),
    );
  });
});

describe("invariant 9 — either vocabulary can block", () => {
  const policy = () => decodePolicy(served(), 1);

  it("blocks on the version alone", () => {
    expect(supportState(build("1.1.9", 999), policy())).toBe("blocked");
  });

  it("blocks on the build alone", () => {
    // Version is fine, build is not. A release that got one of the two right
    // and the other wrong still stops.
    expect(supportState(build("1.4.0", 19), policy())).toBe("blocked");
  });

  it("recommends between the two floors, and blocks neither", () => {
    expect(supportState(build("1.2.5", 25), policy())).toBe("recommended");
  });

  it("says supported at or above the recommended version", () => {
    expect(supportState(build("1.3.0", 25), policy())).toBe("supported");
    expect(supportState(build("2.0.0", 999), policy())).toBe("supported");
  });
});
