// The stored-link grammar, and what it refuses.
//
// A link starts an unauthenticated download that writes to the user's disk, so
// the accepted set is the documented one and everything else is refused rather
// than repaired. These cases are the grammar written out: each rejection below
// is a string the product does not generate.
import { describe, expect, it } from "vitest";

import { parseStoredLink, trustedLinkHosts } from "../../src/main/stored/link.js";

const KEY = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU"; // the frozen vectors' key
const ID = "abc123";

describe("accepted shapes", () => {
  it("accepts the custom scheme", () => {
    const result = parseStoredLink(`relayium://d/${ID}#k=${KEY}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.id).toBe(ID);
    expect(result.link.key).toBe(KEY);
  });

  it("accepts the https form on the production host", () => {
    const result = parseStoredLink(`https://relayium.com/d/${ID}#k=${KEY}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.id).toBe(ID);
  });

  it("accepts the `download` route head both parsers recognise", () => {
    expect(parseStoredLink(`https://relayium.com/download/${ID}#k=${KEY}`).ok).toBe(true);
    expect(parseStoredLink(`relayium://download/${ID}#k=${KEY}`).ok).toBe(true);
  });

  it("preserves the id's case and never unescapes it", () => {
    const mixed = "AbC-_123";
    const result = parseStoredLink(`https://relayium.com/d/${mixed}#k=${KEY}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.id).toBe(mixed);
  });

  it("treats a trailing slash as the same link", () => {
    // Not a tolerance for unknown segments: an EMPTY path segment carries no
    // information, and a user who pasted `…/d/<id>/` named the same object.
    // A non-empty extra segment is still refused (see below).
    const result = parseStoredLink(`https://relayium.com/d/${ID}/#k=${KEY}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.id).toBe(ID);
  });

  it("includes production in the trusted hosts", () => {
    expect(trustedLinkHosts()).toContain("relayium.com");
  });

  it("accepts an https link on an explicitly trusted host only", () => {
    expect(parseStoredLink(`https://localhost/d/${ID}#k=${KEY}`, ["localhost"]).ok).toBe(true);
    expect(parseStoredLink(`https://localhost/d/${ID}#k=${KEY}`, ["relayium.com"]).ok).toBe(false);
  });
});

describe("the key never leaks by accident", () => {
  it("is not enumerable, so an object dump cannot spill it", () => {
    const result = parseStoredLink(`relayium://d/${ID}#k=${KEY}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(Object.keys(result.link)).toEqual(["id"]);
    // Still reachable by name — this is a logging defence, not encapsulation.
    expect(result.link.key).toBe(KEY);
  });
});

describe("refusals", () => {
  const cases: readonly (readonly [string, string])[] = [
    // Another origin, with or without a plausible path.
    [`https://evil.example/d/${ID}#k=${KEY}`, "untrusted-origin"],
    [`https://relayium.com.evil.example/d/${ID}#k=${KEY}`, "untrusted-origin"],
    // Credentials and ports.
    [`https://user:pass@relayium.com/d/${ID}#k=${KEY}`, "untrusted-origin"],
    [`https://relayium.com:8443/d/${ID}#k=${KEY}`, "untrusted-origin"],
    [`relayium://d:1234/${ID}#k=${KEY}`, "untrusted-origin"],
    // Not a stored link.
    [`https://relayium.com/cross-network#c=004291`, "not-a-stored-link"],
    [`https://relayium.com/d/${ID}?utm=1#k=${KEY}`, "not-a-stored-link"],
    [`https://relayium.com/d/extra/${ID}#k=${KEY}`, "not-a-stored-link"],
    [`https://relayium.com/d/#k=${KEY}`, "not-a-stored-link"],
    // Ids the server never issues, and the percent-encoding this never decodes.
    [`https://relayium.com/d/abc%20123#k=${KEY}`, "invalid-id"],
    [`https://relayium.com/d/${"a".repeat(129)}#k=${KEY}`, "invalid-id"],
    [`https://relayium.com/d/a.b#k=${KEY}`, "invalid-id"],
    // No key, or one outside the fragment alphabet.
    [`https://relayium.com/d/${ID}`, "missing-key"],
    [`https://relayium.com/d/${ID}#`, "missing-key"],
    [`https://relayium.com/d/${ID}#k=`, "missing-key"],
    [`https://relayium.com/d/${ID}#k=VV+VV`, "missing-key"],
    [`https://relayium.com/d/${ID}#key=${KEY}`, "missing-key"],
    // Not a link at all.
    ["", "malformed"],
    ["relayium://", "not-a-stored-link"],
    ["http://relayium.com/d/abc#k=VVV", "not-a-relayium-link"],
    ["file:///c:/windows/system32#k=VVV", "not-a-relayium-link"],
    ["javascript:alert(1)", "not-a-relayium-link"],
    [`https://relayium.com/d/${ID}#k=${"V".repeat(2100)}`, "too-long"],
  ];

  for (const [link, reason] of cases) {
    it(`refuses ${JSON.stringify(link.slice(0, 60))} as ${reason}`, () => {
      const result = parseStoredLink(link);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(reason);
    });
  }

  it("never echoes the input in a refusal", () => {
    const result = parseStoredLink(`https://evil.example/d/secret-id#k=${KEY}`);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-id");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("never throws, whatever it is handed", () => {
    for (const input of ["", "\u0000", "relayium://d/\u202e#k=V", "https://", "%%%"]) {
      expect(() => parseStoredLink(input)).not.toThrow();
    }
    // Callers are event handlers; a throw there is an unhandled rejection.
    expect(() => parseStoredLink(undefined as unknown as string)).not.toThrow();
  });
});
