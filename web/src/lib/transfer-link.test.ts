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
  it("extracts a well-formed pairing code", () => {
    expect(parseCodeParam("#c=K7M3X9")).toBe("K7M3X9");
    expect(parseCodeParam("#c=424242")).toBe("424242"); // all-digit codes are still legal
  });
  it("rejects anything that is not a valid code — the link is untrusted input", () => {
    expect(parseCodeParam("#c=K7M3X")).toBe("");     // 短一位
    expect(parseCodeParam("#c=K7M3X92")).toBe("");   // 长一位
    expect(parseCodeParam("#c=042424")).toBe("");    // 0/1 不在字母表里
    expect(parseCodeParam("#c=k7m3x9")).toBe("");    // 小写
    expect(parseCodeParam("#c=K7M3XB")).toBe("");    // B 被剔（和 8 混）
    expect(parseCodeParam("#t=abc")).toBe("");
    expect(parseCodeParam("")).toBe("");
  });
});
