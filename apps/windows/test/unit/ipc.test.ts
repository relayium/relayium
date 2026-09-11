import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IpcRouter, isTrustedSender, expectChunk, expectIndex, expectObject, expectString } from "../../src/main/ipc.js";
import { isAppBundleURL } from "../../src/main/window.js";
import { IPC_CHANNELS, IPC_EVENT_NAMES } from "../../src/shared/ipc-contract.js";

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
  const subscribed = [...preload.matchAll(/subscribe\("([^"]+)"\)/g)].map((m) => m[1]!);

  it("exposes exactly the declared channels", () => {
    expect([...exposed].sort()).toEqual([...IPC_CHANNELS].sort());
  });

  // The event direction gets the same treatment as the invoke direction, and
  // for the same reason: a SECOND main-to-renderer message must not be able to
  // arrive without being declared and reviewed. Without this assertion the push
  // direction would be the one capability class with no parity check on it.
  it("subscribes to exactly the declared events", () => {
    expect([...subscribed].sort()).toEqual([...IPC_EVENT_NAMES].sort());
  });

  it("does not expose a generic event subscription", () => {
    // The helper binds ONE literal per exposed subscription. Two ways that
    // could stop being true, and both are what a generic forwarder looks like
    // the moment before it becomes one: `subscribe` applied to something other
    // than a string literal, or `subscribe` handed to the renderer uncurried so
    // the renderer picks the channel itself.
    expect(preload).not.toMatch(/\bsubscribe\((?!")/);
    expect(preload).not.toMatch(/:\s*subscribe\s*[,}]/);
  });

  it("exposes no generic forwarder and no raw Electron surface", () => {
    // A generic `invoke(channel, ...)` would make every present and future
    // channel reachable from any script the renderer runs.
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(preload).not.toMatch(/\bprocess\b\s*[,}]/);
    expect(preload).not.toContain("require(");
  });
});

// ---------------------------------------------------------------------------
// Document generations
// ---------------------------------------------------------------------------
//
// The id alone stopped being enough once main could hold state on the
// renderer's behalf. A reload keeps the same `WebContents` and the same id, so
// `destroyed` never fires and nothing that hangs off it ever runs — but every
// socket, subscription and lease the previous document asked for is orphaned,
// and the new document never asked for any of them.

