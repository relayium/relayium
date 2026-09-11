// Fail closed, bind exactly, and account for every handle.
//
// The three claims this module makes are that a Windows build never silently
// falls back, that a reopen lands on the staged object or refuses, and that a
// handle this process did not get back is counted rather than assumed released.
// Each is tested against a scripted helper rather than a stub of the client, so
// the protocol is exercised end to end inside the process.
import { describe, expect, it } from "vitest";
import {
  createNativeSourceProvider,
  isCompleteIdentity,
  sameIdentity,
  SourceBindingError,
  type SourceIdentity,
} from "../../src/main/io/native-source.js";
import { NativeSourceError, encodeFrame } from "../../src/main/io/native-source-client.js";
import type { HelperChild, SpawnHelper } from "../../src/main/io/native-helper-client.js";

const VOL = "00000000deadbeef";
const FID = "0123456789abcdef0123456789abcdef";
const OTHER_FID = "fedcba9876543210fedcba9876543210";

interface Request {
  id: number;
  op: string;
  path?: string;
  source?: number;
  offset?: number;
  length?: number;
}
type Reply = { ok: true; result: unknown; chunk?: Uint8Array } | { ok: false; code: string };

interface Scripted {
  spawn: SpawnHelper;
  readonly requests: Request[];
}

