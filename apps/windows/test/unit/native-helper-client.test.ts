// Adversarial tests for the native helper client.
//
// ## Two layers, and only one of them proves filesystem behaviour
//
// Everything below the `describe.skipIf` block drives a FAKE helper process: a
// scripted transport that speaks the frame protocol and can be made to
// misbehave in ways a real helper never would. That proves the client — its
// decoder bounds, correlation, deadlines, kill/join, receipt validation. It
// proves NOTHING about Windows filesystem semantics.
//
// The final block needs a real Windows host and the real executable. It is
// SKIPPED elsewhere with an explicit reason rather than silently absent,
// because a green run on macOS must never be read as integration evidence.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DEADLINES,
  NativeHelperClient,
  NativeHelperError,
  bundledHelperPath,
  resolveHelperPath,
  spawnBundledHelper,
  type HelperChild,
  type NativeManifestEntry,
  type NativePublishReport,
} from "../../src/main/io/native-helper-client.js";

// ---------------------------------------------------------------------------
// Fake helper process
// ---------------------------------------------------------------------------

const KIND_REQUEST = 1;
const KIND_CHUNK = 2;
const KIND_RESPONSE = 3;
const KIND_EVENT = 4;

type DataListener = (chunk: Uint8Array) => void;

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength + 1, false);
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const responseFrame = (value: unknown): Uint8Array => frame(KIND_RESPONSE, encode(value));
const readyFrame = (protocol = 1): Uint8Array => frame(KIND_EVENT, encode({ event: "ready", protocol }));

interface SeenRequest {
  readonly kind: number;
  readonly id: number;
  readonly op?: string;
  readonly index?: number;
  readonly body: Record<string, unknown>;
  readonly dataLength?: number;
}

/**
 * A scripted helper.
 *
 * It decodes what the client sends so tests can assert on the actual bytes on
 * the wire, and it emits exactly what the test tells it to — including
 * malformed frames, out-of-order events and a deliberate silence.
 */
class FakeHelper implements HelperChild {
  readonly requests: SeenRequest[] = [];
  readonly written: Uint8Array[] = [];
  stdinEnded = false;
  killed: NodeJS.Signals | undefined | "called" = undefined;
  killCount = 0;
  /** Make kill() report failure, as it does for an unkillable process. */
  killSucceeds = true;
  /** Suppress the automatic close so a test can hold the process open. */
  autoCloseOnKill = true;

  private stdoutListeners: DataListener[] = [];
  private stderrListeners: DataListener[] = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private inbound = new Uint8Array(0);

  /** Called for every decoded host frame; return frames to emit. */
  onRequest: (request: SeenRequest, helper: FakeHelper) => void = () => undefined;

