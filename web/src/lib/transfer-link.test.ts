import { describe, it, expect } from "vitest";
import { wsURL, parseCodeParam } from "./transfer-link";

describe("wsURL", () => {
  const loc = { protocol: "https:", host: "relayium.com" };
  it("uses ?code= when a code is given", () => {
    expect(wsURL(loc, "424242")).toBe("wss://relayium.com/ws?code=424242");
  });
  it("is the LAN socket without a code, ws on http", () => {
    expect(wsURL(loc, "")).toBe("wss://relayium.com/ws");
    expect(wsURL({ protocol: "http:", host: "localhost:8080" }, "")).toBe("ws://localhost:8080/ws");
  });
});

describe("parseCodeParam", () => {
  it("extracts a 6-digit code, leading zeros allowed", () => {
    expect(parseCodeParam("#c=424242")).toBe("424242");
    expect(parseCodeParam("#c=042424")).toBe("042424");
  });
  it("rejects non-6-digit or malformed fragments", () => {
    expect(parseCodeParam("#c=12345")).toBe("");
    expect(parseCodeParam("#c=1234567")).toBe("");
    expect(parseCodeParam("#c=abcdef")).toBe("");
    expect(parseCodeParam("#t=abc")).toBe("");
    expect(parseCodeParam("")).toBe("");
  });
});