/** A helper that speaks the protocol, driven by one handler. */
function scriptedHelper(handle: (req: Request) => Reply): Scripted {
  const requests: Request[] = [];
  let emit: ((frame: Uint8Array) => void) | null = null;
  const child: HelperChild = {
    stdin: {
      write(chunk: Uint8Array) {
        const req = JSON.parse(new TextDecoder().decode(chunk.subarray(5))) as Request;
        requests.push(req);
        const reply = handle(req);
        queueMicrotask(() => {
          if (emit === null) return;
          if (reply.ok) {
            if (reply.chunk !== undefined) {
              const payload = new Uint8Array(12 + reply.chunk.length);
              new DataView(payload.buffer).setBigUint64(0, BigInt(req.id), false);
              payload.set(reply.chunk, 12);
              emit(encodeFrame(2, payload));
            }
            emit(encodeFrame(3, json({ id: req.id, ok: true, result: reply.result })));
          } else {
            emit(encodeFrame(3, json({ id: req.id, ok: false, code: reply.code })));
          }
        });
        return true;
      },
      end() {},
    },
    stdout: {
      on(_event, listener) {
        emit = listener;
        queueMicrotask(() => listener(encodeFrame(4, json({ event: "source-ready", protocol: 1 }))));
      },
    },
    stderr: { on: () => undefined },
    onExit: (l) => queueMicrotask(() => l(0, null)),
    onClose: () => undefined,
    onError: () => undefined,
    kill: () => true,
  };
  return { spawn: () => child, requests };
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** The ordinary helper: opens anything, reads nothing, closes cleanly. */
function openingHelper(
  identity: { volumeSerial: string; fileId: string } = { volumeSerial: VOL, fileId: FID },
  closeState: "closed" | "failed-close" = "closed",
): Scripted {
  let next = 0;
  return scriptedHelper((req) => {
    switch (req.op) {
      case "open-source":
        next += 1;
        return { ok: true, result: { source: next, size: 5, ...identity } };
      case "read-source":
        return { ok: true, result: { bytes: 5, eof: true }, chunk: new TextEncoder().encode("bytes") };
      case "close-source":
        return { ok: true, result: { state: closeState } };
      default:
        return { ok: false, code: "E_PROTOCOL" };
    }
  });
}

const win32 = (spawn: SpawnHelper) => {
  const provider = createNativeSourceProvider({ platform: "win32", spawn });
  if (provider === null) throw new Error("a Windows provider must never be null");
  return provider;
};

describe("identity is exact, nonzero, and never numeric", () => {
  const id = (volumeSerial: string, fileId: string): SourceIdentity => ({ volumeSerial, fileId });

  it("accepts only fixed-width lowercase nonzero hex", () => {
    expect(isCompleteIdentity(id(VOL, FID))).toBe(true);
    for (const bad of [
      id("", ""),
      id("deadbeef", FID), // too short
      id(VOL + "0", FID), // too long
      id("00000000DEADBEEF", FID), // uppercase
      id("00000000deadbeeg", FID), // not hex
      id("0000000000000000", FID), // zero volume
      id(VOL, "0".repeat(32)), // zero file id
      id(VOL, FID.slice(0, 31)),
    ]) {
      expect({ bad, complete: isCompleteIdentity(bad) }).toEqual({ bad, complete: false });
    }
  });

  it("never calls two unusable identities equal", () => {
    const blank = id("", "");
    const zero = id("0000000000000000", "0".repeat(32));
    // The failure this prevents: a volume that cannot identify its files would
    // otherwise report every file as matching every other.
    expect(sameIdentity(blank, blank)).toBe(false);
    expect(sameIdentity(zero, zero)).toBe(false);
    expect(sameIdentity(zero, blank)).toBe(false);
  });

  it("distinguishes files on the same volume and the same file on two volumes", () => {
    expect(sameIdentity(id(VOL, FID), id(VOL, FID))).toBe(true);
    expect(sameIdentity(id(VOL, FID), id(VOL, OTHER_FID))).toBe(false);
    expect(sameIdentity(id(VOL, FID), id("1111111111111111", FID))).toBe(false);
  });
});

describe("the platform answer is not a fallback signal", () => {
  it("reports no native guarantee off Windows", () => {
    expect(createNativeSourceProvider({ platform: "darwin" })).toBeNull();
    expect(createNativeSourceProvider({ platform: "linux" })).toBeNull();
  });

  it("returns a provider on Windows even when the helper cannot be started", async () => {
    const provider = win32(() => {
      throw new Error("ENOENT");
    });
    // Null here would read to a caller as "use the other path", and there is no
    // other path that can make this claim. So it exists, and it refuses.
    await expect(provider.open("C:\\a\\b.txt")).rejects.toBeInstanceOf(NativeSourceError);
    // Every later open reports the CAUSE, not this object's internal state.
    // Staging many files must not produce one truthful answer and N misleading
    // ones.
    await expect(provider.open("C:\\a\\b.txt")).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.open("C:\\a\\c.txt")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses to exist in a renderer", () => {
    const proc = process as { type?: unknown };
    const original = proc.type;
    Object.defineProperty(process, "type", { value: "renderer", configurable: true });
    try {
      expect(() => createNativeSourceProvider({ platform: "win32" })).toThrow(/main-only/);
    } finally {
      if (original === undefined) delete proc.type;
      else Object.defineProperty(process, "type", { value: original, configurable: true });
    }
  });
});

describe("a reopen binds to the staged object or refuses", () => {
  it("opens without an expectation and reports the identity", async () => {
    const provider = win32(openingHelper().spawn);
    const handle = await provider.open("C:\\a\\b.txt");
    expect(handle.identity).toEqual({ volumeSerial: VOL, fileId: FID });
    expect(handle.size).toBe(5);
    expect(provider.openCount).toBe(1);
    await provider.dispose();
  });

  it("accepts a rebind onto the same file", async () => {
    const provider = win32(openingHelper().spawn);
    const handle = await provider.open("C:\\a\\b.txt", { volumeSerial: VOL, fileId: FID });
    expect(handle.identity.fileId).toBe(FID);
    await provider.dispose();
  });

  it("refuses a rebind onto a different file and RELEASES the handle", async () => {
    const helper = openingHelper();
    const provider = win32(helper.spawn);
    const failure = await provider
      .open("C:\\a\\b.txt", { volumeSerial: VOL, fileId: OTHER_FID })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceBindingError);
    expect(failure).toMatchObject({ reason: "identity-mismatch" });
    // Handing the handle back alongside the refusal would leave the caller
    // holding a reader for the object it just refused.
    expect(helper.requests.map((r) => r.op)).toEqual(["open-source", "close-source"]);
    expect(provider.openCount).toBe(0);
    await provider.dispose();
  });

  it("refuses an identity the helper could not make exact", async () => {
    const helper = openingHelper({ volumeSerial: "0000000000000000", fileId: FID });
    const provider = win32(helper.spawn);
    const failure = await provider.open("C:\\a\\b.txt").catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: "identity-incomplete" });
    expect(helper.requests.map((r) => r.op)).toEqual(["open-source", "close-source"]);
    await provider.dispose();
  });
});