  readonly stdin = {
    write: (chunk: Uint8Array): boolean => {
      this.written.push(chunk.slice());
      this.consume(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  readonly stdout = {
    on: (_event: "data", listener: DataListener): unknown => {
      this.stdoutListeners.push(listener);
      return this;
    },
  };

  readonly stderr = {
    on: (_event: "data", listener: DataListener): unknown => {
      this.stderrListeners.push(listener);
      return this;
    },
  };

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCount += 1;
    this.killed = signal ?? "called";
    if (!this.killSucceeds) return false;
    if (this.autoCloseOnKill) {
      this.exit(137);
      this.close();
    }
    return true;
  }

  // --- driving the fake -----------------------------------------------------

  emit(...frames: Uint8Array[]): void {
    for (const f of frames) for (const listener of this.stdoutListeners) listener(f);
  }

  /** Emit raw bytes, so a test can coalesce or split frames arbitrarily. */
  emitRaw(bytes: Uint8Array): void {
    for (const listener of this.stdoutListeners) listener(bytes);
  }

  emitStderr(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of this.stderrListeners) listener(bytes);
  }

  exit(code: number | null): void {
    for (const listener of this.exitListeners.splice(0)) listener(code, null);
  }

  close(): void {
    for (const listener of this.closeListeners.splice(0)) listener();
  }

  failSpawn(error: Error): void {
    for (const listener of this.errorListeners.splice(0)) listener(error);
  }

  private consume(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.inbound.byteLength + chunk.byteLength);
    merged.set(this.inbound, 0);
    merged.set(chunk, this.inbound.byteLength);
    this.inbound = merged;
    for (;;) {
      if (this.inbound.byteLength < 5) return;
      const view = new DataView(this.inbound.buffer, this.inbound.byteOffset, this.inbound.byteLength);
      const length = view.getUint32(0, false);
      const total = 4 + length;
      if (this.inbound.byteLength < total) return;
      const kind = this.inbound[4] ?? 0;
      const payload = this.inbound.slice(5, total);
      this.inbound = this.inbound.slice(total);

      let seen: SeenRequest;
      if (kind === KIND_CHUNK) {
        const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        seen = {
          kind,
          id: Number(header.getBigUint64(0, false)),
          index: header.getUint32(8, false),
          body: {},
          dataLength: payload.byteLength - 12,
        };
      } else {
        const body = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
        seen = {
          kind,
          id: Number(body["id"]),
          ...(typeof body["op"] === "string" ? { op: body["op"] } : {}),
          body,
        };
      }
      this.requests.push(seen);
      this.onRequest(seen, this);
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MANIFEST: readonly NativeManifestEntry[] = [
  { name: "a.bin", size: 4 },
  { name: "b/c.bin", size: 2 },
];

const FAST = { startupMs: 50, requestMs: 50, publishMs: 50, cancelExitMs: 50, closeAfterExitMs: 20 };

/** A helper that answers open/begin/finish/publish/cancel the way the real one does. */
function cooperative(options: { publish?: unknown; failOpen?: boolean } = {}): FakeHelper {
  const helper = new FakeHelper();
  helper.onRequest = (request, self) => {
    if (request.kind === KIND_CHUNK) {
      const index = request.index ?? 0;
      const declared = MANIFEST[index]?.size ?? 0;
      self.emit(
        responseFrame({
          id: request.id,
          ok: true,
          result: { written: request.dataLength ?? 0, declared },
        }),
      );
      return;
    }
    switch (request.op) {
      case "open":
        if (options.failOpen === true) {
          self.emit(responseFrame({ id: request.id, ok: false, code: "E_MANIFEST" }));
          return;
        }
        self.emit(
          responseFrame({
            id: request.id,
            ok: true,
            result: { files: MANIFEST.length, directories: 1, longPath: false },
          }),
        );
        return;
      case "begin":
        self.emit(responseFrame({ id: request.id, ok: true, result: {} }));
        return;
      case "finish": {
        const index = typeof request.body["index"] === "number" ? request.body["index"] : 0;
        self.emit(
          responseFrame({ id: request.id, ok: true, result: { bytes: MANIFEST[index]?.size ?? 0 } }),
        );
        return;
      }
      case "publish":
        self.emit(
          responseFrame(
            options.publish ?? {
              id: request.id,
              ok: true,
              result: { status: "complete", publishedCount: MANIFEST.length, total: MANIFEST.length },
            },
          ),
        );
        return;
      case "cancel":
        self.emit(
          responseFrame({ id: request.id, ok: true, result: { removedFiles: 1, residue: false } }),
        );
        return;
      default:
        return;
    }
  };
  return helper;
}

/**
 * Answers `open` and then nothing.
 *
 * The decoder tests need a request that is STILL OUTSTANDING when the malformed
 * frame arrives. An earlier version used the cooperative fake, which answers
 * `begin` immediately — so the promise had already resolved, the bad frame met
 * an empty pending slot, and every one of those tests passed while asserting
 * nothing. They were caught by expecting a rejection and receiving `undefined`.
 */
function silentAfterOpen(): FakeHelper {
  const helper = new FakeHelper();
  helper.onRequest = (request, self) => {
    if (request.op === "open") {
      self.emit(
        responseFrame({
          id: request.id,
          ok: true,
          result: { files: MANIFEST.length, directories: 1, longPath: false },
        }),
      );
    }
  };
  return helper;
}

/** Open a client against a fake that announces itself immediately. */
async function openClient(
  helper: FakeHelper,
  deadlines: Partial<typeof DEFAULT_DEADLINES> = FAST,
): Promise<NativeHelperClient> {
  const promise = NativeHelperClient.open({
    authorityId: "auth-1",
    rootPath: "C:\\Users\\someone\\Downloads",
    manifest: MANIFEST,
    spawnHelper: () => helper,
    deadlines,
  });
  helper.emit(readyFrame());
  return promise;
}

/** Publish that resolves after the helper's EOF-driven exit, as the real one does. */
function closeOnEof(helper: FakeHelper, code: number): void {
  const originalEnd = helper.stdin.end;
  (helper.stdin as { end: () => void }).end = (): void => {
    originalEnd.call(helper.stdin);
    // Serve does not exit on publish; it exits on EOF. Exit precedes close.
    helper.exit(code);
    helper.close();
  };
}

// ---------------------------------------------------------------------------
// Process contract
// ---------------------------------------------------------------------------

describe("process contract", () => {
  it("requires a ready event before any request is sent", async () => {
    const helper = cooperative();
    const promise = NativeHelperClient.open({
      authorityId: "auth-1",
      rootPath: "C:\\dest",
      manifest: MANIFEST,
      spawnHelper: () => helper,
      deadlines: FAST,
    });
    // Nothing may be written before the announcement.
    expect(helper.requests).toHaveLength(0);
    helper.emit(readyFrame());
    await promise;
    expect(helper.requests[0]?.op).toBe("open");
  });

  it("rejects a mismatched protocol version and kills the helper", async () => {
    const helper = cooperative();
    const promise = NativeHelperClient.open({
      authorityId: "auth-1",
      rootPath: "C:\\dest",
      manifest: MANIFEST,
      spawnHelper: () => helper,
      deadlines: FAST,
    });
    helper.emit(readyFrame(99));
    await expect(promise).rejects.toBeInstanceOf(NativeHelperError);
    expect(helper.killCount).toBeGreaterThan(0);
  });

  it("times out when the helper never announces itself, and joins the kill", async () => {
    const helper = new FakeHelper();
    await expect(
      NativeHelperClient.open({
        authorityId: "auth-1",
        rootPath: "C:\\dest",
        manifest: MANIFEST,
        spawnHelper: () => helper,
        deadlines: FAST,
      }),
    ).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(helper.killCount).toBeGreaterThan(0);
  });

  it("surfaces a spawn failure rather than hanging", async () => {
    await expect(
      NativeHelperClient.open({
        authorityId: "auth-1",
        rootPath: "C:\\dest",
        manifest: MANIFEST,
        spawnHelper: () => {
          throw new Error("ENOENT");
        },
        deadlines: FAST,
      }),
    ).rejects.toMatchObject({ code: "helper-unavailable" });
  });

  it("refuses an open receipt that disagrees with the manifest length", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 99, directories: 0, longPath: false } }));
      }
      if (request.op === "cancel") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { removedFiles: 0, residue: false } }));
        self.exit(0);
        self.close();
      }
    };
    await expect(openClient(helper)).rejects.toMatchObject({ code: "protocol" });
  });

  it("resolves the packaged and engineering layouts explicitly", async () => {
    const { resolve } = await import("node:path");
    const resources = resolve("/opt/app/resources");
    const moduleDir = resolve("/opt/app/dist/main/io");

    // Packaged: beside the app's resources.
    expect(resolveHelperPath({ unpackaged: false, resourcesPath: resources, moduleDir })).toBe(
      resolve(resources, "relayium-io-helper.exe"),
    );
    // Engineering: a FIXED climb to the app root, then the Go build output.
    // `dist/main/io` and `src/main/io` sit at the same depth, so one constant
    // serves the compiled and the source layouts alike.
    expect(resolveHelperPath({ unpackaged: true, resourcesPath: resources, moduleDir })).toBe(
      resolve("/opt/app/native/build/relayium-io-helper.exe"),
    );
    expect(
      resolveHelperPath({
        unpackaged: true,
        resourcesPath: null,
        moduleDir: resolve("/opt/app/src/main/io"),
      }),
    ).toBe(resolve("/opt/app/native/build/relayium-io-helper.exe"));
  });

  it("refuses a packaged layout with no resourcesPath instead of guessing", () => {
    // The previous version used resourcesPath whenever it was DEFINED — which
    // it also is in an unpackaged Electron run — and otherwise fell back to
    // process.cwd(), which gates nothing. Neither branch could be tested.
    expect(() =>
      resolveHelperPath({ unpackaged: false, resourcesPath: null, moduleDir: "/opt/app/dist/main/io" }),
    ).toThrowError(NativeHelperError);
  });

  it("refuses a relative resolution rather than spawning it hopefully", () => {
    expect(() =>
      resolveHelperPath({ unpackaged: true, resourcesPath: null, moduleDir: "relative/dist/main/io" }),
    ).toThrowError(NativeHelperError);
  });

  it("has a production factory usable with no injected transport", () => {
    // The default is the real spawn, so production needs no seam. Asserted on
    // the option being optional and the factory being exported and callable —
    // NOT by spawning, which would need the built executable.
    expect(typeof spawnBundledHelper).toBe("function");
    expect(bundledHelperPath.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// One in flight, and cancel's exemption from it
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("refuses a second ordinary operation without writing a frame", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
      }
      // begin is deliberately never answered.
    };
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const first = client.begin(0);
    const sentBefore = helper.requests.length;
    await expect(client.begin(1)).rejects.toMatchObject({ code: "busy" });
    expect(helper.requests.length).toBe(sentBefore);
    void first.catch(() => undefined);
    helper.exit(0);
    helper.close();
  });

  it("lets cancel through while an ordinary request is outstanding", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "cancel") {
        // Answered, and only then does the process go away.
        self.emit(responseFrame({ id: request.id, ok: true, result: { removedFiles: 1, residue: false } }));
        self.exit(0);
        self.close();
      }
      // begin is never answered, so it is still pending when cancel arrives.
    };
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0);
    // The critical assertion: cancel is out of band and must NOT be `busy`.
    await expect(client.cancel()).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(helper.requests.some((r) => r.op === "cancel")).toBe(true);
  });

  it("settles an outstanding request from a late reply rather than calling it an unknown id", async () => {
    const helper = new FakeHelper();
    let beginId = 0;
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "begin") {
        beginId = request.id;
        return;
      }
      if (request.op === "cancel") {
        // The helper refuses the queued operation, exactly as the corrected
        // native shutdown path does, and only then exits.
        self.emit(responseFrame({ id: beginId, ok: false, code: "E_CANCELLED" }));
        self.emit(responseFrame({ id: request.id, ok: true, result: { removedFiles: 1, residue: false } }));
        self.exit(0);
        self.close();
      }
    };
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0);
    await expect(client.cancel()).resolves.toBeUndefined();
    // A late reply for an admitted request is a real answer, not a protocol
    // desynchronisation.
    await expect(pending).rejects.toMatchObject({ code: "cancelled", helperCode: "E_CANCELLED" });
  });

  it("treats a genuinely uncorrelated response as a protocol failure", async () => {
    const helper = silentAfterOpen();
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0).catch((error: unknown) => error);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));
    helper.emit(responseFrame({ id: 9999, ok: true, result: {} }));
    const error = await pending;
    expect(error).toMatchObject({ code: "protocol" });
  });
});

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

