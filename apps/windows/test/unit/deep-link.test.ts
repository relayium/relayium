import { describe, expect, it } from "vitest";
import { parseDeepLink, routeFromArgv } from "../../src/main/deep-link.js";

const ok = (raw: string) => {
  const r = parseDeepLink(raw);
  if (!r.ok) throw new Error(`expected a route, got ${r.reason}`);
  return r.route;
};
const why = (raw: string) => {
  const r = parseDeepLink(raw);
  return r.ok ? "unexpectedly-ok" : r.reason;
};

/**
 * The links the released macOS app actually generates.
 *
 * `AppDeepLink.swift`'s pairing URL is
 * `https://relayium.com/cross-network?mode=text#c=004291` — code in the
 * FRAGMENT, mode in the QUERY. An earlier version of this parser looked for the
 * code as a path segment, so every real link parsed as "no code" and would have
 * opened an empty pairing screen.
 */
describe("real generated links", () => {
  it("parses code from the fragment and mode from the query", () => {
    expect(ok("https://relayium.com/cross-network?mode=text#c=004291")).toEqual({
      kind: "realtime-with-mode", code: "004291", mode: "text",
    });
    expect(ok("https://relayium.com/cross-network?mode=file#c=123456")).toEqual({
      kind: "realtime-with-mode", code: "123456", mode: "files",
    });
  });

  it("PRESERVES leading zeros — the code is a string, not a number", () => {
    // `004291` parsed as a number is 4291, a different code that joins nothing.
    const route = ok("https://relayium.com/cross-network#c=004291");
    expect(route).toEqual({ kind: "realtime", code: "004291" });
    expect("code" in route && route.code).not.toBe(4291 as unknown as string);
  });

  it("accepts a bare route with no code", () => {
    expect(ok("https://relayium.com/cross-network")).toEqual({ kind: "realtime", code: null });
  });

  it("accepts the custom scheme by canonical conversion, not host-as-route", () => {
    expect(ok("relayium://cross-network?mode=text#c=000001")).toEqual({
      kind: "realtime-with-mode", code: "000001", mode: "text",
    });
    // An arbitrary host is a route name only if it IS the route.
    expect(why("relayium://evil.example?mode=text#c=000001")).toBe("unknown-route");
  });
});

describe("the code must be exactly six digits", () => {
  it("refuses other lengths and non-digits", () => {
    for (const code of ["12345", "1234567", "ABCDEF", "12 456", "", "-12345"]) {
      expect(why(`https://relayium.com/cross-network#c=${code}`), code).toBe("malformed");
    }
  });

  it("refuses a fragment that is not a single c= item", () => {
    expect(why("https://relayium.com/cross-network#c=004291&c=111111")).toBe("malformed");
    expect(why("https://relayium.com/cross-network#x=004291")).toBe("malformed");
    expect(why("https://relayium.com/cross-network#004291")).toBe("malformed");
  });
});

describe("route and mode grammar", () => {
  it("refuses extra path segments", () => {
    expect(why("https://relayium.com/cross-network/extra#c=004291")).toBe("unknown-route");
  });

  it("refuses an unknown mode rather than ignoring it", () => {
    expect(why("https://relayium.com/cross-network?mode=video#c=004291")).toBe("unknown-route");
  });

  it("refuses a mode with no code", () => {
    expect(why("https://relayium.com/cross-network?mode=text")).toBe("malformed");
  });

  it("still recognises and refuses stored links", () => {
    expect(why("https://relayium.com/d/abc")).toBe("not-yet-supported");
    expect(why("relayium://download/abc")).toBe("not-yet-supported");
  });
});

describe("origin policy on BOTH schemes", () => {
  it("refuses a non-production https host", () => {
    expect(why("https://relayium.com.evil.test/cross-network#c=004291")).toBe("untrusted-origin");
  });

  it("refuses credentials and ports, custom scheme included", () => {
    expect(why("https://u:p@relayium.com/cross-network#c=004291")).toBe("untrusted-origin");
    expect(why("https://relayium.com:8443/cross-network#c=004291")).toBe("untrusted-origin");
    expect(why("relayium://u:p@cross-network#c=004291")).toBe("untrusted-origin");
    expect(why("relayium://cross-network:99#c=004291")).toBe("untrusted-origin");
  });

  it("refuses other schemes outright", () => {
    for (const raw of ["http://relayium.com/cross-network#c=004291", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(why(raw)).toBe("not-a-relayium-link");
    }
  });
});

describe("total, and bounded", () => {
  it("never throws", () => {
    for (const raw of ["", "   ", "::::", "relayium://", "\u0000", "%%%%"]) {
      expect(() => parseDeepLink(raw)).not.toThrow();
    }
  });

  it("bounds the input before parsing", () => {
    expect(why(`https://relayium.com/cross-network#c=${"1".repeat(4000)}`)).toBe("too-long");
  });
});

describe("argv scanning", () => {
  it("finds a real link wherever it sits", () => {
    const r = routeFromArgv(["C:\\app\\Relayium.exe", "--flag", "relayium://cross-network#c=004291"]);
    expect(r.ok && r.route).toEqual({ kind: "realtime", code: "004291" });
  });

  it("reports the most specific rejection", () => {
    expect(routeFromArgv(["Relayium.exe", "relayium://download/x"])).toEqual({
      ok: false, reason: "not-yet-supported",
    });
  });

  it("is safe on an argv with no link", () => {
    expect(routeFromArgv(["Relayium.exe", "--updated"])).toEqual({
      ok: false, reason: "not-a-relayium-link",
    });
  });
});