describe("handles are accounted for, not assumed released", () => {
  it("reads through an open handle and closes it once", async () => {
    const helper = openingHelper();
    const provider = win32(helper.spawn);
    const handle = await provider.open("C:\\a\\b.txt");
    const read = await handle.read(0, 1024);
    expect(new TextDecoder().decode(read.bytes)).toBe("bytes");
    expect(read.eof).toBe(true);

    expect(await handle.close()).toBe("closed");
    expect(provider.openCount).toBe(0);
    // A second close is a no-op rather than a second protocol message.
    expect(await handle.close()).toBe("closed");
    expect(helper.requests.filter((r) => r.op === "close-source")).toHaveLength(1);
    await provider.dispose();
  });

  it("refuses a read through a released handle", async () => {
    const provider = win32(openingHelper().spawn);
    const handle = await provider.open("C:\\a\\b.txt");
    await handle.close();
    // Unknown state, so it must not stay readable; a retry would be a read on
    // exactly that handle.
    await expect(handle.read(0, 16)).rejects.toMatchObject({ code: "closed" });
    await provider.dispose();
  });

  it("counts a failed close as a handle this process still holds", async () => {
    const provider = win32(openingHelper(undefined, "failed-close").spawn);
    const handle = await provider.open("C:\\a\\b.txt");
    expect(await handle.close()).toBe("failed-close");
    const report = await provider.dispose();
    expect(report.leftover).toBe(1);
  });

  it("closes what the caller left open and reports a clean teardown", async () => {
    const helper = openingHelper();
    const provider = win32(helper.spawn);
    await provider.open("C:\\a\\one.txt");
    await provider.open("C:\\a\\two.txt");
    expect(provider.openCount).toBe(2);
    const report = await provider.dispose();
    expect(report.leftover).toBe(0);
    expect(helper.requests.filter((r) => r.op === "close-source")).toHaveLength(2);
  });

  it("refuses to open anything after dispose", async () => {
    const provider = win32(openingHelper().spawn);
    await provider.dispose();
    await expect(provider.open("C:\\a\\b.txt")).rejects.toMatchObject({ code: "closed" });
  });

  it("carries a helper refusal through without inventing a cause", async () => {
    const provider = win32(
      scriptedHelper(() => ({ ok: false, code: "E_REPARSE_COMPONENT" })).spawn,
    );
    await expect(provider.open("C:\\a\\b.txt")).rejects.toMatchObject({
      code: "refused",
      helperCode: "E_REPARSE_COMPONENT",
    });
    await provider.dispose();
  });
});

describe("the source path never leaves main", () => {
  it("appears in exactly one place: the open request", async () => {
    const secret = "C:\\Users\\someone\\Private\\tax-return.pdf";
    const helper = openingHelper();
    const provider = win32(helper.spawn);
    const handle = await provider.open(secret);
    await handle.read(0, 16);
    await handle.close();
    const carrying = helper.requests.filter((r) => JSON.stringify(r).includes("tax-return"));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.op).toBe("open-source");
    // Nothing the handle exposes carries it.
    expect(JSON.stringify({ size: handle.size, identity: handle.identity })).not.toContain("tax-return");
    await provider.dispose();
  });
});