describe("decoder", () => {
  it("rejects an inbound length above the response bound without allocating it", async () => {
    const helper = silentAfterOpen();
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0).catch((error: unknown) => error);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));
    // 8 MiB is legal for the helper's own frame ceiling but impossible inbound.
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(0, 8 << 20, false);
    header[4] = KIND_RESPONSE;
    helper.emitRaw(header);
    expect(await pending).toMatchObject({ code: "protocol" });
    expect(helper.killCount).toBeGreaterThan(0);
  });

  it("rejects a zero length field", async () => {
    const helper = silentAfterOpen();
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0).catch((error: unknown) => error);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(0, 0, false);
    helper.emitRaw(header);
    expect(await pending).toMatchObject({ code: "protocol" });
  });

  it("reassembles a frame delivered one byte at a time", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        const bytes = responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } });
        for (const byte of bytes) self.emitRaw(new Uint8Array([byte]));
      }
    };
    await expect(openClient(helper)).resolves.toBeInstanceOf(NativeHelperClient);
  });

  it("accepts several valid frames coalesced into one read", async () => {
    const helper = new FakeHelper();
    let openId = 0;
    let beginId = 0;
    helper.onRequest = (request) => {
      if (request.op === "open") openId = request.id;
      if (request.op === "begin") beginId = request.id;
    };
    const promise = NativeHelperClient.open({
      authorityId: "auth-1",
      rootPath: "C:\\dest",
      manifest: MANIFEST,
      spawnHelper: () => helper,
      deadlines: { ...FAST, requestMs: 5_000 },
    });
    helper.emit(readyFrame());
    // Wait for `open` to be on the wire, then answer open AND a later begin in
    // a single read. Aggregating more than one frame is normal on a pipe and
    // must not be treated as an error.
    await vi.waitFor(() => expect(openId).toBeGreaterThan(0));
    const client = await (async () => {
      const openReply = responseFrame({ id: openId, ok: true, result: { files: 2, directories: 1, longPath: false } });
      helper.emitRaw(openReply);
      return promise;
    })();
    const begin = client.begin(0);
    await vi.waitFor(() => expect(beginId).toBeGreaterThan(0));
    const a = responseFrame({ id: beginId, ok: true, result: {} });
    const b = responseFrame({ id: 424242, ok: true, result: {} });
    const both = new Uint8Array(a.byteLength + b.byteLength);
    both.set(a, 0);
    both.set(b, a.byteLength);
    helper.emitRaw(both);
    // The first frame is honoured; the second is uncorrelated, which is a
    // protocol failure about correlation and NOT about coalescing.
    await expect(begin).resolves.toBeUndefined();
  });

  it("refuses a host-to-helper frame kind arriving inbound", async () => {
    const helper = silentAfterOpen();
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0).catch((error: unknown) => error);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));
    helper.emitRaw(frame(KIND_REQUEST, encode({ id: 1, op: "open" })));
    expect(await pending).toMatchObject({ code: "protocol" });
  });

  it("refuses a payload that is not JSON", async () => {
    const helper = silentAfterOpen();
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0).catch((error: unknown) => error);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));
    helper.emitRaw(frame(KIND_RESPONSE, new Uint8Array([0x7b, 0x7b, 0x7b])));
    expect(await pending).toMatchObject({ code: "protocol" });
  });

  it("retains only known codes and counters, never raw stderr text", async () => {
    const helper = cooperative();
    const client = await openClient(helper);
    helper.emitStderr("E_PROTOCOL bounded detail 12\n");
    // Each of these defeated the previous character-class filter: a bare
    // filename and a private word contain no separator at all, and a path split
    // across two writes arrives as two separator-free pieces. Excluding `\` and
    // `/` excluded separators and nothing else.
    helper.emitStderr("SECRET-FILENAME-9f3a.bin\n");
    helper.emitStderr("Documents\n");
    helper.emitStderr("C:\\Users\\victim\n");
    helper.emitStderr("Quarterly Layoffs\n");
    for (let i = 0; i < 5; i += 1) helper.emitStderr("E_IO 0x1\n");

    const joined = client.diagnostics.join("\n");
    expect(joined).toContain("E_PROTOCOL x1");
    expect(joined).toContain("E_IO x5");
    expect(joined).toContain("withheld 4 line(s)");
    // Nothing from any withheld line survives, in whole or in part.
    for (const secret of ["SECRET", "9f3a", "Documents", "victim", "Layoffs", "Quarterly"]) {
      expect(joined).not.toContain(secret);
    }
  });

  it("parses a large coalesced read of valid frames", async () => {
    // Coalescing is normal on a pipe. The previous decoder concatenated every
    // arriving chunk before reading a length field and then re-sliced the
    // remainder per frame, so a read carrying many frames cost quadratic
    // copying. This asserts CORRECTNESS over a large coalesced read; the
    // copying cost is a performance property and is deliberately not asserted
    // as a timing.
    const extra = 512;
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op !== "open") return;
      const frames: Uint8Array[] = [
        responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }),
      ];
      for (let i = 0; i < extra; i += 1) frames.push(readyFrame());
      let total = 0;
      for (const f of frames) total += f.byteLength;
      const one = new Uint8Array(total);
      let at = 0;
      for (const f of frames) {
        one.set(f, at);
        at += f.byteLength;
      }
      self.emitRaw(one);
    };
    const client = await openClient(helper);
    expect(client.fileCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Request accounting
// ---------------------------------------------------------------------------

describe("accounting", () => {
  it("sends chunk frames with a non-zero id and the declared index", async () => {
    const helper = cooperative();
    const client = await openClient(helper);
    await client.begin(0);
    await client.write(0, new Uint8Array([1, 2, 3, 4]));
    const chunk = helper.requests.find((r) => r.kind === KIND_CHUNK);
    expect(chunk?.id).toBeGreaterThan(0);
    expect(chunk?.index).toBe(0);
    expect(chunk?.dataLength).toBe(4);
  });

  it("rejects when the helper's written count disagrees with what was sent", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "begin") {
        self.emit(responseFrame({ id: request.id, ok: true, result: {} }));
        return;
      }
      if (request.kind === KIND_CHUNK) {
        // Claims more than it was given.
        self.emit(responseFrame({ id: request.id, ok: true, result: { written: 99, declared: 4 } }));
      }
    };
    const client = await openClient(helper);
    await client.begin(0);
    await expect(client.write(0, new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ code: "short-write" });
  });

  it("refuses a chunk that would exceed the declared length", async () => {
    const helper = cooperative();
    const client = await openClient(helper);
    await client.begin(0);
    await expect(client.write(0, new Uint8Array(5))).rejects.toMatchObject({ code: "length-exceeded" });
  });

  it("refuses a finish whose byte count is not the declared size", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "begin") {
        self.emit(responseFrame({ id: request.id, ok: true, result: {} }));
        return;
      }
      if (request.op === "finish") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { bytes: 1 } }));
      }
    };
    const client = await openClient(helper);
    await client.begin(0);
    await expect(client.finish(0)).rejects.toMatchObject({ code: "length-short" });
  });

  it("refuses the wrong authority", async () => {
    const helper = cooperative();
    const client = await openClient(helper);
    expect(() => {
      client.assertAuthority("someone-else");
    }).toThrowError(NativeHelperError);
    expect(() => {
      client.assertAuthority("auth-1");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Publish receipts
// ---------------------------------------------------------------------------

async function publishWith(reply: (id: number) => unknown, exitCode = 0): Promise<NativePublishReport> {
  const helper = new FakeHelper();
  helper.onRequest = (request, self) => {
    if (request.op === "open") {
      self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
      return;
    }
    if (request.op === "publish") {
      self.emit(responseFrame(reply(request.id)));
    }
  };
  closeOnEof(helper, exitCode);
  const client = await openClient(helper);
  return client.publish();
}

describe("publish receipts", () => {
  it("maps a complete receipt", async () => {
    await expect(
      publishWith((id) => ({ id, ok: true, result: { status: "complete", publishedCount: 2, total: 2 } })),
    ).resolves.toEqual({ status: "complete", publishedCount: 2, total: 2 });
  });

  it("maps a VALIDATED partial receipt even though it arrives as ok:false", async () => {
    // The correction that matters: the helper reports a partial batch as
    // ok:false with E_PARTIAL_PUBLICATION and a receipt. Treating every
    // ok:false as a plain failure would discard the truthful knowledge that
    // file 0 exists on the user's disk.
    await expect(
      publishWith((id) => ({
        id,
        ok: false,
        code: "E_PARTIAL_PUBLICATION",
        result: {
          status: "partial",
          publishedCount: 1,
          total: 2,
          failed: { index: 1, code: "E_EXISTS" },
          unattempted: { from: 2, to: 1 },
        },
      })),
    ).resolves.toEqual({ status: "partial", publishedCount: 1, total: 2, failedIndex: 1, reason: "E_EXISTS" });
  });

  it("refuses a generic ok:false as an error, never as a partial", async () => {
    await expect(
      publishWith((id) => ({ id, ok: false, code: "E_ACCESS" })),
    ).rejects.toMatchObject({ code: "publish-failed", helperCode: "E_ACCESS" });
  });

  it.each([
    [
      "failure index that does not equal the published count",
      { status: "partial", publishedCount: 1, total: 2, failed: { index: 0, code: "E_EXISTS" } },
    ],
    [
      "total that disagrees with the manifest",
      { status: "partial", publishedCount: 1, total: 9, failed: { index: 1, code: "E_EXISTS" } },
    ],
    [
      "published count equal to the total",
      { status: "partial", publishedCount: 2, total: 2, failed: { index: 2, code: "E_EXISTS" } },
    ],
    [
      "negative published count",
      { status: "partial", publishedCount: -1, total: 2, failed: { index: -1, code: "E_EXISTS" } },
    ],
    ["missing failure", { status: "partial", publishedCount: 1, total: 2 }],
    [
      "unattempted range that is not the remainder",
      {
        status: "partial",
        publishedCount: 0,
        total: 2,
        failed: { index: 0, code: "E_EXISTS" },
        unattempted: { from: 1, to: 9 },
      },
    ],
  ])("refuses a partial receipt with a %s", async (_label, result) => {
    // A receipt this side cannot verify is not a report. Each of these would
    // otherwise let the client claim files were saved on the strength of
    // arithmetic that contradicts itself.
    await expect(
      publishWith((id) => ({ id, ok: false, code: "E_PARTIAL_PUBLICATION", result })),
    ).rejects.toMatchObject({ code: "publish-failed" });
  });

  it("refuses a complete receipt whose counts do not add up", async () => {
    await expect(
      publishWith((id) => ({ id, ok: true, result: { status: "complete", publishedCount: 1, total: 2 } })),
    ).rejects.toMatchObject({ code: "protocol" });
  });
});

// ---------------------------------------------------------------------------
// Lifetime after publication
// ---------------------------------------------------------------------------

describe("lifetime after publication", () => {
  it("closes stdin and joins the process, because Serve does not exit on publish", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "publish") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { status: "complete", publishedCount: 2, total: 2 } }));
      }
    };
    closeOnEof(helper, 0);
    const client = await openClient(helper);
    await expect(client.publish()).resolves.toMatchObject({ status: "complete" });
    // Without this the process and its staging directory outlive every
    // reference to them, once the caller drops the lease.
    expect(helper.stdinEnded).toBe(true);
  });

  it("does not drop a receipt that is still buffered when exit fires before close", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "publish") {
        // Node emits `exit` while stdout may still hold the reply. Settling on
        // `exit` would throw away a valid receipt that was already on its way.
        self.exit(0);
        self.emit(responseFrame({ id: request.id, ok: true, result: { status: "complete", publishedCount: 2, total: 2 } }));
        self.close();
      }
    };
    const client = await openClient(helper);
    await expect(client.publish()).resolves.toEqual({ status: "complete", publishedCount: 2, total: 2 });
  });

  it("preserves the saved prefix when post-publish cleanup reports residue", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "publish") {
        self.emit(
          responseFrame({
            id: request.id,
            ok: false,
            code: "E_PARTIAL_PUBLICATION",
            result: {
              status: "partial",
              publishedCount: 1,
              total: 2,
              failed: { index: 1, code: "E_EXISTS" },
              unattempted: { from: 2, to: 1 },
            },
          }),
        );
      }
    };
    // Exit 3: cleanup incomplete. File 0 is still on the user's disk.
    closeOnEof(helper, 3);
    const client = await openClient(helper);
    const error = await client.publish().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeHelperError);
    const typed = error as NativeHelperError;
    expect(typed.code).toBe("residue");
    expect(typed.residue).toBe(true);
    // Cleanup failing does not un-publish anything, and the outcome is never
    // rewritten into `complete`.
    expect(typed.publishReport).toEqual({
      status: "partial",
      publishedCount: 1,
      total: 2,
      failedIndex: 1,
      reason: "E_EXISTS",
    });
  });

  it("reports cleanup uncertain, and keeps the report, when the process will not close", async () => {
    const helper = new FakeHelper();
    helper.killSucceeds = false;
    helper.autoCloseOnKill = false;
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "publish") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { status: "complete", publishedCount: 2, total: 2 } }));
      }
    };
    const client = await openClient(helper);
    const error = (await client.publish().catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("cleanup-uncertain");
    expect(error.residue).toBe(true);
    expect(error.publishReport).toMatchObject({ status: "complete" });
    // Ownership is not dropped just because this attempt was inconclusive.
    expect(helper.killCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cancel and teardown
// ---------------------------------------------------------------------------

describe("cancel", () => {
  it("never touches the filesystem, asserted on the module source", async () => {
    // Spying on `node:fs/promises` is impossible: an ESM namespace is not
    // configurable. The structural claim is stronger anyway — the client must
    // not so much as IMPORT a filesystem module, because cleanup belongs to the
    // helper by handle and this side does not know the staging path.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(
      fileURLToPath(new URL("../../src/main/io/native-helper-client.ts", import.meta.url)),
      "utf8",
    );
    const importLines = source
      .split("\n")
      .filter((line) => /\bfrom\s+"node:|\bimport\("node:/.test(line));
    // The claim that matters, in any form: no filesystem module.
    expect(importLines.join("\n")).not.toMatch(/node:fs/);
    // A closed allowlist. `node:path` and `node:url` are pure string work;
    // `node:child_process` is the one platform import, and only inside the
    // production spawn.
    const allowed = /node:(child_process|path|url)/;
    for (const line of importLines) {
      expect(line).toMatch(allowed);
    }
  });

  it("tears down without a filesystem call and resolves when cleanup is clean", async () => {
    const helper = cooperative();
    helper.onRequest = ((original) => (request: SeenRequest, self: FakeHelper) => {
      original(request, self);
      if (request.op === "cancel") {
        self.exit(0);
        self.close();
      }
    })(helper.onRequest);
    const client = await openClient(helper);
    await expect(client.cancel()).resolves.toBeUndefined();
  });

  it("is idempotent", async () => {
    const helper = cooperative();
    helper.onRequest = ((original) => (request: SeenRequest, self: FakeHelper) => {
      original(request, self);
      if (request.op === "cancel") {
        self.exit(0);
        self.close();
      }
    })(helper.onRequest);
    const client = await openClient(helper);
    const first = client.cancel();
    const second = client.cancel();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(helper.requests.filter((r) => r.op === "cancel")).toHaveLength(1);
  });

  /**
   * Exit codes 3 and 5 are residue by definition.
   *
   * Exit 2 is different and the difference is in the helper, not here: its
   * `finalCode` only upgrades a CLEAN exit to 3, so a protocol failure that
   * also left bytes behind still reports 2. Exit 2 therefore says nothing
   * about residue, and the cancel reply is the only evidence there is. That is
   * why the client trusts an explicit `residue:false` report on that path and
   * assumes residue when no report arrived — an assumption in the safe
   * direction, not a guess dressed up as knowledge.
   */
  it.each([
    [3, "residue", true, true],
    [5, "residue", true, true],
    [2, "cleanup-uncertain", false, false],
  ])(
    "rejects on exit %i as %s with residue %s",
    async (exitCode, expectedCode, reportedResidue, expectedResidue) => {
      const helper = new FakeHelper();
      helper.onRequest = (request, self) => {
        if (request.op === "open") {
          self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
          return;
        }
        if (request.op === "cancel") {
          self.emit(
            responseFrame({ id: request.id, ok: true, result: { removedFiles: 0, residue: reportedResidue } }),
          );
          self.exit(exitCode);
          self.close();
        }
      };
      const client = await openClient(helper);
      // Resolving here would be the silent-loss reporting this path exists to
      // prevent: `cancel()` returns void, so residue has nowhere else to travel.
      const error = (await client.cancel().catch((caught: unknown) => caught)) as NativeHelperError;
      expect(error.code).toBe(expectedCode);
      expect(error.residue).toBe(expectedResidue);
      expect(error.exitCode).toBe(exitCode);
    },
  );

  it("assumes residue on a non-zero exit that produced no cleanup report", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "cancel") {
        // No reply at all: the helper died before it could report cleanup.
        self.exit(2);
        self.close();
      }
    };
    const client = await openClient(helper);
    const error = (await client.cancel().catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("cleanup-uncertain");
    expect(error.residue).toBe(true);
  });

  it("kills and reports cleanup uncertain when the helper ignores cancel", async () => {
    const helper = new FakeHelper();
    helper.killSucceeds = false;
    helper.autoCloseOnKill = false;
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
      }
      // cancel is deliberately ignored.
    };
    const client = await openClient(helper);
    const error = (await client.cancel().catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("cleanup-uncertain");
    expect(error.residue).toBe(true);
    expect(helper.killCount).toBeGreaterThan(0);
  });

  it("records a diagnostic cancel report without it substituting for the rejection", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "cancel") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { removedFiles: 2, residue: true } }));
        self.exit(3);
        self.close();
      }
    };
    const client = await openClient(helper);
    await expect(client.cancel()).rejects.toMatchObject({ code: "residue", residue: true });
    expect(client.lastCancelReport).toMatchObject({ removedFiles: 2, residue: true });
  });

  it("times out a request, kills, and joins", async () => {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
      }
      // begin is never answered.
    };
    const client = await openClient(helper);
    await expect(client.begin(0)).rejects.toMatchObject({ code: "helper-timeout" });
    expect(helper.killCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Terminal-path ordering: kill, JOIN, then settle
// ---------------------------------------------------------------------------

/** Resolve after enough microtask turns for any already-settled promise to run. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Whether `promise` has settled, judged without racing a timer. */
function settlementTracker<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

describe("terminal paths join before settling", () => {
  it("does not settle a timed-out request until the close is observed", async () => {
    // Root's finding A. The timeout used to `void awaitClose(...)` and reject
    // immediately, so a caller was told the request had failed while the child
    // was still running with its staging directory on disk. If that caller then
    // dropped the lease, nothing was left to tear down with.
    //
    // Driven off the OBSERVED kill rather than a sleep: the barrier is the
    // client's own action, not elapsed time.
    const helper = silentAfterOpen();
    helper.autoCloseOnKill = false;
    // The join bound is deliberately long: with a short one the bound could
    // elapse while the test was still polling for the kill, and the assertion
    // would pass for the wrong reason. An OBSERVED close is then the only thing
    // that can settle this request.
    const client = await openClient(helper, { ...FAST, requestMs: 10, closeAfterExitMs: 5_000 });

    const pending = client.begin(0).catch((error: unknown) => error);
    const hasSettled = settlementTracker(pending);

    await vi.waitFor(() => expect(helper.killCount).toBeGreaterThan(0));
    await drainMicrotasks();
    expect(hasSettled()).toBe(false);

    // Now let the process actually go.
    helper.exit(9);
    helper.close();
    const error = (await pending) as NativeHelperError;
    expect(error.code).toBe("helper-timeout");
  });

  it("marks a timed-out request as residue when the process never closes", async () => {
    const helper = silentAfterOpen();
    helper.autoCloseOnKill = false;
    helper.killSucceeds = false;
    const client = await openClient(helper, { ...FAST, requestMs: 10 });
    const error = (await client.begin(0).catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("helper-timeout");
    // Bytes may remain and nobody can say otherwise.
    expect(error.residue).toBe(true);
  });

  it("reports residue after a forced kill EVEN WHEN the close is observed", async () => {
    // The correction root caught. Every terminal path used to build its cause
    // with residue:false and upgrade it only if the close could not be seen —
    // so a forced kill whose close WAS observed reported a clean teardown. It
    // is the opposite: this path kills, the shipped build has
    // OnCloseDeletionEnabled=false, so a hard kill leaves the documented
    // bounded staging residue. Watching the process exit says nothing about
    // what it left behind.
    const helper = silentAfterOpen();
    helper.autoCloseOnKill = true; // the close IS observed
    const client = await openClient(helper, { ...FAST, requestMs: 10 });
    const error = (await client.begin(0).catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("helper-timeout");
    expect(error.residue).toBe(true);
  });

  it("reports NO residue when the helper never got as far as opening a lease", async () => {
    // The other half, so the rule above is not just "always true". Before the
    // `open` frame is written the helper has created no staging directory, so a
    // kill cannot have left anything.
    const helper = new FakeHelper();
    const error = (await NativeHelperClient.open({
      authorityId: "auth-1",
      rootPath: "C:\\dest",
      manifest: MANIFEST,
      spawnHelper: () => helper,
      deadlines: FAST,
    }).catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("helper-unavailable");
    expect(error.residue).toBe(false);
  });

  it("stays idempotent when more malformed data arrives during the join", async () => {
    const helper = silentAfterOpen();
    helper.autoCloseOnKill = false;
    const client = await openClient(helper, { ...FAST, requestMs: 5_000, closeAfterExitMs: 60 });
    const pending = client.begin(0).catch((error: unknown) => error);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));

    helper.emitRaw(frame(KIND_RESPONSE, new Uint8Array([0x7b])));
    await vi.waitFor(() => expect(helper.killCount).toBeGreaterThan(0));
    const killsAfterFirst = helper.killCount;
    // More garbage while the join is still running.
    helper.emitRaw(frame(KIND_RESPONSE, new Uint8Array([0x7b])));
    helper.emitRaw(frame(KIND_REQUEST, encode({ id: 1, op: "open" })));
    await drainMicrotasks();
    // No second kill, no second join, one settlement.
    expect(helper.killCount).toBe(killsAfterFirst);
    expect(await pending).toMatchObject({ code: "protocol" });
  });

  it("does not settle a protocol failure until the close is observed", async () => {
    // Root's finding C: the same ordering defect on the protocol path.
    const helper = silentAfterOpen();
    helper.autoCloseOnKill = false;
    const client = await openClient(helper, { ...FAST, requestMs: 5_000, closeAfterExitMs: 5_000 });

    const pending = client.begin(0).catch((error: unknown) => error);
    const hasSettled = settlementTracker(pending);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));

    helper.emitRaw(frame(KIND_REQUEST, encode({ id: 1, op: "open" })));
    await vi.waitFor(() => expect(helper.killCount).toBeGreaterThan(0));
    await drainMicrotasks();
    expect(hasSettled()).toBe(false);

    helper.exit(2);
    helper.close();
    expect(await pending).toMatchObject({ code: "protocol" });
  });

  it("does not treat a child 'error' as the process being gone", async () => {
    // Root's finding C. `error` is also emitted for a failed signal or message
    // delivery, and the child may still be running. Synthesising exit+close
    // there reported a live process as dead and abandoned its staging directory.
    const helper = silentAfterOpen();
    const client = await openClient(helper, { ...FAST, requestMs: 5_000 });
    const pending = client.begin(0).catch((error: unknown) => error);
    const hasSettled = settlementTracker(pending);
    await vi.waitFor(() => expect(helper.requests.some((r) => r.op === "begin")).toBe(true));

    helper.failSpawn(new Error("kill EPERM"));
    await drainMicrotasks();
    // Still running, so still pending.
    expect(hasSettled()).toBe(false);

    helper.exit(0);
    helper.close();
    await pending;
  });
});