/** A `WebContents` a test can drive. Only what `IpcRouter.bind` touches. */
class FakeContents {
  readonly id = 7;
  destroyed = false;
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.listeners.get(event) ?? this.listeners.set(event, []).get(event)!).push(cb);
    return this;
  }

  once(event: string, cb: (...args: unknown[]) => void): this {
    return this.on(event, cb);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error("destroyed");
    this.sent.push({ channel, payload });
  }

  fire(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

function boundRouter() {
  const contents = new FakeContents();
  const router = new IpcRouter("app", "relayium");
  const retired: number[] = [];
  router.bind(contents as never);
  router.onRevoke((generation) => retired.push(generation));
  return { router, contents, retired };
}

describe("a document generation retires what main held for it", () => {
  it("starts at zero and moves on a main-frame navigation", () => {
    const { router, contents, retired } = boundRouter();
    expect(router.generation).toBe(0);

    contents.fire("did-start-navigation", { isMainFrame: true });

    expect(retired).toEqual([0]);
    expect(router.generation).toBe(1);
  });

  it("treats a navigation with no frame information as a main-frame one", () => {
    // Only an explicit `isMainFrame: false` is a subframe. Guessing the other
    // way would keep a retired document's sockets open.
    const { router, contents } = boundRouter();
    contents.fire("did-start-navigation", {});
    expect(router.generation).toBe(1);
  });

  it("does NOT move for a same-document navigation", () => {
    // `isSameDocument` is Electron's own name for a hash change, `pushState` /
    // `replaceState`, and same-page history. The document and everything main
    // holds for it survive untouched, so revoking here would cancel a transfer
    // in progress because the user switched which page of the app they were
    // looking at.
    const { router, contents, retired } = boundRouter();

    contents.fire("did-start-navigation", { isMainFrame: true, isSameDocument: true });

    expect(retired).toEqual([]);
    expect(router.generation).toBe(0);
  });

  it("still moves for a real main-frame navigation that replaces the document", () => {
    const { router, contents } = boundRouter();
    contents.fire("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(router.generation).toBe(1);
  });

  it("does NOT move for a subframe navigation", () => {
    const { router, contents, retired } = boundRouter();
    contents.fire("did-start-navigation", { isMainFrame: false });
    expect(retired).toEqual([]);
    expect(router.generation).toBe(0);
  });

  it("moves when the renderer crashes, which sends no close for anything it held", () => {
    const { router, contents, retired } = boundRouter();
    contents.fire("render-process-gone");
    expect(retired).toEqual([0]);
    expect(router.generation).toBe(1);
  });

  it("moves when the window is destroyed", () => {
    const { router, contents, retired } = boundRouter();
    contents.fire("destroyed");
    expect(retired).toEqual([0]);
    expect(router.generation).toBe(1);
  });

  it("subscribes to nothing a hidden window would fire", () => {
    // Hiding a window navigates nothing and kills nothing, so a hidden window
    // keeps its sockets and its transfers. Asserted as the exact listener set
    // rather than by describing it, because R-RESIDENT depends on it.
    const { contents } = boundRouter();
    expect([...contents.listeners.keys()].sort()).toEqual([
      "destroyed",
      "did-start-navigation",
      "render-process-gone",
    ]);
  });

  it("runs every revocation even when one of them throws", () => {
    const { router, contents } = boundRouter();
    const reached: string[] = [];
    router.onRevoke(() => {
      reached.push("first");
      throw new Error("teardown failed");
    });
    router.onRevoke(() => reached.push("second"));

    contents.fire("render-process-gone");

    // One holder's failed teardown must not strand the others.
    expect(reached).toEqual(["first", "second"]);
  });
});

describe("the push direction refuses what the invoke direction refuses", () => {
  it("refuses to emit an event name the contract does not declare", () => {
    const { router } = boundRouter();
    expect(() => router.emit("relayium:something-else", 0, {})).toThrow(/undeclared/);
  });

  it("emits a declared event to the bound renderer", () => {
    const { router, contents } = boundRouter();
    expect(router.emit(IPC_EVENT_NAMES[0]!, 0, { token: "t", kind: "open" })).toBe(true);
    expect(contents.sent).toEqual([
      { channel: IPC_EVENT_NAMES[0], payload: { token: "t", kind: "open" } },
    ]);
  });

  it("drops an event addressed to a generation that has been retired", () => {
    const { router, contents } = boundRouter();
    contents.fire("did-start-navigation", { isMainFrame: true });
    // Pushing the old document's frames into the new one is a cross-document
    // leak; the frame is dropped rather than delivered to whoever is there now.
    expect(router.emit(IPC_EVENT_NAMES[0]!, 0, { token: "t", kind: "open" })).toBe(false);
    expect(contents.sent).toEqual([]);
  });

  it("drops an event once the WebContents is destroyed", () => {
    const { router, contents } = boundRouter();
    contents.destroyed = true;
    expect(router.emit(IPC_EVENT_NAMES[0]!, 0, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `shell.openPath` reports by RETURN VALUE
// ---------------------------------------------------------------------------
//
// Electron's typings state it explicitly: the promise fulfils with an empty
// string on success and with an error MESSAGE on failure. An adapter that
// awaited it and discarded the result reported every OS refusal as a success,
// and the page showed nothing while the folder never opened.
//
// The adapter under test is the one `handlers.ts` composes. It is exercised
// here as the shape it is — a function over a fake `shell` — because the real
// one needs an Electron main process, and the property that matters is the
// branch on the returned string.

describe("the reveal adapter", () => {
  /** The adapter `handlers.ts` installs, in the same shape. */
  function revealWith(shell: { openPath(path: string): Promise<string> }) {
    return async (directory: string): Promise<void> => {
      const failure = await shell.openPath(directory);
      if (failure.length > 0) {
        throw Object.assign(new Error("reveal was refused"), { code: "internal" });
      }
    };
  }

  it("treats an empty string as the success it is", async () => {
    const opened: string[] = [];
    const reveal = revealWith({
      openPath: async (path) => {
        opened.push(path);
        return "";
      },
    });
    await expect(reveal("C:/chosen")).resolves.toBeUndefined();
    expect(opened).toEqual(["C:/chosen"]);
  });

  it("throws on a non-empty answer, which is what a refusal looks like", async () => {
    const reveal = revealWith({
      openPath: async () => "Failed to open path C:\\Users\\somebody\\Secret Folder",
    });
    await expect(reveal("C:/chosen")).rejects.toMatchObject({ code: "internal" });
  });

  it("does not carry the OS message — or the path in it — into the error", async () => {
    // The returned text is the OS's own and routinely contains the full path,
    // which is the one thing this boundary exists to keep out of a renderer and
    // out of a log. The caller needs to know THAT it failed.
    const secret = "C:\\Users\\somebody\\Tax Returns 2026";
    const reveal = revealWith({ openPath: async () => `Failed to open path ${secret}` });
    const error = await reveal("C:/chosen").catch((err: unknown) => err);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("Users");
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
