import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { deriveSession, generateKeyPair, ready, type SessionKeys } from "./crypto";
import { createMixedFileSession, MIXED_FILE_GAP_TIMEOUT_MS } from "./mixed-file-session.svelte";
import { SaveCancelledError, type SaveTarget } from "./filesink";
import type { MixedPeerLink } from "./peer-link.svelte";
import {
  BATCH_ABORT,
  ACCEPT,
  COMPLETE,
  CHUNK_OVERHEAD,
  CHUNK_SIZE,
  FILE_BUSY,
  FLOW_WINDOW,
  Receiver,
  REJECT,
  Sender,
  FRAME,
  ackFrame,
  isBatchAbort,
  resumeReqFrame,
} from "./transfer";
import { TextReceiver, TextSender } from "./text-wire";
import {
  KIND_STORED_KEYS,
  StoredKeysReceiver,
  StoredKeysSender,
  type HandoffItem,
} from "./preupload-handoff";
import { encodeKey } from "./store-crypto";

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
  /** B 侧单独的同意窗口。默认与 A 侧同值（真实部署就是同一个常量）；只有那条
   *  「接收端的窗口先走完」的用例需要把两侧岔开，好在发送端放弃之前观察接收端。 */
  consentTimeoutMsB?: number;
  /** Pre-upload key handoff wiring, per side. Omitted by every existing case, so
   *  the lane behaves exactly as it did before frame kind 12 existed. */
  storedKeysA?: () => readonly HandoffItem[];
  onStoredKeysB?: (items: HandoffItem[]) => void;
  onStoredKeysA?: (items: HandoffItem[]) => void;
  /** Which peer ids announced `preupload/1`. Default: neither. */
  preuploadPeers?: string[];
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
    conn: { close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES } as unknown as MixedPeerLink["conn"],
    fileChannel: file.a as unknown as RTCDataChannel,
    textChannel: text.a as unknown as RTCDataChannel,
    keys: aKeys,
    sas: "123456",
    fileSender: new Sender(),
    fileReceiver: new Receiver(),
    textSender: new TextSender(),
    textReceiver: new TextReceiver(),
    storedKeysSender: new StoredKeysSender(),
    storedKeysReceiver: new StoredKeysReceiver(),
  };
  const bLink: MixedPeerLink = {
    peerId: "a",
    role: "responder",
    conn: { close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES } as unknown as MixedPeerLink["conn"],
    fileChannel: file.b as unknown as RTCDataChannel,
    textChannel: text.b as unknown as RTCDataChannel,
    keys: bKeys,
    sas: "123456",
    fileSender: new Sender(),
    fileReceiver: new Receiver(),
    textSender: new TextSender(),
    textReceiver: new TextReceiver(),
    storedKeysSender: new StoredKeysSender(),
    storedKeysReceiver: new StoredKeysReceiver(),
  };
  // ensureLink mirrors the coordinator: it hands back whichever link is current,
  // so a rebuild replaces what a queued batch will launch onto.
  const links = { a: aLink, b: bLink };
  const speaks = new Set(opts.preuploadPeers ?? []);
  const supportsPreupload = (peerId: string) => speaks.has(peerId);
  const a = createMixedFileSession({
    ensureLink: vi.fn(async () => links.a),
    pickSaveTarget: opts.pickA ?? (async () => aTarget),
    storedKeysToSend: opts.storedKeysA,
    onStoredKeys: opts.onStoredKeysA,
    supportsPreupload,
    consentTimeoutMs: opts.consentTimeoutMs,
    receiveStallMs: opts.receiveStallMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    gapTimeoutMs: opts.gapTimeoutMs,
  });
  const b = createMixedFileSession({
    ensureLink: vi.fn(async () => links.b),
    pickSaveTarget: opts.pickB ?? (async () => bTarget),
    onStoredKeys: opts.onStoredKeysB,
    supportsPreupload,
    consentTimeoutMs: opts.consentTimeoutMsB ?? opts.consentTimeoutMs,
    receiveStallMs: opts.receiveStallMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    gapTimeoutMs: opts.gapTimeoutMs,
  });
  a.attach(aLink);
  b.attach(bLink);
  return { a, b, aLink, bLink, links, file, text, aTarget, bTarget, speaks };
}

