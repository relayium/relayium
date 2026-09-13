// The frame boundary, pinned against the Go encoder rather than against itself.
//
// This client carries its own framing because the receive client's is private.
// A second implementation of one format only stays honest if something outside
// it decides what the format is — so the fixtures below are the exact bytes
// `wire.EncodeFrame`, `wire.EncodeChunk` and `sourceserve.EncodeOK` produced,
// captured from the Go encoder. A divergence fails here instead of stalling in
// production.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SOURCE_READ_BYTES,
  NativeSourceClient,
  NativeSourceError,
  encodeFrame,
} from "../../src/main/io/native-source-client.js";
import type { HelperChild } from "../../src/main/io/native-helper-client.js";

// Captured from the Go encoder. See native/internal/sourceserve.
const GO = {
  readyEvent: "00000026047b226576656e74223a22736f757263652d7265616479222c2270726f746f636f6c223a317d",
  openResponse:
    "00000081037b226964223a312c226f6b223a747275652c22726573756c74223a7b22736f75726365223a312c2273697a65223a31322c22766f6c756d6553657269616c223a2230303030303030306465616462656566222c2266696c654964223a223031323334353637383961626364656630313233343536373839616263646566227d7d",
  readChunk: "000000190200000000000000020000000068656c6c6f20736f75726365",
  readResponse: "00000034037b226964223a322c226f6b223a747275652c22726573756c74223a7b226279746573223a31322c22656f66223a747275657d7d",
  closeFailed: "00000035037b226964223a332c226f6b223a747275652c22726573756c74223a7b227374617465223a226661696c65642d636c6f7365227d7d",
  refusal: "0000002e037b226964223a342c226f6b223a66616c73652c22636f6465223a22455f554e4b4e4f574e5f534f55524345227d",
  openRequest:
    "00000032017b226964223a312c226f70223a226f70656e2d736f75726365222c2270617468223a22433a5c5c615c5c622e747874227d",
} as const;

const hex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));
const toHex = (b: Uint8Array): string =>
  [...b].map((v) => v.toString(16).padStart(2, "0")).join("");

interface Fake {
  child: HelperChild;
  emit(frame: Uint8Array): void;
  exit(code: number | null): void;
  close(): void;
  error(message: string): void;
  readonly written: Uint8Array[];
  readonly killed: () => number;
  readonly ended: () => boolean;
}

function fakeHelper(): Fake {
  const data: Array<(chunk: Uint8Array) => void> = [];
  const exits: Array<(code: number | null, signal: string | null) => void> = [];
  const closes: Array<() => void> = [];
  const errors: Array<(error: Error) => void> = [];
  const written: Uint8Array[] = [];
  let killed = 0;
  let ended = false;
  const child: HelperChild = {
    stdin: {
      write(chunk: Uint8Array) {
        written.push(chunk);
        return true;
      },
      end() {
        ended = true;
      },
    },
    stdout: { on: (_e, listener) => data.push(listener) },
    stderr: { on: () => undefined },
    onExit: (l) => exits.push(l),
    onClose: (l) => closes.push(l),
    onError: (l) => errors.push(l),
    kill: () => {
      killed += 1;
      return true;
    },
  };
  return {
    child,
    emit: (frame) => data.forEach((l) => l(frame)),
    exit: (code) => exits.forEach((l) => l(code, null)),
    close: () => closes.forEach((l) => l()),
    error: (message) => errors.forEach((l) => l(new Error(message))),
    written,
    killed: () => killed,
    ended: () => ended,
  };
}

async function started(): Promise<{ fake: Fake; client: NativeSourceClient }> {
  const fake = fakeHelper();
  const client = new NativeSourceClient({ spawn: () => fake.child });
  const starting = client.start();
  await Promise.resolve();
  fake.emit(hex(GO.readyEvent));
  await starting;
  return { fake, client };
}

/** A helper refusal frame correlated to `id`. */
const refusal = (id: number, code: string): Uint8Array =>
  encodeFrame(3, new TextEncoder().encode(JSON.stringify({ id, ok: false, code })));

/** The JSON of the nth frame this client wrote. */
function sentRequest(fake: Fake, index: number): Record<string, unknown> {
  const frame = fake.written[index];
  if (frame === undefined) throw new Error(`no frame at ${index}`);
  return JSON.parse(new TextDecoder().decode(frame.subarray(5))) as Record<string, unknown>;
}

