import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isTrustedSender, expectChunk, expectIndex, expectObject, expectString } from "../../src/main/ipc.js";
import { isAppBundleURL } from "../../src/main/window.js";
import { IPC_CHANNELS } from "../../src/shared/ipc-contract.js";

const SCHEME = "app";
const HOST = "relayium";
const OK = `${SCHEME}://${HOST}/index.html`;

describe("isAppBundleURL", () => {
  it("accepts the app's own bundle", () => {
    expect(isAppBundleURL(OK, SCHEME, HOST)).toBe(true);
    expect(isAppBundleURL(`${SCHEME}://${HOST}/`, SCHEME, HOST)).toBe(true);
  });

  // The whole reason this function does not compare `URL.origin`: `app:` is a
  // non-special scheme, so its origin is the opaque string "null" — and so is
  // `file:`'s and `data:`'s. An origin comparison accepts all three as equal.
  it("refuses the other URLs whose origin is also the opaque string", () => {
    for (const raw of [
      "file:///C:/Users/lily/evil.html",
      "data:text/html,<script>fetch('x')</script>",
      "other://relayium/index.html",
      "relayium://relayium/index.html",
    ]) {
      expect(new URL(raw).origin).toBe("null");
      expect(isAppBundleURL(raw, SCHEME, HOST)).toBe(false);
    }
  });

  it("refuses a different host, a port, and embedded credentials", () => {
    expect(isAppBundleURL(`${SCHEME}://evil/index.html`, SCHEME, HOST)).toBe(false);
    expect(isAppBundleURL(`${SCHEME}://${HOST}:1234/index.html`, SCHEME, HOST)).toBe(false);
    expect(isAppBundleURL(`${SCHEME}://user:pw@${HOST}/index.html`, SCHEME, HOST)).toBe(false);
  });

  it("refuses https, which is a real origin but not this bundle", () => {
    expect(isAppBundleURL("https://relayium.com/index.html", SCHEME, HOST)).toBe(false);
  });

  it("refuses a value that is not a URL", () => {
    expect(isAppBundleURL("", SCHEME, HOST)).toBe(false);
    expect(isAppBundleURL("index.html", SCHEME, HOST)).toBe(false);
  });
});

describe("isTrustedSender", () => {
  const base = { senderId: 7, expectedId: 7, frameUrl: OK, isMainFrame: true, scheme: SCHEME, host: HOST };

  it("accepts our own window's main frame", () => {
    expect(isTrustedSender(base)).toBe(true);
  });

  it("refuses another WebContents", () => {
    expect(isTrustedSender({ ...base, senderId: 8 })).toBe(false);
  });

  it("refuses before a window has been bound", () => {
    expect(isTrustedSender({ ...base, expectedId: null })).toBe(false);
  });

  // A subframe must not borrow the parent's capabilities.
  it("refuses a subframe", () => {
    expect(isTrustedSender({ ...base, isMainFrame: false })).toBe(false);
  });

  it("refuses a main frame that is not the app bundle", () => {
    for (const frameUrl of ["file:///C:/evil.html", "data:text/html,x", "https://evil.example/"]) {
      expect(isTrustedSender({ ...base, frameUrl })).toBe(false);
    }
  });
});

describe("payload guards", () => {
  it("refuses non-objects, arrays and null", () => {
    for (const value of [null, undefined, 1, "s", [], true]) {
      expect(() => expectObject(value)).toThrow();
    }
    expect(expectObject({ a: 1 })).toEqual({ a: 1 });
  });

  it("bounds strings", () => {
    expect(() => expectString("", 10)).toThrow();
    expect(() => expectString("x".repeat(11), 10)).toThrow();
    expect(() => expectString(5, 10)).toThrow();
    expect(expectString("ok", 10)).toBe("ok");
  });

  it("requires a non-negative safe integer index", () => {
    for (const value of [-1, 1.5, Number.NaN, "0", Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => expectIndex(value)).toThrow();
    }
    expect(expectIndex(0)).toBe(0);
  });

  // Coercing a string here would allocate on the sender's say-so.
  it("requires real binary data within the ceiling", () => {
    expect(() => expectChunk("aaaa", 10)).toThrow();
    expect(() => expectChunk(new Uint8Array(11), 10)).toThrow();
    expect(expectChunk(new Uint8Array(4), 10)).toHaveLength(4);
  });
});

describe("the preload bridge matches the contract", () => {
  // The preload is the trust boundary and deliberately spells its channels as
  // literals rather than importing them. This is what keeps that duplication
  // honest: a channel added to the contract and not to the bridge, or — far
  // worse — exposed by the bridge and never declared, fails here.
  const preload = readFileSync(
    fileURLToPath(new URL("../../src/preload/preload.cts", import.meta.url)),
    "utf8",
  );
  const exposed = [...preload.matchAll(/invoke\("([^"]+)"\)/g)].map((m) => m[1]!);

  it("exposes exactly the declared channels", () => {
    expect([...exposed].sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("exposes no generic forwarder and no raw Electron surface", () => {
    // A generic `invoke(channel, ...)` would make every present and future
    // channel reachable from any script the renderer runs.
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(preload).not.toMatch(/\bprocess\b\s*[,}]/);
    expect(preload).not.toContain("require(");
  });
});