async function until(check: () => boolean, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The manifest as the single frame it is whenever the link can carry a whole
 *  chunk — which every link in this file can. */
async function batchFrame(s: Sender, files: Parameters<Sender["batchFrames"]>[0], keys: SessionKeys) {
  const frames = await s.batchFrames(files, keys);
  expect(frames).toHaveLength(1);
  return frames[0];
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
    file.a.send(await batchFrame(aLink.fileSender, [{ name: source.name, size: source.size }], aLink.keys));
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
    file.a.send(await batchFrame(aLink.fileSender, [{ name: source.name, size: 1 }], aLink.keys));
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
    const manifest = await batchFrame(sender, [{ name: good.name, size: good.size }], aLink.keys);
    await batchFrame(other, [{ name: evil.name, size: evil.size }], aLink.keys);
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

  // 线上事故的实时那一半：手机上选择器一个界面都没弹就 reject，接收卡片却写着
  // 「未选择保存位置，已取消」。这三条把归因钉死 —— 只有用户真的取消才叫取消。
  it("reports a picker that never presented UI as a save failure, not the user's cancellation", async () => {
    const pick = vi.fn(async () => { throw Object.assign(new Error("no chooser"), { name: "NotAllowedError" }); });
    const { a, b } = await harness({ pickB: pick });
    a.enqueue("b", picked("android.txt", "payload"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.done === true);
    expect(b.recv?.status).toBe("saveFail");
    // 发送端拿到的仍是一个干净的拒绝：REJECT 就是完整的顺序屏障，通道照旧可用。
    await until(() => a.send?.done === true);
    expect(a.send?.status).toBe("rejected");
    expect(b.incoming).toBeNull();
  });

  // 桌面上一次误按返回键/Esc 不该把整次接收判死。ACCEPT 之前这条 lane 上属于这一
  // 批的东西只有发送端那份 manifest，接收端一个字节都没往回发 —— 所以回到同意提示
  // 不动任何序号/nonce/世代/流控游标，发送端仍停在自己的 waitingAccept 里。
  it("re-asks after a genuine picker cancellation and the retry delivers the exact bytes", async () => {
    let attempts = 0;
    let good: SaveTarget | undefined;
    const pick = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new SaveCancelledError("cancelled by the user");
      return good!;
    });
    const h = await harness({ pickB: pick });
    good = h.bTarget;
    const { a, b } = h;
    a.enqueue("b", picked("retried.txt", "payload"));
    await until(() => !!b.incoming);

    b.accept();
    // 取消没有把提示变成失败卡片：它原地换了一句话，等第二次点击。
    await until(() => b.incoming?.retry === true);
    expect(b.recv, "取消不是一次失败的接收").toBeNull();
    expect(a.send?.done, "发送端必须还在等同一个答复").toBeFalsy();
    expect(a.send?.status).toBe("waitingAccept");

    b.accept();
    await until(() => b.recv?.done === true);
    expect(b.recv?.ok).toBe(true);
    expect(pick).toHaveBeenCalledTimes(2);
    expect([...h.bTarget.output.get("retried.txt")!]).toEqual(bytes("payload"));
    await until(() => a.send?.done === true && a.send.ok === true);
  });

  it("still lets the user decline after a cancellation put the prompt back", async () => {
    const pick = vi.fn(async () => { throw new SaveCancelledError("cancelled by the user"); });
    const { a, b } = await harness({ pickB: pick });
    a.enqueue("b", picked("nope.txt", "payload"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.incoming?.retry === true);
    b.reject();
    await until(() => a.send?.status === "rejected");
    expect(b.incoming).toBeNull();
  });

  // 同意窗口是发送端和接收端共用的同一个 consentTimeoutMs。窗口一过，发送端已经
  // BATCH_ABORT 了这一批，把提示放回可点击状态就是让用户点一个不存在的批次。
  // 这时不假装还能重试 —— 如实报「取消」并收场。
  it("does not re-ask once the consent window has run out during the pick", async () => {
    let rejectPick!: (err: unknown) => void;
    const pick = vi.fn(() => new Promise<SaveTarget>((_, reject) => { rejectPick = reject; }));
    // 两侧共用同一个 consentTimeoutMs。窗口一过，发送端就 BATCH_ABORT 了这一批，
    // 接收端的 consentExpired 也已经置位 —— 迟到的取消不能把提示放回可点击状态，
    // 否则用户点下的 ACCEPT 会发给一个早已放弃这一批的发送端。
    const { a, b } = await harness({ consentTimeoutMs: 60, pickB: pick });
    a.enqueue("b", picked("late.txt", "payload"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.done === true); // 发送端的窗口尽头 —— 也是接收端的
    expect(a.send?.status).toBe("rejected");

    rejectPick(new SaveCancelledError("cancelled by the user"));
    // 迟到的取消一句话都不许说：提示不回来，也不冒出一张能再点的卡片。
    await until(() => pick.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.incoming, "窗口已经关了，这张提示不能再回来").toBeNull();
    expect(b.recv?.done !== false, "不能留下一个还在转的接收").toBe(true);
  });

  it("refuses to re-ask from its own expiry alone, before the sender's abort can arrive", async () => {
    // 上一条里提示是被发送端的 BATCH_ABORT 收走的。真实链路上那个 abort 要走一个
    // 往返，而接收端自己的窗口在同一时刻就已经到点了 —— 中间这一小段，取消如果
    // 把提示放回去，用户点下的 ACCEPT 就发给了一个已经放弃这一批的发送端。
    // 两侧窗口在这里被故意岔开，好把那一小段拉开成可观察的。
    let rejectPick!: (err: unknown) => void;
    const pick = vi.fn(() => new Promise<SaveTarget>((_, reject) => { rejectPick = reject; }));
    const { a, b } = await harness({ consentTimeoutMs: 30_000, consentTimeoutMsB: 60, pickB: pick });
    a.enqueue("b", picked("racy.txt", "payload"));
    await until(() => !!b.incoming);
    b.accept();
    // 纯排序屏障，不是对耗时的断言：定时器只会晚到，不会早到，所以过了这一点
    // B 那个 60ms 的窗口一定已经开过火了。发送端的 30s 窗口还早得很。
    const startedAt = Date.now();
    await until(() => Date.now() - startedAt > 300);
    expect(a.send?.done, "发送端还没放弃 —— 这正是要观察的那一小段").toBeFalsy();

    rejectPick(new SaveCancelledError("cancelled by the user"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 过期以后 ACCEPT / REJECT 都不能再发：它们没有 batch id，迟到后可能回答发送端
    // 的下一批。接收端只隐藏失效提示，等发送端有序的 BATCH_ABORT 收尾。
    expect(b.incoming).toBeNull();
    expect(a.send?.status, "迟到的取消不能发 REJECT 回去").toBe("waitingAccept");
    a.cancel("send");
    await until(() => b.incoming === null);
  });

  it("never sends a late ACCEPT when the picker succeeds after consent expiry", async () => {
    let resolvePick!: (target: SaveTarget) => void;
    const pick = vi.fn(() => new Promise<SaveTarget>((resolve) => { resolvePick = resolve; }));
    const h = await harness({ consentTimeoutMs: 30_000, consentTimeoutMsB: 60, pickB: pick });
    const { a, b } = h;
    a.enqueue("b", picked("too-late.txt", "payload"));
    await until(() => !!b.incoming);
    b.accept();

    const startedAt = Date.now();
    await until(() => Date.now() - startedAt > 300);
    expect(b.incoming, "本地截止时刻一过就应隐藏失效的接收按钮").toBeNull();
    expect(a.send?.status).toBe("waitingAccept");

    resolvePick(h.bTarget);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.send?.status, "迟到的目标绝不能为当前或下一批发 ACCEPT").toBe("waitingAccept");
    expect(h.bTarget.output.has("too-late.txt"), "过期目标不能开始写文件").toBe(false);

    a.cancel("send");
    await until(() => b.incoming === null);
  });

  it("reports a target that fails to open the first file as a save failure", async () => {
    // 选择器给了目标，倒在写盘的第一步（目录分支的 getFileHandle/createWritable）。
    const pick = vi.fn(async () => ({
      label: "broken",
      file: async () => { throw new Error("createWritable: NotAllowedError"); },
    } as SaveTarget));
    const { a, b } = await harness({ pickB: pick });
    a.enqueue("b", picked("unwritable.txt", "payload"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => b.recv?.done === true);
    expect(b.recv?.status).toBe("saveFail");
    await until(() => a.send?.status === "rejected");
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
    const original = bLink.fileSender.batchFrames.bind(bLink.fileSender);
    const batchFrames = vi.spyOn(bLink.fileSender, "batchFrames").mockImplementation(async (...args) => {
      const frames = await original(...args);
      await gate;
      return frames;
    });

    b.enqueue("a", picked("cancelled.txt", "B"));
    await until(() => batchFrames.mock.calls.length === 1);
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
    const batchFrames = vi.spyOn(aLink.fileSender, "batchFrames");
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
    expect(batchFrames).not.toHaveBeenCalled();
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
    file.a.send(await batchFrame(aLink.fileSender, [{ name: source.name, size: source.size }], aLink.keys));
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
    const originalBatchFrame = aLink.fileSender.batchFrames.bind(aLink.fileSender);
    const batchFrames = vi.spyOn(aLink.fileSender, "batchFrames").mockImplementation(async (...args) => {
      const frames = await originalBatchFrame(...args);
      await manifestGate;
      return frames;
    });
    a.enqueue("b", picked("old.txt", "old"));
    await until(() => batchFrames.mock.calls.length === 1);

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
    replacement.b.send(await batchFrame(remoteSender, [{ name: "new.txt", size: 1 }], bLink.keys));
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

  it("resumes the interrupted batch byte-exactly on a new transport", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness();
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    const originalFrames = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      let held = false;
      for await (const frame of originalFrames(...args)) {
        yield frame;
        if (!held && frame[0] === FRAME.CHUNK) { held = true; await sourceGate; }
      }
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(3 * 1024 * 1024)], "interrupted.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => (b.recv?.sent ?? 0) > 0);

    // Both ends observe the drop. Neither lane is poisoned by it.
    file.a.close();
    file.b.close();
    releaseSource();
    await until(() => a.send?.status === "resuming" && b.recv?.status === "resuming");
    expect(a.send?.done).toBe(false);
    expect(b.recv?.done).toBe(false);
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");

    await until(() => b.recv?.status === "recvDone" && a.send?.status === "sendDone");
    expect(bTarget.output.get("interrupted.bin")).toEqual(new Uint8Array(3 * 1024 * 1024));

    // Exactly one announcement, before the generation's first protected frame,
    // naming the seq that frame actually carries.
    const resumes = swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME);
    expect(resumes).toHaveLength(1);
    expect(swap.a.sent.findIndex((frame) => kindOf(frame) === FRAME.RESUME)).toBe(0);
    const point = announced(resumes[0]);
    expect(point.index).toBe(0);
    expect(point.offset).toBeGreaterThan(0);
    expect(seqOf(swap.a.sent.find(isProtected)!)).toBe(point.seq);

    // One nonce sequence for the link's life: unique and strictly increasing
    // across BOTH transport generations.
    const seqs = [...file.a.sent, ...swap.a.sent].filter(isProtected).map(seqOf);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(text.a.readyState).toBe("open");
    expect(text.b.readyState).toBe("open");
  }, 30_000);

  it("resumes at a multi-file boundary without reopening consent or the completed file", async () => {
    const target = memoryTarget();
    const done = vi.fn();
    target.done = done;
    const pick = vi.fn(async () => target);
    const { a, b, aLink, bLink, links, file } = await harness({ pickB: pick });
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    const originalFrames = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      let held = false;
      for await (const frame of originalFrames(...args)) {
        yield frame;
        if (!held && frame[0] === FRAME.DONE) { held = true; await sourceGate; }
      }
    });
    a.enqueue("b", [
      { file: new File(["first"], "first.txt") },
      { file: new File(["second"], "second.txt") },
    ]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => target.output.has("first.txt") && b.recv?.index === 1);
    file.a.close();
    file.b.close();
    releaseSource();
    await until(() => a.send?.status === "resuming" && b.recv?.status === "resuming");

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => a.send?.status === "sendDone" && b.recv?.status === "recvDone");

    expect([...target.output.get("first.txt")!]).toEqual(bytes("first"));
    expect([...target.output.get("second.txt")!]).toEqual(bytes("second"));
    expect(pick).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
    const point = announced(swap.a.sent.find((frame) => kindOf(frame) === FRAME.RESUME)!);
    expect(point).toMatchObject({ index: 1, offset: 0 });
  });

  it("honors receiver cancellation during the gap without resuming protected bytes", async () => {
    const target = memoryTarget();
    const pick = vi.fn(async () => target);
    const { a, b, aLink, bLink, links, file } = await harness({ pickB: pick });
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    const originalFrames = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      let held = false;
      for await (const frame of originalFrames(...args)) {
        yield frame;
        if (!held && frame[0] === FRAME.CHUNK) { held = true; await sourceGate; }
      }
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(3 * CHUNK_SIZE)], "cancel-gap.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => (b.recv?.sent ?? 0) >= CHUNK_SIZE);
    file.a.close();
    file.b.close();
    releaseSource();
    await until(() => a.send?.status === "resuming" && b.recv?.status === "resuming");
    b.cancel("recv");
    expect(b.recv?.status).toBe("recvFail");

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => a.send?.status === "rejected" && !a.active() && !b.active());

    expect(pick).toHaveBeenCalledOnce();
    expect(target.output.get("cancel-gap.bin")?.length).toBe(CHUNK_SIZE);
    expect(swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME)).toHaveLength(0);
  });

  it("ends a batch the peer already rejected when the gap crosses that answer", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness();
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    const originalFrames = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    const frames = vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      let held = false;
      for await (const frame of originalFrames(...args)) {
        yield frame;
        if (!held && frame[0] === FRAME.CHUNK) { held = true; await sourceGate; }
      }
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(3 * CHUNK_SIZE)], "answered-in-gap.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => (b.recv?.sent ?? 0) >= CHUNK_SIZE);

    // The receiver stops on a live transport, so its REJECT really does reach the
    // sender — the sender is just parked in source I/O and has not acted on it.
    b.cancel("recv");
    await until(() => file.b.sent.some((frame) => kindOf(frame) === REJECT[0]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    file.a.close();
    file.b.close();
    releaseSource();

    // A rejected batch has no resume point to wait for. Ending it on the answer
    // it already holds is what keeps the lane out of an unanswerable wait.
    await until(() => a.send?.done === true);
    expect(a.send?.status).toBe("rejected");
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");
    expect(a.active()).toBe(false);

    frames.mockRestore();
    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    a.enqueue("b", picked("after-reject.txt", "the lane survived the answer"));
    await until(() => b.incoming?.files[0].name === "after-reject.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");

    expect([...bTarget.output.get("after-reject.txt")!]).toEqual(bytes("the lane survived the answer"));
    expect(a.errorKey).toBe("");
    expect(swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME)).toHaveLength(1);
    expect(text.a.readyState).toBe("open");
  }, 15_000);

  it("keeps a completed batch successful when the gap crosses the observed answer", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness();
    const send = file.b.send;
    let cut = false;
    file.b.send = function (data) {
      send.call(this, data);
      if (cut || typeof data === "string" || data instanceof Blob) return;
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (view[0] !== COMPLETE[0]) return;
      cut = true;
      // FakeChannel delivers in a microtask. Queueing the close after it makes
      // the sender observe COMPLETE first, while still crossing the async
      // completion continuation with the transport gap.
      queueMicrotask(() => {
        file.a.close();
        file.b.close();
      });
    };

    a.enqueue("b", picked("answered-complete.txt", "durably complete"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => cut && a.send?.done === true);

    expect(a.send?.status).toBe("sendDone");
    expect(a.send?.ok).toBe(true);
    expect(b.recv?.status).toBe("recvDone");
    expect([...bTarget.output.get("answered-complete.txt")!]).toEqual(bytes("durably complete"));
    expect(a.errorKey).toBe("");
    expect(a.active()).toBe(false);

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    a.enqueue("b", picked("after-complete.txt", "the successful lane survived"));
    await until(() => b.incoming?.files[0].name === "after-complete.txt");
    b.accept();
    await until(() => a.send?.status === "sendDone" && b.recv?.status === "recvDone");

    expect([...bTarget.output.get("after-complete.txt")!]).toEqual(bytes("the successful lane survived"));
    expect(swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME)).toHaveLength(1);
    expect(text.a.readyState).toBe("open");
  });

  it("fails only the batch when its resume request never arrives, and realigns the next one", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness({ receiveStallMs: 300 });
    // The receiver's COMPLETE is lost in the gap. It finished and released its
    // lane, so no resume request can ever come for the batch the sender still
    // holds — the one legitimate way to reach the resume-wait deadline.
    const send = file.b.send;
    let cut = false;
    file.b.send = function (data) {
      send.call(this, data);
      if (cut || typeof data === "string" || data instanceof Blob) return;
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (view[0] !== COMPLETE[0]) return;
      cut = true;
      file.a.close();
      file.b.close();
    };
    a.enqueue("b", picked("lost-complete.txt", "written but unacknowledged"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => cut && a.send?.status === "resuming");
    expect(b.recv?.status).toBe("recvDone");
    expect([...bTarget.output.get("lost-complete.txt")!]).toEqual(bytes("written but unacknowledged"));

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);

    await until(() => a.send?.done === true);
    expect(a.send?.status).toBe("sendFail");
    // Nothing about an unanswered request proves the sequence is unusable, so
    // the failure is scoped to the batch and the lane keeps its realignment.
    expect(a.errorKey).toBe("");
    expect(a.active()).toBe(false);
    expect(swap.a.readyState).toBe("open"); // the replacement lane was not torn down

    a.enqueue("b", picked("after-timeout.txt", "the lane still works"));
    await until(() => b.incoming?.files[0].name === "after-timeout.txt");
    b.accept();
    await until(() => b.recv?.status === "recvDone");

    expect([...bTarget.output.get("after-timeout.txt")!]).toEqual(bytes("the lane still works"));
    expect(swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME)).toHaveLength(1);
    expect(swap.a.sent.findIndex((frame) => kindOf(frame) === FRAME.RESUME)).toBe(0);
    expect(b.errorKey).toBe("");
    expect(text.a.readyState).toBe("open");
  }, 15_000);

  it("keeps exactly one sink per file when the gap crosses the next file's async open", async () => {
    const opens: string[] = [];
    const output = new Map<string, Uint8Array>();
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const done = vi.fn();
    const target: SaveTarget = {
      label: "gated",
      done,
      async file(name) {
        opens.push(name);
        if (opens.length === 2) await openGate;
        const chunks: Uint8Array[] = [];
        return {
          async write(chunk) { chunks.push(chunk.slice()); },
          async close() {
            const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const joined = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
            // Model a real save target: a name is never handed out twice, so a
            // second open of the same file is visible as a suffixed duplicate
            // instead of silently overwriting the first.
            output.set(output.has(name) ? `${name} (1)` : name, joined);
          },
        };
      },
    };
    const { a, b, aLink, bLink, links, file } = await harness({ pickB: async () => target });
    a.enqueue("b", [
      { file: new File(["first file"], "first.txt") },
      { file: new File(["second file"], "second.txt") },
    ]);
    await until(() => !!b.incoming);
    b.accept();
    // Parked inside the second file's open: the sink exists, the batch does not
    // know about it yet, and the transport dies exactly there.
    await until(() => opens.length === 2);

    file.a.close();
    file.b.close();
    releaseOpen();
    await until(() => a.send?.status === "resuming" && b.recv?.status === "resuming");

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => a.send?.status === "sendDone" && b.recv?.status === "recvDone");

    expect(opens).toEqual(["first.txt", "second.txt"]);
    expect([...output.keys()]).toEqual(["first.txt", "second.txt"]);
    expect([...output.get("first.txt")!]).toEqual(bytes("first file"));
    expect([...output.get("second.txt")!]).toEqual(bytes("second file"));
    expect(done).toHaveBeenCalledOnce();
    const point = announced(swap.a.sent.find((frame) => kindOf(frame) === FRAME.RESUME)!);
    expect(point).toMatchObject({ index: 1, offset: 0 });
  }, 15_000);

  it("rejects a forged resume request beyond the sender's authenticated frontier", async () => {
    const { a, b, aLink, bLink, links, file, text } = await harness();
    const originalSend = file.a.send;
    let dropped = false;
    file.a.send = function (data) {
      originalSend.call(this, data);
      if (dropped || typeof data === "string" || data instanceof Blob) return;
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (view[0] !== FRAME.CHUNK) return;
      dropped = true;
      file.a.close();
      file.b.close();
    };
    a.enqueue("b", [{ file: new File([new Uint8Array(4 * CHUNK_SIZE)], "frontier.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "resuming");

    const { swap, aNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    // In range and chunk-aligned, but the old transport admitted only one chunk.
    swap.b.send(resumeReqFrame(0, 2 * CHUNK_SIZE));

    await until(() => a.errorKey === "failed");
    expect(text.a.readyState).toBe("open");
    expect(swap.a.sent.filter((frame) => kindOf(frame) === FRAME.RESUME)).toHaveLength(0);
    b.reset();
  });

  it("rejects a resume announcement that differs from the durable sink checkpoint", async () => {
    const { a, b, aLink, bLink, links, file, text } = await harness();
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    const originalFrames = aLink.fileSender.dataFrames.bind(aLink.fileSender);
    vi.spyOn(aLink.fileSender, "dataFrames").mockImplementation(async function* (...args) {
      let held = false;
      for await (const frame of originalFrames(...args)) {
        yield frame;
        if (!held && frame[0] === FRAME.CHUNK) { held = true; await sourceGate; }
      }
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(3 * CHUNK_SIZE)], "checkpoint.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => (b.recv?.sent ?? 0) >= CHUNK_SIZE);
    file.a.close();
    file.b.close();
    releaseSource();
    await until(() => b.recv?.status === "resuming");

    const { swap, bNext } = rebuild(aLink, bLink, links);
    b.attach(bNext);
    // The receiver asks for its non-zero durable prefix. A signalling attacker
    // cannot substitute an earlier point and make the append-only sink duplicate.
    swap.a.send(aLink.fileSender.resumeStartFrame({ index: 0, offset: 0 }));

    await until(() => b.errorKey === "failed");
    expect(text.b.readyState).toBe("open");
    a.reset();
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
    swap.a.send(await batchFrame(aLink.fileSender, [{ name: "sneaky.txt", size: 1 }], aLink.keys));

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

  it("fails the lane on a byte-level realignment without an active batch", async () => {
    const { b, aLink, bLink, links, file, text } = await harness();
    file.b.close();
    const { swap, bNext } = rebuild(aLink, bLink, links);
    b.attach(bNext);

    // Byte points are meaningful only when they exactly match a preserved sink
    // checkpoint. An idle direction still accepts only the batch-free origin.
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
    await until(() => a.send?.status === "resuming");
    expect(dropped).toBe(true);

    expect(a.errorKey).toBe("");
    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => b.recv?.status === "recvDone" && a.send?.status === "sendDone");
    expect(bTarget.output.get("buffered.bin")).toEqual(new Uint8Array(2 * 1024 * 1024));
  }, 30_000);

  it("commits an admitted old-generation write before requesting its exact resume point", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const chunks: Uint8Array[] = [];
    const close = vi.fn();
    let writeStarted = false;
    const stalled: SaveTarget = {
      label: "stalled",
      async file() {
        return {
          async write(chunk) { writeStarted = true; await gate; chunks.push(chunk.slice()); },
          async close() { close(); },
        };
      },
    };
    const pick = vi.fn(async () => stalled);
    const { a, b, aLink, bLink, links, file } = await harness({
      pickB: pick,
    });
    a.enqueue("b", [{ file: new File([new Uint8Array(4 * 1024 * 1024)], "stalled.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => writeStarted);
    // The receive chain is blocked on the first write, so later frames sit in it
    // admitted-but-unfed when the transport dies.
    expect((a.send?.sent ?? 0) > 0 || a.send?.status === "finishing").toBe(true);

    file.a.close();
    file.b.close();
    releaseWrite();
    await until(() => a.send?.status === "resuming" && b.recv?.status === "resuming");
    expect(a.errorKey).toBe("");
    expect(b.errorKey).toBe("");

    const { swap, aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => b.recv?.status === "recvDone" && a.send?.status === "sendDone");
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    expect(joined).toEqual(new Uint8Array(4 * 1024 * 1024));
    expect(pick).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const point = announced(swap.a.sent.find((frame) => kindOf(frame) === FRAME.RESUME)!);
    expect(point.offset).toBe(CHUNK_SIZE);
  }, 30_000);

  it("keeps the inbound sink open across the gap and closes it once after resume", async () => {
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
    const { a, b, aLink, bLink, links, file } = await harness({ pickB: async () => target });
    a.enqueue("b", [{ file: new File([new Uint8Array(2 * 1024 * 1024)], "gap.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    await until(() => events.includes("write-start"));

    file.b.close();
    file.a.close();
    expect(events).toEqual(["write-start"]);
    releaseWrite();
    await until(() => events.includes("write-end"));
    expect(events).not.toContain("close");
    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => b.recv?.status === "recvDone" && a.send?.status === "sendDone");
    expect(events.at(-1)).toBe("close");
    expect(events.filter((event) => event === "close")).toHaveLength(1);
  }, 10_000);

  it("unblocks a sender parked on flow-control credit as soon as the transport dies", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const stalled: SaveTarget = {
      label: "stalled",
      async file() { return { async write() { await gate; }, async close() {} }; },
    };
    const { a, b, aLink, bLink, links, file } = await harness({ pickB: async () => stalled });
    a.enqueue("b", [{ file: new File([new Uint8Array(24 * 1024 * 1024)], "window.bin") }]);
    await until(() => !!b.incoming);
    b.accept();
    // Fill the flow window so the sender is waiting on credit that will never come.
    const onWire = () => file.a.sent
      .filter((frame) => new Uint8Array(frame)[0] === FRAME.CHUNK)
      .reduce((sum, frame) => sum + frame.byteLength - CHUNK_OVERHEAD, 0);
    await until(() => onWire() >= FLOW_WINDOW);

    file.a.close();
    file.b.close();
    // Far below the 60 s stall timeout: a parked send must not wait it out.
    await until(() => a.send?.status === "resuming", 2_000);
    releaseWrite();
    const { aNext, bNext } = rebuild(aLink, bLink, links);
    a.attach(aNext);
    b.attach(bNext);
    await until(() => a.send?.status === "sendDone" && b.recv?.status === "recvDone", 10_000);
  }, 15_000);

  it("keeps a pre-gap send that resolves late inert against the rebuilt generation", async () => {
    const { a, b, aLink, bLink, links, file, text, bTarget } = await harness();
    let releaseManifest!: () => void;
    const manifestGate = new Promise<void>((resolve) => { releaseManifest = resolve; });
    const original = aLink.fileSender.batchFrames.bind(aLink.fileSender);
    const batchFrames = vi.spyOn(aLink.fileSender, "batchFrames").mockImplementation(async (...args) => {
      const frames = await original(...args);
      await manifestGate;
      return frames;
    });
    a.enqueue("b", picked("crossing.txt", "never sent"));
    await until(() => batchFrames.mock.calls.length === 1);

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
    batchFrames.mockRestore();

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

// ── The pre-upload key handoff (frame kind 12) ──────────────────────────────
//
// It shares the file channel and nothing else: its own derived key, its own
// counter, dispatched ahead of the receive chain. Every case here is about that
// separation holding — a handoff must never be able to disturb a transfer, and a
// transfer must never be able to delay a handoff.
describe("stored-key handoff on the file lane", () => {
  const item = (id: string, fill = 3): HandoffItem => ({ id, key: encodeKey(new Uint8Array(32).fill(fill)) });

  it("hands the whole set over the moment the link attaches", async () => {
    const got: HandoffItem[][] = [];
    const items = [item("obj1", 1), item("obj2", 2)];
    await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length > 0);
    expect(got[0]).toEqual(items);
  });

  it("says nothing at all to a peer that never announced preupload/1", async () => {
    // The old/unknown-peer rule. An unknown frame kind is a HARD ERROR in every
    // implementation, so a speculative handoff to a native client, the CLI or an
    // older Web build does not degrade to the live link — it fails the transfer
    // on a frame the peer cannot parse.
    const got: HandoffItem[][] = [];
    const { file, a, b, bTarget } = await harness({
      preuploadPeers: [], // neither side announced
      storedKeysA: () => [item("obj1", 1)],
      onStoredKeysB: (i) => got.push(i),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    expect(file.a.sent.filter((f) => new Uint8Array(f)[0] === KIND_STORED_KEYS)).toEqual([]);

    // And the ordinary transfer to that peer is completely unaffected.
    a.enqueue("b", picked("hello.txt", "hello"));
    await until(() => !!b.incoming);
    b.accept();
    await until(() => a.send?.status === "sendDone" && b.recv?.status === "recvDone");
    expect([...bTarget.output.get("hello.txt")!]).toEqual(bytes("hello"));
  });

  it("sends nothing when there is nothing uploaded", async () => {
    const got: HandoffItem[][] = [];
    const { file } = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => [],
      onStoredKeysB: (i) => got.push(i),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    expect(file.a.sent).toEqual([]);
  });

  it("re-sends the WHOLE current set on a rebuilt transport", async () => {
    // §4.4's retry rule. The set is pulled again rather than remembered, so a
    // reconnect costs one frame and there is no partial form to get wrong.
    const got: HandoffItem[][] = [];
    let items = [item("obj1", 1)];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length === 1);

    // A transport replacement: same link identity, same codecs, new channels.
    const nextFile = channelPair();
    const nextText = channelPair();
    items = [item("obj1", 1), item("obj2", 2)];
    const rebuiltA = { ...h.aLink, fileChannel: nextFile.a as unknown as RTCDataChannel, textChannel: nextText.a as unknown as RTCDataChannel };
    const rebuiltB = { ...h.bLink, fileChannel: nextFile.b as unknown as RTCDataChannel, textChannel: nextText.b as unknown as RTCDataChannel };
    h.links.a = rebuiltA;
    h.links.b = rebuiltB;
    h.b.attach(rebuiltB);
    h.a.attach(rebuiltA);

    await until(() => got.length === 2);
    // The whole set, not the delta — including the id the peer already holds.
    expect(got[1]).toEqual(items);
  });

  it("hands over an object that finished uploading after the link was already open", async () => {
    // The case the attach-time send cannot cover: an upload still in flight when
    // the peer joined is allowed to finish, so a NEW object appears minutes
    // later on a link nobody is going to re-establish.
    const got: HandoffItem[][] = [];
    let items = [item("early", 1)];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length === 1);

    items = [item("early", 1), item("late", 2)];
    h.a.sendStoredKeys();
    await until(() => got.length === 2);
    expect(got[1].map((i) => i.id)).toEqual(["early", "late"]);
  });

  it("does not disturb a file batch, and is not delayed by one", async () => {
    // The whole reason it has its own key and counter. A handoff emitted while a
    // transfer is running must neither consume a seq the file receiver is
    // expecting nor queue behind the receive chain's disk writes.
    const got: HandoffItem[][] = [];
    let items = [item("obj1", 1)];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length === 1);

    h.a.enqueue("b", picked("hello.txt", "hello"));
    await until(() => !!h.b.incoming);
    items = [item("obj1", 1), item("obj2", 2)];
    h.a.sendStoredKeys(); // mid-batch, before consent
    h.b.accept();
    await until(() => h.a.send?.status === "sendDone" && h.b.recv?.status === "recvDone");
    expect([...h.bTarget.output.get("hello.txt")!]).toEqual(bytes("hello"));
    await until(() => got.length === 2);
    expect(h.a.errorKey).toBe("");
    expect(h.b.errorKey).toBe("");
  });

  it("never names an object that left the uploaded set while it was queued", async () => {
    // A queued emission can sit behind another handoff's seal for as long as
    // that seal takes, and the set is not stable across that wait: an entry can
    // be RELEASED to the live link in between and drained into a batch. A frame
    // built from a snapshot taken before that would tell the receiver to fetch
    // and write a file the live lane is delivering at the same moment — one
    // transfer, two writes, from two sources.
    const got: HandoffItem[][] = [];
    let items = [item("obj1", 1), item("released", 2)];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length === 1);

    // Hold a seal open so the NEXT emission is queued behind it, then change the
    // set while it waits — exactly what releaseUploaded() does to the outbox.
    let release!: () => void;
    let sealing = false;
    const gate = new Promise<void>((r) => { release = r; });
    const realFrame = h.aLink.storedKeysSender.frame.bind(h.aLink.storedKeysSender);
    h.aLink.storedKeysSender.frame = async (i, k) => {
      sealing = true;
      await gate;
      return realFrame(i, k);
    };
    h.a.sendStoredKeys(); // occupies the chain
    await until(() => sealing);
    h.a.sendStoredKeys(); // queued behind it

    items = [item("obj1", 1)]; // "released" went back to the live link
    release();
    await until(() => got.length === 3);
    // The frame that was already sealing may name it — it was true when that
    // one was built. The frame that was still QUEUED must not: it is sent after
    // the release, so a set captured at call time is a set that no longer
    // exists.
    expect(got[2].map((i) => i.id)).toEqual(["obj1"]);
  });

  it("recovers from a send that throws, and the peer takes the next set", async () => {
    // The seq is taken synchronously and the seal is async, so a `send()` that
    // throws destroys a frame that already spent its number. If that wedged the
    // peer's receiver, every later whole-set resend would be refused for the
    // life of the link — the sender believing it handed the keys over while the
    // receiver waits for a prompt that can never come.
    const got: HandoffItem[][] = [];
    let items = [item("obj1", 1)];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length === 1);

    const realSend = h.file.a.send.bind(h.file.a);
    let broken = true;
    h.file.a.send = function (data: ArrayBuffer) {
      if (broken && new Uint8Array(data)[0] === KIND_STORED_KEYS) {
        broken = false;
        throw new Error("datachannel send failed");
      }
      realSend(data);
    } as FakeChannel["send"];

    items = [item("obj1", 1), item("obj2", 2)];
    h.a.sendStoredKeys(); // seq burned by the throw; nothing reaches the peer
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);

    items = [item("obj1", 1), item("obj2", 2), item("obj3", 3)];
    h.a.sendStoredKeys();
    await until(() => got.length === 2);
    expect(got[1].map((i) => i.id)).toEqual(["obj1", "obj2", "obj3"]);
    expect(h.b.errorKey).toBe("");
  });

  it("recovers when the transport dies mid-seal and the link is rebuilt", async () => {
    // The generation guard inside the emission fires after the seal, so the
    // frame is silently dropped with its seq spent. The rebuilt transport
    // deliberately carries the SAME codec objects (one link, one counter), so
    // the resend that attach() makes lands on a receiver whose expectation is
    // now behind — exactly the hole the forward-gap rule absorbs.
    const got: HandoffItem[][] = [];
    let items = [item("obj1", 1)];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      storedKeysA: () => items,
      onStoredKeysB: (i) => got.push(i),
    });
    await until(() => got.length === 1);

    // Hold the next seal open, then kill the transport under it. `sealing` is
    // what makes this the case it claims to be: the emission must be INSIDE the
    // seal (its seq already spent) when the rebuild lands, not still queued
    // behind the guard that would have refused it for free.
    let release!: () => void;
    let sealing = false;
    const sealGate = new Promise<void>((r) => { release = r; });
    const realFrame = h.aLink.storedKeysSender.frame.bind(h.aLink.storedKeysSender);
    h.aLink.storedKeysSender.frame = async (i, k) => {
      const out = await realFrame(i, k); // the seq is spent right here
      sealing = true;
      await sealGate;
      return out;
    };
    items = [item("obj1", 1), item("obj2", 2)];
    h.a.sendStoredKeys();
    await until(() => sealing);

    const nextFile = channelPair();
    const nextText = channelPair();
    const rebuiltA = { ...h.aLink, fileChannel: nextFile.a as unknown as RTCDataChannel, textChannel: nextText.a as unknown as RTCDataChannel };
    const rebuiltB = { ...h.bLink, fileChannel: nextFile.b as unknown as RTCDataChannel, textChannel: nextText.b as unknown as RTCDataChannel };
    h.links.a = rebuiltA;
    h.links.b = rebuiltB;
    h.b.attach(rebuiltB);
    h.a.attach(rebuiltA);
    release(); // the superseded frame finishes sealing and is dropped

    await until(() => got.length === 2);
    expect(got[1].map((i) => i.id)).toEqual(["obj1", "obj2"]);
    expect(h.b.errorKey).toBe("");
  });

  it("drops a junk handoff frame without failing the lane", async () => {
    // Peer-authored input: the far end is authenticated but has never been
    // trusted to be well-behaved, and a peer that is buggy or hostile can put
    // whatever it likes on this channel. A malformed kind-12 frame must not
    // become a way to kill a working transfer: it cannot corrupt the file stream
    // (different key, different counter), so it is logged and ignored.
    const got: HandoffItem[][] = [];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      onStoredKeysB: (i) => got.push(i),
    });
    const junk = new Uint8Array(5 + 32);
    junk[0] = KIND_STORED_KEYS;
    h.file.b.onmessage?.(new MessageEvent("message", { data: junk.buffer }));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    expect(h.b.errorKey).toBe("");

    h.a.enqueue("b", picked("hello.txt", "hello"));
    await until(() => !!h.b.incoming);
    h.b.accept();
    await until(() => h.a.send?.status === "sendDone" && h.b.recv?.status === "recvDone");
    expect([...h.bTarget.output.get("hello.txt")!]).toEqual(bytes("hello"));
  });

  it("drops a kind-12 frame too short to be one, instead of feeding it to the file lane", async () => {
    // The demux answers "whose frame is this?", and the answer is the KIND — a
    // truncated kind-12 frame is still not the file stream's. Deciding it by
    // length instead sent a one-byte kind 12 to the file receiver, which then
    // failed the lane on a frame that was never part of its sequence: one byte
    // from a buggy or hostile peer, and the transfer nobody had a problem with
    // is dead. Routed to the handoff decoder it is refused there, logged, and
    // costs the lane nothing — exactly like the junk frame above.
    const got: HandoffItem[][] = [];
    const h = await harness({
      preuploadPeers: ["a", "b"],
      onStoredKeysB: (i) => got.push(i),
    });
    h.file.b.onmessage?.(new MessageEvent("message", { data: new Uint8Array([KIND_STORED_KEYS]).buffer }));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    expect(h.b.errorKey, "one truncated frame killed the file lane").toBe("");

    h.a.enqueue("b", picked("hello.txt", "hello"));
    await until(() => !!h.b.incoming);
    h.b.accept();
    await until(() => h.a.send?.status === "sendDone" && h.b.recv?.status === "recvDone");
    expect([...h.bTarget.output.get("hello.txt")!]).toEqual(bytes("hello"));
  });
});