describe("framing agrees with the Go encoder", () => {
  it("produces byte-identical request frames", async () => {
    const { fake, client } = await started();
    // Driven through the real client, so the assertion covers what it actually
    // sends rather than what a helper in this file re-implements.
    void client.open("C:\\a\\b.txt").catch(() => undefined);
    await Promise.resolve();
    expect(toHex(fake.written[0] ?? new Uint8Array())).toBe(GO.openRequest);
    fake.exit(0);
    await client.dispose();
  });

  it("decodes the Go ready event, response and chunk", async () => {
    const { fake, client } = await started();
    expect(client.ready).toBe(true);

    const opening = client.open("C:\\a\\b.txt");
    await Promise.resolve();
    fake.emit(hex(GO.openResponse));
    expect(await opening).toEqual({
      source: 1,
      size: 12,
      volumeSerial: "00000000deadbeef",
      fileId: "0123456789abcdef0123456789abcdef",
    });

    const reading = client.read(1, 0, 1024);
    await Promise.resolve();
    fake.emit(hex(GO.readChunk));
    fake.emit(hex(GO.readResponse));
    const read = await reading;
    expect(new TextDecoder().decode(read.bytes)).toBe("hello source");
    expect(read.eof).toBe(true);
  });

  it("carries a refusal code without inventing prose", async () => {
    const { fake, client } = await started();
    const pending = client.open("C:\\a");
    await Promise.resolve();
    fake.emit(refusal(1, "E_UNKNOWN_SOURCE"));
    await expect(pending).rejects.toMatchObject({ code: "refused", helperCode: "E_UNKNOWN_SOURCE" });
  });

  it("reads the same refusal shape the Go encoder produces", () => {
    const payload = hex(GO.refusal).subarray(5);
    expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({
      id: 4,
      ok: false,
      code: "E_UNKNOWN_SOURCE",
    });
  });

  it("survives a frame split across two data events", async () => {
    const { fake, client } = await started();
    const opening = client.open("C:\\a\\b.txt");
    await Promise.resolve();
    const frame = hex(GO.openResponse);
    fake.emit(frame.subarray(0, 3));
    fake.emit(frame.subarray(3, 40));
    fake.emit(frame.subarray(40));
    expect((await opening).source).toBe(1);
  });

  it("handles two frames arriving in one data event", async () => {
    const { fake, client } = await started();
    // The chunk fixture correlates to request 2, so the open consumes id 1.
    const opening = client.open("C:\\a\\b.txt");
    await Promise.resolve();
    fake.emit(hex(GO.openResponse));
    await opening;
    const reading = client.read(1, 0, 1024);
    await Promise.resolve();
    const both = new Uint8Array([...hex(GO.readChunk), ...hex(GO.readResponse)]);
    fake.emit(both);
    expect((await reading).bytes.length).toBe(12);
  });
});

describe("hostile frames end the session rather than being interpreted", () => {
  const terminal = async (frame: Uint8Array, expected: string): Promise<void> => {
    const { fake, client } = await started();
    const pending = client.open("C:\\a");
    await Promise.resolve();
    fake.emit(frame);
    await expect(pending).rejects.toThrow(NativeSourceError);
    await expect(pending).rejects.toMatchObject({ code: expected });
    expect(fake.killed()).toBeGreaterThan(0);
  };

  it("refuses an oversize length before allocating for it", async () => {
    const huge = new Uint8Array([0xff, 0xff, 0xff, 0xff, 3]);
    await terminal(huge, "protocol");
  });

  it("refuses a zero length", async () => {
    await terminal(new Uint8Array([0, 0, 0, 0, 3]), "protocol");
  });

  it("refuses an unknown frame kind", async () => {
    await terminal(encodeFrame(9, new TextEncoder().encode("{}")), "protocol");
  });

  it("refuses a response that correlates to nothing", async () => {
    await terminal(encodeFrame(3, new TextEncoder().encode('{"id":777,"ok":true,"result":{}}')), "protocol");
  });

  it("refuses a chunk that correlates to nothing", async () => {
    const payload = new Uint8Array(12 + 3);
    new DataView(payload.buffer).setBigUint64(0, 777n, false);
    await terminal(encodeFrame(2, payload), "protocol");
  });

  it("refuses unreadable JSON", async () => {
    await terminal(encodeFrame(3, new TextEncoder().encode("{not json")), "protocol");
  });

  it("refuses a protocol version it does not speak", async () => {
    const fake = fakeHelper();
    const client = new NativeSourceClient({ spawn: () => fake.child });
    const starting = client.start();
    await Promise.resolve();
    fake.emit(encodeFrame(4, new TextEncoder().encode('{"event":"source-ready","protocol":99}')));
    await expect(starting).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses an event that is not the ready event", async () => {
    const fake = fakeHelper();
    const client = new NativeSourceClient({ spawn: () => fake.child });
    const starting = client.start();
    await Promise.resolve();
    fake.emit(encodeFrame(4, new TextEncoder().encode('{"event":"something-else"}')));
    await expect(starting).rejects.toMatchObject({ code: "protocol" });
  });
});

