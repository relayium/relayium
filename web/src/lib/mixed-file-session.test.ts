import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSession, generateKeyPair, ready } from "./crypto";
import { createMixedFileSession, MIXED_FILE_GAP_TIMEOUT_MS } from "./mixed-file-session.svelte";
import type { SaveTarget } from "./filesink";
import type { MixedPeerLink } from "./peer-link.svelte";
import {
  BATCH_ABORT,
  ACCEPT,
  COMPLETE,
  CHUNK_OVERHEAD,
  FILE_BUSY,
  FLOW_WINDOW,
  Receiver,
  REJECT,
  Sender,
  FRAME,
  ackFrame,
  isBatchAbort,
} from "./transfer";
import { TextReceiver, TextSender } from "./text-wire";

interface FakeChannel {
  sent: ArrayBuffer[];
  peer: FakeChannel | null;
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onbufferedamountlow: (() => void) | null;
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
  close: ReturnType<typeof vi.fn<() => void>>;
}

function channelPair() {
  const make = (): FakeChannel => ({
    sent: [] as ArrayBuffer[],
    peer: null,
    readyState: "open" as RTCDataChannelState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    binaryType: "blob" as BinaryType,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null,
    onbufferedamountlow: null as (() => void) | null,
    send(data: string | Blob | ArrayBuffer | ArrayBufferView) {
      if (typeof data === "string" || data instanceof Blob) throw new Error("unexpected file payload");
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = view.slice().buffer as ArrayBuffer;
      this.sent.push(copy);
      queueMicrotask(() => this.peer?.onmessage?.(new MessageEvent("message", { data: copy })));
    },
    close: vi.fn(function (this: FakeChannel) {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.onclose?.();
    }),
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

interface MemoryTarget extends SaveTarget {
  output: Map<string, Uint8Array>;
}

function memoryTarget(): MemoryTarget {
  const output = new Map<string, Uint8Array>();
  return {
    label: "memory",
    output,
    async file(name) {
      const chunks: Uint8Array[] = [];
      return {
        async write(chunk) { chunks.push(chunk.slice()); },
        async close() {
          const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
          output.set(name, joined);
        },
      };
    },
  };
}

async function harness(opts: {
  pickA?: (files: { name: string; size: number }[]) => Promise<SaveTarget>;
  pickB?: (files: { name: string; size: number }[]) => Promise<SaveTarget>;
  consentTimeoutMs?: number;
  receiveStallMs?: number;
  drainTimeoutMs?: number;
  gapTimeoutMs?: number;
} = {}) {
  const aKey = generateKeyPair();
  const bKey = generateKeyPair();
  const aKeys = await deriveSession("initiator", aKey, bKey.publicKey);
  const bKeys = await deriveSession("responder", bKey, aKey.publicKey);
  const file = channelPair();
  const text = channelPair();
  const aTarget = memoryTarget();
  const bTarget = memoryTarget();
  const aLink: MixedPeerLink = {
    peerId: "b",
    role: "initiator",
    conn: { close: vi.fn() } as unknown as MixedPeerLink["conn"],
    fileChannel: file.a as unknown as RTCDataChannel,
    textChannel: text.a as unknown as RTCDataChannel,
    keys: aKeys,
    sas: "123456",
    fileSender: new Sender(),
    fileReceiver: new Receiver(),
    textSender: new TextSender(),
    textReceiver: new TextReceiver(),
  };
  const bLink: MixedPeerLink = {
    peerId: "a",
    role: "responder",
    conn: { close: vi.fn() } as unknown as MixedPeerLink["conn"],
    fileChannel: file.b as unknown as RTCDataChannel,
    textChannel: text.b as unknown as RTCDataChannel,
    keys: bKeys,
    sas: "123456",
    fileSender: new Sender(),
    fileReceiver: new Receiver(),
    textSender: new TextSender(),
    textReceiver: new TextReceiver(),
  };
  // ensureLink mirrors the coordinator: it hands back whichever link is current,
  // so a rebuild replaces what a queued batch will launch onto.
  const links = { a: aLink, b: bLink };
  const a = createMixedFileSession({
    ensureLink: vi.fn(async () => links.a),
    pickSaveTarget: opts.pickA ?? (async () => aTarget),
    consentTimeoutMs: opts.consentTimeoutMs,
    receiveStallMs: opts.receiveStallMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    gapTimeoutMs: opts.gapTimeoutMs,
  });
  const b = createMixedFileSession({
    ensureLink: vi.fn(async () => links.b),
    pickSaveTarget: opts.pickB ?? (async () => bTarget),
    consentTimeoutMs: opts.consentTimeoutMs,
    receiveStallMs: opts.receiveStallMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    gapTimeoutMs: opts.gapTimeoutMs,
  });
  a.attach(aLink);
  b.attach(bLink);
  return { a, b, aLink, bLink, links, file, text, aTarget, bTarget };
}

async function until(check: () => boolean, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const picked = (name: string, body: string) => [{ file: new File([body], name) }];
const bytes = (text: string) => [...new TextEncoder().encode(text)];

beforeEach(async () => { await ready(); });

describe("mixed file session", () => {
  it("waits for explicit consent, then transfers a batch without closing either lane", async () => {
    const { a, b, file, text, bTarget, aLink, bLink } = await harness();
    a.enqueue("b", picked("hello.txt", "hello"));
    await until(() => !!b.incoming);

    expect(new Uint8Array(file.a.sent[0])[0]).toBe(FRAME.BATCH);
    expect(file.a.sent).toHaveLength(1);
    expect(b.recv).toBeNull();

    b.accept();
    await until(() => a.send?.done === true && b.recv?.done === true);
    expect(a.send?.status).toBe("sendDone");
    expect(b.recv?.status).toBe("recvDone");
    expect([...bTarget.output.get("hello.txt")!]).toEqual(bytes("hello"));
    expect(file.a.readyState).toBe("open");
    expect(file.b.readyState).toBe("open");
    expect(text.a.readyState).toBe("open");
    expect(text.b.readyState).toBe("open");
    expect(aLink.conn.close).not.toHaveBeenCalled();
    expect(bLink.conn.close).not.toHaveBeenCalled();
  });

  it("advances every file in a multi-file batch and finalizes its save target once", async () => {
    const target = memoryTarget();
    const done = vi.fn();
    target.done = done;
    const { a, b } = await harness({ pickB: async () => target });
    a.enqueue("b", [
      { file: new File(["one"], "one.txt") },
      { file: new File(["two"], "two.txt") },
    ]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "sendDone" && b.recv?.status === "recvDone");
    expect([...target.output.get("one.txt")!]).toEqual(bytes("one"));
    expect([...target.output.get("two.txt")!]).toEqual(bytes("two"));
    expect(done).toHaveBeenCalledOnce();
  });

  it("does not decrypt protected file content sent before consent", async () => {
    const { b, bLink, aLink, file, bTarget, text } = await harness();
    const feed = vi.spyOn(bLink.fileReceiver, "feed");
    const source = new File(["secret"], "early.txt");
    file.a.send(await aLink.fileSender.batchFrame([{ name: source.name, size: source.size }], aLink.keys));
    await until(() => !!b.incoming);
    expect(feed).toHaveBeenCalledOnce(); // manifest only

    const frames = aLink.fileSender.dataFrames([source], aLink.keys);
    const first = await frames.next();
    expect(first.done).toBe(false);
    file.a.send(first.value!);
    await until(() => b.errorKey === "failed");
    expect(feed).toHaveBeenCalledOnce();
    expect(bTarget.output.size).toBe(0);
    expect(text.b.readyState).toBe("open");
  });

  it("fails the file lane when authenticated content exceeds the declared drain bound", async () => {
    const { b, aLink, file, text } = await harness();
    const source = new File([new Uint8Array(192 * 1024)], "oversized.bin");
    file.a.send(await aLink.fileSender.batchFrame([{ name: source.name, size: 1 }], aLink.keys));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "receiving");

    for await (const frame of aLink.fileSender.dataFrames([source], aLink.keys)) {
      file.a.send(frame);
      if (new Uint8Array(frame)[0] === FRAME.CHUNK) break;
    }
    await until(() => b.errorKey === "failed");
    expect(file.b.readyState).toBe("closed");
    expect(text.b.readyState).toBe("open");
  });

  it("reports integrity failure with REJECT and waits for BATCH_ABORT instead of sending COMPLETE", async () => {
    const { b, aLink, file } = await harness();
    const good = new File(["good"], "same.txt");
    const evil = new File(["evil"], "same.txt");
    const sender = aLink.fileSender;
    const other = new Sender();
    const manifest = await sender.batchFrame([{ name: good.name, size: good.size }], aLink.keys);
    await other.batchFrame([{ name: evil.name, size: evil.size }], aLink.keys);
    const goodFrames: Uint8Array<ArrayBuffer>[] = [];
    for await (const frame of sender.dataFrames([good], aLink.keys)) goodFrames.push(frame);
    const evilFrames: Uint8Array<ArrayBuffer>[] = [];
    for await (const frame of other.dataFrames([evil], aLink.keys)) evilFrames.push(frame);

    file.a.send(manifest);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "receiving");
    file.a.send(goodFrames[0]);
    file.a.send(evilFrames[1]); // valid ciphertext/seq, deliberately wrong file hash
    await until(() => b.recv?.status === "integrityFail");
    expect(file.b.sent.some((frame) => new Uint8Array(frame)[0] === REJECT[0])).toBe(true);
    expect(file.b.sent.some((frame) => new Uint8Array(frame)[0] === COMPLETE[0])).toBe(false);
    expect(b.active()).toBe(true);
    file.a.send(BATCH_ABORT);
    await until(() => !b.active());
    expect(b.recv?.status).toBe("integrityFail");
  });

  it("keeps local selections FIFO and reuses link-owned codecs across batches", async () => {
    const { a, b, bTarget } = await harness();
    a.enqueue("b", picked("one.txt", "one"));
    a.enqueue("b", picked("two.txt", "two"));

    await until(() => b.incoming?.files[0].name === "one.txt");
    b.accept();
    await until(() => b.incoming?.files[0].name === "two.txt");
    b.accept();
    await until(() => a.send?.done === true && b.recv?.files[0].name === "two.txt" && b.recv.done);

    expect([...bTarget.output.keys()]).toEqual(["one.txt", "two.txt"]);
    expect([...bTarget.output.get("one.txt")!]).toEqual(bytes("one"));
    expect([...bTarget.output.get("two.txt")!]).toEqual(bytes("two"));
  });

  it("uses REJECT as a clean pre-content barrier and immediately offers the next queued batch", async () => {
    const { a, b, bTarget } = await harness();
    a.enqueue("b", picked("no.txt", "private"));
    a.enqueue("b", picked("yes.txt", "accepted"));
    await until(() => b.incoming?.files[0].name === "no.txt");
    b.reject();
    await until(() => b.incoming?.files[0].name === "yes.txt");
    b.accept();
    await until(() => b.recv?.done === true);
    expect(bTarget.output.has("no.txt")).toBe(false);
    expect([...bTarget.output.get("yes.txt")!]).toEqual(bytes("accepted"));
  });

  it("opens the save picker synchronously and asks notification permission only after it resolves", async () => {
    let resolveTarget!: (target: SaveTarget) => void;
    const targetPromise = new Promise<SaveTarget>((resolve) => { resolveTarget = resolve; });
    const pick = vi.fn(() => targetPromise);
    const notify = vi.fn();
    const { a, b, bLink } = await harness({ pickB: pick });
    // Recreate only B with the notification seam while preserving the live link.
    b.detach();
    const receiver = createMixedFileSession({
      ensureLink: async () => bLink,
      pickSaveTarget: pick, requestNotify: notify,
    });
    receiver.attach(bLink);

    a.enqueue("b", picked("gesture.txt", "x"));
    await until(() => !!receiver.incoming);
    receiver.accept();
    expect(pick).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    resolveTarget(memoryTarget());
    await until(() => receiver.recv?.status === "receiving" || receiver.recv?.done === true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("resolves simultaneous offers deterministically and replays the larger peer's batch once", async () => {
    const { a, b, aTarget, bTarget } = await harness();
    a.enqueue("b", picked("from-a.txt", "A"));
    b.enqueue("a", picked("from-b.txt", "B"));

    // a is lexicographically smaller, so its outbound batch wins the collision.
    await until(() => b.incoming?.files[0].name === "from-a.txt");
    expect(a.incoming).toBeNull();
    b.accept();
    await until(() => b.recv?.done === true);

    // b retained its own intent and offers it once the winning batch is complete.
    await until(() => a.incoming?.files[0].name === "from-b.txt", 5_000);
    a.accept();
    await until(() => a.recv?.done === true && b.send?.done === true);
    expect([...bTarget.output.get("from-a.txt")!]).toEqual(bytes("A"));
    expect([...aTarget.output.get("from-b.txt")!]).toEqual(bytes("B"));
    expect(a.queued).toHaveLength(0);
    expect(b.queued).toHaveLength(0);
  });

  it("applies deterministic glare while the larger peer is still resolving its link", async () => {
    const { a, b, bLink, aTarget, bTarget } = await harness();
    b.detach();
    let resolveLink!: (link: MixedPeerLink) => void;
    const linkGate = new Promise<MixedPeerLink>((resolve) => { resolveLink = resolve; });
    const larger = createMixedFileSession({
      ensureLink: () => linkGate,
      pickSaveTarget: async () => bTarget,
    });
    larger.attach(bLink);

    larger.enqueue("a", picked("larger.txt", "B"));
    // Glare ownership comes from the authenticated link role, so a signalling
    // reconnect cannot flip it by temporarily clearing the roster self id.
    a.enqueue("b", picked("smaller.txt", "A"));
    await until(() => larger.incoming?.files[0].name === "smaller.txt");
    expect(larger.queued[0]?.replayed).toBe(true);
    larger.accept();
    await until(() => larger.recv?.status === "recvDone");

    resolveLink(bLink);
    await until(() => a.incoming?.files[0].name === "larger.txt");
    a.accept();
    await until(() => larger.send?.status === "sendDone");
    expect([...bTarget.output.get("smaller.txt")!]).toEqual(bytes("A"));
    expect([...aTarget.output.get("larger.txt")!]).toEqual(bytes("B"));
    expect(larger.queued).toHaveLength(0);
  });

  it("does not replay a cancelled offer when glare crosses manifest encryption", async () => {
    const { a, b, bLink, bTarget } = await harness();
    let releaseManifest!: () => void;
    const gate = new Promise<void>((resolve) => { releaseManifest = resolve; });
    const original = bLink.fileSender.batchFrame.bind(bLink.fileSender);
    const batchFrame = vi.spyOn(bLink.fileSender, "batchFrame").mockImplementation(async (...args) => {
      const frame = await original(...args);
      await gate;
      return frame;
    });

    b.enqueue("a", picked("cancelled.txt", "B"));
    await until(() => batchFrame.mock.calls.length === 1);
    b.cancel("send");
    a.enqueue("b", picked("winning.txt", "A"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseManifest();

    await until(() => b.incoming?.files[0].name === "winning.txt");
    expect(b.queued).toHaveLength(0);
    b.accept();
    await until(() => b.recv?.status === "recvDone" && !a.active() && !b.active());
    expect([...bTarget.output.get("winning.txt")!]).toEqual(bytes("A"));
    expect(a.incoming).toBeNull();
    expect(b.send).toBeNull();
  });

  it("cancels a local batch while link establishment is still pending", async () => {
    const { aLink } = await harness();
    const batchFrame = vi.spyOn(aLink.fileSender, "batchFrame");
    let resolveLink!: (link: MixedPeerLink) => void;
    const gate = new Promise<MixedPeerLink>((resolve) => { resolveLink = resolve; });
    const session = createMixedFileSession({ ensureLink: () => gate });
    session.enqueue("b", picked("cancel-connect.txt", "x"));
    expect(session.send?.status).toBe("connecting");
    session.cancel("send");
    expect(session.active()).toBe(false);
    expect(session.send).toBeNull();

    resolveLink(aLink);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.active()).toBe(false);
    expect(batchFrame).not.toHaveBeenCalled();
  });

  it("bounds automatic BUSY replay to one attempt", async () => {
    const { a, b, file } = await harness();
    a.enqueue("b", picked("twice-busy.txt", "x"));
    await until(() => b.incoming?.files[0].name === "twice-busy.txt");
    // First BUSY requeues the intent. B still owns the first incoming prompt, so
    // its always-on demux answers the replayed manifest with the second BUSY.
    file.b.send(FILE_BUSY);
    await until(() => a.send?.status === "peerBusy");
    expect(a.queued).toHaveLength(0);
    expect(a.active()).toBe(false);
    b.reject();
  });

  it("clamps a forged ACK to bytes actually emitted in the current batch", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const slowTarget: SaveTarget = {
      label: "slow",
      async file() {
        return { async write() { await gate; }, async close() {} };
      },
    };
    const { a, b, file } = await harness({ pickB: async () => slowTarget });
    const body = new Uint8Array(12 * 1024 * 1024);
    a.enqueue("b", [{ file: new File([body], "large.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "sending");

    // An old implementation accepted this huge cumulative value and disabled
    // its receive-memory window. It is larger than bytes sent, so must be ignored.
    file.b.send(ackFrame(Number.MAX_SAFE_INTEGER));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = file.a.sent
      .filter((frame) => new Uint8Array(frame)[0] === FRAME.CHUNK)
      .reduce((sum, frame) => sum + frame.byteLength - CHUNK_OVERHEAD, 0);
    expect(sent).toBeLessThanOrEqual(FLOW_WINDOW + 192 * 1024);
    expect(sent).toBeLessThan(body.length);

    a.cancel("send");
    releaseWrite();
    await until(() => !a.active() && !b.active());
  }, 10_000);

  it("uses the receive watchdog to request an abort and reuses the lane after progress resumes", async () => {
    let releaseFrames!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFrames = resolve; });
    const { a, b, aLink } = await harness({ receiveStallMs: 100, drainTimeoutMs: 500 });
    const original = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      await gate;
      yield* original(...args);
    });
    a.enqueue("b", picked("stall.txt", "resume"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "recvFail");
    releaseFrames();
    await until(() => !a.active() && !b.active());
    expect(b.errorKey).toBe("");

    a.enqueue("b", picked("after-stall.txt", "ok"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "recvDone");
  });

  it("fails a drain that makes no authenticated progress before its deadline", async () => {
    let releaseFrames!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFrames = resolve; });
    const { a, b, aLink, text } = await harness({ receiveStallMs: 20, drainTimeoutMs: 30 });
    const original = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      await gate;
      yield* original(...args);
    });
    a.enqueue("b", picked("dead-stall.txt", "x"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.errorKey === "failed");
    expect(text.b.readyState).toBe("open");
    releaseFrames();
    a.reset();
  });

  it("bounds the serialized receive queue against an uncooperative peer", async () => {
    const { b, bLink, aLink, file, text } = await harness();
    const source = new File([new Uint8Array(64 * 1024)], "flood.bin");
    file.a.send(await aLink.fileSender.batchFrame([{ name: source.name, size: source.size }], aLink.keys));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "receiving");
    const frames = aLink.fileSender.dataFrames([source], aLink.keys);
    const first = await frames.next();
    expect(first.done).toBe(false);
    const feed = vi.spyOn(bLink.fileReceiver, "feed");
    for (let i = 0; i < 300; i++) {
      file.a.send(first.value!);
    }
    await until(() => b.errorKey === "failed");
    // All 300 delivery microtasks enqueue before recvChain starts. The byte bound
    // must fail synchronously, before even the first otherwise-valid chunk is fed.
    expect(feed).not.toHaveBeenCalled();
    expect(file.b.readyState).toBe("closed");
    expect(text.b.readyState).toBe("open");
  });

  it("serializes receive cancellation after an in-flight sink write and reuses the lane", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const events: string[] = [];
    const firstTarget: SaveTarget = {
      label: "slow",
      async file() {
        return {
          async write() { events.push("write-start"); await gate; events.push("write-end"); },
          async close() { events.push("close"); },
        };
      },
    };
    let picks = 0;
    const secondTarget = memoryTarget();
    const { a, b, file } = await harness({
      pickB: async () => (++picks === 1 ? firstTarget : secondTarget),
    });
    const body = new Uint8Array(2 * 1024 * 1024);
    a.enqueue("b", [{ file: new File([body], "cancel.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => events.includes("write-start"));
    b.cancel("recv");
    expect(events).toEqual(["write-start"]);
    await until(() => file.a.sent.some((frame) => isBatchAbort(frame)));
    expect(b.active()).toBe(true); // the ordered abort is still queued behind write()
    releaseWrite();
    await until(() => events.includes("close") && !a.active() && !b.active());
    expect(events).toEqual(["write-start", "write-end", "close"]);

    a.enqueue("b", picked("after-cancel.txt", "still works"));
    await until(() => b.incoming?.files[0].name === "after-cancel.txt");
    b.accept();
    await until(() => b.recv?.done === true && b.recv.files[0].name === "after-cancel.txt");
    expect([...secondTarget.output.get("after-cancel.txt")!]).toEqual(bytes("still works"));
  }, 10_000);

  it("sends BATCH_ABORT on consent timeout and retires a parked prompt", async () => {
    const { a, b, file } = await harness({ consentTimeoutMs: 30 });
    a.enqueue("b", picked("timeout.txt", "later"));
    await until(() => !!b.incoming);

    const sendFromB = file.b.send.bind(file.b);
    file.b.send = (data) => {
      if (typeof data !== "string" && !(data instanceof Blob)) {
        const view = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (view.length === 1 && view[0] === ACCEPT[0]) return; // model an ACCEPT delayed past timeout
      }
      sendFromB(data);
    };
    b.accept();
    await until(() => b.recv?.status === "receiving");

    await until(() => file.a.sent.some((frame) => isBatchAbort(frame)));
    await until(() => !a.active() && !b.active());
    expect(new Uint8Array(BATCH_ABORT)).toEqual(new Uint8Array([0xf8]));
    expect(b.incoming).toBeNull();
  });

  it("does not let a stale outbound erase a replacement link's incoming prompt", async () => {
    const { a, aLink, bLink, text } = await harness();
    let releaseManifest!: () => void;
    const manifestGate = new Promise<void>((resolve) => { releaseManifest = resolve; });
    const originalBatchFrame = aLink.fileSender.batchFrame.bind(aLink.fileSender);
    const batchFrame = vi.spyOn(aLink.fileSender, "batchFrame").mockImplementation(async (...args) => {
      const frame = await originalBatchFrame(...args);
      await manifestGate;
      return frame;
    });
    a.enqueue("b", picked("old.txt", "old"));
    await until(() => batchFrame.mock.calls.length === 1);

    const replacement = channelPair();
    const newLink: MixedPeerLink = {
      ...aLink,
      fileChannel: replacement.a as unknown as RTCDataChannel,
      fileSender: new Sender(),
      fileReceiver: new Receiver(),
    };
    a.detach();
    a.attach(newLink);
    const remoteSender = new Sender();
    replacement.b.send(await remoteSender.batchFrame([{ name: "new.txt", size: 1 }], bLink.keys));
    await until(() => a.incoming?.files[0].name === "new.txt");

    releaseManifest();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.incoming?.files[0].name).toBe("new.txt");
    expect(a.errorKey).toBe("");
    expect(replacement.a.readyState).toBe("open");
    expect(text.a.readyState).toBe("open");
    a.reject();
  });

  it("keeps cancellation terminal when it crosses a slow DONE close", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const created: string[] = [];
    const target: SaveTarget = {
      label: "slow-close",
      async file(name) {
        created.push(name);
        return {
          async write() {},
          async close() { await closeGate; },
        };
      },
    };
    const { a, b } = await harness({ pickB: async () => target });
    a.enqueue("b", [
      { file: new File(["one"], "one.txt") },
      { file: new File(["two"], "two.txt") },
    ]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => created.length === 1 && b.recv?.sent === 3);
    b.cancel("recv");
    releaseClose();
    await until(() => !a.active() && !b.active());
    expect(b.recv?.status).toBe("recvFail");
    expect(b.recv?.ok).toBe(false);
    expect(created).toEqual(["one.txt"]);
  });

  it("reset retires an active sink after its admitted write and clears the session", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const events: string[] = [];
    const target: SaveTarget = {
      label: "reset",
      async file() {
        return {
          async write() { events.push("write-start"); await gate; events.push("write-end"); },
          async close() { events.push("close"); },
        };
      },
    };
    const { a, b } = await harness({ pickB: async () => target });
    a.enqueue("b", [{ file: new File([new Uint8Array(512 * 1024)], "reset.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => events.includes("write-start"));
    b.reset();
    expect(b.active()).toBe(false);
    expect(b.link).toBeNull();
    expect(events).toEqual(["write-start"]);
    releaseWrite();
    await until(() => events.includes("close"));
    expect(events).toEqual(["write-start", "write-end", "close"]);
    a.reset();
  });

  it("keeps protected nonce sequence unique across an aborted and successful batch", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let pickCount = 0;
    const slowTarget: SaveTarget = {
      label: "slow",
      async file() {
        return { async write() { await writeGate; }, async close() {} };
      },
    };
    const finalTarget = memoryTarget();
    const { a, b, file } = await harness({
      pickB: async () => (++pickCount === 1 ? slowTarget : finalTarget),
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(12 * 1024 * 1024)], "abort.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "sending");
    a.cancel("send");
    releaseWrite();
    await until(() => !a.active() && !b.active());

    a.enqueue("b", picked("success.txt", "success"));
    await until(() => b.incoming?.files[0].name === "success.txt");
    b.accept();
    await until(() => a.send?.status === "sendDone");

    const seqs = file.a.sent.flatMap((frame) => {
      const view = new Uint8Array(frame);
      if (view[0] !== FRAME.BATCH && view[0] !== FRAME.CHUNK && view[0] !== FRAME.DONE) return [];
      return [new DataView(frame).getUint32(1)];
    });
    expect(seqs).toEqual(seqs.map((_, index) => index));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("fails only the file lane on malformed protected input", async () => {
    const { b, file, text, bLink } = await harness();
    file.b.onmessage?.(new MessageEvent("message", { data: new Uint8Array([0x42]).buffer }));
    await until(() => b.errorKey === "failed");
    expect(file.b.readyState).toBe("closed");
    expect(text.b.readyState).toBe("open");
    expect(bLink.conn.close).not.toHaveBeenCalled();

    const received = vi.fn();
    text.a.onmessage = received;
    text.b.send(new Uint8Array([7]));
    await until(() => received.mock.calls.length === 1);
    expect(new Uint8Array(received.mock.calls[0][0].data)).toEqual(new Uint8Array([7]));
  });
});

// A transport gap on the file lane is repairable, and this is where that claim
// is either true or a bug: the codecs survive, so anything this lane gets wrong
// about its own sequence is wrong for the rest of the link's life.
describe("mixed file session transport recovery", () => {
  /** Model an authenticated transport rebuild: brand-new channels, the same peer
   *  and the SAME four codec objects. That identity is replaceTransport's whole
   *  contract, and it is what tells a rebuild apart from a new link. */
  function rebuild(
    aLink: MixedPeerLink,
    bLink: MixedPeerLink,
    links?: { a: MixedPeerLink; b: MixedPeerLink },
  ) {
    const swap = channelPair();
    const aNext = { ...aLink, fileChannel: swap.a as unknown as RTCDataChannel };
    const bNext = { ...bLink, fileChannel: swap.b as unknown as RTCDataChannel };
    if (links) { links.a = aNext; links.b = bNext; }
    return { swap, aNext, bNext };
  }

  const kindOf = (frame: ArrayBuffer) => new Uint8Array(frame)[0];
  const isProtected = (frame: ArrayBuffer) =>
    kindOf(frame) === FRAME.BATCH || kindOf(frame) === FRAME.CHUNK || kindOf(frame) === FRAME.DONE;
  const seqOf = (frame: ArrayBuffer) => new DataView(frame).getUint32(1);
  const announced = (frame: ArrayBuffer) =>
    JSON.parse(new TextDecoder().decode(new Uint8Array(frame).slice(5))) as
      { index: number; offset: number; seq: number };

  it("fails the interrupted batch, then runs the next one byte-exactly on a new transport", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness();
    a.enqueue("b", [{ file: new File([new Uint8Array(3 * 1024 * 1024)], "interrupted.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "sending" && (b.recv?.sent ?? 0) > 0);

    // Both ends observe the drop. Neither lane is poisoned by it.
    file.a.close();
    file.b.close();
    await until(() => a.send?.done === true && b.recv?.done === true);
    expect(a.send?.status).toBe("sendFail");
    expect(b.recv?.status).toBe("recvFail");
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");

    a.enqueue("b", picked("after-gap.txt", "recovered byte exactly"));
    await until(() => b.incoming?.files[0].name === "after-gap.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone" && a.send?.status === "sendDone");
    expect([...bTarget.output.get("after-gap.txt")!]).toEqual(bytes("recovered byte exactly"));

    // Exactly one announcement, before the generation's first protected frame,
    // naming the seq that frame actually carries.
    const resumes = swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME);
    expect(resumes).toHaveLength(1);
    expect(swap.a.sent.findIndex((frame) => kindOf(frame) === FRAME.RESUME)).toBe(0);
    const point = announced(resumes[0]);
    expect(point.index).toBe(0);
    expect(point.offset).toBe(0);
    expect(seqOf(swap.a.sent.find(isProtected)!)).toBe(point.seq);

    // One nonce sequence for the link's life: unique and strictly increasing
    // across BOTH transport generations.
    const seqs = [...file.a.sent, ...swap.a.sent].filter(isProtected).map(seqOf);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(text.a.readyState).toBe("open");
    expect(text.b.readyState).toBe("open");
  });

  it("announces realignment once per generation, not once per batch", async () => {
    const { a, b, aLink, bLink, links, file } = await harness();
    file.a.close();
    file.b.close();
    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);

    a.enqueue("b", picked("first.txt", "one"));
    await until(() => b.incoming?.files[0].name === "first.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");
    a.enqueue("b", picked("second.txt", "two"));
    await until(() => b.incoming?.files[0].name === "second.txt");
    b.accept();
    await until(() => b.recv?.files[0].name === "second.txt" && b.recv.status === "recvDone");

    expect(swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME)).toHaveLength(1);
  });

  it("fails the lane on a protected frame that skips realignment after a gap", async () => {
    const { b, aLink, bLink, links, file, text } = await harness();
    file.b.close();
    const { swap, bNext } = rebuild(aLink, bLink, links);
    b.attach(bNext);

    // A peer that just carries on where it left off. Its sequence may well line
    // up, but this side cannot prove what it dropped in the gap.
    swap.a.send(await aLink.fileSender.batchFrame([{ name: "sneaky.txt", size: 1 }], aLink.keys));

    await until(() => b.errorKey === "failed");
    expect(b.incoming).toBeNull();
    expect(text.b.readyState).toBe("open");
  });

  it("fails the lane on a second realignment inside one generation", async () => {
    const { a, b, aLink, bLink, links, file } = await harness();
    file.a.close();
    file.b.close();
    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    a.enqueue("b", picked("ok.txt", "fine"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "recvDone");

    swap.a.send(aLink.fileSender.resumeStartFrame({ index: 0, offset: 0 }));

    await until(() => b.errorKey === "failed");
  });

  it("fails the lane on a realignment that claims a byte-level resume point", async () => {
    const { b, aLink, bLink, links, file, text } = await harness();
    file.b.close();
    const { swap, bNext } = rebuild(aLink, bLink, links);
    b.attach(bNext);

    // Byte-level continuation is the next slice. Until then the only acceptable
    // announcement is the batch-free origin.
    swap.a.send(aLink.fileSender.resumeStartFrame({ index: 2, offset: 4096 }));

    await until(() => b.errorKey === "failed");
    expect(text.b.readyState).toBe("open");
  });

  it("never rewinds the receive nonce for a backwards realignment", async () => {
    const { a, b, aLink, bLink, links, file } = await harness();
    a.enqueue("b", picked("first.txt", "advance the sequence"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.status === "recvDone");
    file.a.close();
    file.b.close();
    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);

    // A forged announcement from a sequence that has already been spent.
    swap.a.send(new Sender().resumeStartFrame({ index: 0, offset: 0 }));

    await until(() => b.errorKey === "failed");
    // The receiver still refuses to go back: an old ciphertext cannot be made
    // valid again under the same key and sequence number.
    expect(() => bLink.fileReceiver.resumeAt(new Uint8Array(32), 0)).toThrow(/backwards/);
  });

  it("keeps the codecs reusable when protected bytes were still buffered at the gap", async () => {
    const { a, b, aLink, bLink, links, file, bTarget } = await harness();
    const send = file.a.send;
    let dropped = false;
    file.a.send = function (data) {
      send.call(this, data);
      if (dropped || typeof data === "string" || data instanceof Blob) return;
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (view[0] !== FRAME.CHUNK) return;
      dropped = true;
      // Drop synchronously after the first protected frame enters the SCTP send
      // buffer. This makes the race deterministic instead of polling a transient
      // `sending` UI state that a fast in-memory channel can skip between ticks.
      file.a.bufferedAmount = 512 * 1024;
      file.a.close();
      file.b.close();
    };
    a.enqueue("b", [{ file: new File([new Uint8Array(2 * 1024 * 1024)], "buffered.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.done === true);
    expect(dropped).toBe(true);

    expect(a.errorKey).toBe("");
    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    a.enqueue("b", picked("after-buffered.txt", "still works"));
    await until(() => b.incoming?.files[0].name === "after-buffered.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");
    expect([...bTarget.output.get("after-buffered.txt")!]).toEqual(bytes("still works"));
  });

  it("drops frames admitted but never fed, without poisoning, and stays byte-exact", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let picks = 0;
    const stalled: SaveTarget = {
      label: "stalled",
      async file() { return { async write() { await gate; }, async close() {} }; },
    };
    const finalTarget = memoryTarget();
    const { a, b, aLink, bLink, links, file } = await harness({
      pickB: async () => (++picks === 1 ? stalled : finalTarget),
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(4 * 1024 * 1024)], "stalled.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "sending");
    // The receive chain is blocked on the first write, so later frames sit in it
    // admitted-but-unfed when the transport dies.
    await until(() => file.b.sent.length > 0 || (a.send?.sent ?? 0) > 0);

    file.a.close();
    file.b.close();
    releaseWrite();
    await until(() => a.send?.done === true && b.recv?.done === true);
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");

    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    a.enqueue("b", picked("after-drop.txt", "exact"));
    await until(() => b.incoming?.files[0].name === "after-drop.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");
    expect([...finalTarget.output.get("after-drop.txt")!]).toEqual(bytes("exact"));
  }, 10_000);

  it("closes the inbound sink once, after the in-flight write, never beside it", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const events: string[] = [];
    const target: SaveTarget = {
      label: "slow",
      async file() {
        return {
          async write() { events.push("write-start"); await gate; events.push("write-end"); },
          async close() { events.push("close"); },
        };
      },
    };
    const { a, b, file } = await harness({ pickB: async () => target });
    a.enqueue("b", [{ file: new File([new Uint8Array(2 * 1024 * 1024)], "gap.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => events.includes("write-start"));

    file.b.close();
    file.a.close();
    expect(events).toEqual(["write-start"]);
    releaseWrite();
    await until(() => events.includes("close"));
    expect(events).toEqual(["write-start", "write-end", "close"]);
  }, 10_000);

  it("unblocks a sender parked on flow-control credit as soon as the transport dies", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const stalled: SaveTarget = {
      label: "stalled",
      async file() { return { async write() { await gate; }, async close() {} }; },
    };
    const { a, b, file } = await harness({ pickB: async () => stalled });
    a.enqueue("b", [{ file: new File([new Uint8Array(24 * 1024 * 1024)], "window.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    // Fill the flow window so the sender is waiting on credit that will never come.
    const onWire = () => file.a.sent
      .filter((frame) => new Uint8Array(frame)[0] === FRAME.CHUNK)
      .reduce((sum, frame) => sum + frame.byteLength - CHUNK_OVERHEAD, 0);
    await until(() => onWire() >= FLOW_WINDOW);

    file.a.close();
    // Far below the 60 s stall timeout: a parked send must not wait it out.
    await until(() => a.send?.status === "sendFail", 2_000);
    releaseWrite();
  }, 15_000);

  it("keeps a pre-gap send that resolves late inert against the rebuilt generation", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness();
    let releaseManifest!: () => void;
    const manifestGate = new Promise<void>((resolve) => { releaseManifest = resolve; });
    const original = aLink.fileSender.batchFrame.bind(aLink.fileSender);
    const batchFrame = vi.spyOn(aLink.fileSender, "batchFrame").mockImplementation(async (...args) => {
      const frame = await original(...args);
      await manifestGate;
      return frame;
    });
    a.enqueue("b", picked("crossing.txt", "never sent"));
    await until(() => batchFrame.mock.calls.length === 1);

    // The gap crosses manifest encryption: a nonce is burned for a frame that
    // never leaves this side.
    file.a.close();
    file.b.close();
    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    releaseManifest();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The stale send neither poisons the reused codecs nor re-suspends the
    // rebuilt lane.
    expect(a.errorKey).toBe("");
    expect(a.send?.status).toBe("sendFail");
    batchFrame.mockRestore();

    a.enqueue("b", picked("after-crossing.txt", "burned nonce repaired"));
    await until(() => b.incoming?.files[0].name === "after-crossing.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");
    expect([...bTarget.output.get("after-crossing.txt")!]).toEqual(bytes("burned nonce repaired"));
    expect(text.a.readyState).toBe("open");
  });

  it("fails the lane, and only the lane, when no replacement arrives in time", async () => {
    const { a, b, file, text, bLink } = await harness({ gapTimeoutMs: 30 });
    a.enqueue("b", picked("orphan.txt", "x"));
    await until(() => !!b.incoming);
    file.b.close();

    await until(() => b.errorKey === "failed");
    expect(text.b.readyState).toBe("open");
    expect(bLink.conn.close).not.toHaveBeenCalled();
    a.reset();
  });

  it("bounds the gap with a deliberately longer timeout than the link's own window", () => {
    expect(MIXED_FILE_GAP_TIMEOUT_MS).toBe(120_000);
  });

  it("records recovery intent at the gap, and clears it only on replacement", async () => {
    const { a, b, aLink, bLink, links, file } = await harness();
    expect(a.needsRecovery()).toBe(false);

    a.enqueue("b", picked("intent.txt", "x"));
    await until(() => !!b.incoming);
    file.a.close();

    // active() is already terminal here — which is exactly why the marker exists.
    expect(a.active()).toBe(false);
    expect(a.needsRecovery()).toBe(true);
    a.suspend(); // idempotent second entry, from the coordinator
    expect(a.needsRecovery()).toBe(true);

    const { aNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    expect(a.needsRecovery()).toBe(false);
    b.reset();
  });

  it("does not claim recovery for an idle lane, and a double suspend is one gap", async () => {
    const { a, b, file } = await harness();
    a.suspend();
    a.suspend();
    file.a.close(); // the real onclose, after the coordinator already suspended

    expect(a.needsRecovery()).toBe(false);
    expect(a.errorKey).toBe("");
    expect(a.active()).toBe(false);
    b.reset();
  });

  it("holds a queued batch through the gap and launches it on the replacement", async () => {
    const { a, b, aLink, bLink, links, file, bTarget } = await harness();
    a.enqueue("b", picked("gap-queued.txt", "queued through the gap"));
    await until(() => !!b.incoming);
    b.reject();
    await until(() => !b.incoming);
    file.a.close();
    file.b.close();
    // Enqueued while there is no transport at all.
    a.enqueue("b", picked("mid-gap.txt", "enqueued mid gap"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.queued).toHaveLength(1);
    expect(a.needsRecovery()).toBe(true);

    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => b.incoming?.files[0].name === "mid-gap.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");
    expect([...bTarget.output.get("mid-gap.txt")!]).toEqual(bytes("enqueued mid gap"));
    expect(a.queued).toHaveLength(0);
  });
});
