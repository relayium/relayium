import { describe, it, expect, afterEach, vi } from "vitest";
import { wsURL, parseCodeParam, pairPreflight, createPair, PAIR_TRAFFIC_SPENT } from "./transfer-link";

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

// ── the pre-mint admission preflight (B3) ───────────────────────────────────
//
// The choose screen asks the SERVER whether this account may mint at all, rather
// than doing arithmetic over /api/me/usage. A client-side "used >= cap" is a
// second implementation of the mid-month proration rule the server applies
// (monthlyTrafficCap), and a second implementation is a disagreement waiting to
// happen — on the one screen whose whole job is to tell the truth about it.
//
// Every one of these is a FAIL-OPEN case except the explicit blocked answer.
// A preflight that could not be read must never be the reason a user cannot
// start a transfer: the POST is the authoritative gate and it re-asks.
describe("pairPreflight", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const respond = (body: unknown, status = 200) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: status >= 200 && status < 300, status, json: async () => body,
    })) as unknown as typeof fetch);

  it("reports the server's blocked answer with its machine-readable reason", async () => {
    respond({ allowed: false, reason: PAIR_TRAFFIC_SPENT });
    expect(await pairPreflight()).toEqual({ allowed: false, reason: PAIR_TRAFFIC_SPENT });
  });

  it("reports allowed when the account has allowance left", async () => {
    respond({ allowed: true });
    expect(await pairPreflight()).toEqual({ allowed: true, reason: "" });
  });

  it("fails open when the request never reaches the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
    expect(await pairPreflight()).toEqual({ allowed: true, reason: "" });
  });

  it("fails open on a server error", async () => {
    respond({}, 500);
    expect(await pairPreflight()).toEqual({ allowed: true, reason: "" });
  });

  // Backward compatibility, both ways round: a server that predates this
  // endpoint answers 404, and a new client must read that as "no opinion"
  // rather than as a block.
  it("fails open against a server that has no preflight endpoint", async () => {
    respond("not found", 404);
    expect(await pairPreflight()).toEqual({ allowed: true, reason: "" });
  });

  it("fails open on a body it cannot parse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError("html"); },
    })) as unknown as typeof fetch);
    expect(await pairPreflight()).toEqual({ allowed: true, reason: "" });
  });
});

// The authoritative refusal, as the client sees it. A 429 from /api/pair is two
// different things — the per-IP limiter ("slow down") and this account's spent
// allowance — and they lead to different screens, so the machine-readable code
// in the body is what tells them apart.
describe("createPair on a refusal", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("carries the refusal reason off the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 429, json: async () => ({ error: PAIR_TRAFFIC_SPENT }),
    })) as unknown as typeof fetch);
    await expect(createPair()).rejects.toMatchObject({
      status: 429, reason: PAIR_TRAFFIC_SPENT,
    });
  });

  it("leaves the reason empty for a refusal that carries no code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 429, json: async () => { throw new SyntaxError("text/plain"); },
    })) as unknown as typeof fetch);
    await expect(createPair()).rejects.toMatchObject({ status: 429, reason: "" });
  });
});