describe("a read's bytes and its stated count must agree", () => {
  it("refuses a chunk longer than the reported count", async () => {
    const { fake, client } = await started();
    const opening = client.open("C:\\a");
    await Promise.resolve();
    fake.emit(hex(GO.openResponse));
    await opening;
    const reading = client.read(1, 0, 1024);
    await Promise.resolve();
    fake.emit(hex(GO.readChunk));
    // Same chunk, but the response claims four bytes.
    fake.emit(encodeFrame(3, new TextEncoder().encode('{"id":2,"ok":true,"result":{"bytes":4,"eof":false}}')));
    await expect(reading).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses two chunks for one request", async () => {
    const { fake, client } = await started();
    const opening = client.open("C:\\a");
    await Promise.resolve();
    fake.emit(hex(GO.openResponse));
    await opening;
    const reading = client.read(1, 0, 1024);
    await Promise.resolve();
    fake.emit(hex(GO.readChunk));
    fake.emit(hex(GO.readChunk));
    await expect(reading).rejects.toMatchObject({ code: "protocol" });
  });

  it("accepts a response with no chunk as an empty read", async () => {
    const { fake, client } = await started();
    const reading = client.read(1, 0, 1024);
    await Promise.resolve();
    fake.emit(encodeFrame(3, new TextEncoder().encode('{"id":1,"ok":true,"result":{"bytes":0,"eof":true}}')));
    expect(await reading).toEqual({ bytes: new Uint8Array(0), eof: true });
  });
});

describe("ranges are refused before a frame is sent", () => {
  it("refuses a negative offset, a zero length and an oversize length", async () => {
    const { fake, client } = await started();
    const before = fake.written.length;
    for (const [offset, length] of [
      [-1, 16],
      [0, 0],
      [0, -4],
      [0, MAX_SOURCE_READ_BYTES + 1],
      [1.5, 16],
    ] as const) {
      await expect(client.read(1, offset, length)).rejects.toMatchObject({ code: "protocol" });
    }
    expect(fake.written.length).toBe(before);
  });

  it("accepts exactly the maximum", async () => {
    const { fake, client } = await started();
    void client.read(1, 0, MAX_SOURCE_READ_BYTES).catch(() => undefined);
    await Promise.resolve();
    expect(sentRequest(fake, 0)).toMatchObject({ op: "read-source", length: MAX_SOURCE_READ_BYTES });
  });
});

describe("one request in flight", () => {
  it("serialises rather than pipelining", async () => {
    const { fake, client } = await started();
    const first = client.open("C:\\one");
    const second = client.open("C:\\two");
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.written.length).toBe(1);

    fake.emit(hex(GO.openResponse));
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.written.length).toBe(2);
    expect(sentRequest(fake, 1)).toMatchObject({ id: 2, op: "open-source" });
    void second.catch(() => undefined);
    fake.exit(0);
    await client.dispose();
  });
});

describe("a lost answer is never reported as success", () => {
  it("rejects an in-flight request when the process exits", async () => {
    const { fake, client } = await started();
    const pending = client.open("C:\\a");
    await Promise.resolve();
    fake.exit(3);
    fake.close();
    await expect(pending).rejects.toMatchObject({ code: "closed", exitCode: 3 });
  });

  it("rejects an in-flight request on dispose", async () => {
    const { fake, client } = await started();
    const pending = client.open("C:\\a");
    await Promise.resolve();
    const disposing = client.dispose();
    fake.exit(0);
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await disposing;
    expect(fake.ended()).toBe(true);
  });

  it("rejects when the helper cannot be spawned at all", async () => {
    const client = new NativeSourceClient({
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(client.start()).rejects.toMatchObject({ code: "unavailable" });
    await expect(client.open("C:\\a")).rejects.toBeInstanceOf(NativeSourceError);
  });

  it("rejects when the child has no usable stdio", async () => {
    const fake = fakeHelper();
    const client = new NativeSourceClient({
      spawn: () => ({ ...fake.child, stdout: null }),
    });
    await expect(client.start()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reports a spawn error arriving after the child was handed over", async () => {
    const fake = fakeHelper();
    const client = new NativeSourceClient({ spawn: () => fake.child });
    const starting = client.start();
    await Promise.resolve();
    fake.error("spawn EACCES");
    await expect(starting).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("deadlines are real", () => {
  // The rejection handler is attached BEFORE the clock is advanced. Attaching
  // afterwards leaves the promise momentarily unhandled, which Node reports as
  // an unhandled rejection and which says nothing about the code under test.
  const capture = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(() => null, (error: unknown) => error);

  it("fails a start that never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeHelper();
      const client = new NativeSourceClient({
        spawn: () => fake.child,
        deadlines: { startupMs: 10 },
      });
      const outcome = capture(client.start());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11);
      expect(await outcome).toMatchObject({ code: "timeout" });
      expect(fake.killed()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a request that is never answered", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeHelper();
      const client = new NativeSourceClient({
        spawn: () => fake.child,
        deadlines: { requestMs: 10 },
      });
      const starting = client.start();
      await Promise.resolve();
      fake.emit(hex(GO.readyEvent));
      await starting;
      const outcome = capture(client.open("C:\\a"));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11);
      expect(await outcome).toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nothing user-authored leaves this module", () => {
  it("keeps the path out of every error it raises", async () => {
    const secret = "C:\\Users\\someone\\Private\\tax-return.pdf";
    const { fake, client } = await started();
    const pending = client.open(secret);
    await Promise.resolve();
    fake.emit(refusal(1, "E_UNKNOWN_SOURCE"));
    const error = await pending.catch((e: unknown) => e);
    const rendered = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    expect(rendered).not.toContain("tax-return");
    expect(rendered).not.toContain("someone");
  });
});
