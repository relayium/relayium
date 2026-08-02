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
    expect(parseCodeParam("#c=483920")).toBe("483920");
    expect(parseCodeParam("#c=004291")).toBe("004291"); // 前导零不能被吃掉
    expect(parseCodeParam("#c=000000")).toBe("000000"); // 全零是一个普通的码
  });
  it("rejects anything that is not a valid code — the link is untrusted input", () => {
    expect(parseCodeParam("#c=48392")).toBe("");     // 短一位
    expect(parseCodeParam("#c=4839201")).toBe("");   // 长一位
    expect(parseCodeParam("#c=K7M3X9")).toBe("");    // 旧字母表：格式变更之后整个失效
    expect(parseCodeParam("#c=48392a")).toBe("");    // 任何字母
    expect(parseCodeParam("#c=48 392")).toBe("");    // 空格
    expect(parseCodeParam("#c=+48392")).toBe("");    // 数字形状但不是数字字符
    expect(parseCodeParam("#t=abc")).toBe("");
    expect(parseCodeParam("")).toBe("");
  });
});