// ---------------------------------------------------------------------------
// Cleanup retry
// ---------------------------------------------------------------------------

describe("cleanup retry", () => {
  it("retries a failed teardown instead of replaying the rejection", async () => {
    // Root's finding B. `cancellation` memoised the REJECTED promise forever,
    // so a caller acting on `cleanup-uncertain` got the identical rejection
    // back and no second kill was attempted — the retained-child-for-retry this
    // client's own checkpoint claimed never existed.
    const helper = silentAfterOpen();
    helper.autoCloseOnKill = false;
    helper.killSucceeds = false;
    const client = await openClient(helper);

    const first = (await client.cancel().catch((error: unknown) => error)) as NativeHelperError;
    expect(first.code).toBe("cleanup-uncertain");
    const killsAfterFirst = helper.killCount;
    expect(killsAfterFirst).toBeGreaterThan(0);

    const second = (await client.cancel().catch((error: unknown) => error)) as NativeHelperError;
    expect(second.code).toBe("cleanup-uncertain");
    // The retry actually tried again.
    expect(helper.killCount).toBeGreaterThan(killsAfterFirst);

    // Stale close watchers must not accumulate. Every failed retry adds one
    // timed-out waiter under the old implementation, keyed to exactly the
    // situation that makes retries happen.
    for (let i = 0; i < 6; i += 1) await client.cancel().catch(() => undefined);
    expect(client.pendingCloseWatchers).toBe(0);

    // And once the process does go, a further retry succeeds.
    helper.killSucceeds = true;
    helper.autoCloseOnKill = true;
    helper.exit(0);
    helper.close();
    await expect(client.cancel()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cancel reply validation and accounting terminalisation
// ---------------------------------------------------------------------------

function cancelReplyHelper(reply: (id: number) => unknown, exitCode: number): FakeHelper {
  const helper = new FakeHelper();
  helper.onRequest = (request, self) => {
    if (request.op === "open") {
      self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
      return;
    }
    if (request.op === "cancel") {
      const value = reply(request.id);
      if (value !== null) self.emit(responseFrame(value));
      self.exit(exitCode);
      self.close();
    }
  };
  return helper;
}

describe("cancel reply validation", () => {
  it.each([
    ["ok:false", (id: number) => ({ id, ok: false, code: "E_INTERNAL" }), 0],
    ["a non-record result", (id: number) => ({ id, ok: true, result: 7 }), 0],
    ["a missing count", (id: number) => ({ id, ok: true, result: { residue: false } }), 0],
    ["a negative count", (id: number) => ({ id, ok: true, result: { removedFiles: -1, residue: false } }), 0],
    ["a non-boolean residue", (id: number) => ({ id, ok: true, result: { removedFiles: 1, residue: "no" } }), 0],
  ])("treats %s as unconfirmed cleanup, not clean", async (_label, reply, exitCode) => {
    // Root's finding D. These were accepted as cleanup reports, and exit 0 then
    // returned cleanly regardless of what the reply said.
    const client = await openClient(cancelReplyHelper(reply, exitCode));
    const error = (await client.cancel().catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("cleanup-uncertain");
    expect(error.residue).toBe(true);
  });

  it("honours an explicit residue:true even when the helper exits 0", async () => {
    const client = await openClient(
      cancelReplyHelper((id) => ({ id, ok: true, result: { removedFiles: 0, residue: true } }), 0),
    );
    const error = (await client.cancel().catch((caught: unknown) => caught)) as NativeHelperError;
    expect(error.code).toBe("residue");
    expect(error.residue).toBe(true);
    expect(error.exitCode).toBe(0);
  });

  it("resolves on a validated clean report with exit 0", async () => {
    const client = await openClient(
      cancelReplyHelper((id) => ({ id, ok: true, result: { removedFiles: 3, residue: false } }), 0),
    );
    await expect(client.cancel()).resolves.toBeUndefined();
    expect(client.lastCancelReport).toMatchObject({ removedFiles: 3, residue: false });
  });
});

describe("accounting failures are terminal", () => {
  async function mismatchedClient(): Promise<NativeHelperClient> {
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "begin") {
        self.emit(responseFrame({ id: request.id, ok: true, result: {} }));
        return;
      }
      if (request.kind === KIND_CHUNK) {
        self.emit(responseFrame({ id: request.id, ok: true, result: { written: 99, declared: 4 } }));
      }
    };
    return openClient(helper);
  }

  it("refuses every further operation after a write accounting mismatch", async () => {
    // Root's finding D. The mismatch threw but left the state `ready`, so the
    // caller could begin the next file or publish the batch — publishing a file
    // this client had already refused to believe in.
    const client = await mismatchedClient();
    await client.begin(0);
    await expect(client.write(0, new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ code: "short-write" });

    await expect(client.begin(1)).rejects.toMatchObject({ code: "io-failed" });
    await expect(client.finish(0)).rejects.toMatchObject({ code: "io-failed" });
    await expect(client.publish()).rejects.toMatchObject({ code: "io-failed" });
    await expect(client.write(0, new Uint8Array([1]))).rejects.toMatchObject({ code: "io-failed" });
  });

  it("still allows teardown after an accounting failure", async () => {
    // Terminal for IO, not for cleanup: the helper is alive and its staging
    // directory still has to be removed.
    const helper = new FakeHelper();
    helper.onRequest = (request, self) => {
      if (request.op === "open") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { files: 2, directories: 1, longPath: false } }));
        return;
      }
      if (request.op === "begin") {
        self.emit(responseFrame({ id: request.id, ok: true, result: {} }));
        return;
      }
      if (request.kind === KIND_CHUNK) {
        self.emit(responseFrame({ id: request.id, ok: true, result: { written: 99, declared: 4 } }));
        return;
      }
      if (request.op === "cancel") {
        self.emit(responseFrame({ id: request.id, ok: true, result: { removedFiles: 1, residue: false } }));
        self.exit(0);
        self.close();
      }
    };
    const client = await openClient(helper);
    await client.begin(0);
    await expect(client.write(0, new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ code: "short-write" });
    await expect(client.cancel()).resolves.toBeUndefined();
    expect(helper.requests.some((r) => r.op === "cancel")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real Windows harness — the client driving the REAL executable
// ---------------------------------------------------------------------------
//
// Everything above drives a fake. It proves the client and proves NOTHING about
// filesystem behaviour, which is why this block exists and why it must not be a
// placeholder: an earlier version asserted `expect(REAL_HELPER).toBe(true)`,
// which can never serve as acceptance for anything. The Go tests passing on a
// Windows runner do not cover this path either — they exercise the helper, not
// the TypeScript client that has to speak to it.
//
// Skipped ONLY when the host is not Windows. On Windows the executable is
// required, and its absence fails loudly rather than skipping, because a skip
// here would read as evidence that was never gathered.

const IS_WINDOWS = process.platform === "win32";

/**
 * The real executable.
 *
 * `RELAYIUM_NATIVE_HELPER_EXE` is a TEST-only lookup for a CI-built binary and
 * is read only inside this block — the client itself has no environment
 * override of any kind, which the layout tests above assert.
 */
async function realHelperPath(): Promise<string> {
  const { access } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const candidates = [
    process.env["RELAYIUM_NATIVE_HELPER_EXE"],
    resolve(process.cwd(), "native", "build", "relayium-io-helper.exe"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next
    }
  }
  throw new Error(
    `the real helper executable was not found. Looked at:\n  ${candidates.join("\n  ")}\n` +
      "Build it with: go build -o native/build/relayium-io-helper.exe " +
      "./native/cmd/relayium-io-helper, or set RELAYIUM_NATIVE_HELPER_EXE.",
  );
}

/** Wrap a real child process in the client's transport shape. */
async function spawnRealHelper(exe: string): Promise<HelperChild> {
  const { spawn } = await import("node:child_process");
  const child = spawn(exe, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onClose: (listener) => {
      child.once("close", () => listener());
    },
    onError: (listener) => {
      child.once("error", listener);
    },
    kill: (signal) => child.kill(signal),
  };
}

describe.skipIf(!IS_WINDOWS)("real Windows helper integration", () => {
  // ## Owned resources, released after every test
  //
  // Each test creates a temp root and a live child process. Without this, five
  // mkdtemp roots leaked per run and a failing test could leave a helper
  // running — the exact residue this module exists to prevent, produced by its
  // own test suite.
  //
  // Only what these tests created is removed: each root is recorded when it is
  // made, and nothing else is ever touched.
  const ownedRoots: string[] = [];
  const ownedClients: NativeHelperClient[] = [];

  // ## A discarded cleanup failure is a false green
  //
  // An earlier version swallowed both the cancel and the removal, so a run in
  // which a helper survived or a staging directory remained still reported
  // success — the precise failure this suite exists to detect, hidden by the
  // suite's own hook.
  //
  // So every owned cleanup is still ATTEMPTED even after an earlier one fails,
  // and the failures are collected and thrown together. Throwing here does not
  // erase a primary assertion: vitest reports a failing test and a failing hook
  // separately, so the original diagnosis survives alongside the leak.
  afterEach(async () => {
    const { access, rm } = await import("node:fs/promises");
    const failures: Error[] = [];

    // Clients first: cancel joins the process, so the root becomes removable
    // and no helper outlives the test. A rejection here is a real signal — it
    // means teardown could not be confirmed — and is recorded, not dropped.
    for (const client of ownedClients.splice(0)) {
      try {
        await client.cancel();
      } catch (error) {
        const typed = error instanceof NativeHelperError ? error : null;
        failures.push(
          new Error(
            `owned client teardown failed: ${String(error)}` +
              (typed !== null ? ` (residue=${String(typed.residue)} exit=${String(typed.exitCode)})` : ""),
          ),
        );
      }
    }

    for (const root of ownedRoots.splice(0)) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(new Error(`owned root could not be removed: ${root}: ${String(error)}`));
      }
      // Asserted, not assumed: `force` hides a removal that did nothing, and on
      // Windows a surviving handle is exactly what makes a removal fail.
      try {
        await access(root);
        failures.push(new Error(`owned root still exists after cleanup: ${root}`));
      } catch {
        // Gone, as required.
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "owned test resources were not released");
    }
  });

  /** Send one file end to end through the client. */
  async function sendFile(
    client: NativeHelperClient,
    index: number,
    bytes: Uint8Array,
  ): Promise<void> {
    await client.begin(index);
    if (bytes.byteLength > 0) await client.write(index, bytes);
    await client.finish(index);
  }

  async function openReal(
    root: string,
    manifest: readonly NativeManifestEntry[],
  ): Promise<NativeHelperClient> {
    const exe = await realHelperPath();
    const client = await NativeHelperClient.open({
      authorityId: "windows-harness",
      rootPath: root,
      manifest,
      spawnHelper: () => spawnRealHelper(exe),
    });
    // Recorded the moment it exists, so a failure below still releases it.
    ownedClients.push(client);
    return client;
  }

  async function tempRoot(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const root = await mkdtemp(joinPath(tmpdir(), "relayium-client-"));
    ownedRoots.push(root);
    return root;
  }

  async function stagingEntries(root: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name.startsWith(".relayium-incoming-")).map((e) => e.name);
  }

  it("publishes exact bytes, including a nested path and a zero-byte file", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const root = await tempRoot();

    const binary = new Uint8Array([0x00, 0xff, 0x7f, 0x80]);
    const nested = new TextEncoder().encode("hi");
    const manifest: readonly NativeManifestEntry[] = [
      { name: "top.bin", size: binary.byteLength },
      { name: "nested/dir/inner.txt", size: nested.byteLength },
      { name: "empty.bin", size: 0 },
    ];

    const client = await openReal(root, manifest);
    expect(client.fileCount).toBe(3);
    await sendFile(client, 0, binary);
    await sendFile(client, 1, nested);
    await sendFile(client, 2, new Uint8Array(0));

    await expect(client.publish()).resolves.toEqual({
      status: "complete",
      publishedCount: 3,
      total: 3,
    });

    expect(new Uint8Array(await readFile(joinPath(root, "top.bin")))).toEqual(binary);
    expect(await readFile(joinPath(root, "nested", "dir", "inner.txt"), "utf8")).toBe("hi");
    expect((await stat(joinPath(root, "empty.bin"))).size).toBe(0);
    // The helper cleaned up after the EOF this client sends on publish.
    expect(await stagingEntries(root)).toEqual([]);
  });

  it("never replaces an existing destination, and reports a truthful partial", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const root = await tempRoot();

    // Already there, with content the transfer must not touch.
    await writeFile(joinPath(root, "second.bin"), "ORIGINAL", "utf8");

    const payload = new TextEncoder().encode("ab");
    const manifest: readonly NativeManifestEntry[] = [
      { name: "first.bin", size: 2 },
      { name: "second.bin", size: 2 },
      { name: "third.bin", size: 2 },
    ];
    const client = await openReal(root, manifest);
    await sendFile(client, 0, payload);
    await sendFile(client, 1, payload);
    await sendFile(client, 2, payload);

    const report = await client.publish();
    expect(report).toEqual({
      status: "partial",
      publishedCount: 1,
      total: 3,
      failedIndex: 1,
      reason: "E_EXISTS",
    });

    // The prefix landed.
    expect(await readFile(joinPath(root, "first.bin"), "utf8")).toBe("ab");
    // The existing file is byte-for-byte untouched. This is the invariant the
    // whole module exists for.
    expect(await readFile(joinPath(root, "second.bin"), "utf8")).toBe("ORIGINAL");
    // Nothing after the failure was attempted.
    await expect(readFile(joinPath(root, "third.bin"), "utf8")).rejects.toThrow();
    expect(await stagingEntries(root)).toEqual([]);
  });

  it("leaves nothing behind when cancelled mid-transfer", async () => {
    const { readdir } = await import("node:fs/promises");
    const root = await tempRoot();
    const manifest: readonly NativeManifestEntry[] = [{ name: "aborted.bin", size: 8 }];

    const client = await openReal(root, manifest);
    await client.begin(0);
    await client.write(0, new Uint8Array([1, 2, 3, 4]));

    await expect(client.cancel()).resolves.toBeUndefined();

    // No staging directory, and above all nothing at the destination name.
    expect(await readdir(root)).toEqual([]);
  });

  it("joins the process on publish, so the lease leaves no live helper", async () => {
    const { join: joinPath } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    const root = await tempRoot();
    const manifest: readonly NativeManifestEntry[] = [{ name: "only.bin", size: 1 }];

    const client = await openReal(root, manifest);
    await sendFile(client, 0, new Uint8Array([42]));
    await expect(client.publish()).resolves.toMatchObject({ status: "complete" });
    expect(new Uint8Array(await readFile(joinPath(root, "only.bin")))).toEqual(new Uint8Array([42]));

    // Serve does not exit on publish; the client closes stdin and joins. After
    // that the lease is finished, so nothing further may run on it.
    await expect(client.publish()).rejects.toBeInstanceOf(NativeHelperError);
    await expect(client.begin(0)).rejects.toBeInstanceOf(NativeHelperError);
    // Idempotent teardown on an already-closed helper resolves.
    await expect(client.cancel()).resolves.toBeUndefined();
    expect(await stagingEntries(root)).toEqual([]);
  });

  it("refuses a manifest that tries to escape the chosen root", async () => {
    const { readdir } = await import("node:fs/promises");
    const root = await tempRoot();
    await expect(
      openReal(root, [{ name: "../escaped.bin", size: 1 }]),
    ).rejects.toBeInstanceOf(NativeHelperError);
    // `open` tears its own process down when it fails, so nothing is recorded
    // for the hook to release — and nothing is left in the root either.
    expect(await readdir(root)).toEqual([]);
  });
});
